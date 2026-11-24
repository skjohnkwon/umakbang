//! What floats over the explorer: the right-click menu (`ExplorerMenu.tsx` on Radix's
//! context menu), the name prompt (`NamePopover`) and the confirmation dialog
//! (`ConfirmDialog`). They are drawn last, over everything, with a window-sized catcher under
//! each so a press anywhere else dismisses rather than reaching what is beneath.

use crate::screen::{Action, SearchBox, State, style};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::text::TextStyle;
use crate::ui::tree::{El, Field, col, div, icon, input, text};
use std::path::PathBuf;

/// What a menu item does.
#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    Play,
    OpenFolder,
    OpenExternally,
    Cut,
    Copy,
    Paste(PathBuf),
    Duplicate,
    Rename,
    Delete,
    NewFolder(PathBuf),
    NewFolderWithSelection(PathBuf),
    MoveTo(PathBuf),
    TogglePin,
    ToggleRandomExclude,
    GoToFolder,
    Reveal,
    CopyPath,
    CopyName,
    SelectAll,
    /// Opens the tag editor on the selection.
    Tags,
    /// The type filter's entries, and its Clear and Sort by type.
    ToggleKind(String),
    ToggleExt(String),
    ClearTypeFilter,
    SortByType,
    /// The columns menu: one column on or off, or all of them back to their defaults.
    ToggleColumn(crate::columns::ColumnId),
    ResetColumns,
    /// YT2MP3's two selects.
    YtFormat(&'static str),
    YtBitrate(u32),
    /// Clear and re-run the selection's tempo and key analysis.
    Reprocess,
    /// Draft a contract for the selected tracks.
    GenerateContract,
    /// Open the split dialog for the selected files.
    SplitStems,
    /// The Stems model.
    StemSplitter(&'static str),
    /// Where the sound goes: a device by name, or empty for the system default.
    OutputDevice(String),
    /// Drops a folder from the library, by its label. Nothing on disk is touched.
    RemoveRoot(String),
    /// The analysis scope: a folder tag, or everything.
    AnalysisTag(Option<String>),
    /// Another machine's files, copied into the download folder; its project, packed there.
    CopyHere,
    PackHere,
    /// A folder in the other half of the explorer, splitting it if it is not.
    OpenInOtherPane,
    /// The selection renamed to carry its key and tempo; a zip unpacked beside itself; the
    /// selection moved into a folder picked there and then.
    RenameWithMetadata,
    ExtractHere,
    MoveToChosen,
}

#[derive(Clone, Debug)]
pub enum MenuItem {
    Label(String),
    Separator,
    Item { icon: &'static str, label: String, shortcut: Option<String>, enabled: bool, cmd: Cmd },
    /// Opens a list to the side on hover: Move to.
    Sub { icon: &'static str, label: String, items: Vec<MenuItem> },
}

#[derive(Clone, Debug)]
pub struct Menu {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub items: Vec<MenuItem>,
    /// The item the keyboard or pointer is on.
    pub hover: Option<usize>,
    /// The open submenu: which item, and where its list sits.
    pub sub: Option<(usize, f32, f32, f32)>,
    /// Stays open as items are picked: the checkbox menus, which are for picking several.
    pub keep_open: bool,
}

/// What a name prompt is for, so the app knows what to do with the answer.
#[derive(Clone, Debug)]
pub enum PromptKind {
    Rename(PathBuf),
    NewFolder(PathBuf),
    /// A new folder that the selection then moves into.
    NewFolderWith(PathBuf, Vec<PathBuf>),
    /// The loop region saved beside the track it came from: the source and the seconds.
    SaveTrim(PathBuf, f64, f64),
}

#[derive(Clone, Debug)]
pub struct Prompt {
    pub kind: PromptKind,
    pub title: String,
    pub confirm: String,
    pub field: SearchBox,
    pub error: Option<String>,
    pub x: f32,
    pub y: f32,
    /// The name it opened with: an untouched rename is a cancel.
    pub initial: String,
}

#[derive(Clone, Debug)]
pub struct Dialog {
    pub title: String,

    pub confirm: String,
    pub destructive: bool,
    pub paths: Vec<PathBuf>,
    /// Set when confirming packs this project from another machine, rather than deleting.
    pub pack: Option<String>,
    /// The description broken into lines by measured width, as the panel will hold them.
    pub lines: Vec<String>,
}

/// `TagEditor` in its popover: the tags on the selection, a field, and every other tag ranked
/// against what is typed.
#[derive(Clone, Debug)]
pub struct TagEditor {
    pub paths: Vec<String>,
    pub label: String,
    pub field: SearchBox,
    /// Each tag on any selected path, and on how many.
    pub applied: Vec<(String, usize)>,
    /// What the arrows walk: (tag, files carrying it), with -1 for the "Create" row.
    pub rows: Vec<(String, i64)>,
    pub highlight: usize,
    pub x: f32,
    pub y: f32,
}

pub const TAG_ROW: f32 = 25.25;

pub const ITEM_HEIGHT: f32 = 26.75;
pub const LABEL_HEIGHT: f32 = 23.75;
pub const SEPARATOR_HEIGHT: f32 = 9.0;
pub const MENU_PAD: f32 = 4.0;

pub fn height_of(items: &[MenuItem]) -> f32 {
    items
        .iter()
        .map(|item| match item {
            MenuItem::Label(_) => LABEL_HEIGHT,
            MenuItem::Separator => SEPARATOR_HEIGHT,
            _ => ITEM_HEIGHT,
        })
        .sum::<f32>()
        + MENU_PAD * 2.0
        + 2.0
}

/// Where each item's top sits inside the panel.
pub fn item_top(items: &[MenuItem], index: usize) -> f32 {
    MENU_PAD + 1.0 + height_of(&items[..index]) - MENU_PAD * 2.0 - 2.0
}

fn panel(t: &Theme, x: f32, y: f32, width: f32) -> El<Action> {
    // `rounded-md border bg-popover p-1 shadow-lg`.
    col().absolute(x, y).w(width).p(MENU_PAD).rounded(6.0).bg(t.popover).border(t.border, 1.0).shadow(4.0, 12.0, 0.25)
}

fn items_el(t: &Theme, items: &[MenuItem], hover: Option<usize>, open_sub: Option<usize>, sub: bool) -> Vec<El<Action>> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| match item {
            MenuItem::Label(label) => div().h(LABEL_HEIGHT).shrink0().items_center().px(8.0).child(text(label.clone(), style(10.5, 400, t.muted_foreground)).min_w(0.0)),
            MenuItem::Separator => div().h(SEPARATOR_HEIGHT).shrink0().ml(-MENU_PAD).mr(-MENU_PAD).items_center().child(div().h(1.0).grow().bg(t.border)),
            MenuItem::Item { icon: glyph, label, shortcut, enabled, .. } => {
                let lit = *enabled && hover == Some(index);
                let mut row = div()
                    .h(ITEM_HEIGHT)
                    .shrink0()
                    .items_center()
                    .gap(8.0)
                    .px(8.0)
                    .rounded(4.0)
                    .opacity(if *enabled { 1.0 } else { 0.5 })
                    .maybe(lit, |el| el.bg(t.accent))
                    .child(icon(glyph, 14.0, t.popover_foreground))
                    .child(text(label.clone(), style(12.5, 400, if lit { t.accent_foreground } else { t.popover_foreground })).min_w(0.0));
                if let Some(keys) = shortcut {
                    row = row.child(text(keys.clone(), TextStyle { tracking: 0.025, ..style(10.5, 400, t.muted_foreground.alpha(0.6)) }).ml_auto().pl(20.0).shrink0());
                }
                if *enabled {
                    row = row.on(if sub { Action::SubItem(index) } else { Action::MenuItem(index) });
                }
                row
            }
            MenuItem::Sub { icon: glyph, label, .. } => {
                let lit = hover == Some(index) || open_sub == Some(index);
                div()
                    .h(ITEM_HEIGHT)
                    .shrink0()
                    .items_center()
                    .gap(8.0)
                    .px(8.0)
                    .rounded(4.0)
                    .maybe(lit, |el| el.bg(t.accent))
                    .on(Action::MenuItem(index))
                    .child(icon(glyph, 14.0, t.popover_foreground))
                    .child(text(label.clone(), style(12.5, 400, t.popover_foreground)).min_w(0.0))
                    .child(icon("chevron-right", 14.0, t.muted_foreground).ml_auto().pl(4.0))
            }
        })
        .collect()
}

/// Everything that floats, in order, for the root to lay over the explorer.
pub fn layers(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let mut out = Vec::new();
    if let Some(menu) = &s.menu {
        out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).on(Action::Dismiss));
        // A long menu (the type filter on a library of forty extensions) stops at the window.
        out.push(panel(t, menu.x, menu.y, menu.width).max_h(viewport.1 - menu.y - 8.0).clip().children(items_el(t, &menu.items, menu.hover, menu.sub.map(|s| s.0), false)));
        if let Some((index, x, y, width)) = menu.sub {
            if let Some(MenuItem::Sub { items, .. }) = menu.items.get(index) {
                out.push(panel(t, x, y, width).children(items_el(t, items, s.sub_hover, None, true)));
            }
        }
    }
    if let Some(prompt) = &s.prompt {
        out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).on(Action::Dismiss));
        out.push(prompt_el(t, prompt));
    }
    if let Some(editor) = &s.tag_editor {
        out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).on(Action::Dismiss));
        out.push(tag_editor_el(t, editor));
    }
    if let Some(picker) = &s.color_picker {
        out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).on(Action::Dismiss));
        let (label, presets): (String, &[&str]) = match picker.target {
            crate::color_picker::Target::Accent => ("Accent colour".into(), &crate::color_picker::ACCENT_PRESETS),
            crate::color_picker::Target::Background => ("Background colour".into(), &crate::color_picker::SURFACE_PRESETS),
            crate::color_picker::Target::Stop(i) => (format!("Stop {}", i + 1), &crate::color_picker::ACCENT_PRESETS),
        };
        out.push(crate::color_picker::popover(s, t, picker, &label, presets));
    }
    if let Some(dialog) = &s.dialog {
        // `bg-black/50` over everything; the panel centred.
        out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).bg(Rgba::rgb8(0, 0, 0).alpha(0.5)).on(Action::Dismiss));
        out.push(dialog_el(t, dialog, viewport));
    }
    out.extend(transport_popovers(s, t, viewport));
    if let Some(notice) = &s.notice {
        out.push(
            div()
                .absolute((viewport.0 - 360.0) / 2.0, viewport.1 - 64.0)
                .w(360.0)
                .min_w(0.0)
                .px(12.0)
                .py(8.0)
                .rounded(6.0)
                .bg(t.popover)
                .border(t.border, 1.0)
                .shadow(4.0, 12.0, 0.25)
                .on(Action::Dismiss)
                .child(text(notice.clone(), style(12.0, 400, t.popover_foreground)).min_w(0.0)),
        );
    }
    out
}

