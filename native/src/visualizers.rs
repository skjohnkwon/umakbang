//! The visualizer panel beside the table, ported from `components/visualizers/Visualizers.tsx`.
//!
//! Each plot is a canvas that keeps its pixels between frames, as a `<canvas>` does: it is drawn
//! into on the animation frame while something plays (`Visuals::frame`), once more when playback
//! stops, and wiped five seconds into the silence - the three phases of `audio-tap.ts`. Laying
//! the screen out only places the canvas; the painter blits what is already there. The stereo
//! panel's phosphor trail depends on that, since each frame fades the previous one.
//!
//! The canvas geometry is Chromium's: floored to whole CSS pixels (`useVisualizerCanvas`
//! measures with `Math.floor`), placed on a whole pixel, and clipped by the section's rounded
//! corners when it is composited.

use crate::analyser::{Analyser, time_bytes};
use crate::player::{Channel, Ring};
use crate::screen::Action;
use crate::theme::Theme;
use crate::ui::color::{Rgba, mix_oklab};
use crate::ui::text::TextStyle;
use crate::ui::tree::{El, Painter, col, div, icon, paint, text};
use resvg::tiny_skia::{
    BlendMode, Color, FillRule, GradientStop, LineJoin, LinearGradient, Paint, PathBuilder, Pixmap, PixmapMut,
    Point, Rect, SpreadMode, Stroke, Transform,
};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Mutex;

/// `DEFAULT_VISUALIZER_STOPS`: green, yellow, orange, red, magenta.
pub const DEFAULT_STOPS: [&str; 5] = ["#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899"];

/// `BAND_COUNT` in palette.ts.
const BANDS: usize = 10;

/// `WAVE_STEPS` in palette.ts.
const WAVE_STEPS: usize = 16;

/// Levels' scale, in dB.
const TICKS_DB: [f32; 6] = [-48.0, -36.0, -24.0, -12.0, -6.0, 0.0];

/// Below ~30Hz there is nothing musical to show, and log scales blow up near zero.
const MIN_HZ: f32 = 30.0;

/// dB span the fine analyser covers before the user's headroom.
const SPECTRUM_RANGE_DB: f32 = 84.0;

/// The analysers' sizes in `audio-tap.ts`.
const FFT_SIZE: usize = 2048;
const FINE_FFT_SIZE: usize = 8192;

/// The rolling waveform's scroll rate, the width each column's envelope is read over, and the
/// context its tone is estimated from - `RollingWaveform`'s constants.
const COLUMNS_PER_SECOND: f32 = 360.0;
const OLDEST_ALPHA: f32 = 0.55;
const ENVELOPE_OVERLAP: f32 = 3.0;
const TONE_WINDOW_COLUMNS: f32 = 16.0;

/// Goniometer points per frame, and the arc's dot size.
const TRACE_POINTS: usize = 480;
const DOT: f32 = 2.5;

/// The colours the panels draw with, resolved once: `palette.ts`.
#[derive(Clone)]
pub struct Palette {
    /// Silence to full energy (the first entry is what silence looks like), 256 entries, as the rasterised strip gives them back.
    pub heat: Vec<[u8; 4]>,
    /// Magnitude to bar colour, ten steps along the ramp.
    pub bands: Vec<Rgba>,
    /// The user's ramp in sixteen steps, mixed in OKLab - what the waveforms tint with.
    pub wave: Vec<Rgba>,
    pub primary: Rgba,
    pub hot: Rgba,
    pub border: Rgba,
    pub muted: Rgba,
    pub foreground: Rgba,
}

impl Palette {
    pub fn new(stops: &[String], t: &Theme) -> Palette {
        let mut parsed: Vec<Rgba> = stops.iter().filter_map(|s| Rgba::from_hex(s)).collect();
        if parsed.is_empty() {
            parsed = DEFAULT_STOPS.iter().filter_map(|s| Rgba::from_hex(s)).collect();
        }
        if parsed.len() == 1 {
            parsed.push(parsed[0]);
        }
        // The ramp is rasterised across 256 pixels by a canvas gradient, which interpolates
        // in sRGB and samples at pixel centres; the colours are read back out of that strip.
        let heat: Vec<[u8; 4]> = (0..256).map(|i| ramp(&parsed, (i as f32 + 0.5) / 256.0).to_u8()).collect();
        let rgb = |c: [u8; 4]| Rgba::rgb8(c[0], c[1], c[2]);
        let bands = (0..BANDS).map(|band| rgb(heat[(((band as f32 + 0.5) / BANDS as f32) * 255.0).round() as usize])).collect();
        // `sampleStops`: the two stops a step falls between, as `color-mix(in oklab, a N%, b)`
        // with N a whole percent.
        let span = 1.0 / (parsed.len() - 1) as f32;
        let wave = (0..WAVE_STEPS)
            .map(|step| {
                let t = step as f32 / (WAVE_STEPS - 1) as f32;
                let index = ((t / span).floor() as usize).min(parsed.len() - 2);
                let amount = (t - index as f32 * span) / span;
                let weight = ((1.0 - amount) * 100.0).round() / 100.0;
                mix_oklab(parsed[index], parsed[index + 1], weight)
            })
            .collect();
        Palette {
            heat,
            bands,
            wave,
            primary: parsed[0],
            hot: parsed[parsed.len() - 1],
            border: t.border,
            muted: t.muted_foreground,
            foreground: t.foreground,
        }
    }
}

/// The colour `at` (0..1) along the stops, evenly spaced, mixed in sRGB.
fn ramp(stops: &[Rgba], at: f32) -> Rgba {
    let span = (stops.len() - 1) as f32;
    let position = at.clamp(0.0, 1.0) * span;
    let index = (position.floor() as usize).min(stops.len() - 2);
    let f = position - index as f32;
    let (a, b) = (stops[index], stops[index + 1]);
    Rgba { r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f, a: 1.0 }
}

/* ------------------------------------------------------------------ the shared state */

/// What a frame means, as `FramePhase` has it.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Phase {
    /// Audio is moving: draw it.
    Live,
    /// The single settling frame when playback stops.
    Idle,
    /// Nothing has played for a while: throw away what is on screen.
    Clear,
}

