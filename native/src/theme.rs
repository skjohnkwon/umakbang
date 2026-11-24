//! The colour tokens, as the Electron app resolves them on this machine.
//!
//! Captured from the running app (`getComputedStyle` on every `--*` variable) with this user's
//! accent and background applied, so this is their theme rather than the stock one. Porting
//! `ThemeBridge` and `lib/theme.ts` - which derive these from `Settings.accent` and
//! `Settings.background` - replaces the constants with the same computation later.

use crate::ui::color::{Rgba, oklab, oklch};

#[derive(Clone, Copy)]
pub struct Theme {
    pub background: Rgba,
    pub foreground: Rgba,
    pub card: Rgba,
    pub muted: Rgba,
    pub muted_foreground: Rgba,
    pub accent: Rgba,
    pub secondary: Rgba,
    pub border: Rgba,
    pub input: Rgba,
    pub primary: Rgba,
    pub primary_foreground: Rgba,
    /// The rating stars run the visualizer ramp, quiet at one and hot at five.
    pub stars: [Rgba; 5],
    /// The Type column's per-kind colours.
    pub project: Rgba,
    pub audio_type: Rgba,
    pub midi: Rgba,
    pub popover: Rgba,
    pub popover_foreground: Rgba,
    pub accent_foreground: Rgba,
    pub destructive: Rgba,
    pub destructive_foreground: Rgba,
    /// `--ring`: the focus ring, which this theme sets to the accent.
    pub ring: Rgba,
    /// Chromium's selection highlight on Windows: the system accent, `Highlight`.
    pub selection: Rgba,
    pub secondary_foreground: Rgba,
}

impl Theme {
    pub fn captured() -> Theme {
        Theme {
            background: oklch(0.3428, 0.0261, 160.0),
            foreground: oklch(0.995, 0.0183, 160.0),
            card: oklch(0.3728, 0.0287, 160.0),
            muted: oklch(0.4078, 0.0326, 160.0),
            muted_foreground: oklch(0.7628, 0.0417, 160.0),
            accent: oklch(0.4428, 0.0378, 160.0),
            secondary: oklch(0.4178, 0.0326, 160.0),
            border: oklch(0.4528, 0.0365, 160.0),
            input: oklch(0.4828, 0.0391, 160.0),
            primary: oklch(0.7103, 0.196, 47.16),
            primary_foreground: oklch(0.1682, 0.049, 47.16),
            stars: [
                oklab(0.678_885, -0.030_850_1, -0.156_341),
                oklab(0.830_563, -0.093_149_3, -0.044_120_3),
                oklab(0.863_555, 0.006_998_21, 0.144_108),
                oklab(0.757_679, 0.096_589_7, 0.120_218),
                oklab(0.690_53, 0.157_069, 0.076_506_7),
            ],
            project: oklch(0.72, 0.15, 15.0),
            audio_type: oklch(0.76, 0.12, 195.0),
            midi: oklch(0.72, 0.14, 295.0),
            popover: oklch(0.3928, 0.0326, 160.0),
            popover_foreground: oklch(0.995, 0.0183, 160.0),
            accent_foreground: oklch(0.995, 0.0208, 160.0),
            destructive: oklch(0.62, 0.19, 25.0),
            destructive_foreground: oklch(0.98, 0.005, 25.0),
            ring: oklch(0.7103, 0.196, 47.16),
            selection: Rgba::rgb8(0, 120, 215),
            secondary_foreground: oklch(0.995, 0.0228, 160.0),
        }
    }
}

/* ------------------------------------------------------------------ derivation */

/// A colour in OKLCH, in doubles as the Electron app computes it.
#[derive(Clone, Copy, Debug)]
pub struct Lch {
    pub l: f64,
    pub c: f64,
    pub h: f64,
}

fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.040_45 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(v: f64) -> f64 {
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// `#rrggbb` (or `#rgb`) as sRGB 0..1.
pub fn hex_to_rgb(hex: &str) -> Option<(f64, f64, f64)> {
    let h = hex.trim().trim_start_matches('#');
    let full: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h.to_string(),
        _ => return None,
    };
    let v = u32::from_str_radix(&full, 16).ok()?;
    Some((((v >> 16) & 255) as f64 / 255.0, ((v >> 8) & 255) as f64 / 255.0, (v & 255) as f64 / 255.0))
}

