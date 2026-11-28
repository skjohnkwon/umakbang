//! The explorer screen, built to match the Electron app at the same window size.
//!
//! Numbers are not guesses: each comes from the running Electron app (element boxes, computed
//! colours and fonts, captured over the DevTools protocol), noted where they are not obvious.
//! The layout follows the components it replaces - `TitleBar`, `Sidebar`, `PaneBar`,
//! `FileTable`, `NowPlayingBar`, `VisualizerPanel`.

use crate::columns::{Column, ColumnId, Sort};
use crate::layout::{Handle, Sizes};
use crate::table::FileMeta;
use crate::library::{FileRow, FolderRow, format_count};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::text::TextStyle;
use crate::ui::tree::{El, Field, Painter, col, div, icon, icon_filled, input, paint, text, para};
use crate::userdata::QuickFolder;
use resvg::tiny_skia::{Paint, PathBuilder, Pixmap, PixmapMut, Stroke, Transform};
use crate::visualizers::Visuals;
use crate::waveform::{Status, Wave};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

#[derive(Clone, PartialEq, Debug)]
pub enum Action {
    Drag,
    Minimize,
    Maximize,
    Close,
    Back,
    Forward,
    Up,
    Refresh,
    NewFolder,
    Split,
    Crumb(i64),
    /// A press on a table row: folders first, then files, as the table lists them.
    Row(usize),
    /// A header click: sort by that key (`setSort`).
    SortBy(&'static str),
    /// The boundary after a column, dragged to resize it.
    ColumnResize(ColumnId),
    /// A star in the Rating column: file index, stars.
    Rate(usize, u8),
    Nav(&'static str),
    /// The Stats page: a date range, a chart's metric (chart, projects-or-hours), and a chart
    /// under the pointer.
    StatsRange(usize),
    StatsMetric(u8, bool),
    Chart(u8),
    /// The YT2MP3 page: close, link, install, download, stop, format, bitrate; and Show for
    /// the folder (None) or one of this sitting's files.
    Yt(&'static str),
    YtShow(Option<usize>),
    /// A form field taking the keyboard.
    Field(&'static str),
    /// Contracts: a named button, a section, a record's open/show/forget (0/1/2), a preset's
    /// delete, a preset chip in the draft, the preview pane.
    Contracts(&'static str),
    ContractsSection(usize),
    ContractRecord(usize, u8),
    ContractPreset(usize),
    ContractChip(usize),
    ContractPreview,
    /// The split dialog and the Stems settings: settings, cancel, split, check, model.
    Stems(&'static str),
    /// Analysis settings: the scope tag's list, and testing the external key command.
    AnalysisTag,
    KeyTest,
    /// Shortcuts: listen for a new key, put one back, put them all back.
    ShortcutBind(&'static str),
    ShortcutReset(&'static str),
    ShortcutsReset,
    /// Updates: open or close a changelog entry. Developer: replay the tour. Player: the
    /// output device list.
    Changelog(usize),
    /// Settings → Updates: ask GitHub now; restart into the staged version.
    UpdateCheck,
    UpdateRestart,
    /// Remote: ask the tailnet again.
    PeersRefresh,
    /// Plugins: open the favourites manager, close it; pick a row (side, index); pick a side;
    /// move what is picked (to favourites or back); a format chip, clear them; look at FL again;
    /// compare with a machine on the tailnet.
    FlManage,
    FlClose,
    FlPick(u8, usize),
    FlSelectAll(u8),
    FlMove(bool),
    FlFormat(usize),
    FlFormatsClear,
    FlRecheck,
    PluginsCompare(usize),
    /// Remote: open a peer's library in the explorer (the serving peer, then the library).
    BrowseLibrary(usize, usize),
    /// Backup: write a bundle (true asks where), import a bundle or settings file. The import
    /// wizard: locate a folder, skip it, find them all in one folder, import, cancel. A peer's
    /// tags and ratings into the wizard; another machine's newer settings.
    BackupExport(bool),
    BackupImport,
    ImportLocate(usize),
    ImportSkip(usize),
    ImportFindAll,
    /// The folders already placed, shown or hidden again.
    ImportShowPlaced,
    ImportApply,
    ImportCancel,
    RemoteImport(usize),
    SyncSettings,
    /// The first-run tour's Skip.
    TourSkip,
    /// The split explorer: close the pane this is in, and the divider between the two.
    ClosePane,
    PaneDivider,
    ReplayTour,
    OutputMenu,
    /// Appearance: open a picker (0 accent, 1 background, 2 a gradient stop), its field, its
    /// hue bar, a preset, its reset; add a stop; reset the theme (0, 1), the stops, headroom;
    /// a gradient preset.
    Pick(u8, usize),
    PickerArea,
    PickerHue,
    PickerPreset(usize),
    PickerReset,
    StopAdd,
    ThemeReset(u8),
    StopsReset,
    HeadroomReset,
    GradientPreset(usize),
    Quick(usize),
    Tag(usize),
    Tool(&'static str),
    Play,
    Previous,
    Next,
    /// A press on the transport's waveform: seek to where it landed.
    Seek,
    Search,
    TagSearch,
    /// The toolbar's Clear N: the search and every tag filter (`clearAllFilters`).
    ClearFilters,
    /// The tag strip's Clear: every tag filter off.
    ClearTags,
    /// A star row in the sidebar: files rated exactly this.
    Stars(u8),
    /// A press outside a menu, prompt or dialog, or on its Cancel: closes it.
    Dismiss,
    /// The mark in the title bar: About.
    About,
    /// About's GitHub button.
    AboutSource,
    /// An item of the open menu, and of its submenu.
    MenuItem(usize),
    SubItem(usize),
    /// The prompt's text box, its confirm button, and the dialog's.
    PromptField,
    /// The tag editor's rows and the x on an applied tag; a press in a Notes cell.
    TagRow(usize),
    TagRemove(usize),
    Note(usize),
    PromptConfirm,
    DialogConfirm,
    /// The transport's popover buttons, and what is inside them: the volume slider, the queue's
    /// rows, varispeed's steppers and Reset.
    Volume,
    VolumeSlider,
    VolumePanel,
    Queue,
    QueueRow(usize),
    Varispeed,
    VarispeedStep(bool, i8),
    VarispeedReset,
    /// The project clock beside the details: shows the project.
    ProjectTime,
    /// The Settings page: a section, its close button, and its controls by setting key.
    SettingsSection(usize),
    SettingsClose,
    SettingSwitch(&'static str),
    SettingChoice(&'static str, &'static str),
    /// A setting that is a folder: the system picker, then the setting.
    SettingPick(&'static str),
    SettingSlider(&'static str),
    SettingRemove(&'static str, usize),
    /// The search box's clear button.
    ClearSearch,
    /// A row of the folder tree: browse it. Its chevron only folds it.
    TreeRow(usize),
    /// The transport's scissors, and Save selection.
    Trim,
    TrimSave,
    TreeChevron(usize),
    /// The tree heading's buttons: the playing track's folder, and adding a library folder.
    Locate,
    AddFolder,
    /// A press on one of the pane handles: drag it, or double-click it back to its default.
    Resize(Handle),
}

/// A saved view, or the folder in `State::folder`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum View {
    Folder,
    /// Files rated `min..=max` stars, from anywhere.
    Rated(u8, u8),
    /// The OS Downloads folder, read from disk rather than the index.
    Downloads,
    /// The Settings page, over the explorer.
    Settings,
    /// The production stats.
    Stats,
    /// YT2MP3.
    Downloading,
    /// Contracts.
    Contracts,
}

impl View {
    /// A page rather than a list of files: no folder tools in the title bar.
    pub fn is_page(self) -> bool {
        matches!(self, View::Settings | View::Stats | View::Downloading | View::Contracts)
    }
}

impl State {
    /// Whether the rows come from more than one folder, so each says where it lives.
    pub fn spans_folders(&self) -> bool {
        self.searching || self.view != View::Folder
    }
}

/// What is typed in the search box, where the caret and selection are (byte offsets), and
/// whether it has the keyboard.
#[derive(Clone, Debug, Default)]
pub struct SearchBox {
    pub value: String,
    pub caret: usize,
    pub anchor: usize,
    pub focused: bool,
}

/// One row of the sidebar's folder tree.
#[derive(Clone)]
pub struct TreeRow {
    pub id: i64,
    pub name: String,
    pub depth: usize,
    pub files: i64,
    pub has_children: bool,
    pub open: bool,
    pub kind: TreeKind,
}

/// What a tree row stands for, which decides its glyph.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TreeKind {
    Folder,
    /// This machine: its library, under its name.
    This { mac: bool },
    /// Another machine; faded while it is not answering.
    Device { mac: bool, online: bool },
    /// A folder on another machine being listed.
    Loading,
}

/// The track in the transport.
pub struct NowPlaying {
    pub file: FileRow,
    /// The detail line under the name, already formatted (`formatDetails`).
    pub details: String,
    pub time: f64,
    pub duration: f64,
    pub playing: bool,
    pub wave: Rc<RefCell<Wave>>,
    /// How long the FL Studio project of the same name has been open (`ProjectTime`), and
    /// where it is.
    pub project: Option<(f64, String)>,
}

/// The transport's level and varispeed, and which of its popovers is open.
#[derive(Clone, Debug)]
pub struct Transport {
    pub volume: f32,
    pub muted: bool,
    pub volume_open: bool,
    pub queue_open: bool,
    pub varispeed_open: bool,
    /// Held by tempo or by interval (`Varispeed`): `(by_bpm, value)`.
    pub varispeed: Option<(bool, f64)>,
    /// The queue as names, and which is playing.
    pub queue: Vec<String>,
    pub queue_index: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct Split {
    pub ratio: f32,
    pub second_active: bool,
}

/// The widths of the two panes in a middle column this wide: main on the left, second on the
/// right, a pixel of border between.
pub fn pane_widths(middle: f32, ratio: f32) -> (f32, f32) {
    let left = ((middle - 1.0) * ratio).round().max(0.0);
    (left, (middle - 1.0 - left).max(0.0))
}

pub struct State {
    pub folder: FolderRow,
    /// Said in place of an empty table: a folder on another machine still being listed, or why
    /// it could not be.
    pub folder_status: Option<String>,
    /// This machine's name, which the library's own root goes by in the Devices section.
    pub this_device: String,
    pub crumbs: Vec<FolderRow>,
    pub folders: Vec<FolderRow>,
    pub files: Vec<FileRow>,
    /// Selected rows, by their index in the table (folders first), and the one keyboard
    /// moves start from.
    pub selection: BTreeSet<usize>,
    pub focus: Option<usize>,
    pub scroll: f32,
    pub scroll_x: f32,
    pub columns: Vec<Column>,
    pub sort: Sort,
    /// The row under the pointer (`group-hover`), and the star it is over.
    pub hover_row: Option<usize>,
    pub hover_star: Option<(usize, u8)>,
    /// The column boundary hovered or dragged, lit like the pane handles.
    pub column_hot: Option<ColumnId>,
    pub ratings: HashMap<String, u8>,
    /// Per file of the open folder, in table order.
    pub file_meta: Vec<FileMeta>,
    /// The folder tree's rows as they are expanded, and how far each half of the sidebar is
    /// scrolled.
    pub tree: Vec<TreeRow>,
    /// The search box, and whether the table is showing its results rather than the folder.
    /// What the table is listing: a folder, or one of the saved views.
    pub view: View,
    /// Files whose tempo and key are being worked out right now: their cells turn.
    pub analysing: std::collections::HashSet<String>,
    /// Files that left the folder on screen while it was open (`unreachable`): kept where they
    /// were and drawn faded, because a row vanishing under the pointer means the next click
    /// lands on a different file. Gone once the folder is left.
    pub gone: std::collections::HashSet<String>,
    pub settings_section: usize,
    pub stats: crate::stats_page::StatsState,
    /// The Stats row in the sidebar (`showStats`).
    pub show_stats: bool,
    pub youtube: crate::download_page::YoutubeState,
    pub form: crate::form::Form,
    pub contracts: crate::contracts_page::ContractsUi,
    pub stem_dialog: Option<crate::stem_dialog::StemDialog>,
    pub fl_dialog: Option<crate::fl_plugins::Dialog>,
    pub importing: Option<crate::import_wizard::Wizard>,
    pub tour: Option<crate::tour::Tour>,
    /// Two folders at once (`docs/split-view.md`): where the divider is, and whether the pane
    /// being worked in - the one in these fields - is the second, right-hand one.
    pub split: Option<Split>,
    /// No library folder at all: the welcome screen instead of the explorer.
    pub no_library: bool,
    /// "Start fresh on next launch" is on, which is why there is no library.
    pub reset_armed: bool,
    pub stem_job: Option<crate::stem_dialog::StemJob>,
    pub stem_settings: crate::stem_dialog::StemSettings,
    /// The folder a dragged row would land in if let go now: a folder row, a tree row or a
    /// quick-access row, lit as `.drop-over` lights it.
    pub drop_over: Option<Action>,
    /// The window's modes: the mini player, visualizers only (the stage) and whether the
    /// pointer is over it, pin on top, and the visualizer panel.
    pub color_picker: Option<crate::color_picker::Picker>,
    pub mini_player: bool,
    /// The scissors: a drag on the waveform paints a loop region. The region, in seconds.
    pub trimming: bool,
    pub region: Option<(f64, f64)>,
    pub stage: bool,
    pub stage_hover: bool,
    pub always_on_top: bool,
    pub panel_open: bool,
    /// `youtubeFormat` and `youtubeBitrate`.
    pub youtube_settings: (String, u32),
    /// Whether the sidebar's two scrolling halves overflow, and so give a scrollbar its gutter
    /// - classic scrollbars take room only when there is something to scroll.
    pub nav_gutter: bool,
    pub tree_gutter: bool,
    pub settings_scroll: f32,
    pub settings_values: crate::settings_page::Values,
    pub transport: Transport,
    /// Where the transport's buttons were last drawn, for popovers to hang off.
    pub anchors: Vec<(Action, [f32; 4])>,
    /// What the scanner is doing, while it is: "checking for changes".
    pub scan_status: Option<String>,
    /// What floats over the explorer: the right-click menu (and the submenu item hovered),
    /// a name prompt, a confirmation, and a one-line notice.
    pub menu: Option<crate::overlay::Menu>,
    pub sub_hover: Option<usize>,
    pub prompt: Option<crate::overlay::Prompt>,
    pub tag_editor: Option<crate::overlay::TagEditor>,
    /// The Notes cell being typed in: which file, and the field.
    pub note_edit: Option<(String, SearchBox)>,
    pub dialog: Option<crate::overlay::Dialog>,
    /// About, open since then (`AboutDialog.tsx`); the name types itself out from it.
    pub about: Option<std::time::Instant>,
    pub notice: Option<String>,
    pub search: SearchBox,
    pub searching: bool,
    /// Folders off: every file at or beneath the folder, as one flat list (`recursive`).
    pub recursive: bool,
    /// Which title bar toggles are on, to light them: play on select, auto advance, audio
    /// only, and how many type filters there are.
    pub play_on_select: bool,
    pub auto_advance: bool,
    pub audio_only: bool,
    pub type_filters: usize,
    /// Every file the search matched; the table lists the best of them.
    pub search_total: usize,
    pub tree_scroll: f32,
    /// The sidebar's upper section, and the tag strip inside it (`overflow-y-auto`).
    pub nav_scroll: f32,
    pub tags_scroll: f32,
    /// Tags on the open folder's subfolders, by folder id.
    pub folder_tags: HashMap<i64, Vec<String>>,
    pub total_files: i64,
    pub stars: [usize; 5],
    pub rated_share: f64,
    pub quick: Vec<QuickFolder>,
    /// Each quick-access folder as a library path, or `None` for one outside the library.
    pub quick_dirs: Vec<Option<String>>,
    pub tags: Vec<(String, usize)>,
    /// The tags filtering the table (ANDed), and per tag in `tags` how many tagged paths
    /// clicking it would leave (`useTagFacets`).
    pub tag_filter: Vec<String>,
    pub tag_available: Vec<usize>,
    pub file_tags: HashMap<String, Vec<String>>,
    pub file_icons: HashMap<String, Rc<Pixmap>>,
    pub maximized: bool,
    /// What the transport has loaded; its controls are enabled by there being one.
    pub now: Option<NowPlaying>,
    pub visuals: Rc<RefCell<Visuals>>,
    /// The playing row's icon opacity, on Tailwind's `animate-pulse` curve.
    pub pulse: f32,
    pub can_back: bool,
    pub can_forward: bool,
    pub version: String,
    /// The pane sizes on screen, and which handle the pointer is over or dragging - which
    /// lights it, as `group-hover:bg-primary` does.
    pub sizes: Sizes,
    pub hot: Option<Handle>,
    pub resizing: Option<Handle>,
}

/// `.drop-over`: the primary at 22% with a 1px inset ring, on the folder a drag would land in.
pub fn drop_lit(el: El<Action>, s: &State, t: &Theme, action: Action) -> El<Action> {
    if s.drop_over.as_ref() != Some(&action) {
        return el;
    }
    let ring = t.primary;
    el.bg(t.primary.alpha(0.22)).overlay(std::rc::Rc::new(move |pm: &mut resvg::tiny_skia::PixmapMut, r: [f32; 4], scale: f32| {
        let w = scale.max(1.0);
        if let Some(rect) = resvg::tiny_skia::Rect::from_ltrb(r[0] + w / 2.0, r[1] + w / 2.0, r[2] - w / 2.0, r[3] - w / 2.0) {
            let path = resvg::tiny_skia::PathBuilder::from_rect(rect);
            let mut paint = resvg::tiny_skia::Paint::default();
            paint.set_color(ring.skia());
            pm.stroke_path(&path, &paint, &resvg::tiny_skia::Stroke { width: w, ..Default::default() }, resvg::tiny_skia::Transform::identity(), None);
        }
    }))
}

pub fn style(size: f32, weight: u16, color: Rgba) -> TextStyle {
    TextStyle { size, line_height: size * 1.5, weight, color, tabular: false, tracking: 0.0, grayscale: false, italic: false, font: crate::ui::text::Font::Sans }
}

pub fn tnum(size: f32, weight: u16, color: Rgba) -> TextStyle {
    TextStyle { tabular: true, ..style(size, weight, color) }
}

pub fn build(s: &State, t: &Theme, viewport: (f32, f32), other: Option<El<Action>>) -> El<Action> {
    // The shrunken windows are the whole window: no title bar, no sidebar.
    if s.mini_player {
        return crate::compact::mini(s, t, viewport).children(crate::overlay::layers(s, t, viewport));
    }
    if s.stage {
        return crate::compact::stage(s, t, viewport).children(crate::overlay::layers(s, t, viewport));
    }
    // No library yet: the title bar and the welcome screen - or Settings, which is reachable
    // before there is a library, since the cog is on screen and "Start fresh" leads here.
    if s.no_library {
        let page = if s.view == View::Settings { crate::settings_page::page(s, t, &s.settings_values).grow() } else { welcome(s, t) };
        return col()
            .w(viewport.0)
            .h(viewport.1)
            .bg(t.background)
            .child(title_bar(s, t))
            .child(div().grow().min_h0().child(page))
            .children(crate::import_wizard::dialog(s, t, viewport))
            .children(crate::overlay::layers(s, t, viewport));
    }
    let z = s.sizes;
    let middle = viewport.0 - z.sidebar - z.panel;
    let panel_glow = match (s.resizing, s.hot) {
        (Some(Handle::Panel), _) => Some(t.primary),
        (None, Some(Handle::Panel)) => Some(t.primary.alpha(0.5)),
        _ => None,
    };
    col()
        .w(viewport.0)
        .h(viewport.1)
        .bg(t.background)
        .child(title_bar(s, t))
        .child(
            div()
                .grow()
                .min_h0()
                .child(sidebar(s, t, viewport.1 - 38.0))
                .child(
                    // A page replaces the explorer; the transport stays, as it belongs to what
                    // is playing rather than to the page.
                    if s.view == View::Settings {
                        col().grow().min_h0().child(crate::settings_page::page(s, t, &s.settings_values).grow()).child(transport(s, t, middle))
                    } else if s.view == View::Stats {
                        col().grow().min_h0().child(crate::stats_page::page(s, t, middle)).child(transport(s, t, middle))
                    } else if s.view == View::Contracts {
                        col().grow().min_h0().child(crate::contracts_page::page(s, t, middle)).child(transport(s, t, middle))
                    } else if s.view == View::Downloading {
                        col().grow().min_h0().child(crate::download_page::page(s, t, middle)).child(transport(s, t, middle))
                    } else {
                        match (s.split, other) {
                            // Two panes over one transport: the one in the store's fields drawn
                            // here, the other built from its own, beside it.
                            (Some(split), Some(other)) => {
                                let (left, right) = pane_widths(middle, split.ratio);
                                let here = explorer_pane(s, t, viewport.1, if split.second_active { right } else { left }, true);
                                let (a, b) = if split.second_active { (other, here) } else { (here, other) };
                                col()
                                    .grow()
                                    .min_h0()
                                    .child(
                                        div()
                                            .grow()
                                            .min_h0()
                                            .child(a.w(left).shrink0())
                                            .child(div().w(1.0).shrink0().bg(t.border))
                                            .child(b.w(right).shrink0())
                                            // The divider's grip, 7px over the border.
                                            .child(div().absolute(left - 3.0, 0.0).w(7.0).h_full().on(Action::PaneDivider)),
                                    )
                                    .child(transport(s, t, middle))
                            }
                            _ => col().grow().min_h0().child(pane_bar(s, t, false)).child(crate::table::table(s, t, viewport.1, middle)).child(transport(s, t, middle)),
                        }
                    },
                )
                .maybe(s.panel_open, |el| el.child(crate::visualizers::panel(t, &s.visuals, viewport.1 - 38.0, z.panel, lit(s, t, Handle::Panel), panel_glow))),
        )
        // The handles that straddle a border, laid over everything last so they win the press
        // wherever they overlap the rows beside them - the `z-30` they carry in the Electron app.
        // 11px each, as `-right-[5px] w-[11px]` and its kin place them.
        .child(zone(Handle::Sidebar, z.sidebar - 6.0, 38.0, 11.0, viewport.1 - 38.0))
        .maybe(s.panel_open, |el| el.child(zone(Handle::Panel, viewport.0 - z.panel - 5.0, 38.0, 11.0, viewport.1 - 38.0)))
        .child(zone(Handle::Player, z.sidebar, viewport.1 - z.player - 5.0, middle, 11.0))
        .children(crate::contracts_page::dialog(s, t, viewport))
        .children(crate::stem_dialog::dialog(s, t, viewport))
        .children(crate::fl_plugins::dialog(s, t, viewport))
        .children(crate::import_wizard::dialog(s, t, viewport))
        .children(crate::overlay::layers(s, t, viewport))
        .children(crate::tour::overlay(s, t, viewport))
}

/// `NoLibrary`: what umakbang is, the one button that starts it, and the way in for somebody
/// coming from another machine.
fn welcome(s: &State, t: &Theme) -> El<Action> {
    let muted = t.muted_foreground;
    let mut page = col().grow().items_center().justify_center().gap(12.0).px(32.0);
    if s.reset_armed {
        page = page.child(
            col()
                .mb(4.0)
                .w(420.0)
                .px(12.0)
                .py(8.0)
                .rounded(6.0)
                .border(t.primary.alpha(0.4), 1.0)
                .bg(t.primary.alpha(0.1))
                .child(text("Started fresh, on purpose", style(12.0, 500, t.foreground)))
                .child(para("\u{201c}Start fresh on next launch\u{201d} is on in Settings \u{2192} Developer, so this launch came up as a new install. Nothing was deleted: your real library, tags and ratings are set aside, and they come back on the launch after you turn this off.", TextStyle { line_height: 17.9, ..style(11.0, 400, muted) }).mt(2.0))
                .child(
                    div()
                        .mt(6.0)
                        .h(24.0)
                        .px(8.0)
                        .items_center()
                        .self_start()
                        .rounded(6.0)
                        .bg(t.secondary)
                        .hover_bg(t.secondary.alpha(0.8))
                        .on(Action::SettingSwitch("resetOnLaunch"))
                        .child(text("Turn it off and restore on next launch", style(12.0, 500, t.secondary_foreground))),
                ),
        );
    }
    page.child(logo(t.primary.alpha(0.7), 36.0))
        .child(
            col()
                .items_center()
                .child(text("Point umakbang at your music folder", style(15.0, 500, t.foreground)))
                .child(text("it\u{2019}s pronounced oo-mahk-bahng", TextStyle { italic: true, ..style(11.0, 400, muted.alpha(0.6)) }).mt(2.0))
                .child(para("umakbang indexes every audio and project file underneath it, reads their tempo, key and format, and lets you audition anything without leaving the window.", TextStyle { line_height: 20.3, ..style(12.5, 400, muted) }).centered().w(380.0).mt(8.0)),
        )
        .child(
            div()
                .mt(4.0)
                .h(28.0)
                .px(10.0)
                .gap(6.0)
                .items_center()
                .rounded(6.0)
                .bg(t.primary)
                .hover_bg(t.primary.alpha(0.9))
                .on(Action::AddFolder)
                .child(icon("folder-open", 14.0, t.primary_foreground))
                .child(text("Choose folder", style(12.5, 500, t.primary_foreground))),
        )
        .child(text("Nothing is copied or moved unless you ask.", style(11.0, 400, muted.alpha(0.6))))
        .child(
            col()
                .mt(12.0)
                .w(340.0)
                .pt(12.0)
                .gap(4.0)
                .items_center()
                .border_t(t.border.alpha(0.5))
                .child(
                    div()
                        .h(24.0)
                        .px(8.0)
                        .gap(6.0)
                        .items_center()
                        .rounded(6.0)
                        .hover_bg(t.accent)
                        .on(Action::BackupImport)
                        .child(icon("download", 14.0, muted))
                        .child(text("Import settings\u{2026}", style(12.0, 500, muted))),
                )
                .child(para("Coming from another machine? Bring your tags, ratings and preferences across from a backup.", TextStyle { line_height: 17.9, ..style(11.0, 400, muted.alpha(0.6)) }).centered()),
        )
}

/// An invisible press target for a pane handle.
fn zone(handle: Handle, x: f32, y: f32, w: f32, h: f32) -> El<Action> {
    div().absolute(x, y).w(w.max(0.0)).h(h.max(0.0)).on(Action::Resize(handle))
}

/// A handle's grip colour: the border, lit while hovered or dragged.
fn lit(s: &State, t: &Theme, handle: Handle) -> Rgba {
    if s.resizing == Some(handle) || (s.resizing.is_none() && s.hot == Some(handle)) { t.primary } else { t.border }
}

/* ------------------------------------------------------------------ title bar */

fn title_bar(s: &State, t: &Theme) -> El<Action> {
    // A toggle that is on: `bg-primary/15 text-primary`.
    let lit = |name: &str| match name {
        "mouse-pointer-click" => s.play_on_select,
        "repeat" => s.auto_advance,
        "audio-lines" => s.audio_only,
        "folder-tree" => s.recursive,
        _ => false,
    };
    let tool = |name: &'static str, color: Rgba| {
        let on = lit(name);
        div()
            .size(24.0, 24.0)
            .items_center()
            .justify_center()
            .rounded(4.0)
            .maybe(on, |el| el.bg(t.primary.alpha(0.15)))
            .hover_bg(if on { t.primary.alpha(0.15) } else { t.accent })
            .on(Action::Tool(name))
            // Folders off draws the flat list it gives.
            .child(icon(if name == "folder-tree" && s.recursive { "list-music" } else { name }, 14.0, if on { t.primary } else { color }))
    };
    let first = ["mouse-pointer-click", "repeat", "wand-sparkles", "dices", "audio-lines", "folder-tree", "list-filter"];
    // The window's own controls: mini player, visualizers only, pin on top, the panel, Settings.
    // Named apart from their glyphs, since "audio-lines" is also Audio only on the left.
    let second = [
        ("picture-in-picture2", "mini-player", t.foreground),
        ("audio-lines", "stage", t.foreground),
        ("pin-off", "pin", t.foreground),
        ("panel-right", "panel", t.primary),
        ("cog", "settings", t.foreground),
    ];

    div()
        .h(38.0)
        .shrink0()
        .items_center()
        .border_b(t.border)
        .child(
            // The mark and the version, then the search centred in what is left (`mx-auto`) - so
            // it stays centred as the window is resized. Both gaps are the drag handle.
            div()
                .h_full()
                .shrink0()
                .items_center()
                .pl(12.0 + TRAFFIC_LIGHTS)
                .pr(2.0)
                .gap(6.0)
                .on(Action::Drag)
                // A button into About, the drag handle around it.
                .child(
                    div()
                        .items_center()
                        .gap(6.0)
                        .px(2.0)
                        .py(2.0)
                        .rounded(4.0)
                        .hover_bg(t.accent.alpha(0.6))
                        .on(Action::About)
                        .child(icon("logo", 16.0, t.primary))
                        .child(text(s.version.clone(), TextStyle { line_height: 10.0, ..tnum(10.0, 400, t.muted_foreground.alpha(0.7)) })),
                ),
        )
        .child(div().grow().min_w(8.0).h_full().on(Action::Drag))
        .child(search_box(s, t))
        .child(div().grow().min_w(8.0).h_full().on(Action::Drag))
        .maybe(s.scan_status.is_some(), |el| {
            el.child(
                div()
                    .min_w(0.0)
                    .mr(6.0)
                    .items_center()
                    .gap(6.0)
                    .child(icon("loader2", 12.0, t.muted_foreground))
                    .child(text(s.scan_status.clone().unwrap_or_default(), tnum(11.5, 400, t.muted_foreground)).min_w(0.0)),
            )
        })
        .maybe(!s.view.is_page() && !s.no_library, |el| el.child(
            div()
                .shrink0()
                // The last two sit a pixel further apart: in the Electron app each is wrapped in the
                // popover trigger that opens its menu.
                .children(first.iter().enumerate().flat_map(|(i, &name)| {
                    let mut els = vec![tool(name, t.foreground).ml(if i == 6 { 1.0 } else { 0.0 })];
                    // `ClearFiltersButton`, after the playback toggles: only while something is
                    // filtering, saying how much - the search counts one, each tag one.
                    let active = usize::from(!s.search.value.trim().is_empty()) + s.tag_filter.len();
                    if i == 1 && active > 0 {
                        els.push(
                            div()
                                .h(24.0)
                                .items_center()
                                .px(6.0)
                                .gap(4.0)
                                .rounded(4.0)
                                .hover_bg(t.accent)
                                .on(Action::ClearFilters)
                                .child(icon("filter-x", 14.0, t.primary))
                                .child(text(format!("Clear {active}"), tnum(11.0, 500, t.primary))),
                        );
                    }
                    els
                }))
                .child(tool("columns3", t.muted_foreground).ml(1.0)),
        ))
        .child(div().ml(8.0).gap(2.0).shrink0().children(second.iter().map(|&(glyph, action, color)| {
            // Pin on top is lit while it holds (`bg-primary/15 text-primary`), with the pin
            // that says so; the panel toggle is primary while the panel is out.
            let (glyph, color, lit) = match action {
                "pin" if s.always_on_top => ("pin", t.primary, true),
                "panel" => (glyph, if s.panel_open { t.primary } else { t.foreground }, false),
                "stage" if s.stage => (glyph, t.primary, true),
                _ => (glyph, color, false),
            };
            div().size(24.0, 24.0).items_center().justify_center().rounded(4.0).maybe(lit, |el| el.bg(t.primary.alpha(0.15))).hover_bg(t.accent).on(Action::Tool(action)).child(icon(glyph, 14.0, color))
        })))
        .child(caption_buttons(s, t).ml(6.0))
}

/// The search `<input>`: `h-[26px] pl-7 pr-7` with the magnifier at `left-2`, a clear button
/// at `right-1.5` once something is typed, and the `ring-1 ring-ring border-ring` focus ring.
fn search_box(s: &State, t: &Theme) -> El<Action> {
    let field = Field {
        value: s.search.value.clone(),
        placeholder: if s.search.focused { "name, ext:wav, bpm>120, key:Am, tag:keeper, stars:4-5".into() } else { "Search library".into() },
        caret: s.search.caret,
        anchor: s.search.anchor,
        focused: s.search.focused,
        // An input's line box is `normal`: Segoe UI's rounded ascent and descent, 16px here.
        style: TextStyle { line_height: 16.0, ..style(12.5, 400, t.foreground) },
        placeholder_color: t.muted_foreground.alpha(0.7),
        selection: t.selection,
    };
    let mut trailing = div().w(22.0).h_full().shrink0().items_center().justify_end();
    if !s.search.value.is_empty() {
        trailing = trailing.child(div().size(18.0, 18.0).items_center().justify_center().rounded(4.0).on(Action::ClearSearch).child(icon("x", 14.0, t.muted_foreground)));
    }
    let focused = s.search.focused;
    let mut field_box = div()
        .w(420.0)
        .min_w(0.0)
        .h(26.0)
        .items_center()
        .pl(7.0)
        .pr(5.0)
        .rounded(6.0)
        .bg(t.background)
        .border(if focused { t.ring } else { t.input }, 1.0)
        .on(Action::Search)
        .child(icon("search", 14.0, t.muted_foreground))
        .child(input(field).grow().h_full().ml(6.0))
        .child(trailing);
    if !focused {
        return field_box;
    }
    // The ring sits outside the border: a 1px frame around the box, taking no room.
    field_box.style.margin = taffy::prelude::Rect { left: taffy::prelude::length(0.0), right: taffy::prelude::length(0.0), top: taffy::prelude::length(0.0), bottom: taffy::prelude::length(0.0) };
    let mut ring = div().w(422.0).min_w(0.0).h(28.0).p(1.0).rounded(7.0).bg(t.ring).child(field_box.w_full());
    ring.style.margin = taffy::prelude::Rect { left: taffy::prelude::length(-1.0), right: taffy::prelude::length(-1.0), top: taffy::prelude::length(-1.0), bottom: taffy::prelude::length(-1.0) };
    ring
}

/// Minimise, maximise and close, drawn the way Windows draws a `titleBarOverlay`: 46px wide,
/// hairline glyphs, red behind the close glyph on hover.
pub fn caption_buttons_pub(s: &State, t: &Theme) -> El<Action> {
    caption_buttons(s, t)
}

/// The caption buttons at another height: the stage keeps them in a 30px strip.
pub fn caption_buttons_sized(s: &State, t: &Theme, height: f32) -> El<Action> {
    let mut el = caption_buttons(s, t);
    el.style.size.height = taffy::prelude::length(height);
    for child in &mut el.children {
        child.style.size.height = taffy::prelude::length(height);
    }
    el
}

/// The mark, in one colour.
pub fn logo(color: Rgba, size: f32) -> El<Action> {
    icon("logo", size, color)
}

pub fn format_time_pub(seconds: f64) -> String {
    format_time(seconds)
}

/// The room the Mac's own window buttons (the traffic lights) take at the left of the title
/// bar. Windows has none there: its caption buttons are drawn at the right, below.
#[cfg(target_os = "macos")]
pub const TRAFFIC_LIGHTS: f32 = 70.0;
#[cfg(not(target_os = "macos"))]
pub const TRAFFIC_LIGHTS: f32 = 0.0;

fn caption_buttons(s: &State, t: &Theme) -> El<Action> {
    // A Mac window keeps the system's traffic lights, at the left; nothing is drawn here.
    if cfg!(target_os = "macos") {
        return div();
    }
    let glyph = |kind: u8, color: Rgba| -> Painter {
        Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
            let (cx, cy) = (((r[0] + r[2]) / 2.0).round() + 0.5, ((r[1] + r[3]) / 2.0).round() + 0.5);
            let half = 5.0 * scale;
            let mut pb = PathBuilder::new();
            match kind {
                0 => {
                    pb.move_to(cx - half, cy);
                    pb.line_to(cx + half, cy);
                }
                1 => {
                    if let Some(rect) = resvg::tiny_skia::Rect::from_xywh(cx - half, cy - half, half * 2.0, half * 2.0) {
                        pb.push_rect(rect);
                    }
                }
                2 => {
                    // Restore: two overlapping squares.
                    let small = half - 2.0 * scale;
                    if let Some(rect) = resvg::tiny_skia::Rect::from_xywh(cx - half, cy - small, small * 2.0, small * 2.0) {
                        pb.push_rect(rect);
                    }
                    pb.move_to(cx - half + 2.0 * scale, cy - small);
                    pb.line_to(cx - half + 2.0 * scale, cy - half);
                    pb.line_to(cx + half, cy - half);
                    pb.line_to(cx + half, cy + small - 2.0 * scale);
                    pb.line_to(cx + small, cy + small - 2.0 * scale);
                }
                _ => {
                    pb.move_to(cx - half, cy - half);
                    pb.line_to(cx + half, cy + half);
                    pb.move_to(cx + half, cy - half);
                    pb.line_to(cx - half, cy + half);
                }
            }
            if let Some(path) = pb.finish() {
                let mut paint = Paint::default();
                paint.set_color(color.skia());
                paint.anti_alias = kind == 3;
                pm.stroke_path(&path, &paint, &Stroke { width: scale, ..Stroke::default() }, Transform::identity(), None);
            }
        })
    };
    let button = |kind: u8, action: Action, hover: Rgba| {
        div().size(46.0, 38.0).hover_bg(hover).on(action).child(paint(glyph(kind, t.foreground)).grow().h_full())
    };
    div()
        .shrink0()
        .h_full()
        .child(button(0, Action::Minimize, t.foreground.alpha(0.1)))
        .child(button(if s.maximized { 2 } else { 1 }, Action::Maximize, t.foreground.alpha(0.1)))
        .child(button(3, Action::Close, Rgba::rgb8(0xc4, 0x2b, 0x1c)))
}

/* ------------------------------------------------------------------ sidebar */

fn sidebar(s: &State, t: &Theme, height: f32) -> El<Action> {
    let width = s.sizes.sidebar;
    // The rows stop at the border, and at the nav's scrollbar gutter when it has one: 11px
    // short of the pane then, 1px otherwise.
    let inner = width - if s.nav_gutter { 11.0 } else { 1.0 };
    let tree_inner = width - if s.tree_gutter { 11.0 } else { 1.0 };
    let row = |name: &'static str, label: String, indent: f32, icon_color: Rgba, active: bool, filled: bool, action: Action| {
        div()
            .w(inner)
            .h(24.0)
            .shrink0()
            .items_center()
            .pl(indent)
            .pr(8.0)
            .gap(4.0)
            .maybe(active, |el| el.bg(t.primary.alpha(0.12)))
            .hover_bg(if active { t.primary.alpha(0.12) } else { t.accent.alpha(0.6) })
            .on(action)
            .child(if filled { icon_filled(name, 14.0, icon_color) } else { icon(name, 14.0, icon_color) })
            .child(text(label, style(12.5, 400, if active { t.foreground } else { t.muted_foreground })))
    };
    let count = |n: String| text(n, tnum(10.5, 400, t.muted_foreground.alpha(0.6)));
    let label = |words: &str| {
        div().pl(12.0).h(15.0).shrink0().child(text(words.to_string(), style(10.0, 600, t.muted_foreground.alpha(0.7))).w(inner - 44.0))
    };
    let dim = t.muted_foreground.alpha(0.8);
    let rated_total: usize = s.stars.iter().sum();

    // Sized to its contents and giving way when the window is short (`shrink min-h-0`), so it
    // scrolls rather than pushing the folder tree below it off the bottom.
    let mut nav = col()
        .min_h0()
        .pt(6.0)
        .bg(t.card.alpha(0.4))
        .scroll_named("nav", s.nav_scroll)
        .scrollbar(t.border)
        .child(row("folder-open", "Files".into(), 22.0, if s.view == View::Folder { t.primary } else { dim }, s.view == View::Folder, false, Action::Nav("files")).child(count(s.total_files.to_string()).ml_auto_el()))
        .maybe(s.show_stats, |el| el.child(row("bar-chart3", "Stats".into(), 22.0, if s.view == View::Stats { t.primary } else { dim }, s.view == View::Stats, false, Action::Nav("stats"))))
        .child(row("file-pen-line", "Contracts".into(), 22.0, if s.view == View::Contracts { t.primary } else { dim }, s.view == View::Contracts, false, Action::Nav("contracts")))
        .child(row("cloud-download", "YT2MP3".into(), 22.0, if s.view == View::Downloading { t.primary } else { dim }, s.view == View::Downloading, false, Action::Nav("youtube")))
        .child(
            row("star", "Rated".into(), 22.0, if s.view == View::Rated(1, 5) { t.primary } else { dim }, s.view == View::Rated(1, 5), true, Action::Nav("rated")).child(
                div()
                    .ml_auto()
                    // The row's `gap-1` and the count's own `pl-1`.
                    .gap(8.0)
                    .items_center()
                    .child(text(format!("{}%", (s.rated_share * 100.0).round()), tnum(10.5, 400, t.primary.alpha(0.7))))
                    .child(count(rated_total.to_string())),
            ),
        );
    for stars in (1..=5).rev() {
        nav = nav.child(
            row("star", "★".repeat(stars), 33.0, t.stars[stars - 1], s.view == View::Rated(stars as u8, stars as u8), true, Action::Stars(stars as u8))
                .child(count(s.stars[5 - stars].to_string()).ml_auto_el()),
        );
    }
    nav = nav.child(label("Quick access").mt(16.0)).child(div().h(4.0).shrink0());
    // The OS Downloads folder heads the list, ahead of the folders the user pinned.
    nav = nav.child(row("pin", "Downloads".into(), 22.0, if s.view == View::Downloads { t.primary } else { dim }, s.view == View::Downloads, false, Action::Nav("downloads")));
    for (i, quick) in s.quick.iter().enumerate() {
        let here = s.view == View::Folder && s.quick_dirs.get(i).is_some_and(|d| d.as_deref() == Some(s.folder.path.as_str()));
        nav = nav.child(drop_lit(row("pin", quick.label.clone(), 22.0, if here { t.primary } else { dim }, here, false, Action::Quick(i)), s, t, Action::Quick(i)));
    }
    nav = nav
        .child(
            // `px-2` around `px-1`: the heading 12px in, the Clear ending 12px short.
            div()
                .w(inner)
                .h(15.0)
                .mt(12.0)
                .shrink0()
                .items_center()
                .pl(12.0)
                .pr(12.0)
                .child(text("Tags", style(10.0, 600, t.muted_foreground.alpha(0.7))))
                // Only while something is filtering: the way back to everything.
                .maybe(!s.tag_filter.is_empty(), |el| {
                    el.child(
                        div()
                            .ml_auto()
                            .h(15.0)
                            .items_center()
                            .gap(2.0)
                            .px(4.0)
                            .rounded(4.0)
                            .hover_bg(t.accent)
                            .on(Action::ClearTags)
                            .child(icon("x", 10.0, t.primary))
                            .child(text("Clear", style(10.0, 400, t.primary))),
                    )
                }),
        )
        .child(
            div()
                .mt(4.0)
                .ml(8.0)
                .w(inner - 16.0)
                .h(22.0)
                .shrink0()
                .items_center()
                .pl(5.0)
                .gap(7.0)
                .rounded(4.0)
                .bg(t.secondary.alpha(0.4))
                .border(t.border.alpha(0.6), 1.0)
                .on(Action::TagSearch)
                .child(icon("search", 12.0, t.muted_foreground.alpha(0.5)))
                .child(text(format!("Search {} tags", s.tags.len()), TextStyle { line_height: 15.0, ..style(11.0, 400, t.muted_foreground.alpha(0.5)) })),
        )
        .child(
            // The sidebar less its scrollbar and `px-2` either side, like the search above, and
            // no taller than the split under it says (`maxHeight`), scrolling past that.
            div().mt(4.0).ml(8.0).w(inner - 16.0).max_h(s.sizes.tags).shrink0().scroll_named("tags", s.tags_scroll).scrollbar(t.border).child(div().w(inner - 16.0).wrap().gap(4.0).children(s.tags.iter().enumerate().map(|(i, (tag, n))| {
                let active = s.tag_filter.contains(tag);
                let available = s.tag_available.get(i).copied().unwrap_or(*n);
                // Nothing carries this as well as what is already selected: faded and dead
                // rather than removed, since which tags exist is the other thing this says.
                let dead = !active && available == 0;
                let (bg, border, fg, figure) = if active {
                    (t.primary.alpha(0.2), t.primary, t.foreground, t.muted_foreground.alpha(0.6))
                } else if dead {
                    (t.secondary.alpha(0.2), t.border.alpha(0.3), t.muted_foreground.alpha(0.4), t.muted_foreground.alpha(0.3))
                } else {
                    (t.secondary.alpha(0.5), t.border.alpha(0.6), t.muted_foreground, t.muted_foreground.alpha(0.6))
                };
                div()
                    .h(20.5)
                    .items_center()
                    .pl(6.0)
                    .pr(6.0)
                    .rounded(4.0)
                    .bg(bg)
                    .border(border, 1.0)
                    .maybe(!dead && !active, |el| el.hover_bg(t.accent))
                    .maybe(!dead, |el| el.on(Action::Tag(i)))
                    .child(if active { icon("hash", 10.0, t.primary) } else { icon("hash", 10.0, fg).opacity(0.5) })
                    .child(text(tag.clone(), style(11.0, 400, fg)).ml(2.0))
                    // `gap-0.5` and the count's own `pl-0.5`: what clicking it leaves.
                    .child(text(available.to_string(), tnum(10.0, 400, figure)).ml(4.0))
            }))),
        );

    // The split under the tags: 7px to grab, a hairline in the middle of it.
    let line = match (s.resizing, s.hot) {
        (Some(Handle::Tags), _) => t.primary,
        (None, Some(Handle::Tags)) => t.primary.alpha(0.6),
        _ => t.border,
    };
    let split = div().h(7.0).shrink0().on(Action::Resize(Handle::Tags)).child(div().mt(3.0).h(1.0).grow().bg(line));
    // The folder tree's half, `flex-1` against the nav's natural height - which on a library
    // with this many tags leaves it its bottom padding and no more.
    let tree = col().grow().min_h0().pb(6.0).bg(t.card.alpha(0.4)).clip().child(folder_tree(s, t, tree_inner));
    col()
        .w(width)
        .shrink0()
        .border_r(t.border)
        .child(nav)
        .child(split)
        .child(tree)
        // The width handle, straddling the border and centred on it.
        .child(div().absolute(width - 3.0, ((height - 28.0) / 2.0).max(0.0)).w(3.0).h(28.0).rounded(1.5).bg(lit(s, t, Handle::Sidebar)))
}

/// `SectionLabel` "Devices" with its buttons, then the rows: this machine's library first, then
/// every other machine on the tailnet running umakbang, each a tree of its own. Indented 11px a
/// level (capped at six), a chevron slot, the glyph, the name and the recursive count. Rows are
/// laid out only where they can be seen - an expanded sample pack is thousands of them.
fn folder_tree(s: &State, t: &Theme, width: f32) -> El<Action> {
    let small = |name: &'static str, action: Action, enabled: bool| {
        div()
            .size(16.0, 16.0)
            .items_center()
            .justify_center()
            .rounded(2.0)
            .opacity(if enabled { 1.0 } else { 0.3 })
            .maybe(enabled, |el| el.hover_bg(t.accent).on(action))
            .child(icon(name, 12.0, t.muted_foreground.alpha(0.7)))
    };
    let heading = div()
        .w(width)
        .h(23.0)
        .shrink0()
        .items_center()
        .px(12.0)
        .pt(4.0)
        .pb(4.0)
        .child(text("Devices", style(10.0, 600, t.muted_foreground.alpha(0.7))))
        .child(
            div()
                .ml_auto()
                .gap(2.0)
                .items_center()
                .child(small("refresh-cw", Action::PeersRefresh, true))
                .child(small("locate-fixed", Action::Locate, s.now.is_some()))
                .child(small("plus", Action::AddFolder, true)),
        );
    const ROW: f32 = 24.0;
    let first = (s.tree_scroll / ROW).floor().max(0.0) as usize;
    let mut rows = div().w(width).h(s.tree.len() as f32 * ROW).shrink0();
    for (index, node) in s.tree.iter().enumerate().skip(first).take(80) {
        let active = node.id == s.folder.id;
        let indent = 6.0 + node.depth.min(6) as f32 * 11.0;
        let chevron = div()
            .w(12.0)
            .h(14.0)
            .shrink0()
            .items_center()
            .justify_center()
            .maybe(node.has_children, |el| el.on(Action::TreeChevron(index)).child(icon(if node.open { "chevron-down" } else { "chevron-right" }, 12.0, t.muted_foreground.alpha(0.7))));
        let tint = if active { t.primary } else { t.muted_foreground.alpha(0.8) };
        let (glyph, faded) = match node.kind {
            TreeKind::This { mac } => (icon(if mac { "laptop" } else { "monitor" }, 14.0, tint), false),
            TreeKind::Device { mac, online } => (icon(if mac { "laptop" } else { "monitor" }, 14.0, tint), !online),
            TreeKind::Loading => (icon("loader2", 14.0, tint), false),
            TreeKind::Folder => (icon(if node.open { "folder-open" } else { "folder" }, 14.0, tint), false),
        };
        let label = if node.id == crate::library::LIBRARY { s.this_device.clone() } else { node.name.clone() };
        rows = rows.child(
            div()
                .absolute(0.0, index as f32 * ROW)
                .w(width)
                .h(ROW)
                .items_center()
                .pl(indent)
                .pr(8.0)
                .gap(4.0)
                .maybe(active, |el| el.bg(t.primary.alpha(0.12)))
                .maybe(faded, |el| el.opacity(0.45))
                .hover_bg(if active { t.primary.alpha(0.12) } else { t.accent.alpha(0.6) })
                .on(Action::TreeRow(index))
                .pipe(|el| drop_lit(el, s, t, Action::TreeRow(index)))
                .child(chevron)
                .child(glyph.shrink0())
                .child(text(label, style(12.5, 400, if active { t.foreground } else { t.muted_foreground })).min_w(0.0))
                .child(text(if node.files > 0 { node.files.to_string() } else { String::new() }, tnum(10.5, 400, t.muted_foreground.alpha(0.6))).ml_auto().pl(4.0).shrink0()),
        );
    }
    col().grow().min_h0().child(heading).child(div().grow().min_h0().scroll_named("tree", s.tree_scroll).scrollbar(t.border).child(rows))
}

fn static_crumb(t: &Theme, glyph: &'static str, filled: bool, label: String) -> El<Action> {
    div()
        .items_center()
        .gap(6.0)
        .child(if filled { icon_filled(glyph, 14.0, t.primary) } else { icon(glyph, 14.0, t.primary) })
        .child(text(label, style(12.0, 500, t.foreground)))
}

/* ------------------------------------------------------------------ pane bar */

/// One half of the split: its strip and its table.
pub fn explorer_pane(s: &State, t: &Theme, window_height: f32, width: f32, active: bool) -> El<Action> {
    col().min_h0().min_w(0.0).child(pane_bar(s, t, active)).child(crate::table::table(s, t, window_height, width))
}

/// `PaneBar`. With the explorer split, the pane being worked in is marked by a line across the
/// top of its strip, and each strip's last button closes its own half.
fn pane_bar(s: &State, t: &Theme, active: bool) -> El<Action> {
    // `disabled:opacity-40`, and no action: a disabled button does not take the click.
    let button = |name: &'static str, action: Action, color: Rgba, enabled: bool| {
        div()
            .size(24.0, 24.0)
            .shrink0()
            .items_center()
            .justify_center()
            .rounded(4.0)
            .maybe(enabled, |el| el.hover_bg(t.accent).on(action))
            .opacity(if enabled { 1.0 } else { 0.4 })
            .child(icon(name, 14.0, color))
    };
    let crumb = |name: &str, id: Option<i64>, current: bool| {
        div()
            .h(22.0)
            .min_w(0.0)
            .items_center()
            .px(4.0)
            .rounded(4.0)
            .hover_bg(t.accent)
            .maybe(id.is_some(), |el| el.on(Action::Crumb(id.unwrap_or_default())))
            .child(text(name.to_string(), style(12.0, if current { 500 } else { 400 }, if current { t.foreground } else { t.muted_foreground })))
    };
    // As `Breadcrumbs` builds it: the virtual "Library" alone, then each folder grouped with the
    // chevron before it. The grouping is what decides how the trail shrinks - flex shares the
    // shortfall by each item's own width, and a group's width includes its chevron.
    // On another machine the trail starts at the device, which is the first of the crumbs.
    let mut crumbs = div().min_w(0.0).items_center().gap(2.0).clip();
    let remote = crate::devices::is_device(s.folder.id);
    if !remote {
        crumbs = crumbs.child(crumb(&s.this_device, Some(crate::library::LIBRARY), s.crumbs.is_empty()));
    }
    let last = s.crumbs.len().saturating_sub(1);
    for (i, folder) in s.crumbs.iter().enumerate() {
        crumbs = crumbs.child(
            div()
                .min_w(0.0)
                .items_center()
                .gap(2.0)
                .maybe(!(remote && i == 0), |el| el.child(icon("chevron-right", 12.0, t.muted_foreground.alpha(0.5))))
                .child(crumb(&folder.name, Some(folder.id), i == last)),
        );
    }
    // The folders only when there are some; the files always - a search counts every match,
    // not just the ones listed.
    let files = if s.searching { s.search_total } else { s.files.len() };
    let mut parts = Vec::new();
    if !s.folders.is_empty() {
        parts.push(format!("{} folder{}", format_count(s.folders.len() as i64), if s.folders.len() == 1 { "" } else { "s" }));
    }
    parts.push(format!("{} file{}", format_count(files as i64), if files == 1 { "" } else { "s" }));
    let counts = parts.join(" · ");
    div()
        .h(30.0)
        .shrink0()
        .items_center()
        .pl(10.0)
        .pr(10.0)
        .border_b(t.border)
        .child(button("arrow-left", Action::Back, t.foreground, s.can_back))
        .child(button("arrow-right", Action::Forward, t.foreground, s.can_forward))
        // A device's own top has nowhere further up to go.
        .child(button("corner-left-up", Action::Up, t.foreground, s.view == View::Folder && s.folder.id != crate::library::LIBRARY && !(remote && s.folder.parent.is_none())).ml(8.0))
        // Both act on the folder you are standing in, so a saved view has neither; and another
        // machine's library is read-only.
        .child(button("refresh-cw", Action::Refresh, t.foreground, s.view == View::Folder).ml(8.0))
        .child(button("folder-plus", Action::NewFolder, t.foreground, s.view == View::Folder && !remote).ml(8.0))
        .child(div().grow().min_w(0.0).ml(8.0).items_center().child(match s.view {
            View::Folder => crumbs,
            // `StaticCrumb`: the view's glyph in the accent, and its name.
            View::Rated(min, max) => static_crumb(t, "star", true, if min == max { format!("{} only", "★".repeat(min as usize)) } else if (min, max) == (1, 5) { "Rated".into() } else { format!("{min}–{max} stars") }),
            View::Downloads => static_crumb(t, "download", false, "Downloads".into()),
            View::Settings => static_crumb(t, "cog", false, "Settings".into()),
            View::Stats => static_crumb(t, "bar-chart3", false, "Stats".into()),
            View::Downloading => static_crumb(t, "cloud-download", false, "YT2MP3".into()),
            View::Contracts => static_crumb(t, "file-pen-line", false, "Contracts".into()),
        }))
        .child(text(counts, tnum(11.5, 400, t.muted_foreground)).ml(8.0))
        // Worth saying only once more than one row is in play.
        .maybe(s.selection.len() > 1, |el| el.child(text(format!("{} selected", format_count(s.selection.len() as i64)), tnum(11.5, 500, t.primary)).ml(8.0)))
        .child(if s.split.is_some() { button("x", Action::ClosePane, t.foreground, true).ml(8.0) } else { button("columns2", Action::Split, t.foreground, true).ml(8.0) })
        .maybe(s.split.is_some() && active, |el| el.child(div().absolute(0.0, 0.0).w_full().h(2.0).bg(t.primary)))
}

/* ------------------------------------------------------------------ transport */

fn transport(s: &State, t: &Theme, width: f32) -> El<Action> {
    let now = s.now.as_ref();
    let loaded = now.is_some();
    // Ghost buttons, `disabled:opacity-40` until there is something to act on - which with
    // nothing loaded is all of them but the volume.
    let button = |name: &'static str, color: Rgba, enabled: bool, action: Option<Action>| {
        let el = div()
            .size(24.0, 24.0)
            .items_center()
            .justify_center()
            .rounded(4.0)
            .maybe(enabled, |el| el.hover_bg(t.accent))
            .opacity(if enabled { 1.0 } else { 0.4 })
            .child(icon(name, 14.0, color));
        match action {
            Some(action) if enabled => el.on(action),
            _ => el,
        }
    };
    let playing = now.is_some_and(|n| n.playing);
    let mut controls = div()
        .gap(2.0)
        .items_center()
        .child(button("skip-back", t.foreground, loaded, Some(Action::Previous)))
        .child(
            div()
                .size(28.0, 28.0)
                .items_center()
                .justify_center()
                .rounded(14.0)
                .bg(t.primary)
                .maybe(loaded, |el| el.hover_bg(t.primary.alpha(0.9)).on(Action::Play))
                // `disabled:opacity-30`, and the glyph is `fill-current`.
                .opacity(if loaded { 1.0 } else { 0.3 })
                .child(icon_filled(if playing { "pause" } else { "play" }, 12.0, t.primary_foreground)),
        )
        .child(button("skip-forward", t.foreground, loaded, Some(Action::Next)))
        .child(button("locate-fixed", t.muted_foreground, loaded, Some(Action::Locate)))
        .child(button("list-music", t.foreground, !s.transport.queue.is_empty(), Some(Action::Queue)))
        // The speaker mutes; the slider hovers out of it.
        .child(button(if s.transport.muted || s.transport.volume == 0.0 { "volume-x" } else { "volume2" }, if s.transport.muted { t.destructive } else { t.foreground }, true, Some(Action::Volume)));
    // Varispeed reads out what is held while it is on - a transport quietly two semitones sharp
    // is the one state of it you must not be able to miss.
    controls = match (s.transport.varispeed, now) {
        (Some((by_bpm, value)), Some(now)) => {
            let rate = crate::app::rate_for(now.file.bpm, Some((by_bpm, value)));
            let readout = if by_bpm { format!("{} BPM", trimmed(now.file.bpm.unwrap_or(value) * rate)) } else { format!("{} st", signed(12.0 * rate.log2())) };
            controls.child(div().h(24.0).items_center().gap(4.0).px(6.0).rounded(6.0).hover_bg(t.accent).on(Action::Varispeed).child(icon("gauge", 14.0, t.primary)).child(text(readout, tnum(11.0, 400, t.primary))))
        }
        _ => controls.child(button("gauge", t.foreground, now.is_some_and(|n| n.file.playable), Some(Action::Varispeed))),
    };
    // The clock sits with the controls that act on what is playing. The row is live so it can
    // tick on the animation frame without the rest of the strip being redrawn.
    if let Some(now) = now {
        controls = controls.child(text(format!("{} / {}", format_time(now.time), format_time(now.duration)), tnum(11.0, 400, t.muted_foreground)).pl(4.0).shrink0());
    }
    // Trim: only the toggle until a region is drawn, then its length and Save.
    let playable = now.is_some_and(|n| n.file.playable);
    controls = controls.child(button("scissors", if s.trimming { t.primary } else { t.foreground }, playable, Some(Action::Trim)));
    if let (Some(_), Some((a, b))) = (now, s.region) {
        controls = controls
            .child(text(crate::columns::duration_precise(Some(b - a)), tnum(11.0, 400, t.primary)).shrink0())
            .child(button("save", t.foreground, true, Some(Action::TrimSave)));
    }
    controls = controls.live();

    let heading = match now {
        Some(now) => col()
            .w_full()
            .items_center()
            .child(div().w_full().justify_center().child(text(now.file.name.clone(), TextStyle { line_height: 15.0, ..style(12.0, 500, t.foreground) })))
            .child(div().mt(2.0).items_center().justify_center().gap(6.0).child(text(now.details.clone(), tnum(10.5, 400, t.muted_foreground))).maybe(now.project.is_some(), |el| {
                // How long the project of the same name was open: a clock, not another word.
                let seconds = now.project.as_ref().map_or(0.0, |p| p.0);
                el.child(div().items_center().gap(2.0).shrink0().on(Action::ProjectTime).child(icon("clock", 10.0, t.muted_foreground)).child(text(format_hours(seconds / 3600.0), tnum(10.5, 400, t.muted_foreground))))
            })),
        None => col().child(
            text("Select a file to start playing - the rest of its folder queues up automatically.", style(11.0, 400, t.muted_foreground.alpha(0.7)))
                .w(s.sizes.split),
        ),
    };

    let wave_half = match now {
        Some(now) => {
            let painter = crate::waveform::painter(now.wave.clone(), s.visuals.borrow().palette.clone(), s.visuals.borrow().ramp, t.primary, t.muted_foreground, t.background);
            let status = now.wave.borrow().status;
            div().grow().min_w(0.0).items_center().child(
                paint(painter)
                    .grow()
                    // `Math.max(24, height - 18)`.
                    .h((s.sizes.player - 18.0).max(24.0))
                    .live()
                    .on(Action::Seek)
                    // The loop's length over its middle, in the played colour.
                    .maybe(s.region.is_some() && now.duration > 0.0, |el| {
                        let (a, b) = s.region.unwrap_or_default();
                        let (a, b) = ((a / now.duration).clamp(0.0, 1.0) as f32, (b / now.duration).clamp(0.0, 1.0) as f32);
                        let grow = |v: f32| {
                            let mut d = div();
                            d.style.flex_grow = v.max(0.0);
                            d.style.flex_basis = taffy::prelude::length(0.0);
                            d
                        };
                        el.child(
                            div()
                                .absolute(0.0, 3.0)
                                .w_full()
                                .child(grow(a))
                                .child(grow(b - a).justify_center().child(text(crate::columns::duration_precise(Some(s.region.map_or(0.0, |r| r.1 - r.0))), TextStyle { line_height: 12.0, ..tnum(10.0, 400, t.primary) }).shrink0()))
                                .child(grow(1.0 - b)),
                        )
                    })
                    .maybe(status == Status::Loading, |el| {
                        el.child(div().grow().items_center().justify_center().child(text("reading waveform…", style(10.5, 400, t.muted_foreground.alpha(0.7)))))
                    }),
            )
        }
        None => div().grow().items_center().justify_center().child(text("nothing playing", style(10.5, 400, t.muted_foreground.alpha(0.4)))),
    };

    let split_line = match (s.resizing, s.hot) {
        (Some(Handle::Split), _) | (None, Some(Handle::Split)) => t.primary,
        _ => t.border,
    };
    // The controls take the split as a preferred width, not a floor (`shrink`, `maxWidth:
    // 100%`): with the panels wide the strip can be narrower than the split alone.
    let mut controls_half = col().w(s.sizes.split).min_w(0.0).items_center().justify_center().gap(8.0).clip().child(heading).child(controls);
    controls_half.style.flex_shrink = 1.0;
    controls_half.style.max_size.width = taffy::prelude::percent(1.0);
    div()
        .h(s.sizes.player)
        .shrink0()
        .items_center()
        .px(12.0)
        .gap(12.0)
        .bg(t.card.alpha(0.5))
        .border_t(t.border)
        .clip()
        // The height handle: a 3px pill at `top: -1px` from the padding edge, which is the
        // border box's top - where taffy measures from - and the strip's `overflow-hidden`
        // cuts the row over the border away, leaving two pixels under it. Placed by
        // arithmetic - see the sidebar's.
        .child(div().absolute((width - 28.0) / 2.0, 0.0).w(28.0).h(3.0).rounded(1.5).bg(lit(s, t, Handle::Player)))
        .child(controls_half)
        // The boundary between the halves: `h-[70%]` of the strip inside its top border.
        .child(
            div()
                .w(11.0)
                .h_full()
                .shrink0()
                .items_center()
                .justify_center()
                .on(Action::Resize(Handle::Split))
                .child(div().w(2.0).h((s.sizes.player - 1.0) * 0.7).rounded(1.0).bg(split_line)),
        )
        .child(wave_half)
}

/// `formatHours`.
pub fn format_hours(hours: f64) -> String {
    if !hours.is_finite() || hours <= 0.0 {
        return "0h".into();
    }
    if hours < 1.0 {
        return format!("{}m", (hours * 60.0).round());
    }
    let whole = hours.floor();
    let minutes = ((hours - whole) * 60.0).round();
    if whole >= 100.0 {
        return format!("{}h", format_count(hours.round() as i64));
    }
    if minutes > 0.0 { format!("{whole}h {minutes}m") } else { format!("{whole}h") }
}

/// One decimal, none when it would be a zero (`trimmed`).
pub fn trimmed(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 { format!("{rounded}") } else { format!("{rounded:.1}") }
}

/// With its sign (`signed`).
pub fn signed(value: f64) -> String {
    let text = trimmed(value);
    if value > 0.05 { format!("+{text}") } else if text == "-0" { "0".into() } else { text }
}

/// `formatTime`: m:ss, or h:mm:ss past the hour.
fn format_time(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 { seconds.floor() as u64 } else { 0 };
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// Small helpers that read better at the call site than their spelled-out styles.
trait Extra {
    fn ml_auto_el(self) -> Self;
}

impl Extra for El<Action> {
    /// `ml-auto`: pushed to the far end of its row, as the counts are.
    fn ml_auto_el(self) -> Self {
        self.ml_auto().shrink0()
    }
}