/// The analysers, read once per frame and shared by every panel - Chromium answers a second
/// `getByteFrequencyData` in the same render quantum from the first, so the spectrogram and
/// the bars see one spectrum.
pub struct Analysis {
    fine: Analyser,
    pub fine_bytes: Vec<u8>,
    pub mono: Vec<f32>,
    pub mono_bytes: Vec<u8>,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub rate: f32,
    scratch: Vec<f32>,
}

impl Analysis {
    fn new() -> Analysis {
        // The fine analyser's own settings: less smoothing than the others, and a window moved
        // down 6dB to make up for four times the bins.
        let fine = Analyser::new(FINE_FFT_SIZE, 0.55, -102.0, -18.0);
        Analysis {
            fine_bytes: vec![0; fine.bins()],
            fine,
            mono: vec![0.0; FFT_SIZE],
            mono_bytes: vec![128; FFT_SIZE],
            left: vec![0.0; FFT_SIZE],
            right: vec![0.0; FFT_SIZE],
            rate: 44100.0,
            scratch: vec![0.0; FINE_FFT_SIZE],
        }
    }

    fn read(&mut self, ring: &Ring) {
        ring.latest(Channel::Mono, &mut self.scratch);
        self.fine.analyse(&self.scratch);
        self.fine.bytes(&mut self.fine_bytes);
        ring.latest(Channel::Mono, &mut self.mono);
        time_bytes(&self.mono, &mut self.mono_bytes);
        ring.latest(Channel::Left, &mut self.left);
        ring.latest(Channel::Right, &mut self.right);
        self.rate = ring.sample_rate as f32;
    }

    fn bins(&self) -> usize {
        self.fine_bytes.len()
    }
}

/// A canvas: CSS size (floored), the device scale, and the bitmap at that size.
pub struct Surface {
    pub w: f32,
    pub h: f32,
    pub scale: f32,
    pub pixmap: Pixmap,
}

impl Surface {
    fn transform(&self) -> Transform {
        Transform::from_scale(self.scale, self.scale)
    }
    fn clear(&mut self) {
        self.pixmap.fill(Color::TRANSPARENT);
    }
}

/// What the frame hands every panel's draw.
struct Ctx<'a> {
    palette: &'a Palette,
    analysis: &'a Analysis,
    /// Milliseconds, shared by every panel.
    time: f64,
    headroom: f32,
    /// `Settings.waveformTint` is anything but `accent`: waveforms take the ramp.
    ramp: bool,
}

enum Panel {
    Spectrogram(Spectrogram),
    Spectrum(Spectrum),
    Wave(Rolling),
    Scope,
    Levels(Levels),
    Stereo,
}

struct Slot {
    surface: Option<Surface>,
    panel: Panel,
}

pub struct Visuals {
    pub palette: Palette,
    pub headroom: f32,
    pub ramp: bool,
    analysis: Analysis,
    slots: Vec<Slot>,
    /// The frame clock, for panels resized between frames.
    time: f64,
    playing: bool,
    /// Something has been drawn since the last wipe - nothing else is worth wiping.
    pub painted: bool,
}

/// The panels in their canonical order (`VISUALIZERS`).
const SPECTROGRAM: usize = 0;
const SPECTRUM: usize = 1;
const WAVE: usize = 2;
const SCOPE: usize = 3;
const LEVELS: usize = 4;
const STEREO: usize = 5;

impl Visuals {
    pub fn new(palette: Palette, headroom_db: f32, ramp: bool) -> Visuals {
        let slot = |panel| Slot { surface: None, panel };
        Visuals {
            palette,
            headroom: headroom_db.clamp(0.0, 18.0),
            ramp,
            analysis: Analysis::new(),
            slots: vec![
                slot(Panel::Spectrogram(Spectrogram { history: None })),
                slot(Panel::Spectrum(Spectrum::default())),
                slot(Panel::Wave(Rolling::default())),
                slot(Panel::Scope),
                slot(Panel::Levels(Levels::default())),
                slot(Panel::Stereo),
            ],
            time: 0.0,
            playing: false,
            painted: false,
        }
    }

    /// One frame of the shared loop, `time` in milliseconds.
    pub fn frame(&mut self, phase: Phase, time: f64, ring: Option<&Mutex<Ring>>) {
        self.time = time;
        self.playing = phase == Phase::Live;
        if phase == Phase::Live {
            // Copied out and the lock let go before anything is drawn: the audio thread
            // writes into this ring and must never wait on a frame.
            if let Some(ring) = ring.and_then(|r| r.lock().ok()) {
                self.analysis.read(&ring);
            }
            self.painted = true;
        }
        if phase == Phase::Clear {
            self.painted = false;
        }
        let ctx = Ctx { palette: &self.palette, analysis: &self.analysis, time, headroom: self.headroom, ramp: self.ramp };
        for slot in &mut self.slots {
            let Some(surface) = slot.surface.as_mut() else { continue };
            if phase == Phase::Clear {
                clear(&mut slot.panel, surface, &ctx);
            }
            draw(&mut slot.panel, surface, phase == Phase::Live, &ctx);
        }
    }

    /// The meter's readout: the loudest channel's peak in dBFS, `None` for silence.
    pub fn readout(&self) -> Option<f32> {
        match &self.slots[LEVELS].panel {
            Panel::Levels(levels) => levels.readout,
            _ => None,
        }
    }

    /// Fits slot `index` to a box of `w` x `h` CSS pixels, rebuilding what depends on its size
    /// and drawing it at rest - what `measure` does when the ResizeObserver fires.
    fn fit(&mut self, index: usize, w: f32, h: f32, scale: f32) {
        let slot = &mut self.slots[index];
        if slot.surface.as_ref().is_some_and(|s| s.w == w && s.h == h && s.scale == scale) {
            return;
        }
        let Some(pixmap) = Pixmap::new((w * scale).round().max(1.0) as u32, (h * scale).round().max(1.0) as u32) else { return };
        let mut surface = Surface { w, h, scale, pixmap };
        let ctx = Ctx { palette: &self.palette, analysis: &self.analysis, time: self.time, headroom: self.headroom, ramp: self.ramp };
        resize(&mut slot.panel, &surface, &ctx);
        draw(&mut slot.panel, &mut surface, false, &ctx);
        slot.surface = Some(surface);
    }
}