/// Where a transport button is, from the last frame's hit boxes.
fn anchor(s: &State, action: &Action) -> Option<[f32; 4]> {
    s.anchors.iter().find(|(a, _)| a == action).map(|(_, r)| *r)
}

/// The transport's popovers, above their buttons: the volume slider (`VolumeControl`), the
/// queue (`Up next`) and varispeed (`VarispeedControl`).
fn transport_popovers(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let mut out = Vec::new();
    let tr = &s.transport;
    let panel = |x: f32, bottom: f32, w: f32, h: f32| col().absolute(x.clamp(4.0, viewport.0 - w - 4.0), (bottom - h).max(4.0)).w(w).rounded(6.0).bg(t.popover).border(t.border, 1.0).shadow(4.0, 12.0, 0.25);
    if tr.volume_open {
        if let Some(r) = anchor(s, &Action::Volume) {
            // `p-2`, a 96px slider turned upright, and the level under it.
            let (w, h) = (40.0, 2.0 + 16.0 + 96.0 + 6.0 + 16.0);
            let level = if tr.muted { 0.0 } else { tr.volume };
            let slider = paint_slider(t, level);
            out.push(
                panel((r[0] + r[2]) / 2.0 - w / 2.0, r[1] - 2.0, w, h)
                    .p(8.0)
                    .items_center()
                    .gap(6.0)
                    .on(Action::VolumePanel)
                    .child(crate::ui::tree::paint(slider).w(24.0).h(96.0).on(Action::VolumeSlider))
                    .child(text(if tr.muted { "muted".to_string() } else { format!("{}%", (tr.volume * 100.0).round()) }, crate::screen::tnum(10.5, 400, t.muted_foreground))),
            );
        }
    }
    if tr.queue_open {
        if let Some(r) = anchor(s, &Action::Queue) {
            out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).on(Action::Dismiss));
            let rows = tr.queue.len().min(10) as f32;
            let h = 2.0 + 8.0 + 23.0 + rows * 26.0;
            let mut list = panel(r[0], r[1] - 6.0, 288.0, h).p(4.0).child(div().h(23.0).items_center().px(8.0).child(text(format!("Queue · {}", tr.queue.len()), style(10.5, 600, t.muted_foreground))));
            let first = tr.queue_index.saturating_sub(4).min(tr.queue.len().saturating_sub(10));
            for (i, name) in tr.queue.iter().enumerate().skip(first).take(10) {
                let color = if i == tr.queue_index { t.primary } else if i < tr.queue_index { t.foreground.alpha(0.5) } else { t.foreground };
                list = list.child(
                    div()
                        .h(26.0)
                        .shrink0()
                        .items_center()
                        .gap(8.0)
                        .px(8.0)
                        .rounded(4.0)
                        .hover_bg(t.accent)
                        .on(Action::QueueRow(i))
                        .child(text((i + 1).to_string(), crate::screen::tnum(10.5, 400, t.muted_foreground.alpha(0.6))).w(20.0).shrink0())
                        .child(text(name.clone(), style(12.0, 400, color)).min_w(0.0)),
                );
            }
            out.push(list);
        }
    }
    if tr.varispeed_open {
        if let Some(r) = anchor(s, &Action::Varispeed) {
            out.push(div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).on(Action::Dismiss));
            let bpm = s.now.as_ref().and_then(|n| n.file.bpm);
            let rate = crate::app::rate_for(bpm, tr.varispeed);
            let semitones = 12.0 * rate.log2();
            let stepper = |label: &str, value: String, unit: &str, held: bool, enabled: bool, tempo: bool| {
                div()
                    .h(24.0)
                    .items_center()
                    .gap(4.0)
                    .child(text(label.to_string(), style(11.0, 400, t.muted_foreground)).w(52.0).shrink0())
                    .child(div().size(24.0, 24.0).items_center().justify_center().rounded(6.0).opacity(if enabled { 1.0 } else { 0.4 }).maybe(enabled, |el| el.hover_bg(t.accent).on(Action::VarispeedStep(tempo, -1))).child(icon("minus", 12.0, t.popover_foreground)))
                    .child(div().grow().h(24.0).items_center().justify_center().rounded(2.0).border(if held { t.primary.alpha(0.6) } else { t.border }, 1.0).bg(t.background).child(text(value, crate::screen::tnum(12.0, 400, if held { t.primary } else { t.foreground }))))
                    .child(div().size(24.0, 24.0).items_center().justify_center().rounded(6.0).opacity(if enabled { 1.0 } else { 0.4 }).maybe(enabled, |el| el.hover_bg(t.accent).on(Action::VarispeedStep(tempo, 1))).child(icon("plus", 12.0, t.popover_foreground)))
                    .child(text(unit.to_string(), style(10.5, 400, t.muted_foreground)).w(28.0).shrink0())
            };
            let held_bpm = tr.varispeed.is_some_and(|v| v.0);
            let held_st = tr.varispeed.is_some_and(|v| !v.0);
            let playing_bpm = bpm.map(|b| b * rate);
            let mut body = panel(r[0] + 12.0 - 120.0, r[1] - 6.0, 240.0, 2.0 + 20.0 + 24.0 + 6.0 + 24.0 + 8.0 + 1.0 + 8.0 + 16.0 * 3.0 + 20.0)
                .p(10.0)
                .child(
                    div()
                        .mb(8.0)
                        .items_center()
                        .justify_between()
                        .child(text("Varispeed", style(11.0, 600, t.popover_foreground)))
                        .child(div().h(20.0).items_center().px(6.0).rounded(6.0).opacity(if tr.varispeed.is_some() { 1.0 } else { 0.4 }).maybe(tr.varispeed.is_some(), |el| el.hover_bg(t.accent).on(Action::VarispeedReset)).child(text("Reset", style(10.5, 500, t.muted_foreground)))),
                )
                .child(stepper("Tempo", playing_bpm.map(crate::screen::trimmed).unwrap_or_else(|| "-".into()), "BPM", held_bpm, bpm.is_some(), true))
                .child(stepper("Pitch", crate::screen::signed(semitones), "st", held_st, true, false).mt(6.0));
            let mut info = col().mt(8.0).pt(8.0).border_t(t.border).gap(2.0);
            info = info.child(text(
                match bpm {
                    Some(b) => format!("{} → {} BPM · {}% speed", crate::screen::trimmed(b), crate::screen::trimmed(b * rate), (rate * 1000.0).round() / 10.0),
                    None => format!("Tempo unknown · {}% speed", (rate * 1000.0).round() / 10.0),
                },
                crate::screen::tnum(10.5, 400, t.muted_foreground),
            ));
            info = info.child(text("Tempo and pitch move together, like tape. Shift steps by 0.1.", style(10.5, 400, t.muted_foreground.alpha(0.6))).min_w(0.0));
            body = body.child(info);
            out.push(body);
        }
    }
    out
}

