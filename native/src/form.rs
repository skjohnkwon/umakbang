//! Forms: named text fields with one focus between them, for the pages that ask for typing -
//! Contracts' terms and purchasers, the contract draft. Single-line fields edit through the
//! same `edit_field` the search box does; areas add newlines and moving by visual line.

use crate::screen::{style, Action, SearchBox, State};
use crate::theme::Theme;
use crate::ui::text::{Text, TextStyle};
use crate::ui::tree::{area, area_lines, div, input, El, Field};
use std::collections::HashMap;
use winit::event::KeyEvent;
use winit::keyboard::{Key, NamedKey};

#[derive(Default)]
pub struct Form {
    pub fields: HashMap<&'static str, SearchBox>,
    pub focus: Option<&'static str>,
    /// How far each area is scrolled, in pixels.
    pub scroll: HashMap<&'static str, f32>,
}

impl Form {
    pub fn value(&self, key: &str) -> &str {
        self.fields.get(key).map_or("", |f| f.value.as_str())
    }

    pub fn set(&mut self, key: &'static str, value: impl Into<String>) {
        let value = value.into();
        let field = self.fields.entry(key).or_default();
        field.caret = value.len();
        field.anchor = field.caret;
        field.value = value;
    }

    pub fn focus(&mut self, key: &'static str) {
        if let Some(old) = self.focus.take() {
            if let Some(f) = self.fields.get_mut(old) {
                f.focused = false;
            }
        }
        let field = self.fields.entry(key).or_default();
        field.focused = true;
        self.focus = Some(key);
    }

    /// Leaves the focused field; says which it was.
    pub fn blur(&mut self) -> Option<&'static str> {
        let key = self.focus.take()?;
        if let Some(f) = self.fields.get_mut(key) {
            f.focused = false;
        }
        Some(key)
    }
}

/// The `Input` component: 28px (or `height`), a border that turns to the ring when focused.
pub fn field(s: &State, t: &Theme, key: &'static str, placeholder: &str, height: f32) -> El<Action> {
    field_styled(s, t, key, placeholder, height, TextStyle { line_height: 16.0, ..style(12.5, 400, t.foreground) })
}

/// A field in another type: the colour picker's hex is `font-mono text-[11px]`.
pub fn field_styled(s: &State, t: &Theme, key: &'static str, placeholder: &str, height: f32, text_style: TextStyle) -> El<Action> {
    let f = s.form.fields.get(key).cloned().unwrap_or_default();
    let focused = s.form.focus == Some(key);
    let data = Field {
        value: f.value,
        placeholder: placeholder.to_string(),
        caret: f.caret,
        anchor: f.anchor,
        focused,
        style: text_style,
        placeholder_color: t.muted_foreground.alpha(0.7),
        selection: t.selection,
    };
    div()
        .h(height)
        .min_w(0.0)
        .items_center()
        .px(if height < 26.0 { 6.0 } else { 8.0 })
        .rounded(6.0)
        .border(if focused { t.ring } else { t.input }, 1.0)
        .bg(t.background)
        .on(Action::Field(key))
        .child(input(data).grow().h_full())
}

/// An `<input type="password">`: the same field, its characters drawn as dots.
pub fn password_field(s: &State, t: &Theme, key: &'static str, placeholder: &str, height: f32) -> El<Action> {
    let f = s.form.fields.get(key).cloned().unwrap_or_default();
    let focused = s.form.focus == Some(key);
    // A dot per character; the caret and selection counted in characters, then in dots.
    let dots = |byte: usize| f.value[..byte.min(f.value.len())].chars().count() * '•'.len_utf8();
    let data = Field {
        value: "•".repeat(f.value.chars().count()),
        placeholder: placeholder.to_string(),
        caret: dots(f.caret),
        anchor: dots(f.anchor),
        focused,
        style: TextStyle { line_height: 16.0, ..style(12.0, 400, t.foreground) },
        placeholder_color: t.muted_foreground.alpha(0.7),
        selection: t.selection,
    };
    div()
        .h(height)
        .min_w(0.0)
        .items_center()
        .px(8.0)
        .rounded(6.0)
        .border(if focused { t.ring } else { t.input }, 1.0)
        .bg(t.background)
        .on(Action::Field(key))
        .child(input(data).grow().h_full())
}