fn resize(panel: &mut Panel, s: &Surface, c: &Ctx) {
    match panel {
        Panel::Spectrogram(p) => p.resize(s, c),
        Panel::Spectrum(p) => p.resize(s, c),
        Panel::Wave(p) => p.resize(s),
        _ => {}
    }
}

fn draw(panel: &mut Panel, s: &mut Surface, active: bool, c: &Ctx) {
    match panel {
        Panel::Spectrogram(p) => p.draw(s, active, c),
        Panel::Spectrum(p) => p.draw(s, active, c),
        Panel::Wave(p) => p.draw(s, active, c),
        Panel::Scope => scope(s, active, c),
        Panel::Levels(p) => p.draw(s, active, c),
        Panel::Stereo => stereo(s, active, c),
    }
}

fn clear(panel: &mut Panel, s: &mut Surface, c: &Ctx) {
    match panel {
        Panel::Spectrogram(p) => p.clear(c),
        Panel::Spectrum(p) => p.clear(),
        Panel::Wave(p) => p.clear(),
        Panel::Levels(p) => p.clear(),
        _ => {}
    }
    let _ = s;
}

/* ------------------------------------------------------------------ helpers */

/// Where each row of a log frequency axis falls, in fractional bins.
fn log_bin_edges(count: usize, bins: usize, sample_rate: f32) -> Vec<f32> {
    let nyquist = sample_rate / 2.0;
    (0..=count)
        .map(|i| {
            let hz = MIN_HZ * (nyquist / MIN_HZ).powf(i as f32 / count as f32);
            ((hz / nyquist) * bins as f32).clamp(0.0, (bins - 1) as f32)
        })
        .collect()
}

/// The loudest bin between two fractional positions, or an interpolation between neighbours
/// when the band is narrower than a bin.
fn band_peak(data: &[u8], from: f32, to: f32) -> f32 {
    let first = from.floor() as usize;
    let last = to.floor() as usize;
    if last <= first {
        let middle = (from + to) / 2.0;
        let index = middle.floor() as usize;
        let fraction = middle - index as f32;
        let low = *data.get(index).unwrap_or(&0) as f32;
        let high = data.get(index + 1).map(|&v| v as f32).unwrap_or(low);
        return low + (high - low) * fraction;
    }
    data[first..=last.min(data.len() - 1)].iter().copied().max().unwrap_or(0) as f32
}

fn to_unit_db(amplitude: f32) -> f32 {
    let db = 20.0 * amplitude.max(1e-5).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Where a stretch of audio's energy sits, 0 (low) to 1 (high), from its zero crossings:
/// `brightnessOf` in peaks-core.ts.
pub fn brightness_of(crossings: usize, samples: usize, sample_rate: f32) -> f32 {
    if samples <= 1 || crossings == 0 {
        return 0.0;
    }
    let frequency = (crossings as f32 / samples as f32) * sample_rate / 2.0;
    ((frequency / 40.0).ln() / (8000.0f32 / 40.0).ln()).clamp(0.0, 1.0)
}

fn paint_of(color: Rgba) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color(color.skia());
    paint.anti_alias = true;
    paint
}

fn fill(pm: &mut PixmapMut, rect: [f32; 4], color: Rgba, transform: Transform) {
    if let Some(r) = Rect::from_xywh(rect[0], rect[1], rect[2], rect[3]) {
        pm.fill_rect(r, &paint_of(color), transform, None);
    }
}

fn stroke(pm: &mut PixmapMut, pb: PathBuilder, color: Rgba, width: f32, transform: Transform) {
    if let Some(path) = pb.finish() {
        let stroke = Stroke { width, line_join: LineJoin::Round, ..Stroke::default() };
        pm.stroke_path(&path, &paint_of(color), &stroke, transform, None);
    }
}

/// Source-over of an axis-aligned rectangle in device pixels, each pixel covered by exactly
/// as much of it as falls inside - what an anti-aliased fill of the same rectangle gives.
fn fill_rect_exact(pixmap: &mut Pixmap, r: [f32; 4], color: Rgba) {
    let (pw, ph) = (pixmap.width() as i32, pixmap.height() as i32);
    let (x0, y0, x1, y1) = (r[0].max(0.0), r[1].max(0.0), (r[0] + r[2]).min(pw as f32), (r[1] + r[3]).min(ph as f32));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let [cr, cg, cb, ca] = color.to_u8();
    let data = pixmap.data_mut();
    let cover = |lo: f32, hi: f32, p: i32| (hi.min(p as f32 + 1.0) - lo.max(p as f32)).clamp(0.0, 1.0);
    for y in (y0.floor() as i32)..(y1.ceil() as i32).min(ph) {
        let cy = cover(y0, y1, y);
        for x in (x0.floor() as i32)..(x1.ceil() as i32).min(pw) {
            let a = (ca as f32 * cy * cover(x0, x1, x)).round() as u32;
            if a == 0 {
                continue;
            }
            let keep = 255 - a;
            let px = &mut data[((y * pw + x) * 4) as usize..((y * pw + x) * 4 + 4) as usize];
            for (c, v) in [cr, cg, cb].into_iter().enumerate() {
                px[c] = ((v as u32 * a + 127) / 255 + (px[c] as u32 * keep + 127) / 255).min(255) as u8;
            }
            px[3] = (a + (px[3] as u32 * keep + 127) / 255).min(255) as u8;
        }
    }
}

fn fill_path(pm: &mut PixmapMut, pb: PathBuilder, paint: &Paint, transform: Transform) {
    if let Some(path) = pb.finish() {
        pm.fill_path(&path, paint, FillRule::Winding, transform, None);
    }
}

/* ------------------------------------------------------------------ spectrogram */

struct History {
    /// Device pixels, opaque, one column per frame written at `head`.
    pixels: Vec<[u8; 4]>,
    width: usize,
    height: usize,
    head: usize,
    /// Bin boundary per pixel row.
    edges: Vec<f32>,
}

struct Spectrogram {
    history: Option<History>,
}

