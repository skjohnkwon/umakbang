//! Text, shaped by cosmic-text in the same font the Electron app draws with.
//!
//! The app's `--font-sans` resolves to Segoe UI on Windows (asked of Chromium directly with
//! `CSS.getPlatformFontsForNode`, not guessed from the stack). Only its files are loaded, plus
//! Segoe UI Symbol for the rating stars, rather than every font on the system - fontdb would
//! otherwise index a few hundred files to draw text in one family.
//!
//! Shaped lines are cached by what they say and how; a frame redraws the same few hundred
//! strings, and shaping is the expensive part.

use super::color::Rgba;
use cosmic_text::{
    Attrs, Buffer, Family, FeatureTag, FontFeatures, FontSystem, Metrics, Shaping, SwashCache, Weight, Wrap,
    fontdb,
};
use super::dwrite::{PHASES, Raster};
use resvg::tiny_skia::PixmapMut;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub struct TextStyle {
    pub size: f32,
    pub line_height: f32,
    pub weight: u16,
    pub color: Rgba,
    /// `font-variant-numeric: tabular-nums` - the `.tnum` class.
    pub tabular: bool,
    /// `letter-spacing`, in em: Tailwind's `tracking-[0.09em]` is 0.09.
    pub tracking: f32,
    /// Grayscale coverage rather than ClearType: what Chromium draws canvas text with, since a
    /// canvas with an alpha channel cannot know the colour behind it.
    pub grayscale: bool,
    pub italic: bool,
    /// Which family: Segoe UI, `font-mono` (Cascadia Mono, where Chromium resolves
    /// `ui-monospace` on Windows 11), or Arial for the contract's own page.
    pub font: Font,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Font {
    #[default]
    Sans,
    Mono,
    Arial,
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct Key {
    text: String,
    size: u32,
    line: u32,
    weight: u16,
    tabular: bool,
    tracking: u32,
    font: Font,
    italic: bool,
}

struct Shaped {
    buffer: Buffer,
    width: f32,
}

pub struct Text {
    fonts: FontSystem,
    glyphs: SwashCache,
    shaped: HashMap<Key, Shaped>,
    raster: Option<Raster>,
    blend: Blend,
    /// The family names `Font::Sans`, `Font::Mono` and `Font::Arial` resolve to here.
    families: [String; 3],
}

/// Segoe UI, Cascadia Mono and Arial, from the Windows fonts folder - only their files, not
/// every font on the system.
#[cfg(windows)]
fn load_fonts(db: &mut fontdb::Database) -> [String; 3] {
    let fonts_dir = std::env::var("WINDIR").map(|w| format!("{w}\\Fonts")).unwrap_or_else(|_| "C:\\Windows\\Fonts".into());
    // The italics too: without them an italic line is set upright, as nothing says so.
    for file in ["segoeui.ttf", "seguisb.ttf", "segoeuib.ttf", "segoeuii.ttf", "seguisbi.ttf", "segoeuiz.ttf", "seguisym.ttf", "CascadiaMono.ttf", "arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"] {
        let _ = db.load_font_file(format!("{fonts_dir}\\{file}"));
    }
    ["Segoe UI".into(), "Cascadia Mono".into(), "Arial".into()]
}

/// What Chromium resolves the same stacks to on a Mac: `system-ui` is SF Pro, `ui-monospace`
/// SF Mono, and Arial is in Supplemental. Apple Symbols carries the rating stars. The family
/// names are read back from the files, since Apple's internal names change between releases.
#[cfg(target_os = "macos")]
fn load_fonts(db: &mut fontdb::Database) -> [String; 3] {
    let sets: [(&[&str], &str); 3] = [
        (&["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/SFNSItalic.ttf"], "Helvetica Neue"),
        (&["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/SFNSMonoItalic.ttf"], "Menlo"),
        (
            &[
                "/System/Library/Fonts/Supplemental/Arial.ttf",
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
                "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
            ],
            "Helvetica",
        ),
    ];
    let mut families: [String; 3] = Default::default();
    for (slot, (files, fallback)) in sets.iter().enumerate() {
        let before = db.len();
        for file in *files {
            let _ = db.load_font_file(file);
        }
        let loaded = db.faces().skip(before).next().and_then(|f| f.families.first().map(|(name, _)| name.clone()));
        families[slot] = match loaded {
            Some(name) => name,
            None => {
                // The fallback family lives in a collection beside it.
                let file = match *fallback {
                    "Helvetica Neue" => "/System/Library/Fonts/HelveticaNeue.ttc",
                    "Menlo" => "/System/Library/Fonts/Menlo.ttc",
                    _ => "/System/Library/Fonts/Helvetica.ttc",
                };
                let _ = db.load_font_file(file);
                fallback.to_string()
            }
        };
    }
    let _ = db.load_font_file("/System/Library/Fonts/Apple Symbols.ttf");
    families
}

/// Chromium draws `font-weight: 500` in Segoe UI as Semibold: the family has no medium, and
/// DirectWrite rounds up where CSS matching would round down to Regular. Matched here, since
/// the folder names in the table are 500 and visibly heavier than the files beside them.
fn face_weight(weight: u16) -> u16 {
    match weight {
        0..=450 => 400,
        451..=650 => 600,
        _ => 700,
    }
}

impl Text {
    pub fn new() -> Text {
        let mut db = fontdb::Database::new();
        let families = load_fonts(&mut db);
        db.set_sans_serif_family(families[0].clone());
        let fonts = FontSystem::new_with_locale_and_db("en-US".into(), db);
        Text { fonts, glyphs: SwashCache::new(), shaped: HashMap::new(), raster: Raster::new(), blend: Blend::new(), families }
    }

    fn key(text: &str, style: &TextStyle) -> Key {
        Key {
            text: text.to_string(),
            size: style.size.to_bits(),
            line: style.line_height.to_bits(),
            weight: face_weight(style.weight),
            tabular: style.tabular,
            tracking: style.tracking.to_bits(),
            font: style.font,
            italic: style.italic,
        }
    }

    fn shape(&mut self, text: &str, style: &TextStyle) -> &mut Shaped {
        let key = Text::key(text, style);
        if !self.shaped.contains_key(&key) {
            // A crude bound: a window of text that changes as you scroll keeps adding entries.
            if self.shaped.len() > 4096 {
                self.shaped.clear();
            }
            let metrics = Metrics::new(style.size, style.line_height);
            let mut buffer = Buffer::new(&mut self.fonts, metrics);
            buffer.set_wrap(Wrap::None);
            buffer.set_size(None, Some(style.line_height));
            let mut features = FontFeatures::new();
            if style.tabular {
                features.enable(FeatureTag::new(b"tnum"));
            }
            let mut attrs = Attrs::new()
                .family(Family::Name(match style.font {
                    Font::Sans => &self.families[0],
                    Font::Mono => &self.families[1],
                    Font::Arial => &self.families[2],
                }))
                .style(if style.italic { cosmic_text::Style::Italic } else { cosmic_text::Style::Normal })
                .weight(Weight(face_weight(style.weight)))
                .font_features(features);
            if style.tracking != 0.0 {
                attrs = attrs.letter_spacing(style.tracking);
            }
            buffer.set_text(text, &attrs, Shaping::Advanced, None);
            buffer.shape_until_scroll(&mut self.fonts, false);
            let width = buffer.layout_runs().map(|run| run.line_w).fold(0.0, f32::max);
            self.shaped.insert(key.clone(), Shaped { buffer, width });
        }
        self.shaped.get_mut(&key).expect("just inserted")
    }

    pub fn width(&mut self, text: &str, style: &TextStyle) -> f32 {
        self.shape(text, style).width
    }

    /// The text as it fits in `max_width`: whole, or cut with an ellipsis like CSS `truncate`.
    pub fn fit(&mut self, text: &str, style: &TextStyle, max_width: f32) -> String {
        if self.width(text, style) <= max_width + 0.5 {
            return text.to_string();
        }
        let chars: Vec<char> = text.chars().collect();
        let (mut lo, mut hi) = (0usize, chars.len());
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            let candidate: String = chars[..mid].iter().collect::<String>() + "…";
            if self.width(&candidate, style) <= max_width + 0.5 { lo = mid } else { hi = mid - 1 }
        }
        chars[..lo].iter().collect::<String>() + "…"
    }

    /// Draws one line with its line box's top-left at (x, y), clipped to `clip` (x0, y0, x1, y1).
    pub fn draw(&mut self, target: &mut PixmapMut, text: &str, style: &TextStyle, x: f32, y: f32, clip: [f32; 4]) {
        let key = Text::key(text, style);
        if !self.shaped.contains_key(&key) {
            self.shape(text, style);
        }
        if self.raster.is_none() {
            return self.draw_swash(target, &key, style, x, y, clip);
        }
        let Text { fonts, shaped, raster, blend, .. } = self;
        let raster = raster.as_mut().expect("checked above");
        let shaped = shaped.get(&key).expect("shaped above");
        let (width, height) = (target.width() as i32, target.height() as i32);
        let pixels = target.data_mut();
        let (x0, y0) = (clip[0].floor().max(0.0) as i32, clip[1].floor().max(0.0) as i32);
        let (x1, y1) = ((clip[2].ceil() as i32).min(width), (clip[3].ceil() as i32).min(height));
        let [cr, cg, cb, ca] = style.color.to_u8();
        for run in shaped.buffer.layout_runs() {
            // Blink rounds the font's ascent and descent to whole pixels before splitting the
            // leading, then puts the baseline on a whole pixel; x is left to fall between them.
            // Centring with the exact metrics, as cosmic-text does, lands a pixel lower at 12.5px.
            let _ = run.line_y;
            let size = style.size;
            let (ascent, descent) = ((size * SEGOE_ASCENT).round(), (size * SEGOE_DESCENT).round());
            let baseline = (y + ((style.line_height - ascent - descent) / 2.0).floor() + ascent).round() as i32;
            for g in run.glyphs {
                let Some(face) = fonts.db().face(g.font_id) else { continue };
                let path = match &face.source {
                    fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _) => path.clone(),
                    _ => continue,
                };
                let index = face.index;
                let pen = x + g.x + g.font_size * g.x_offset;
                // Nearest quarter pixel: the whole pixels and the quarter within one, from one rounding
                // so that a pen just short of a pixel boundary carries over instead of overshooting.
                let quarters = (pen * PHASES).round() as i32;
                let whole = quarters.div_euclid(PHASES as i32);
                let phase = quarters.rem_euclid(PHASES as i32) as u8;
                let Some(glyph) = raster.glyph(&path, index, g.glyph_id, g.font_size, phase, style.grayscale) else { continue };
                for row in 0..glyph.height {
                    let py = baseline + glyph.top + row;
                    if py < y0 || py >= y1 {
                        continue;
                    }
                    for column in 0..glyph.width {
                        let px = whole + glyph.left + column;
                        if px < x0 || px >= x1 {
                            continue;
                        }
                        let at = ((row * glyph.width + column) * 3) as usize;
                        let coverage = [glyph.rgb[at], glyph.rgb[at + 1], glyph.rgb[at + 2]];
                        if coverage == [0, 0, 0] {
                            continue;
                        }
                        blend.apply(pixels, ((py * width + px) * 4) as usize, [cr, cg, cb], ca, coverage);
                    }
                }
            }
        }
    }

    /// The fallback where DirectWrite is not there: swash's grayscale coverage.
    fn draw_swash(&mut self, target: &mut PixmapMut, key: &Key, style: &TextStyle, x: f32, y: f32, clip: [f32; 4]) {
        let [cr, cg, cb, ca] = style.color.to_u8();
        let color = cosmic_text::Color::rgba(cr, cg, cb, ca);
        let Text { fonts, glyphs, shaped, .. } = self;
        let shaped = shaped.get_mut(key).expect("shaped above");
        let (width, height) = (target.width() as i32, target.height() as i32);
        let pixels = target.data_mut();
        let (ox, oy) = (x.round() as i32, y.round() as i32);
        let (x0, y0, x1, y1) = (clip[0].floor() as i32, clip[1].floor() as i32, clip[2].ceil() as i32, clip[3].ceil() as i32);
        shaped.buffer.draw(fonts, glyphs, color, |gx, gy, gw, gh, c| {
            let alpha = c.a() as u32;
            if alpha == 0 {
                return;
            }
            for py in oy + gy..oy + gy + gh as i32 {
                if py < y0.max(0) || py >= y1.min(height) {
                    continue;
                }
                for px in ox + gx..ox + gx + gw as i32 {
                    if px < x0.max(0) || px >= x1.min(width) {
                        continue;
                    }
                    blend(pixels, ((py * width + px) * 4) as usize, [c.r(), c.g(), c.b()], alpha);
                }
            }
        });
    }
}