/// A `<textarea>`: `rows` lines of `text_style`, padded `px-2 py-1.5`.
pub fn text_area(s: &State, t: &Theme, key: &'static str, text_style: TextStyle, height: f32) -> El<Action> {
    let f = s.form.fields.get(key).cloned().unwrap_or_default();
    let focused = s.form.focus == Some(key);
    let data = Field {
        value: f.value,
        placeholder: String::new(),
        caret: f.caret,
        anchor: f.anchor,
        focused,
        style: text_style,
        placeholder_color: t.muted_foreground.alpha(0.7),
        selection: t.selection,
    };
    let scroll = s.form.scroll.get(key).copied().unwrap_or(0.0);
    div()
        .h(height)
        .min_w(0.0)
        .px(8.0)
        .py(6.0)
        .rounded(4.0)
        .border(if focused { t.primary } else { t.border }, 1.0)
        .bg(t.background)
        .clip()
        .on(Action::Field(key))
        .child(area(data, scroll).grow().h_full())
}

pub enum AreaEdit {
    Done,
    Escape,
    Ignored,
}

/// Keys for a textarea whose text is laid out `width` wide.
pub fn edit_area(f: &mut SearchBox, event: &KeyEvent, ctrl: bool, shift: bool, alt: bool, text: &mut Text, style: &TextStyle, width: f32) -> AreaEdit {
    match &event.logical_key {
        Key::Named(NamedKey::Enter) => {
            let (lo, hi) = (f.caret.min(f.anchor), f.caret.max(f.anchor));
            f.value.replace_range(lo..hi, "\n");
            f.caret = lo + 1;
            f.anchor = f.caret;
            AreaEdit::Done
        }
        Key::Named(NamedKey::ArrowUp) | Key::Named(NamedKey::ArrowDown) => {
            let lines = area_lines(text, &f.value, style, width);
            let line = line_of(&lines, f.caret);
            let x = text.width(&f.value[lines[line].0..f.caret.max(lines[line].0)], style);
            let target = if matches!(event.logical_key, Key::Named(NamedKey::ArrowUp)) { line.checked_sub(1) } else { (line + 1 < lines.len()).then_some(line + 1) };
            f.caret = match target {
                Some(t) => offset_at(text, &f.value, lines[t], style, x),
                None if matches!(event.logical_key, Key::Named(NamedKey::ArrowUp)) => 0,
                None => f.value.len(),
            };
            if !shift {
                f.anchor = f.caret;
            }
            AreaEdit::Done
        }
        Key::Named(NamedKey::Home) | Key::Named(NamedKey::End) if !ctrl => {
            let lines = area_lines(text, &f.value, style, width);
            let (from, to) = lines[line_of(&lines, f.caret)];
            f.caret = if matches!(event.logical_key, Key::Named(NamedKey::Home)) { from } else { to };
            if !shift {
                f.anchor = f.caret;
            }
            AreaEdit::Done
        }
        Key::Character(c) if ctrl && c.eq_ignore_ascii_case("v") => {
            let pasted = arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default().replace("\r\n", "\n");
            let (lo, hi) = (f.caret.min(f.anchor), f.caret.max(f.anchor));
            f.value.replace_range(lo..hi, &pasted);
            f.caret = lo + pasted.len();
            f.anchor = f.caret;
            AreaEdit::Done
        }
        _ => match crate::app::ops::edit_field(f, event, ctrl, shift, alt) {
            crate::app::ops::Edit::Escape => AreaEdit::Escape,
            crate::app::ops::Edit::Ignored => AreaEdit::Ignored,
            _ => AreaEdit::Done,
        },
    }
}

fn line_of(lines: &[(usize, usize)], caret: usize) -> usize {
    lines.iter().rposition(|(from, _)| *from <= caret).unwrap_or(0)
}

/// The byte offset in a line nearest `x` pixels from its start.
pub fn offset_at(text: &mut Text, value: &str, (from, to): (usize, usize), style: &TextStyle, x: f32) -> usize {
    let mut best = (from, f32::INFINITY);
    let mut at = from;
    loop {
        let d = (text.width(&value[from..at], style) - x).abs();
        if d < best.1 {
            best = (at, d);
        }
        if at >= to {
            break;
        }
        at += value[at..].chars().next().map_or(1, char::len_utf8);
    }
    best.0
}

/// Keeps the caret's line inside an area `height` tall.
pub fn scroll_to_caret(scroll: f32, caret_line: usize, line_height: f32, height: f32) -> f32 {
    let top = caret_line as f32 * line_height;
    if top < scroll {
        top
    } else if top + line_height > scroll + height {
        top + line_height - height
    } else {
        scroll
    }
}

/// The caret's visual line, for scrolling to it.
pub fn caret_line(text: &mut Text, f: &SearchBox, style: &TextStyle, width: f32) -> usize {
    line_of(&area_lines(text, &f.value, style, width), f.caret)
}
