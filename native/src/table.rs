//! The file table: `FileTable.tsx`'s header and rows, one cell per visible column.
//!
//! Rows are a grid in the Electron app - `pl-2 pr-3`, a track per visible column at its saved
//! width, then a filler - inside a wrapper whose minimum width is the sum of the columns. So a
//! row is `max(sum, pane)` wide, the cells start 8px in, and the horizontal scroll covers the sum.

use crate::columns::{self, Column, ColumnId, def_of};
use crate::keys;
use crate::screen::{Action, State, style, tnum};
use crate::theme::Theme;
use crate::ui::color::{Rgba, mix_oklab};
use crate::ui::text::TextStyle;
use crate::ui::tree::{El, Field, Painter, col, div, icon, icon_filled, image, input, scrollbar_h, scrollbar_v, text};
use resvg::tiny_skia::PixmapMut;
use std::rc::Rc;

pub const ROW: f32 = 26.0;
pub const HEADER: f32 = 24.0;
/// Chromium's scrollbar thickness on Windows, which `.scroll-thin` keeps.
pub const SCROLLBAR: f32 = 10.0;
const PAD_LEFT: f32 = 8.0;
/// `ROW_TAG_MAX` and `ROW_TAG_BUDGET`: how many tags a row shows before `+N`.
const TAG_MAX: usize = 8;
const TAG_BUDGET: usize = 30;

/// One file's resolved display values, worked out once when the folder opens rather than per
/// frame: the detected tempo and key folded in, the note, and how sure the key is.
#[derive(Clone, Default)]
pub struct FileMeta {
    pub bpm: Option<f64>,
    /// As shown: a detected key as its relative pair.
    pub key: Option<String>,
    pub key_position: Option<f32>,
    pub key_unsure: bool,
    pub note: String,
}

/// What a row of the open folder is.
pub enum RowRef<'a> {
    Folder(&'a crate::library::FolderRow),
    File(usize, &'a crate::library::FileRow),
}

pub fn row_at(s: &State, index: usize) -> Option<RowRef<'_>> {
    if index < s.folders.len() {
        Some(RowRef::Folder(&s.folders[index]))
    } else {
        s.files.get(index - s.folders.len()).map(|f| RowRef::File(index - s.folders.len(), f))
    }
}

pub fn row_count(s: &State) -> usize {
    s.folders.len() + s.files.len()
}

pub fn visible(columns: &[Column]) -> impl Iterator<Item = &Column> {
    columns.iter().filter(|c| c.visible)
}

/// The sum of the visible columns: the rows' minimum width.
pub fn columns_width(columns: &[Column]) -> f32 {
    visible(columns).map(|c| c.width).sum()
}

/// How far the table scrolls sideways in a pane `pane` wide.
pub fn max_scroll_x(columns: &[Column], pane: f32) -> f32 {
    (columns_width(columns) - (pane - SCROLLBAR)).max(0.0)
}

/// The table body's visible height: what is left between the pane bar and the transport, less
/// the header and the horizontal scrollbar's gutter.
pub fn body_height(window_height: f32, player: f32) -> f32 {
    (window_height - 38.0 - 30.0 - HEADER - player - SCROLLBAR).max(0.0)
}

/// `rampText`: a value's place on the visualizer ramp, mixed with a fifth of the foreground so
/// the quiet end of a dark ramp is still readable.
fn ramp_text(wave: &[Rgba], t: Theme, position: f32) -> Option<Rgba> {
    if wave.is_empty() {
        return None;
    }
    let step = wave[(position.clamp(0.0, 1.0) * (wave.len() - 1) as f32).round() as usize];
    Some(mix_oklab(step, t.foreground, 0.8))
}

/// A cell's text: truncated inside the cell, right-aligned for value columns.
fn value(content: String, style: TextStyle, right: bool, pr: f32) -> El<Action> {
    let mut cell = div().w_full().h_full().items_center().pr(pr).min_w(0.0);
    if right {
        cell = cell.justify_end();
    }
    cell.child(text(content, style).min_w(0.0))
}