impl Spectrogram {
    fn resize(&mut self, s: &Surface, c: &Ctx) {
        let width = ((s.w * s.scale).floor() as usize).max(1);
        let height = ((s.h * s.scale).floor() as usize).max(1);
        if self.history.as_ref().is_some_and(|h| h.width == width && h.height == height) {
            return;
        }
        let quiet = c.palette.heat[0];
        let mut pixels = vec![quiet; width * height];
        // What was on screen is carried across, unrolled into time order and stretched.
        if let Some(old) = &self.history {
            for x in 0..width {
                let from_x = (old.head + (x * old.width) / width) % old.width;
                for y in 0..height {
                    let from_y = (y * old.height) / height;
                    pixels[y * width + x] = old.pixels[from_y * old.width + from_x];
                }
            }
        }
        self.history = Some(History { pixels, width, height, head: 0, edges: log_bin_edges(height, c.analysis.bins(), c.analysis.rate) });
    }

    fn draw(&mut self, s: &mut Surface, active: bool, c: &Ctx) {
        let Some(history) = self.history.as_mut() else { return };
        if active {
            let data = &c.analysis.fine_bytes;
            for y in 0..history.height {
                // Row 0 is the top of the panel, so it reads the highest band.
                let low = history.edges[history.height - 1 - y];
                let high = history.edges[history.height - y];
                let peak = band_peak(data, low, low.max(high)).round() as usize;
                history.pixels[y * history.width + history.head] = c.palette.heat[peak.min(255)];
            }
            history.head = (history.head + 1) % history.width;
        }
        // The ring stitched back into time order, newest at the right edge.
        let (dw, dh) = (s.pixmap.width() as usize, s.pixmap.height() as usize);
        let quiet = c.palette.heat[0];
        let data = s.pixmap.data_mut();
        for (y, row) in data.chunks_exact_mut(dw * 4).enumerate().take(dh) {
            if y >= history.height || dw != history.width {
                for (x, px) in row.chunks_exact_mut(4).enumerate() {
                    let from = if x < history.width && y < history.height {
                        history.pixels[y * history.width + (history.head + x) % history.width]
                    } else {
                        quiet
                    };
                    px.copy_from_slice(&from);
                }
                continue;
            }
            let line = &history.pixels[y * history.width..(y + 1) * history.width];
            let (older, newer) = (&line[history.head..], &line[..history.head]);
            for (px, from) in row.chunks_exact_mut(4).zip(older.iter().chain(newer)) {
                px.copy_from_slice(from);
            }
        }
    }

    fn clear(&mut self, c: &Ctx) {
        if let Some(history) = self.history.as_mut() {
            history.pixels.iter_mut().for_each(|p| *p = c.palette.heat[0]);
            history.head = 0;
        }
    }
}

/* ------------------------------------------------------------------ frequency bars */

#[derive(Default)]
struct Spectrum {
    edges: Vec<f32>,
    peaks: Vec<f32>,
    holds: Vec<f32>,
    bands: Vec<u8>,
    count: usize,
}

impl Spectrum {
    fn resize(&mut self, s: &Surface, c: &Ctx) {
        // ~2.5px per bar.
        let count = (s.w / 2.5).round().clamp(24.0, 192.0) as usize;
        if count == self.count {
            return;
        }
        *self = Spectrum {
            edges: log_bin_edges(count, c.analysis.bins(), c.analysis.rate),
            peaks: vec![0.0; count],
            holds: vec![0.0; count],
            bands: vec![0; count],
            count,
        };
    }

    fn draw(&mut self, s: &mut Surface, active: bool, c: &Ctx) {
        s.clear();
        if self.count == 0 {
            return;
        }
        let (w, h, tf) = (s.w, s.h, s.transform());
        let zero = SPECTRUM_RANGE_DB / (SPECTRUM_RANGE_DB + c.headroom);
        let silent = vec![0u8; c.analysis.bins()];
        let data: &[u8] = if active { &c.analysis.fine_bytes } else { &silent };
        let slot = w / self.count as f32;
        let bar = (slot - (slot * 0.4).min(1.0)).max(0.75);
        let bands = &c.palette.bands;
        let hottest = bands.len() - 1;
        for i in 0..self.count {
            let from = self.edges[i];
            let value = band_peak(data, from, from.max(self.edges[i + 1] - 1.0)) / 255.0 * zero;
            self.peaks[i] = value;
            self.bands[i] = ((value * bands.len() as f32) as usize).min(hottest) as u8;
            self.holds[i] = if value >= self.holds[i] { value } else { value.max(self.holds[i] - 0.006) };
        }
        // The bars are rectangles that never touch, so each is filled with its exact edge
        // coverage - the pixels an anti-aliased path fill gives, for a fraction of the work.
        let scale = s.scale;
        for i in 0..self.count {
            let height = (self.peaks[i] * h).max(1.0);
            let color = bands[self.bands[i] as usize];
            fill_rect_exact(&mut s.pixmap, [i as f32 * slot * scale, (h - height) * scale, bar * scale, height * scale], color);
        }
        let mut pm = s.pixmap.as_mut();
        // The decay line: the shape of the spectrum a moment ago.
        let mut line = PathBuilder::new();
        for i in 0..self.count {
            let (x, y) = (i as f32 * slot + bar / 2.0, (h - self.holds[i] * h).max(0.5));
            if i == 0 { line.move_to(x, y) } else { line.line_to(x, y) }
        }
        stroke(&mut pm, line, c.palette.foreground.alpha(0.5), 1.0, tf);
    }

    fn clear(&mut self) {
        self.peaks.iter_mut().for_each(|v| *v = 0.0);
        self.holds.iter_mut().for_each(|v| *v = 0.0);
    }
}

/* ------------------------------------------------------------------ oscilloscope */