pub fn rgb_to_hex((r, g, b): (f64, f64, f64)) -> String {
    let q = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", q(r), q(g), q(b))
}

pub fn rgb_to_lch((r, g, b): (f64, f64, f64)) -> Lch {
    let (lr, lg, lb) = (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b));
    let l = (0.412_221_470_8 * lr + 0.536_332_536_3 * lg + 0.051_445_992_9 * lb).cbrt();
    let m = (0.211_903_498_2 * lr + 0.680_699_545_1 * lg + 0.107_396_956_6 * lb).cbrt();
    let s = (0.088_302_461_9 * lr + 0.281_718_837_6 * lg + 0.629_978_700_5 * lb).cbrt();
    let ok_l = 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
    let ok_a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
    let ok_b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
    let c = ok_a.hypot(ok_b);
    let h = if c < 1e-6 { 0.0 } else { (ok_b.atan2(ok_a).to_degrees() + 360.0) % 360.0 };
    Lch { l: ok_l, c, h }
}

fn lch_to_linear(x: Lch) -> [f64; 3] {
    let (a, b) = (x.h.to_radians().cos() * x.c, x.h.to_radians().sin() * x.c);
    let l_ = (x.l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m_ = (x.l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s_ = (x.l - 0.089_484_177_5 * a - 1.291_485_548 * b).powi(3);
    [
        4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_,
        -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_,
        -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_,
    ]
}

/// Back to sRGB, bringing the chroma in until it fits the gamut (`oklchToRgb`).
pub fn lch_to_rgb(x: Lch) -> (f64, f64, f64) {
    let fits = |v: [f64; 3]| v.iter().all(|c| *c >= -1e-4 && *c <= 1.0 + 1e-4);
    let mut linear = lch_to_linear(x);
    if !fits(linear) {
        let (mut lo, mut hi) = (0.0, x.c);
        for _ in 0..18 {
            let mid = (lo + hi) / 2.0;
            if fits(lch_to_linear(Lch { c: mid, ..x })) { lo = mid } else { hi = mid }
        }
        linear = lch_to_linear(Lch { c: lo, ..x });
    }
    let s = |v: f64| linear_to_srgb(v).clamp(0.0, 1.0);
    (s(linear[0]), s(linear[1]), s(linear[2]))
}

fn luminance((r, g, b): (f64, f64, f64)) -> f64 {
    0.2126 * srgb_to_linear(r) + 0.7152 * srgb_to_linear(g) + 0.0722 * srgb_to_linear(b)
}

fn contrast(a: (f64, f64, f64), b: (f64, f64, f64)) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// `contrastingForeground`: the lightness on the base's hue, nearest the base, that still
/// reaches `target` against it - or the extreme that comes closest.
fn contrasting(base: Lch, target: f64, chroma_scale: f64) -> Lch {
    let base_rgb = lch_to_rgb(base);
    let chroma = (base.c * chroma_scale).min(0.05);
    let at = |l: f64| contrast(lch_to_rgb(Lch { l, c: chroma, h: base.h }), base_rgb);
    let extreme = if at(0.995) >= at(0.12) { 0.995 } else { 0.12 };
    if at(extreme) < target {
        return Lch { l: extreme, c: chroma, h: base.h };
    }
    let (mut ok, mut fail) = (extreme, base.l);
    for _ in 0..20 {
        let mid = (ok + fail) / 2.0;
        if at(mid) >= target { ok = mid } else { fail = mid }
    }
    Lch { l: ok, c: chroma, h: base.h }
}

/// As `formatOklch` writes it into the page - four places, four, two - then drawn.
fn token(x: Lch) -> Rgba {
    let round = |v: f64, places: i32| {
        let k = 10f64.powi(places);
        (v * k).round() / k
    };
    oklch(round(x.l.clamp(0.0, 1.0), 4) as f32, round(x.c.max(0.0), 4) as f32, round(x.h, 2) as f32)
}

/// `readableTextOn`: a check mark that shows on a swatch of this colour.
pub fn readable_text_on(hex: &str) -> Rgba {
    hex_to_rgb(hex).map_or(Rgba::rgb8(0, 0, 0), |rgb| token(contrasting(rgb_to_lch(rgb), 4.5, 0.2)))
}

impl Theme {
    /// The app's own dark theme (`.dark` in index.css), before any override.
    pub fn stock() -> Theme {
        Theme {
            background: oklch(0.175, 0.008, 260.0),
            foreground: oklch(0.93, 0.005, 260.0),
            card: oklch(0.205, 0.009, 260.0),
            muted: oklch(0.24, 0.01, 260.0),
            muted_foreground: oklch(0.655, 0.014, 260.0),
            accent: oklch(0.275, 0.012, 260.0),
            secondary: oklch(0.25, 0.01, 260.0),
            border: oklch(0.285, 0.011, 260.0),
            input: oklch(0.315, 0.012, 260.0),
            primary: oklch(0.76, 0.12, 195.0),
            primary_foreground: oklch(0.19, 0.03, 195.0),
            popover: oklch(0.225, 0.01, 260.0),
            popover_foreground: oklch(0.93, 0.005, 260.0),
            accent_foreground: oklch(0.94, 0.005, 260.0),
            ring: oklch(0.76, 0.12, 195.0),
            secondary_foreground: oklch(0.9, 0.006, 260.0),
            ..Theme::captured()
        }
    }

    /// `applyThemeOverrides`: the accent sets primary and the ring; the background sets every
    /// surface by stepping lightness and chroma from it, and each text colour by the contrast
    /// it has to reach against what it sits on.
    pub fn derive(primary: Option<&str>, background: Option<&str>) -> Theme {
        let mut t = Theme::stock();
        if let Some(p) = primary.and_then(hex_to_rgb).map(rgb_to_lch) {
            t.primary = token(p);
            t.primary_foreground = token(contrasting(p, 7.0, 0.25));
            t.ring = token(p);
        }
        if let Some(b) = background.and_then(hex_to_rgb).map(rgb_to_lch) {
            let dark = b.l < 0.55;
            let step = |dl_dark: f64, cx_dark: f64, dl_light: f64, cx_light: f64| {
                let (dl, cx) = if dark { (dl_dark, cx_dark) } else { (dl_light, cx_light) };
                Lch { l: (b.l + dl).clamp(0.02, 1.0), c: (b.c * cx).min(b.c + 0.02).max(0.0), h: b.h }
            };
            t.background = token(b);
            t.foreground = token(contrasting(b, 15.0, 0.7));
            t.popover_foreground = t.foreground;
            t.muted_foreground = token(contrasting(b, 5.5, 1.6));
            t.card = token(step(0.03, 1.1, 0.015, 0.4));
            t.popover = token(step(0.05, 1.25, 0.015, 0.55));
            let secondary = step(0.075, 1.25, -0.03, 1.6);
            t.secondary = token(secondary);
            t.secondary_foreground = token(contrasting(secondary, 11.5, 0.7));
            t.muted = token(step(0.065, 1.25, -0.03, 1.6));
            let accent = step(0.1, 1.45, -0.045, 2.2);
            t.accent = token(accent);
            t.accent_foreground = token(contrasting(accent, 12.0, 0.55));
            t.border = token(step(0.11, 1.4, -0.08, 2.2));
            t.input = token(step(0.14, 1.5, -0.1, 2.6));
        }
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This machine's accent and background give back the theme captured from the running
    /// Electron app, token for token.
    #[test]
    fn derives_the_captured_theme() {
        let (got, want) = (Theme::derive(Some("#ff7100"), Some("#2d3d34")), Theme::captured());
        let pairs = [
            ("background", got.background, want.background),
            ("foreground", got.foreground, want.foreground),
            ("card", got.card, want.card),
            ("muted", got.muted, want.muted),
            ("muted_foreground", got.muted_foreground, want.muted_foreground),
            ("accent", got.accent, want.accent),
            ("secondary", got.secondary, want.secondary),
            ("border", got.border, want.border),
            ("input", got.input, want.input),
            ("primary", got.primary, want.primary),
            ("primary_foreground", got.primary_foreground, want.primary_foreground),
            ("popover", got.popover, want.popover),
            ("accent_foreground", got.accent_foreground, want.accent_foreground),
            ("secondary_foreground", got.secondary_foreground, want.secondary_foreground),
        ];
        for (name, a, b) in pairs {
            let (a, b) = (a.to_u8(), b.to_u8());
            assert!(a.iter().zip(b.iter()).all(|(x, y)| (*x as i32 - *y as i32).abs() <= 1), "{name}: {a:?} vs {b:?}");
        }
    }
}