pub fn table(s: &State, t: &Theme, window_height: f32, pane: f32) -> El<Action> {
    let body_height = body_height(window_height, s.sizes.player);
    let total = row_count(s);
    let row_width = columns_width(&s.columns).max(pane - SCROLLBAR);
    let first = (s.scroll / ROW).floor().max(0.0) as usize;
    let shown = (body_height / ROW).ceil() as usize + 1;
    let wave = s.visuals.borrow().palette.wave.clone();

    let mut content = div().w(row_width).h(total as f32 * ROW).ml(-s.scroll_x);
    for index in first..(first + shown).min(total) {
        content = content.child(row(s, t, &wave, index, row_width).absolute(0.0, index as f32 * ROW));
    }
    let body = div().grow().min_h0().scroll(s.scroll).child(content);

    // Header and rows scroll together in one box with 10px scrollbars that take their own
    // gutters: rows stop 10px short of the pane's right edge and of the transport.
    let inner = col()
        .grow()
        .min_h0()
        .mr(SCROLLBAR)
        .mb(SCROLLBAR)
        .clip()
        .child(div().h(HEADER).shrink0().clip().child(header(s, t, row_width).absolute(-s.scroll_x, 0.0)))
        .child(body);
    let content_width = row_width;
    col().grow().min_h0().child(inner).overlay(scrollbars(t, s.scroll, s.scroll_x, total as f32 * ROW, body_height, content_width))
}

/* ------------------------------------------------------------------ header */

fn header(s: &State, t: &Theme, row_width: f32) -> El<Action> {
    let mut row = div().w(row_width).h(HEADER).items_center().bg(t.card).border_b(t.border).pl(PAD_LEFT);
    let mut x = PAD_LEFT;
    let mut handles = Vec::new();
    for column in visible(&s.columns) {
        let d = def_of(column.id);
        let active = d.sort.is_some_and(|k| k == s.sort.key);
        let color = if active { t.foreground } else { t.muted_foreground };
        let mut label = div().w(column.width).h_full().items_center().gap(2.0).min_w(0.0).shrink0();
        if d.right {
            label = label.justify_end().pr(4.0);
        }
        label = label.child(text(d.label, style(10.5, 500, color)).min_w(0.0));
        if active {
            label = label.child(icon(if s.sort.ascending() { "arrow-up" } else { "arrow-down" }, 10.0, color));
        }
        if let Some(key) = d.sort {
            label = label.on(Action::SortBy(key));
        }
        row = row.child(label);
        x += column.width;
        // The resize handle sits over the boundary, 8px wide (`-right-1 w-2`), its hairline 14px
        // tall from 4px down.
        let lit = s.column_hot == Some(column.id);
        handles.push(
            div()
                .absolute(x - 4.0, 0.0)
                .w(8.0)
                .h(HEADER)
                .on(Action::ColumnResize(column.id))
                .child(div().absolute(3.5, 4.0).w(1.0).h(14.0).bg(if lit { t.primary } else { t.border })),
        );
    }
    row.children(handles)
}

/* ------------------------------------------------------------------ rows */

fn row(s: &State, t: &Theme, wave: &[Rgba], index: usize, width: f32) -> El<Action> {
    let hovered = s.hover_row == Some(index);
    let selected = s.selection.contains(&index);
    let mut el = div().w(width).h(ROW).items_center().pl(PAD_LEFT).border_b(t.border.alpha(0.4)).on(Action::Row(index));
    match row_at(s, index) {
        Some(RowRef::Folder(folder)) => {
            el = el.maybe(selected, |e| e.bg(t.accent)).maybe(!selected && hovered, |e| e.bg(t.accent.alpha(0.5)));
            el = crate::screen::drop_lit(el, s, t, Action::Row(index));
            for column in visible(&s.columns) {
                el = el.child(div().w(column.width).h_full().shrink0().min_w(0.0).clip().items_center().child(folder_cell(s, t, wave, column.id, folder, hovered)));
            }
        }
        Some(RowRef::File(at, file)) => {
            let current = s.now.as_ref().is_some_and(|n| n.file.path == file.path);
            el = if current {
                el.bg(t.primary.alpha(0.12))
            } else {
                el.maybe(selected, |e| e.bg(t.accent)).maybe(!selected && hovered, |e| e.bg(t.accent.alpha(0.5)))
            };
            let meta = s.file_meta.get(at).cloned().unwrap_or_default();
            for column in visible(&s.columns) {
                el = el.child(div().w(column.width).h_full().shrink0().min_w(0.0).clip().items_center().child(file_cell(s, t, wave, column.id, index, at, file, &meta, hovered, current)));
            }
        }
        None => {}
    }
    el
}