/// Chromium's range input with `accent-color: var(--primary)`, turned a quarter anticlockwise
/// so the maximum is at the top: a 4px track, filled up to the value, and a round thumb.
fn paint_slider(t: &Theme, level: f32) -> crate::ui::tree::Painter {
    let (fill, rest) = (t.primary, t.border);
    std::rc::Rc::new(move |pm: &mut resvg::tiny_skia::PixmapMut, r: [f32; 4], scale: f32| {
        let cx = (r[0] + r[2]) / 2.0;
        let (top, bottom) = (r[1] + 8.0 * scale, r[3] - 8.0 * scale);
        let y = bottom - (bottom - top) * level.clamp(0.0, 1.0);
        let half = 2.0 * scale;
        crate::ui::tree::fill_rect(pm, [(cx - half) / scale, top / scale, (cx + half) / scale, y / scale], [r[0] / scale, r[1] / scale, r[2] / scale, r[3] / scale], 2.0, rest, scale);
        crate::ui::tree::fill_rect(pm, [(cx - half) / scale, y / scale, (cx + half) / scale, bottom / scale], [r[0] / scale, r[1] / scale, r[2] / scale, r[3] / scale], 2.0, fill, scale);
        let thumb = 8.0 * scale;
        crate::ui::tree::fill_rect(pm, [(cx - thumb) / scale, (y - thumb) / scale, (cx + thumb) / scale, (y + thumb) / scale], [r[0] / scale, r[1] / scale - 8.0, r[2] / scale, r[3] / scale + 8.0], 8.0, fill, scale);
    })
}

