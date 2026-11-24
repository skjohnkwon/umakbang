//! Colours as the Electron app writes them: OKLCH and OKLab, converted to sRGB the way the
//! browser does (OKLab -> linear sRGB -> gamma), so a token here is the same pixel as there.

use resvg::tiny_skia;

/// Straight (not premultiplied) sRGB, 0..1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    #[allow(dead_code)]
    pub const TRANSPARENT: Rgba = Rgba { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };

    pub const fn rgb8(r: u8, g: u8, b: u8) -> Rgba {
        Rgba { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a: 1.0 }
    }

    /// `#rrggbb`, as the settings store the visualizer stops.
    pub fn from_hex(hex: &str) -> Option<Rgba> {
        let digits = hex.trim().strip_prefix('#')?;
        if digits.len() != 6 {
            return None;
        }
        let value = u32::from_str_radix(digits, 16).ok()?;
        Some(Rgba::rgb8((value >> 16) as u8, (value >> 8) as u8, value as u8))
    }

    /// The same colour at a fraction of its opacity - Tailwind's `/60`.
    pub fn alpha(self, a: f32) -> Rgba {
        Rgba { a: self.a * a, ..self }
    }

    pub fn skia(self) -> tiny_skia::Color {
        tiny_skia::Color::from_rgba(
            self.r.clamp(0.0, 1.0),
            self.g.clamp(0.0, 1.0),
            self.b.clamp(0.0, 1.0),
            self.a.clamp(0.0, 1.0),
        )
        .unwrap_or(tiny_skia::Color::TRANSPARENT)
    }

    pub fn to_u8(self) -> [u8; 4] {
        let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        [q(self.r), q(self.g), q(self.b), q(self.a)]
    }

    /// `#rrggbb`, for substituting into an SVG.
    pub fn hex(self) -> String {
        let [r, g, b, _] = self.to_u8();
        format!("#{r:02x}{g:02x}{b:02x}")
    }
}

pub fn oklab(l: f32, a: f32, b: f32) -> Rgba {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    let r = 4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3;
    let g = -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_38 * s3;
    let bl = -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3;
    Rgba { r: gamma(r), g: gamma(g), b: gamma(bl), a: 1.0 }
}

/// `color-mix(in oklab, from <weight>, to)`: the two converted to OKLab, blended there, and
/// brought back to sRGB clamped into gamut.
pub fn mix_oklab(from: Rgba, to: Rgba, from_weight: f32) -> Rgba {
    let (a, b) = (to_oklab(from), to_oklab(to));
    let w = from_weight;
    let mut c = oklab(a.0 * w + b.0 * (1.0 - w), a.1 * w + b.1 * (1.0 - w), a.2 * w + b.2 * (1.0 - w));
    c.a = from.a * w + to.a * (1.0 - w);
    c
}

fn to_oklab(c: Rgba) -> (f32, f32, f32) {
    let lin = |v: f32| if v <= 0.040_45 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    let (r, g, b) = (lin(c.r), lin(c.g), lin(c.b));
    let l = (0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    (
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    )
}

pub fn oklch(l: f32, c: f32, h: f32) -> Rgba {
    let radians = h.to_radians();
    oklab(l, c * radians.cos(), c * radians.sin())
}

fn gamma(linear: f32) -> f32 {
    let v = linear.clamp(0.0, 1.0);
    if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_and_black() {
        assert_eq!(oklch(1.0, 0.0, 0.0).to_u8(), [255, 255, 255, 255]);
        assert_eq!(oklch(0.0, 0.0, 0.0).to_u8(), [0, 0, 0, 255]);
    }
}
