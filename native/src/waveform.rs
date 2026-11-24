//! The transport's waveform: `Waveform.tsx` and the peaks format of `peaks-core.ts`.
//!
//! Peaks are 1,024 buckets of three bytes - floor, ceiling and where the bucket's energy sits
//! - worked out on a thread of their own from a full decode, as `peaks.worker.ts` does. The
//! decode streams: a long mix is never held as samples, only the bucket it is filling. A
//! short file, whose tone estimate reaches past its own bucket, is held whole, since it is
//! small by definition.
//!
//! On screen it is two pre-rendered shapes, the played part and the rest, blitted either side
//! of the playhead every frame - the same two blits the Electron canvas does.

use crate::ui::color::Rgba;
use crate::visualizers::{Palette, brightness_of};
use resvg::tiny_skia::{Paint, Pixmap, PixmapMut, Rect, Transform};
use rodio::Source;
use std::cell::RefCell;
use std::rc::Rc;

pub const BUCKETS: usize = 1024;
pub const STRIDE: usize = 3;
/// Samples the tone estimate is measured over, whatever a bucket is worth.
const TONE_WINDOW: usize = 2048;
/// Decoding a giant is not worth it for a picture.
const MAX_DECODE_BYTES: u64 = 300 * 1024 * 1024;
/// Below this many frames the file is decoded into memory and bucketed exactly as the worker
/// does; above it, buckets are at least `TONE_WINDOW` wide and can be filled as they stream.
const HOLD_WHOLE: usize = 4_000_000;

/// Decodes `path` and folds it into peaks. `duration` is the probe's length, used to size the
/// buckets ahead of the decode when the container does not say.
pub fn peaks(path: &str, duration: Option<f64>) -> Option<Vec<u8>> {
    // Another machine has usually drawn it already; fetching the file to draw it again is the
    // transfer the index exists to avoid.
    if crate::remote::is_remote(path) {
        if let Some(peaks) = crate::remote::peaks(path).filter(|p| p.len() >= BUCKETS * STRIDE) {
            return Some(peaks);
        }
    }
    // With the byte length known, which MP3 needs for a duration.
    let decoder = crate::remote::decoder_limited(path, MAX_DECODE_BYTES).ok()?;
    let channels = decoder.channels().get() as usize;
    let rate = decoder.sample_rate().get() as f32;
    let seconds = decoder.total_duration().map(|d| d.as_secs_f64()).or(duration);
    let estimate = seconds.map(|s| (s * rate as f64).round() as usize);

    // Mono, as `downmix` makes it: the channels averaged.
    let mut frames = decoder.map(|s| s as f32);
    let mut next_frame = move || {
        let mut sum = 0.0;
        for c in 0..channels {
            sum += frames.next()?;
            let _ = c;
        }
        Some(sum / channels as f32)
    };

    match estimate {
        Some(estimate) if estimate > HOLD_WHOLE => Some(streamed(&mut next_frame, estimate, rate)),
        _ => {
            let mut signal = Vec::new();
            while let Some(v) = next_frame() {
                signal.push(v);
                if signal.len() > 64_000_000 {
                    return None;
                }
            }
            Some(build(&signal, rate))
        }
    }
}

fn quantise(min: f32, max: f32, brightness: f32, out: &mut [u8]) {
    out[0] = ((min.max(-1.0) + 1.0) * 127.5).round() as u8;
    out[1] = ((max.min(1.0) + 1.0) * 127.5).round() as u8;
    out[2] = (brightness * 255.0).round() as u8;
}

/// `buildPeaks`, over a signal held whole.
fn build(signal: &[f32], rate: f32) -> Vec<u8> {
    let mut peaks = vec![0u8; BUCKETS * STRIDE];
    let per = (signal.len() / BUCKETS).max(1);
    for bucket in 0..BUCKETS {
        let start = bucket * per;
        let end = (start + per).min(signal.len());
        let (mut min, mut max) = (0.0f32, 0.0f32);
        for &v in signal.get(start..end).unwrap_or(&[]) {
            if v < min {
                min = v;
            } else if v > max {
                max = v;
            }
        }
        let tone_end = signal.len().min(end.max(start + TONE_WINDOW));
        let mut crossings = 0;
        let mut previous = signal.get(start).copied().unwrap_or(0.0);
        for &v in signal.get(start + 1..tone_end).unwrap_or(&[]) {
            if (v < 0.0) != (previous < 0.0) {
                crossings += 1;
            }
            previous = v;
        }
        let brightness = brightness_of(crossings, tone_end.saturating_sub(start), rate);
        quantise(min, max, brightness, &mut peaks[bucket * STRIDE..]);
    }
    peaks
}