fn scope(s: &mut Surface, active: bool, c: &Ctx) {
    s.clear();
    let (w, h, tf) = (s.w, s.h, s.transform());
    let mut pm = s.pixmap.as_mut();
    let mid = h / 2.0;
    fill(&mut pm, [0.0, mid.round(), w, 1.0], c.palette.border, tf);
    let size = FFT_SIZE;
    let flat = [128u8; FFT_SIZE];
    let data: &[u8] = if active { &c.analysis.mono_bytes } else { &flat };
    // Trigger on a rising zero crossing so the trace stands still.
    let span = size >> 1;
    let start = (1..span).find(|&i| data[i - 1] < 128 && data[i] >= 128).unwrap_or(0);
    let points = (w.floor() as usize).clamp(2, span);
    let step = span as f32 / points as f32;
    let ramp = &c.palette.wave;
    // Coloured by distance from the centre line, stroked in runs of one colour.
    // Each colour's runs are subpaths of one path, stroked once.
    let mut runs: Vec<PathBuilder> = (0..ramp.len()).map(|_| PathBuilder::new()).collect();
    let mut index = 0;
    let mut previous = (0.0, mid);
    for i in 0..points {
        let sample = data[start + (i as f32 * step).floor() as usize] as f32;
        let unit = ((sample - 128.0).abs() / 128.0).min(1.0);
        let y = mid - ((sample - 128.0) / 128.0) * (mid - 1.0);
        let x = (i as f32 / (points - 1) as f32) * w;
        let next = ((unit * ramp.len() as f32).floor() as usize).min(ramp.len() - 1);
        if i == 0 {
            index = next;
            runs[index].move_to(x, y);
        } else if next == index {
            runs[index].line_to(x, y);
        } else {
            // Close the run through this point so the colours meet.
            runs[index].line_to(x, y);
            index = next;
            runs[index].move_to(previous.0, previous.1);
            runs[index].line_to(x, y);
        }
        previous = (x, y);
    }
    for (pb, color) in runs.into_iter().zip(ramp) {
        stroke(&mut pm, pb, *color, 1.25, tf);
    }
}

/* ------------------------------------------------------------------ rolling waveform */

#[derive(Default)]
struct Rolling {
    min: Vec<f32>,
    max: Vec<f32>,
    tone: Vec<f32>,
    head: usize,
    columns: usize,
    /// The frame clock when the last column was written; 0 is "nothing yet".
    last_time: f64,
    carry: f32,
}

impl Rolling {
    fn resize(&mut self, s: &Surface) {
        // One column per device pixel.
        let columns = ((s.w * s.scale).round() as usize).max(1);
        if columns == self.columns {
            return;
        }
        let mut next = Rolling { min: vec![0.0; columns], max: vec![0.0; columns], tone: vec![0.0; columns], head: 0, columns, last_time: self.last_time, carry: 0.0 };
        if self.columns > 0 {
            for x in 0..columns {
                let from = (self.head + (x * self.columns) / columns) % self.columns;
                next.min[x] = self.min[from];
                next.max[x] = self.max[from];
                next.tone[x] = self.tone[from];
            }
        }
        *self = next;
    }

    fn draw(&mut self, s: &mut Surface, active: bool, c: &Ctx) {
        s.clear();
        let (w, h, ratio) = (s.w, s.h, s.scale);
        let mut pm = s.pixmap.as_mut();
        let step = 1.0 / ratio;
        let mid = h / 2.0;
        let tf = Transform::from_scale(ratio, ratio);
        fill(&mut pm, [0.0, (mid * ratio).round() * step, w, step], c.palette.border, tf);
        if self.columns == 0 {
            return;
        }
        if active {
            let data = &c.analysis.mono;
            let size = data.len();
            let rate = c.analysis.rate;
            let per_column = rate / COLUMNS_PER_SECOND;
            let elapsed = if self.last_time == 0.0 { 1000.0 / 60.0 } else { c.time - self.last_time };
            self.carry += (elapsed.max(0.0) / 1000.0) as f32 * rate;
            let mut count = (self.carry / per_column).floor() as usize;
            let available = (size as f32 / per_column).floor() as usize;
            if count >= available {
                count = available;
                self.carry = 0.0;
            } else {
                self.carry -= count as f32 * per_column;
            }
            for col in 0..count {
                let from = (size as f32 - ((count - col) as f32 * per_column).round()) as isize;
                let to = (size as f32 - ((count - col - 1) as f32 * per_column).round()) as usize;
                let envelope_from = (from - ((ENVELOPE_OVERLAP - 1.0) * per_column).round() as isize).max(0) as usize;
                let (mut low, mut high) = (0.0f32, 0.0f32);
                for &sample in &data[envelope_from..to] {
                    if sample < low {
                        low = sample;
                    } else if sample > high {
                        high = sample;
                    }
                }
                let window_start = (from as f32 - TONE_WINDOW_COLUMNS * per_column).max(0.0).floor() as usize;
                let mut crossings = 0;
                let mut previous = data[window_start];
                for &sample in &data[window_start + 1..to] {
                    if (sample < 0.0) != (previous < 0.0) {
                        crossings += 1;
                    }
                    previous = sample;
                }
                self.min[self.head] = low;
                self.max[self.head] = high;
                self.tone[self.head] = brightness_of(crossings, to - window_start, rate);
                self.head = (self.head + 1) % self.columns;
            }
        }
        self.last_time = c.time;

        // Oldest at the left, newest at the right. Every edge is on the device grid, so the
        // columns are written straight into the bitmap rather than filled one by one.
        let scale = mid - 1.0;
        drop(pm);
        let (pw, ph) = (s.pixmap.width() as usize, s.pixmap.height() as i32);
        let data = s.pixmap.data_mut();
        for x in 0..self.columns.min(pw) {
            let index = (self.head + x) % self.columns;
            let (low, high) = (self.min[index], self.max[index]);
            if low == 0.0 && high == 0.0 {
                continue;
            }
            let color = if c.ramp {
                let ramp = &c.palette.wave;
                ramp[((self.tone[index] * ramp.len() as f32).floor() as usize).min(ramp.len() - 1)]
            } else {
                c.palette.primary
            };
            let alpha = OLDEST_ALPHA + (1.0 - OLDEST_ALPHA) * (x as f32 / self.columns as f32);
            let top = ((mid - high * scale) * ratio).round() as i32;
            let bottom = ((mid - low * scale) * ratio).round() as i32;
            let [r, g, b, a] = color.alpha(alpha).to_u8();
            // Premultiplied, as the canvas holds it.
            let pre = |v: u8| (v as u32 * a as u32 + 127) / 255;
            let (r, g, b) = (pre(r), pre(g), pre(b));
            let keep = 255 - a as u32;
            for y in top.max(0)..(top + (bottom - top).max(1)).min(ph) {
                let at = (y as usize * pw + x) * 4;
                let px = &mut data[at..at + 4];
                px[0] = (r + (px[0] as u32 * keep + 127) / 255).min(255) as u8;
                px[1] = (g + (px[1] as u32 * keep + 127) / 255).min(255) as u8;
                px[2] = (b + (px[2] as u32 * keep + 127) / 255).min(255) as u8;
                px[3] = (a as u32 + (px[3] as u32 * keep + 127) / 255).min(255) as u8;
            }
        }
    }