/// Segoe UI's usWinAscent and usWinDescent over its 2048 units per em: what DirectWrite, and
/// so Chromium, measures a line with.
const SEGOE_ASCENT: f32 = 2210.0 / 2048.0;
const SEGOE_DESCENT: f32 = 514.0 / 2048.0;

/// Coverage corrected the way Skia corrects it before blending (`SkMaskGamma`), then blended
/// plainly in sRGB as Skia's blitters do.
///
/// One gamma for every colour did not fit: bright text on the dark panels wanted a heavier curve
/// than the muted text beside it, and any single value improved one by spoiling the other.
/// Skia's answer is a table per text-colour value: it assumes the background is that value's
/// inverse, works out what a blend in a linear space would give, and bakes the difference into
/// the coverage. The contrast lift tapers to nothing as the text approaches white. Both
/// constants were fitted against screenshots of the Electron app (`UMAKBANG_TEXT_GAMMA`, where
/// 0 means the sRGB curve, and `UMAKBANG_TEXT_CONTRAST` override them for that).
struct Blend {
    /// `[text channel value][coverage]` -> corrected coverage.
    tables: Vec<[u8; 256]>,
}

fn to_luma(gamma: f32, v: f32) -> f32 {
    if gamma == 0.0 {
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    } else {
        v.powf(gamma)
    }
}

