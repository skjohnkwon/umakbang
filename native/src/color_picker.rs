//! `ColorPicker.tsx`: a swatch that opens a 228px popover - a saturation/brightness field, a
//! hue bar, the colour with its hex, and presets. Live: every move is applied as it is made.

use crate::screen::{style, Action, State};
use crate::theme::{hex_to_rgb, readable_text_on, rgb_to_hex, Theme};
use crate::ui::color::Rgba;
use crate::ui::tree::{col, div, icon, paint, text, El, Painter};
use resvg::tiny_skia::{Paint, PixmapMut, Rect, Transform};
use std::rc::Rc;

pub const ACCENT_PRESETS: [&str; 8] = ["#4fb3c8", "#5b8def", "#7c6cf0", "#b56ce0", "#e0607e", "#e0873c", "#3fb27f", "#94a3b8"];
pub const SURFACE_PRESETS: [&str; 8] = ["#0e1013", "#16191f", "#1c2028", "#232833", "#ffffff", "#f7f8fa", "#eff1f5", "#e7eaf0"];

/// What a picker is editing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    Accent,
    Background,
    Stop(usize),
}

#[derive(Clone, Debug)]
pub struct Picker {
    pub target: Target,
    pub h: f64,
    pub s: f64,
    pub v: f64,
    pub x: f32,
    pub y: f32,
    /// Whether it has a Reset (or for a stop, Remove).
    pub resettable: bool,
}

pub fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    let c = v * s;
    let hp = (h.rem_euclid(360.0) / 60.0) % 6.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    (r + m, g + m, b + m)
}

pub fn rgb_to_hsv((r, g, b): (f64, f64, f64)) -> (f64, f64, f64) {
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let d = max - min;
    let mut h = 0.0;
    if d > 1e-6 {
        h = if max == r {
            60.0 * (((g - b) / d) % 6.0)
        } else if max == g {
            60.0 * ((b - r) / d + 2.0)
        } else {
            60.0 * ((r - g) / d + 4.0)
        };
    }
    ((h + 360.0) % 360.0, if max == 0.0 { 0.0 } else { d / max }, max)
}

impl Picker {
    pub fn open(target: Target, hex: &str, x: f32, y: f32, resettable: bool) -> Picker {
        let (h, s, v) = hex_to_rgb(hex).map(rgb_to_hsv).unwrap_or((200.0, 0.5, 0.7));
        Picker { target, h, s, v, x, y, resettable }
    }

    pub fn hex(&self) -> String {
        rgb_to_hex(hsv_to_rgb(self.h, self.s, self.v))
    }

    /// A preset or a typed hex: its hue kept when the colour is grey or black, where hue
    /// means nothing and would otherwise snap the bar back to red.
    pub fn take_hex(&mut self, hex: &str) -> bool {
        let Some((h, s, v)) = hex_to_rgb(hex).map(rgb_to_hsv) else { return false };
        if s > 1e-6 && v > 1e-6 {
            self.h = h;
        }
        self.s = s;
        self.v = v;
        true
    }
}

fn rgba(hex: &str) -> Rgba {
    Rgba::from_hex(hex).unwrap_or(Rgba::rgb8(0, 0, 0))
}

/// The trigger: a 14px swatch with a border and an inner hairline.
pub fn swatch(t: &Theme, hex: &str, action: Action) -> El<Action> {
    div().size(14.0, 14.0).shrink0().rounded(4.0).border(t.border, 1.0).bg(rgba(hex)).on(action)
}

fn field_painter(h: f64) -> Painter {
    Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], _scale: f32| {
        // `white → hue` across, then `transparent → black` down, per pixel.
        let (x0, y0) = (r[0].round() as i32, r[1].round() as i32);
        let (w, hgt) = ((r[2] - r[0]).round().max(1.0) as i32, (r[3] - r[1]).round().max(1.0) as i32);
        let (pw, ph) = (pm.width() as i32, pm.height() as i32);
        let hue = hsv_to_rgb(h, 1.0, 1.0);
        let data = pm.data_mut();
        for yy in 0..hgt {
            let py = y0 + yy;
            if py < 0 || py >= ph {
                continue;
            }
            let v = 1.0 - yy as f64 / (hgt - 1).max(1) as f64;
            for xx in 0..w {
                let px = x0 + xx;
                if px < 0 || px >= pw {
                    continue;
                }
                let s = xx as f64 / (w - 1).max(1) as f64;
                let c = |hc: f64| ((1.0 - s + s * hc) * v * 255.0).round() as u8;
                let at = ((py * pw + px) * 4) as usize;
                data[at] = c(hue.0);
                data[at + 1] = c(hue.1);
                data[at + 2] = c(hue.2);
                data[at + 3] = 255;
            }
        }
    })
}