    fn clear(&mut self) {
        self.min.iter_mut().for_each(|v| *v = 0.0);
        self.max.iter_mut().for_each(|v| *v = 0.0);
        self.tone.iter_mut().for_each(|v| *v = 0.0);
        self.head = 0;
        self.last_time = 0.0;
        self.carry = 0.0;
    }
}

/* ------------------------------------------------------------------ level meter */

#[derive(Default, Clone, Copy)]
struct Hold {
    value: f32,
    at: f64,
}

/// Peak hold: snap up instantly, sit for a beat, then fall at a readable rate.
fn update_hold(hold: &mut Hold, unit: f32, now: f64) -> f32 {
    if unit >= hold.value {
        hold.value = unit;
        hold.at = now;
    } else if now - hold.at > 800.0 {
        hold.value = unit.max(hold.value - 0.008);
    }
    hold.value
}

#[derive(Default)]
struct Levels {
    holds: [Hold; 2],
    readout: Option<f32>,
}

impl Levels {
    /// Horizontal, as the stacked panel lays it out: the bars grow left to right.
    fn draw(&mut self, s: &mut Surface, active: bool, c: &Ctx) {
        s.clear();
        let (w, h, tf) = (s.w, s.h, s.transform());
        let mut pm = s.pixmap.as_mut();
        let range = 60.0 + c.headroom;
        let zero = 60.0 / range;
        let p = c.palette;
        let bar = ((h - 10.0) / 2.0 - 2.0).clamp(4.0, 20.0);
        let gap = 3.0;
        let start = (h - (bar * 2.0 + gap)) / 2.0;
        let length = w;
        let thickness = bar * 2.0 + gap;
        for db in TICKS_DB {
            let at = (((db + 60.0) / range) * (length - 1.0)).round();
            fill(&mut pm, [at, start, 1.0, thickness], p.muted.alpha(0.22), tf);
        }
        // The ramp along the meter's length, whole.
        let stops: Vec<GradientStop> =
            p.wave.iter().enumerate().map(|(i, c)| GradientStop::new(i as f32 / (p.wave.len() - 1) as f32, c.skia())).collect();
        let shader = LinearGradient::new(Point::from_xy(0.0, 0.0), Point::from_xy(w, 0.0), stops, SpreadMode::Pad, Transform::identity());
        let mut peaks = [0.0f32; 2];
        for channel in 0..2 {
            let samples: &[f32] = if !active {
                &[]
            } else if channel == 0 {
                &c.analysis.left
            } else {
                &c.analysis.right
            };
            let (mut sum, mut peak) = (0.0f32, 0.0f32);
            for &v in samples {
                sum += v * v;
                peak = peak.max(v.abs());
            }
            let rms = if samples.is_empty() { 0.0 } else { to_unit_db((sum / samples.len() as f32).sqrt()) * zero };
            let held = update_hold(&mut self.holds[channel], if samples.is_empty() { 0.0 } else { to_unit_db(peak) * zero }, c.time);
            let offset = start + channel as f32 * (bar + gap);
            fill(&mut pm, [0.0, offset, length, bar], p.border.alpha(0.5), tf);
            if let (Some(shader), Some(r)) = (shader.clone(), Rect::from_xywh(0.0, offset, rms * length, bar)) {
                let paint = Paint { shader, anti_alias: true, ..Paint::default() };
                pm.fill_rect(r, &paint, tf, None);
            }
            if held > 0.01 {
                let color = if held >= zero - 0.002 { p.hot } else { p.foreground };
                let at = (length - 2.0).min(held * length);
                fill(&mut pm, [at, offset, 2.0, bar], color, tf);
            }
            peaks[channel] = peak;
        }
        let loudest = peaks[0].max(peaks[1]);
        self.readout = if loudest > 0.0 { Some((20.0 * loudest.log10()).min(0.0)) } else { None };
    }

    fn clear(&mut self) {
        self.holds = [Hold::default(); 2];
    }
}

/* ------------------------------------------------------------------ stereo field */