/// `size="sm"` buttons: `h-6 px-2 text-[12px] font-medium`, ghost or filled.
fn button(t: &Theme, label: &str, filled: Option<(Rgba, Rgba)>, action: Action) -> El<Action> {
    let el = div().h(24.0).items_center().px(8.0).rounded(6.0).on(action);
    match filled {
        Some((bg, fg)) => el.bg(bg).hover_bg(bg.alpha(0.9)).child(text(label.to_string(), style(12.0, 500, fg))),
        None => el.hover_bg(t.accent).child(text(label.to_string(), style(12.0, 500, t.popover_foreground))),
    }
}

fn prompt_el(t: &Theme, prompt: &Prompt) -> El<Action> {
    let field = Field {
        value: prompt.field.value.clone(),
        placeholder: String::new(),
        caret: prompt.field.caret,
        anchor: prompt.field.anchor,
        focused: true,
        style: TextStyle { line_height: 16.0, ..style(12.5, 400, t.foreground) },
        placeholder_color: t.muted_foreground.alpha(0.7),
        selection: t.selection,
    };
    // `h-7 rounded-md border bg-background px-2`, focused: the ring's colour and a 1px ring.
    let input_box = div()
        .h(30.0)
        .p(1.0)
        .rounded(7.0)
        .bg(t.ring)
        .ml(-1.0)
        .mr(-1.0)
        .child(div().grow().h(28.0).items_center().px(8.0).rounded(6.0).bg(t.background).border(t.ring, 1.0).on(Action::PromptField).child(input(field).grow().h_full()));
    let mut body = col()
        .absolute(prompt.x, prompt.y)
        .w(320.0)
        .p(8.0)
        .rounded(6.0)
        .bg(t.popover)
        .border(t.border, 1.0)
        .shadow(4.0, 12.0, 0.25)
        .child(div().mb(6.0).child(text(prompt.title.clone(), style(11.0, 400, t.muted_foreground)).min_w(0.0)))
        .child(input_box);
    if let Some(error) = &prompt.error {
        body = body.child(div().mt(6.0).child(text(error.clone(), style(11.0, 400, t.destructive)).min_w(0.0)));
    }
    let ready = !prompt.field.value.trim().is_empty();
    body.child(
        div()
            .mt(8.0)
            .justify_end()
            .gap(6.0)
            .child(button(t, "Cancel", None, Action::Dismiss))
            .child(button(t, &prompt.confirm, Some((t.primary, t.primary_foreground)), Action::PromptConfirm).opacity(if ready { 1.0 } else { 0.4 })),
    )
}