/// The same buckets filled as the samples arrive, sized from the expected length. Samples past
/// the last bucket are dropped, as `buildPeaks` drops the remainder of an uneven division.
fn streamed(next: &mut impl FnMut() -> Option<f32>, estimate: usize, rate: f32) -> Vec<u8> {
    let mut peaks = vec![0u8; BUCKETS * STRIDE];
    for bucket in peaks.chunks_mut(STRIDE) {
        quantise(0.0, 0.0, 0.0, bucket);
    }
    let per = (estimate / BUCKETS).max(1);
    'buckets: for bucket in 0..BUCKETS {
        let (mut min, mut max, mut crossings, mut count) = (0.0f32, 0.0f32, 0usize, 0usize);
        let mut previous = 0.0f32;
        while count < per {
            let Some(v) = next() else {
                if count > 0 {
                    quantise(min, max, brightness_of(crossings, count, rate), &mut peaks[bucket * STRIDE..]);
                }
                break 'buckets;
            };
            if v < min {
                min = v;
            } else if v > max {
                max = v;
            }
            if count > 0 && (v < 0.0) != (previous < 0.0) {
                crossings += 1;
            }
            previous = v;
            count += 1;
        }
        quantise(min, max, brightness_of(crossings, count, rate), &mut peaks[bucket * STRIDE..]);
    }
    peaks
}

/* ------------------------------------------------------------------ on screen */

#[derive(Clone, Copy, PartialEq)]
pub enum Status {
    Loading,
    Ready,
    Unavailable,
}

/// The playing track's waveform as the transport draws it.
pub struct Wave {
    pub status: Status,
    pub peaks: Option<Vec<u8>>,
    /// 0..1 through the track, and whether there is a length to divide by at all.
    pub progress: f32,
    pub has_duration: bool,
    /// The loop region, as fractions of the track: drawn over the shape, outside it pushed back.
    pub region: Option<(f32, f32)>,
    shape: Option<Shape>,
}

/// Both tints, pre-rendered at the box's size.
struct Shape {
    w: u32,
    h: u32,
    scale: f32,
    played: Pixmap,
    rest: Pixmap,
}

impl Wave {
    pub fn new() -> Wave {
        Wave { status: Status::Loading, peaks: None, progress: 0.0, has_duration: false, region: None, shape: None }
    }

    pub fn set_peaks(&mut self, peaks: Option<Vec<u8>>) {
        self.status = if peaks.is_some() { Status::Ready } else { Status::Unavailable };
        self.peaks = peaks;
        self.shape = None;
    }
}

/// `renderShape`: one column per CSS pixel, its bucket's floor to ceiling, coloured by where
/// its energy sits when the waveform takes the ramp.
fn render_shape(peaks: &[u8], w: u32, h: u32, scale: f32, color: Rgba, alpha: f32, ramp: Option<&[Rgba]>) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(((w as f32 * scale).floor() as u32).max(1), ((h as f32 * scale).floor() as u32).max(1))?;
    let buckets = peaks.len() / STRIDE;
    let mid = h as f32 / 2.0;
    let tf = Transform::from_scale(scale, scale);
    let mut pm = pixmap.as_mut();
    for x in 0..w {
        let bucket = (((x as f32 / w as f32) * buckets as f32).floor() as usize).min(buckets - 1);
        let min = peaks[bucket * STRIDE] as f32 / 127.5 - 1.0;
        let max = peaks[bucket * STRIDE + 1] as f32 / 127.5 - 1.0;
        let fill = match ramp {
            Some(ramp) => {
                let t = peaks[bucket * STRIDE + 2] as f32 / 255.0;
                ramp[((t * ramp.len() as f32).floor() as usize).min(ramp.len() - 1)]
            }
            None => color,
        };
        let (top, bottom) = (mid - max * mid, mid - min * mid);
        if let Some(r) = Rect::from_xywh(x as f32, top, 1.0, (bottom - top).max(1.0)) {
            let mut paint = Paint::default();
            paint.set_color(fill.alpha(alpha).skia());
            paint.anti_alias = true;
            pm.fill_rect(r, &paint, tf, None);
        }
    }
    Some(pixmap)
}