fn from_luma(gamma: f32, v: f32) -> f32 {
    if gamma == 0.0 {
        if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
    } else {
        v.powf(1.0 / gamma)
    }
}

impl Blend {
    fn new() -> Blend {
        let gamma: f32 = std::env::var("UMAKBANG_TEXT_GAMMA").ok().and_then(|v| v.parse().ok()).unwrap_or(TEXT_GAMMA);
        let contrast: f32 = std::env::var("UMAKBANG_TEXT_CONTRAST").ok().and_then(|v| v.parse().ok()).unwrap_or(TEXT_CONTRAST);
        // SkTMaskGamma_build_correcting_lut, one table per source value.
        let tables = (0..256)
            .map(|source| {
                let src = source as f32 / 255.0;
                let lin_src = to_luma(gamma, src);
                let dst = 1.0 - src;
                let lin_dst = to_luma(gamma, dst);
                let adjusted = contrast * lin_dst;
                let mut table = [0u8; 256];
                for (i, entry) in table.iter_mut().enumerate() {
                    let raw = i as f32 / 255.0;
                    let srca = raw + (1.0 - raw) * adjusted * raw;
                    let value = if (src - dst).abs() < 1.0 / 256.0 {
                        srca
                    } else {
                        let out = from_luma(gamma, lin_src * srca + (1.0 - srca) * lin_dst);
                        (out - dst) / (src - dst)
                    };
                    *entry = (value * 255.0).round().clamp(0.0, 255.0) as u8;
                }
                table
            })
            .collect();
        Blend { tables }
    }