/// `typeIconClass`: the kind's colour, which the row icon and the Type column share.
fn kind_color(t: &Theme, file: &crate::library::FileRow) -> Rgba {
    if !file.playable && file.kind == "audio" {
        return t.muted_foreground.alpha(0.6);
    }
    match file.kind.as_str() {
        "midi" => t.midi,
        "project" => t.project,
        _ => t.audio_type,
    }
}

fn kind_icon(kind: &str) -> &'static str {
    match kind {
        "midi" => "file-music",
        "project" => "file-sliders",
        "archive" => "file-archive",
        _ => "file-audio2",
    }
}

/// `visibleRowTags`: the newest tags that fit the budget, the first always.
fn row_tags(tags: &[String]) -> (&[String], usize) {
    let mut start = tags.len();
    let mut spent = 0;
    while start > 0 && tags.len() - start < TAG_MAX {
        let tag = &tags[start - 1];
        if start < tags.len() && spent + tag.chars().count() > TAG_BUDGET {
            break;
        }
        spent += tag.chars().count();
        start -= 1;
    }
    (&tags[start..], start)
}

fn chips(t: &Theme, tags: Option<&Vec<String>>) -> Option<El<Action>> {
    let tags = tags.filter(|tags| !tags.is_empty())?;
    let (shown, hidden) = row_tags(tags);
    let mut strip = div().gap(2.0).items_center().shrink0();
    for tag in shown {
        strip = strip.child(
            div()
                .h(20.0)
                .items_center()
                .px(6.0)
                .rounded(4.0)
                .bg(t.secondary)
                .border(t.border.alpha(0.6), 1.0)
                .shrink0()
                .child(text(tag.clone(), TextStyle { tracking: 0.025, line_height: 16.0, ..style(10.5, 500, t.secondary_foreground) })),
        );
    }
    if hidden > 0 {
        strip = strip.child(text(format!("+{hidden}"), style(10.5, 400, t.muted_foreground.alpha(0.6))).shrink0_el());
    }
    Some(strip)
}