/// Arc mode: the half circle of dots, angle for where a pair sits between the speakers and
/// radius for how loud. The canvas is never cleared while playing - each frame fades the last.
fn stereo(s: &mut Surface, active: bool, c: &Ctx) {
    let (w, h, tf) = (s.w, s.h, s.transform());
    let p = c.palette;
    let strip = 3.0;
    let plot = (h - strip - 4.0).max(1.0);
    if active {
        // Phosphor decay: `destination-out` at 0.12, which in 8 bits is a multiply by 224/255.
        for v in s.pixmap.data_mut() {
            *v = ((*v as u32 * 224 + 127) / 255) as u8;
        }
    } else {
        s.clear();
    }
    let mut pm = s.pixmap.as_mut();
    let (cx, cy) = (w / 2.0, plot - 1.0);
    let r = (cx - 2.0).min(plot - 2.0).max(4.0);
    // The half circle from the left end over the top, its diameter, and the centre tick.
    let k = 0.552_284_8 * r;
    let mut pb = PathBuilder::new();
    pb.move_to(cx - r, cy);
    pb.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
    pb.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
    pb.move_to(cx - r, cy);
    pb.line_to(cx + r, cy);
    pb.move_to(cx, cy - r);
    pb.line_to(cx, cy - r * 0.82);
    stroke(&mut pm, pb, p.muted.alpha(0.5), 1.0, tf);
    if !active {
        return;
    }

    let (left, right) = (&c.analysis.left, &c.analysis.right);
    let step = (FFT_SIZE / TRACE_POINTS).max(1);
    let mut dots: Vec<(f32, f32, usize)> = Vec::with_capacity(FFT_SIZE / step + 1);
    let (mut correlation, mut energy_l, mut energy_r) = (0.0f32, 0.0f32, 0.0f32);
    let bands = &p.bands;
    for i in (0..FFT_SIZE).step_by(step) {
        let (l, rr) = (left[i], right[i]);
        correlation += l * rr;
        energy_l += l * l;
        energy_r += rr * rr;
        let magnitude = (l * l + rr * rr).sqrt();
        if magnitude < 0.002 {
            continue;
        }
        let pan = rr.abs().atan2(l.abs()) / std::f32::consts::FRAC_PI_2;
        let angle = std::f32::consts::PI * (1.0 - pan);
        let reach = r * to_unit_db(magnitude);
        let band = (((pan - 0.5).abs() * 2.0 * bands.len() as f32) as usize).min(bands.len() - 1);
        dots.push((cx + angle.cos() * reach, cy - angle.sin() * reach, band));
    }
    // A fill per colour band, additive so a dense cluster reads as bright.
    for (band, color) in bands.iter().enumerate() {
        let mut pb = PathBuilder::new();
        let mut drew = false;
        for &(x, y, _) in dots.iter().filter(|d| d.2 == band) {
            if let Some(rect) = Rect::from_xywh(x - DOT / 2.0, y - DOT / 2.0, DOT, DOT) {
                pb.push_rect(rect);
                drew = true;
            }
        }
        if drew {
            let mut paint = paint_of(*color);
            paint.blend_mode = BlendMode::Plus;
            fill_path(&mut pm, pb, &paint, tf);
        }
    }
    // Correlation along the bottom: right of centre is mono-compatible, left is trouble.
    let denominator = (energy_l * energy_r).sqrt();
    let phase = if denominator > 1e-9 { correlation / denominator } else { 0.0 };
    let y = h - strip;
    fill(&mut pm, [0.0, y, w, strip], p.border.alpha(0.5), tf);
    let from = cx.min(cx + phase * cx);
    fill(&mut pm, [from, y, phase.abs() * cx, strip], if phase < 0.0 { p.hot } else { p.primary }, tf);
    fill(&mut pm, [cx.round(), y - 1.0, 1.0, strip + 2.0], p.muted, tf);
}

/* ------------------------------------------------------------------ layout */

fn style(size: f32, weight: u16, color: Rgba) -> TextStyle {
    TextStyle { size, line_height: size * 1.5, weight, color, tabular: false, tracking: 0.0, grayscale: false, italic: false, font: crate::ui::text::Font::Sans }
}

/// `width` is the panel's, `grip` the colour of the handle on its left edge, and `glow` the
/// full-height line that handle shows while hovered or dragged.
pub fn panel(t: &Theme, visuals: &Rc<RefCell<Visuals>>, panel_height: f32, width: f32, grip_color: Rgba, glow: Option<Rgba>) -> El<Action> {
    let control = |name: &'static str| {
        div().size(24.0, 24.0).items_center().justify_center().rounded(4.0).hover_bg(t.accent).child(icon(name, 14.0, t.muted_foreground))
    };
    col()
        .w(width)
        .shrink0()
        .bg(t.card.alpha(0.3))
        .border_l(t.border)
        .child(
            div()
                .h(30.0)
                .shrink0()
                .items_center()
                .pl(10.0)
                .pr(10.0)
                .gap(2.0)
                .border_b(t.border)
                .child(text("Visualizers", style(10.5, 500, t.muted_foreground)))
                .child(control("music").ml_auto())
                // The panel's own close: the title bar's panel toggle, from this side.
                .child(control("x").on(Action::Tool("panel"))),
        )
        .child(stack(t, visuals, false))
        // The handle the panel is resized by, centred on its left edge: a 3px line the
        // panel's height while it is in play, and the grip over it.
        .maybe(glow.is_some(), |el| el.child(div().absolute(0.0, 0.0).w(3.0).h(panel_height).rounded(1.5).bg(glow.unwrap_or(grip_color))))
        .child(grip(grip_color, panel_height))
}

/// `VisualizerStack`: the panels in a column, each a weighted share of the height - or side by
/// side on the stage, sharing the width with their minimums turned sideways (`* 1.6`).
pub fn stack(t: &Theme, visuals: &Rc<RefCell<Visuals>>, horizontal: bool) -> El<Action> {
    let readout = visuals.borrow().readout();
    let plot = |index: usize| canvas(visuals.clone(), index);
    let s = |name: &str, grow: f32, min: f32, controls: Option<El<Action>>, index: usize, over: Option<El<Action>>| {
        let mut el = section(t, name, grow, min, controls, plot(index), over);
        if horizontal {
            el.style.min_size.height = taffy::prelude::auto();
            el.style.min_size.width = taffy::prelude::length(min * 1.6);
        }
        el
    };
    let base = if horizontal { div().grow().min_w(0.0).min_h0() } else { col().grow().min_h0() };
    base.gap(4.0)
        .child(s("Spectrogram", 1.6, 64.0, None, SPECTROGRAM, None))
        .child(s("Spectrum", 1.0, 56.0, None, SPECTRUM, None))
        .child(s("Waveform", 1.0, 56.0, None, WAVE, None))
        .child(s("Scope", 1.0, 56.0, None, SCOPE, None))
        .child(s("Levels", 0.35, 44.0, None, LEVELS, Some(peak_readout(t, &visuals.borrow().palette, readout))))
        .child(s("Stereo field", 1.1, 72.0, Some(toggle(t, "Arc")), STEREO, None))
}

/// Placed by arithmetic rather than `top: 50%`: in this taffy an absolutely positioned box
/// resolves percentages and opposing insets against the window, not its parent. Its left
/// edge is the panel's border, which is where taffy measures insets from.
fn grip(color: Rgba, panel_height: f32) -> El<Action> {
    div().absolute(0.0, ((panel_height - 28.0) / 2.0).max(0.0)).w(3.0).h(28.0).rounded(1.5).bg(color)
}