/// The input every popover field shares: `h-7 rounded-md border bg-background px-2`, with the
/// focus ring.
fn focused_input(t: &Theme, field: &SearchBox, placeholder: &str, action: Action) -> El<Action> {
    let field = Field {
        value: field.value.clone(),
        placeholder: placeholder.to_string(),
        caret: field.caret,
        anchor: field.anchor,
        focused: true,
        style: TextStyle { line_height: 16.0, ..style(12.5, 400, t.foreground) },
        placeholder_color: t.muted_foreground.alpha(0.7),
        selection: t.selection,
    };
    div()
        .h(30.0)
        .shrink0()
        .p(1.0)
        .rounded(7.0)
        .bg(t.ring)
        .ml(-1.0)
        .mr(-1.0)
        .child(div().grow().h(28.0).items_center().px(8.0).rounded(6.0).bg(t.background).border(t.ring, 1.0).on(action).child(input(field).grow().h_full()))
}

fn tag_editor_el(t: &Theme, editor: &TagEditor) -> El<Action> {
    let whole = editor.paths.len();
    let mut body = col()
        .absolute(editor.x, editor.y)
        .w(288.0)
        .p(8.0)
        .rounded(6.0)
        .bg(t.popover)
        .border(t.border, 1.0)
        .shadow(4.0, 12.0, 0.25)
        .child(div().mb(6.0).child(text(editor.label.clone(), style(11.0, 400, t.muted_foreground)).min_w(0.0)));
    if !editor.applied.is_empty() {
        // A tag on some of a selection is not one on all of it: faded, with how many.
        body = body.child(div().mb(8.0).wrap().gap(4.0).children(editor.applied.iter().enumerate().map(|(i, (tag, count))| {
            let partial = *count != whole;
            let mut badge = div()
                .h(22.0)
                .items_center()
                .gap(4.0)
                .pl(6.0)
                .pr(4.0)
                .rounded(4.0)
                .bg(t.secondary)
                .border(t.border.alpha(0.6), 1.0)
                .child(text(tag.clone(), TextStyle { tracking: 0.025, line_height: 16.0, ..style(10.5, 500, t.secondary_foreground) }).opacity(if partial { 0.6 } else { 1.0 }));
            if partial {
                badge = badge.child(text(count.to_string(), crate::screen::tnum(10.0, 400, t.muted_foreground)));
            }
            badge.child(div().size(12.0, 12.0).items_center().justify_center().rounded(2.0).on(Action::TagRemove(i)).child(icon("x", 10.0, t.muted_foreground)))
        })));
    }
    body = body.child(focused_input(t, &editor.field, "Add a tag, then Enter", Action::PromptField));
    if !editor.rows.is_empty() {
        // Capped and scrolled to the highlight, as `max-h-[168px] overflow-y-auto` with
        // `scrollIntoView` keeps it.
        let visible = (168.0 / TAG_ROW).floor() as usize;
        let first = editor.highlight.saturating_sub(visible.saturating_sub(1));
        let mut list = col().mt(6.0).max_h(168.0).clip();
        for (index, (tag, count)) in editor.rows.iter().enumerate().skip(first).take(visible + 1) {
            let lit = index == editor.highlight;
            let fg = if lit { t.foreground } else { t.muted_foreground };
            let mut row = div().h(TAG_ROW).shrink0().items_center().gap(6.0).px(6.0).rounded(4.0).maybe(lit, |el| el.bg(t.accent)).on(Action::TagRow(index));
            row = if *count < 0 {
                row.child(icon("plus", 12.0, fg)).child(text("Create ", style(11.5, 400, fg))).child(text(tag.clone(), style(11.5, 400, t.foreground)).ml(-6.0).min_w(0.0))
            } else {
                row.child(text(tag.clone(), style(11.5, 400, fg)).min_w(0.0)).child(text(count.to_string(), crate::screen::tnum(10.5, 400, t.muted_foreground.alpha(0.5))).ml_auto().shrink0())
            };
            list = list.child(row);
        }
        body = body.child(list);
    }
    body
}