#[allow(clippy::too_many_arguments)]
fn file_cell(s: &State, t: &Theme, wave: &[Rgba], id: ColumnId, row: usize, at: usize, file: &crate::library::FileRow, meta: &FileMeta, hovered: bool, current: bool) -> El<Action> {
    let muted = t.muted_foreground;
    let base = if s.gone.contains(&file.path) { muted.alpha(0.45) } else if file.playable { t.foreground } else { muted };
    match id {
        ColumnId::Name => {
            let lead = if current {
                let playing = s.now.as_ref().is_some_and(|n| n.playing);
                icon("audio-lines", 14.0, t.primary).opacity(if playing { s.pulse } else { 1.0 }).live()
            } else {
                match s.file_icons.get(&file.ext.to_lowercase()) {
                    Some(pixmap) => image(pixmap.clone(), 14.0),
                    None => icon(kind_icon(&file.kind), 14.0, kind_color(t, file)),
                }
            };
            let mut cell = div()
                .w_full()
                .h_full()
                .items_center()
                .gap(6.0)
                .pr(8.0)
                .min_w(0.0)
                .child(lead.shrink0_el())
                .child(text(file.name.clone(), style(12.5, if current { 500 } else { 400 }, if current { t.foreground } else { base })).min_w(0.0));
            if let Some(strip) = chips(t, s.file_tags.get(&file.path)) {
                cell = cell.child(strip);
            }
            // A list spanning folders says where each file lives (`parentLabel`).
            if s.spans_folders() {
                cell = cell.child(text(parent_label(&file.dir), style(11.0, 400, muted.alpha(0.6))).ml_auto().pl(8.0).shrink0_el());
            }
            cell
        }
        ColumnId::Rating => {
            let rating = s.ratings.get(&file.path).copied().unwrap_or(0);
            let shown = match s.hover_star {
                Some((r, star)) if r == row => star,
                _ => rating,
            };
            let mut stars = div().w_full().h_full().items_center().justify_end().gap(1.0).pr(4.0);
            for star in 1..=5u8 {
                let lit = star <= shown;
                let glyph = if lit { icon_filled("star", 10.0, t.stars[star as usize - 1]) } else { icon("star", 10.0, muted.alpha(0.4)).opacity(if hovered { 1.0 } else { 0.0 }) };
                stars = stars.child(div().size(10.0, 10.0).shrink0().on(Action::Rate(at, star)).child(glyph));
            }
            stars
        }
        ColumnId::Type => value(file.ext.to_uppercase(), style(11.0, 400, kind_color(t, file)), true, 8.0),
        // A blank cell is "no value"; a turning one is "not yet" (`Working`).
        ColumnId::Bpm | ColumnId::Key if s.analysing.contains(&file.path) && (if id == ColumnId::Bpm { meta.bpm.is_none() } else { meta.key.is_none() }) => {
            let cell = div().w_full().h_full().items_center().pr(4.0).child(icon("loader2", 10.0, muted).opacity(0.5));
            if id == ColumnId::Bpm { cell.justify_end() } else { cell }
        }
        ColumnId::Bpm => {
            let color = meta.bpm.and_then(|b| ramp_text(wave, *t, columns::tempo_position(b))).unwrap_or(muted);
            value(meta.bpm.map(|b| format!("{}", b.round())).unwrap_or_default(), tnum(12.5, 400, color), true, 4.0)
        }
        ColumnId::Key => {
            let color = meta.key_position.and_then(|p| ramp_text(wave, *t, p)).unwrap_or(muted);
            // A reading the detector barely believed is dimmed rather than hidden.
            value(meta.key.clone().unwrap_or_default(), style(12.5, 400, color), false, 0.0).opacity(if meta.key_unsure { 0.55 } else { 1.0 })
        }
        ColumnId::Time => value(if file.kind == "audio" { columns::duration_precise(file.duration) } else { String::new() }, tnum(12.5, 400, muted), true, 4.0),
        ColumnId::Format => value(if file.kind == "audio" { columns::format(file.sample_rate) } else { String::new() }, tnum(12.5, 400, muted.alpha(0.8)), true, 4.0),
        ColumnId::Size => value(columns::size(file.size), tnum(12.5, 400, muted.alpha(0.8)), true, 4.0),
        ColumnId::Modified => {
            let color = ramp_text(wave, *t, columns::day_position(file.mtime)).unwrap_or(muted.alpha(0.8));
            value(crate::localtime::date_time(file.mtime).unwrap_or_else(|| "—".into()), tnum(12.5, 400, color), true, 4.0)
        }
        ColumnId::Notes => {
            // `NoteCell`: an input in the row, where writing costs nothing - no double-click,
            // no pencil to find. Focused, the text turns foreground.
            let editing = s.note_edit.as_ref().filter(|(path, _)| *path == file.path).map(|(_, f)| f.clone());
            let field = editing.clone().unwrap_or(crate::screen::SearchBox { value: meta.note.clone(), ..Default::default() });
            let focused = editing.is_some();
            div().w_full().h_full().items_center().pr(4.0).min_w(0.0).on(Action::Note(at)).child(
                input(Field {
                    value: field.value,
                    placeholder: "…".into(),
                    caret: field.caret,
                    anchor: field.anchor,
                    focused,
                    style: TextStyle { line_height: 16.0, ..style(12.0, 400, if focused { t.foreground } else { muted }) },
                    placeholder_color: muted.alpha(0.25),
                    selection: t.selection,
                })
                .grow()
                .h_full(),
            )
        }
        ColumnId::Waveform => div(),
    }
}