    /// Text over an opaque pixel: the frame's background is always opaque.
    fn apply(&self, pixels: &mut [u8], at: usize, rgb: [u8; 3], alpha: u8, coverage: [u8; 3]) {
        for channel in 0..3 {
            let c = self.tables[rgb[channel] as usize][coverage[channel] as usize] as u32 * alpha as u32;
            let (src, dst) = (rgb[channel] as u32, pixels[at + channel] as u32);
            pixels[at + channel] = ((src * c + dst * (255 * 255 - c) + 255 * 255 / 2) / (255 * 255)) as u8;
        }
        pixels[at + 3] = 255;
    }
}

/// Fitted; see `Blend`. The sRGB curve beat every power curve tried (1.2 to 2.4) in every region
/// at once; contrast barely matters past 0.5, since it tapers out for the light text here.
const TEXT_GAMMA: f32 = 0.0;
const TEXT_CONTRAST: f32 = 0.5;

/// Source-over onto premultiplied RGBA, with a straight-alpha source colour.
fn blend(pixels: &mut [u8], at: usize, rgb: [u8; 3], alpha: u32) {
    let inv = 255 - alpha;
    for channel in 0..3 {
        let src = rgb[channel] as u32 * alpha / 255;
        pixels[at + channel] = (src + pixels[at + channel] as u32 * inv / 255) as u8;
    }
    pixels[at + 3] = (alpha + pixels[at + 3] as u32 * inv / 255) as u8;
}