fn dialog_el(t: &Theme, dialog: &Dialog, viewport: (f32, f32)) -> El<Action> {
    let width = 380f32.min(viewport.0 - 32.0);
    let confirm = if dialog.destructive { (t.destructive, t.destructive_foreground) } else { (t.primary, t.primary_foreground) };
    // Centred on its height: padding, the title, the description's lines, the buttons.
    let height = 16.0 + 19.5 + 6.0 + dialog.lines.len().max(1) as f32 * 17.25 + 16.0 + 24.0 + 16.0 + 2.0;
    col()
        .absolute(((viewport.0 - width) / 2.0).round(), ((viewport.1 - height) / 2.0).round())
        .w(width)
        .p(16.0)
        .rounded(8.0)
        .bg(t.popover)
        .border(t.border, 1.0)
        .shadow(16.0, 40.0, 0.35)
        .child(text(dialog.title.clone(), style(13.0, 500, t.popover_foreground)).min_w(0.0))
        .child(col().mt(6.0).children(dialog.lines.iter().map(|line| text(line.clone(), style(11.5, 400, t.muted_foreground)).min_w(0.0))))
        // Windows puts the confirming button left of Cancel.
        .child(div().mt(16.0).justify_end().gap(6.0).child(button(t, &dialog.confirm, Some(confirm), Action::DialogConfirm)).child(button(t, "Cancel", None, Action::Dismiss)))
        .child(div().absolute(width - 32.0, 8.0).size(22.0, 22.0).items_center().justify_center().rounded(4.0).hover_bg(t.accent).on(Action::Dismiss).child(icon("x", 14.0, t.muted_foreground)))
}