fn folder_cell(s: &State, t: &Theme, wave: &[Rgba], id: ColumnId, folder: &crate::library::FolderRow, hovered: bool) -> El<Action> {
    let muted = t.muted_foreground;
    match id {
        ColumnId::Name => {
            // `fill-muted-foreground/20` under the outline.
            let glyph = div().size(14.0, 14.0).shrink0().child(icon_filled("folder", 14.0, muted.alpha(0.2)).absolute(0.0, 0.0)).child(icon("folder", 14.0, muted).absolute(0.0, 0.0));
            let mut cell = div()
                .w_full()
                .h_full()
                .items_center()
                .gap(6.0)
                .pr(8.0)
                .min_w(0.0)
                .child(glyph)
                .child(text(folder.name.clone(), style(12.5, 500, t.foreground)).min_w(0.0));
            if let Some(strip) = chips(t, s.folder_tags.get(&folder.id)) {
                cell = cell.child(strip);
            }
            cell.child(icon("chevron-right", 12.0, muted.alpha(0.4)).opacity(if hovered { 1.0 } else { 0.0 }).shrink0_el())
                .child(text(crate::library::format_count(folder.files), tnum(11.0, 400, muted.alpha(0.6))).ml_auto().pl(8.0).shrink0_el())
        }
        ColumnId::Type => value("Folder".into(), style(11.0, 400, muted), true, 8.0),
        ColumnId::Modified => {
            let color = ramp_text(wave, *t, columns::day_position(folder.latest)).unwrap_or(muted.alpha(0.8));
            value(crate::localtime::date(folder.latest).unwrap_or_else(|| "—".into()), tnum(12.5, 400, color), true, 4.0)
        }
        _ => div(),
    }
}

/// The table's scrollbars: vertical down the whole table (the header is sticky inside the same
/// scroller in the Electron app), horizontal along the bottom when the columns run wider than
/// the pane.
fn scrollbars(t: &Theme, scroll: f32, scroll_x: f32, content: f32, viewport: f32, width: f32) -> Painter {
    let color = t.border;
    Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        let bottom_bar = SCROLLBAR * scale;
        scrollbar_v(pm, [r[0], r[1], r[2], r[3] - bottom_bar], content + HEADER, viewport + HEADER, scroll, color, scale);
        let pane = (r[2] - r[0]) / scale;
        scrollbar_h(pm, [r[0], r[1], r[2] - SCROLLBAR * scale, r[3]], width, pane - SCROLLBAR, scroll_x, color, scale);
    })
}

/// Small helpers that read better at the call site.
trait Extra {
    fn shrink0_el(self) -> Self;
}

impl Extra for El<Action> {
    fn shrink0_el(mut self) -> Self {
        self.style.flex_shrink = 0.0;
        self
    }
}

/// `parentLabel`: the last two segments of a folder path.
pub fn parent_label_pub(dir: &str) -> String {
    parent_label(dir)
}

fn parent_label(dir: &str) -> String {
    if dir.is_empty() {
        return "Library root".into();
    }
    let parts: Vec<&str> = dir.split('/').collect();
    if parts.len() <= 2 { dir.to_string() } else { format!("…/{}", parts[parts.len() - 2..].join("/")) }
}

/// Resolves what a file row shows for tempo, key and note.
pub fn meta_for(file: &crate::library::FileRow, data: &crate::userdata::UserData) -> FileMeta {
    let detected_key = data.detected_key.get(&file.path);
    let raw_key = file.musical_key.clone().filter(|k| !k.is_empty()).or_else(|| detected_key.cloned());
    let detected = file.musical_key.as_deref().is_none_or(str::is_empty) && detected_key.is_some();
    FileMeta {
        bpm: file.bpm.or_else(|| data.detected_bpm.get(&file.path).copied()),
        key_position: raw_key.as_deref().and_then(keys::fifths_position),
        key: raw_key.map(|k| if detected { keys::relative_pair(&k) } else { k }),
        key_unsure: detected && data.detected_key_fit.get(&file.path).is_some_and(|&fit| fit < 0.55),
        note: data.notes.get(&file.path).cloned().unwrap_or_default(),
    }
}