/// `Panel`: a rounded card with a 17px header - the name, and any switches beside the hide
/// button, which is there but invisible until the section is hovered. The plot is live: it is
/// repainted on its own every animation frame, with whatever is drawn over it.
fn section(t: &Theme, name: &str, grow: f32, min_height: f32, controls: Option<El<Action>>, plot: Painter, over: Option<El<Action>>) -> El<Action> {
    let label = TextStyle { tracking: 0.09, ..style(9.5, 500, t.muted_foreground.alpha(0.7)) };
    let mut header = div().h(17.0).shrink0().items_center().justify_between().pl(8.0).pr(2.0).child(text(name.to_string(), label));
    let mut right = div().items_center().gap(2.0);
    if let Some(controls) = controls {
        right = right.child(controls);
    }
    header = header.child(right.child(div().size(16.0, 16.0)));
    let mut el = col()
        .min_h0()
        .rounded(6.0)
        .bg(t.card.alpha(0.5))
        .clip()
        .child(header)
        .child(paint(plot).grow().w_full().live().maybe(over.is_some(), |el| el.children(over)));
    // A weighted share of the stack, as `VISUALIZERS` gives each panel.
    el.style.flex_grow = grow;
    el.style.flex_basis = taffy::prelude::length(0.0);
    el.style.min_size.height = taffy::prelude::length(min_height);
    el
}

/// `PanelToggle`: a quiet text switch in the header.
fn toggle(t: &Theme, label: &str) -> El<Action> {
    let style = TextStyle { tracking: 0.08, line_height: 13.5, ..style(9.0, 500, t.muted_foreground.alpha(0.5)) };
    div().h(16.0).items_center().px(4.0).rounded(4.0).hover_bg(t.accent).child(text(label.to_string(), style))
}

/// The peak readout over the meter, in dBFS: `−∞ dB` in silence, one decimal above -10dB, and
/// the hot colour once it reaches full scale. Canvas text, so grayscale; `textBaseline = 'top'`
/// at y 2. Chromium measures 'top' with the font's typographic ascent (Segoe UI's
/// sTypoAscender, 1567 of 2048 units), not the ascent a line box uses - so the baseline is
/// 7.65px below y, where a line box would put it 11px below its top.
fn peak_readout(t: &Theme, p: &Palette, db: Option<f32>) -> El<Action> {
    let (label, color) = match db {
        None => ("−∞ dB".to_string(), t.foreground.alpha(0.35)),
        Some(db) => {
            let label = if db > -10.0 { format!("{db:.1} dB") } else { format!("{} dB", db.round() as i32) };
            (label, if db >= -0.1 { p.hot } else { t.foreground }.alpha(0.9))
        }
    };
    let style = TextStyle { line_height: 14.0, grayscale: true, ..style(10.0, 400, color) };
    let shift = 2.0 + 10.0 * 1567.0 / 2048.0 - 11.0;
    div().grow().justify_end().items_start().pr(3.0).child(text(label, style).mt(shift))
}

/// Places slot `index`'s canvas: fits it to the box (which draws it at rest the first time),
/// then composites what it holds, with the section's rounded bottom corners cut out.
fn canvas(visuals: Rc<RefCell<Visuals>>, index: usize) -> Painter {
    Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        let (w, h) = (((r[2] - r[0]) / scale).floor().max(1.0), ((r[3] - r[1]) / scale).floor().max(1.0));
        let mut v = visuals.borrow_mut();
        v.fit(index, w, h, scale);
        let Some(surface) = v.slots[index].surface.as_ref() else { return };
        let (x, y) = (r[0].round(), r[1].round());
        composite(pm, &surface.pixmap, (x as i32, y as i32), r[3] - y, r[2] - x, 6.0 * scale);
    })
}

/// Source-over of `src` onto `pm` at `at`, with what falls outside the rounded corners at
/// `bottom` (in the bitmap's pixels) cut away by its coverage - in one pass, every frame.
fn composite(pm: &mut PixmapMut, src: &Pixmap, at: (i32, i32), bottom: f32, right: f32, radius: f32) {
    let (tw, th) = (pm.width() as i32, pm.height() as i32);
    let (sw, sh) = (src.width() as i32, src.height() as i32);
    let corner_top = ((bottom - radius).floor() as i32).max(0);
    let corners = [(radius, bottom - radius), (right - radius, bottom - radius)];
    let data = pm.data_mut();
    let source = src.data();
    for y in 0..sh {
        let ty = at.1 + y;
        if ty < 0 || ty >= th {
            continue;
        }
        let x0 = (-at.0).max(0);
        let x1 = sw.min(tw - at.0);
        if x1 <= x0 {
            continue;
        }
        let srow = &source[((y * sw + x0) * 4) as usize..((y * sw + x1) * 4) as usize];
        let drow = &mut data[((ty * tw + at.0 + x0) * 4) as usize..((ty * tw + at.0 + x1) * 4) as usize];
        for (i, (d, s)) in drow.chunks_exact_mut(4).zip(srow.chunks_exact(4)).enumerate() {
            let x = x0 + i as i32;
            let mut coverage = 16u32;
            if y >= corner_top && ((x as f32) < radius || (x as f32 + 1.0) > right - radius) {
                coverage = corner_coverage(x, y, radius, corners);
            }
            let a = s[3] as u32 * coverage / 16;
            if a == 0 {
                continue;
            }
            for c in 0..4 {
                let sc = s[c] as u32 * coverage / 16;
                d[c] = (sc + (d[c] as u32 * (255 - a) + 127) / 255).min(255) as u8;
            }
        }
    }
}

/// How much of pixel (x, y) the corner's circle covers, in sixteenths, from a 4x4 grid.
fn corner_coverage(x: i32, y: i32, radius: f32, corners: [(f32, f32); 2]) -> u32 {
    let left = (x as f32) < radius;
    let (cx, cy) = if left { corners[0] } else { corners[1] };
    let mut inside = 0;
    for sy in 0..4 {
        for sx in 0..4 {
            let (px, py) = (x as f32 + (sx as f32 + 0.5) / 4.0, y as f32 + (sy as f32 + 0.5) / 4.0);
            let outside_corner = if left { px < cx } else { px > cx };
            if py <= cy || !outside_corner || (px - cx).powi(2) + (py - cy).powi(2) <= radius * radius {
                inside += 1;
            }
        }
    }
    inside
}