/// A paragraph broken into lines by word at `width`, by measured text - a dialog's
/// description is the one place prose wraps.
pub fn wrap(paragraph: &str, width: f32, measure: &mut dyn FnMut(&str) -> f32) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in paragraph.split_whitespace() {
        let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        if !line.is_empty() && measure(&candidate) > width {
            lines.push(std::mem::replace(&mut line, word.to_string()));
        } else {
            line = candidate;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// The widest an item list needs, for the panel's width: `min-w-[11rem]`.
pub fn width_of(items: &[MenuItem], measure: &mut dyn FnMut(&str, &TextStyle) -> f32, t: &Theme) -> f32 {
    let item_style = style(12.5, 400, t.popover_foreground);
    let key_style = TextStyle { tracking: 0.025, ..style(10.5, 400, t.muted_foreground) };
    let widest = items
        .iter()
        .map(|item| match item {
            MenuItem::Label(label) => measure(label, &style(10.5, 400, t.muted_foreground)) + 16.0,
            MenuItem::Separator => 0.0,
            MenuItem::Item { label, shortcut, .. } => 8.0 + 14.0 + 8.0 + measure(label, &item_style) + shortcut.as_ref().map_or(0.0, |k| 20.0 + measure(k, &key_style)) + 8.0,
            MenuItem::Sub { label, .. } => 8.0 + 14.0 + 8.0 + measure(label, &item_style) + 8.0 + 4.0 + 14.0 + 8.0,
        })
        .fold(0.0, f32::max);
    // Long labels (a file name) are cut rather than making the menu as wide as the window.
    (widest + MENU_PAD * 2.0 + 2.0).clamp(176.0, 352.0).ceil()
}