fn hue_painter() -> Painter {
    Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], _scale: f32| {
        let w = (r[2] - r[0]).max(1.0);
        let mut x = r[0];
        while x < r[2] {
            let (cr, cg, cb) = hsv_to_rgb(((x - r[0]) / w * 360.0) as f64, 1.0, 1.0);
            if let Some(rect) = Rect::from_xywh(x, r[1], 1.0, r[3] - r[1]) {
                let mut paint = Paint::default();
                paint.set_color(Rgba::rgb8((cr * 255.0) as u8, (cg * 255.0) as u8, (cb * 255.0) as u8).skia());
                pm.fill_rect(rect, &paint, Transform::identity(), None);
            }
            x += 1.0;
        }
    })
}

pub fn popover(s: &State, t: &Theme, p: &Picker, label: &str, presets: &[&str]) -> El<Action> {
    let current = p.hex();
    let mut header = div().mb(8.0).items_center().justify_between().gap(8.0).child(text(label.to_string(), style(11.0, 500, t.muted_foreground)));
    if p.resettable {
        header = header.child(
            div()
                .items_center()
                .gap(4.0)
                .px(4.0)
                .py(2.0)
                .rounded(4.0)
                .hover_bg(t.accent)
                .on(Action::PickerReset)
                .child(icon("rotate-ccw", 12.0, t.muted_foreground))
                .child(text("Reset", style(11.0, 400, t.muted_foreground))),
        );
    }
    let (fw, fh) = (228.0 - 20.0, 112.0);
    let knob = div()
        .absolute((p.s as f32 * fw - 6.0).clamp(-6.0, fw - 6.0), ((1.0 - p.v as f32) * fh - 6.0).clamp(-6.0, fh - 6.0))
        .size(12.0, 12.0)
        .rounded(6.0)
        .border(Rgba::rgb8(255, 255, 255), 2.0);
    let area = paint(field_painter(p.h)).w(fw).h(fh).rounded(4.0).on(Action::PickerArea).child(knob);
    let hue_knob = div().absolute((p.h as f32 / 360.0 * fw - 7.0).clamp(-7.0, fw - 7.0), -2.0).size(14.0, 14.0).rounded(7.0).border(Rgba::rgb8(255, 255, 255), 2.0);
    let hue = paint(hue_painter()).w(fw).h(10.0).mt(8.0).rounded(5.0).on(Action::PickerHue).child(hue_knob);
    let hex_row = div()
        .mt(8.0)
        .items_center()
        .gap(6.0)
        .child(div().size(24.0, 24.0).shrink0().rounded(4.0).border(t.border, 1.0).bg(rgba(&current)))
        .child(crate::form::field_styled(s, t, "cp.hex", "", 24.0, crate::ui::text::TextStyle { line_height: 16.0, font: crate::ui::text::Font::Mono, ..style(11.0, 400, t.foreground) }).grow());
    let mut swatches = div().mt(8.0).wrap().gap(4.0);
    for (i, preset) in presets.iter().enumerate() {
        let selected = preset.eq_ignore_ascii_case(&current);
        swatches = swatches.child(
            div()
                .size(18.0, 18.0)
                .items_center()
                .justify_center()
                .rounded(4.0)
                .border(t.border, 1.0)
                .bg(rgba(preset))
                .on(Action::PickerPreset(i))
                .maybe(selected, |el| el.child(icon("check", 12.0, readable_text_on(preset)))),
        );
    }
    col()
        .absolute(p.x, p.y)
        .w(228.0)
        .p(10.0)
        .rounded(6.0)
        .border(t.border, 1.0)
        .bg(t.popover)
        .shadow(8.0, 24.0, 0.3)
        .child(header)
        .child(area)
        .child(hue)
        .child(hex_row)
        .child(swatches)
}