/// Source-over of columns `from..to` of `src` onto `pm` at `at`.
fn blit_columns(pm: &mut PixmapMut, src: &Pixmap, at: (i32, i32), from: u32, to: u32) {
    let (tw, th) = (pm.width() as i32, pm.height() as i32);
    let sw = src.width() as i32;
    let data = pm.data_mut();
    let source = src.data();
    for y in 0..src.height() as i32 {
        let ty = at.1 + y;
        if ty < 0 || ty >= th {
            continue;
        }
        for x in from as i32..(to as i32).min(sw) {
            let tx = at.0 + x;
            if tx < 0 || tx >= tw {
                continue;
            }
            let s = ((y * sw + x) * 4) as usize;
            let a = source[s + 3] as u32;
            if a == 0 {
                continue;
            }
            let d = ((ty * tw + tx) * 4) as usize;
            for c in 0..4 {
                data[d + c] = (source[s + c] as u32 + (data[d + c] as u32 * (255 - a) + 127) / 255).min(255) as u8;
            }
        }
    }
}

/// The waveform's painter: the played part up to the playhead, the rest after it at 45%, and
/// the playhead itself - or, with no peaks, a slim progress track.
pub fn painter(wave: Rc<RefCell<Wave>>, palette: Palette, ramp: bool, played: Rgba, rest: Rgba, dim: Rgba) -> crate::ui::tree::Painter {
    Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        let mut wave = wave.borrow_mut();
        let (w, h) = (((r[2] - r[0]) / scale).floor().max(1.0) as u32, ((r[3] - r[1]) / scale).floor().max(1.0) as u32);
        let stale = wave.shape.as_ref().is_none_or(|s| s.w != w || s.h != h || s.scale != scale);
        if stale {
            wave.shape = wave.peaks.as_ref().and_then(|peaks| {
                let ramp = ramp.then_some(palette.wave.as_slice());
                Some(Shape {
                    w,
                    h,
                    scale,
                    played: render_shape(peaks, w, h, scale, played, 1.0, ramp)?,
                    rest: render_shape(peaks, w, h, scale, rest, 0.45, ramp)?,
                })
            });
        }
        let (x, y) = (r[0].round(), r[1].round());
        let tf = Transform::from_row(scale, 0.0, 0.0, scale, x, y);
        let played_x = (wave.progress * w as f32).round();
        let mid = h as f32 / 2.0;
        let fill = |pm: &mut PixmapMut, rect: [f32; 4], color: Rgba| {
            if let Some(rect) = Rect::from_xywh(rect[0], rect[1], rect[2], rect[3]) {
                let mut paint = Paint::default();
                paint.set_color(color.skia());
                paint.anti_alias = true;
                pm.fill_rect(rect, &paint, tf, None);
            }
        };
        match &wave.shape {
            Some(shape) => {
                let split = (played_x * scale) as u32;
                blit_columns(pm, &shape.played, (x as i32, y as i32), 0, split);
                blit_columns(pm, &shape.rest, (x as i32, y as i32), split, shape.rest.width());
            }
            None => {
                fill(pm, [0.0, mid - 1.0, w as f32, 2.0], rest.alpha(0.25));
                fill(pm, [0.0, mid - 1.0, played_x, 2.0], played);
            }
        }
        // The loop: everything outside it pushed back rather than the inside lit up - the
        // inside is coloured by its own sound, and a wash would fight that where it is looked at
        // hardest. Its edges and their handles in the played colour.
        if let Some((a, b)) = wave.region.filter(|_| wave.has_duration) {
            let (x1, x2) = ((a * w as f32).clamp(0.0, w as f32), (b * w as f32).clamp(0.0, w as f32));
            fill(pm, [0.0, 0.0, x1, h as f32], dim.alpha(0.6));
            fill(pm, [x2, 0.0, w as f32 - x2, h as f32], dim.alpha(0.6));
            fill(pm, [x1, 0.0, 1.5, h as f32], played);
            fill(pm, [x2 - 1.5, 0.0, 1.5, h as f32], played);
            fill(pm, [x1, mid - 9.0, 5.0, 18.0], played);
            fill(pm, [x2 - 5.0, mid - 9.0, 5.0, 18.0], played);
        }
        if wave.has_duration {
            fill(pm, [played_x.min(w as f32 - 1.0), 0.0, 1.0, h as f32], played);
        }
    })
}
