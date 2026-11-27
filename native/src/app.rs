//! The window: winit for the OS window and input; `present` puts the CPU-drawn pixels on screen.
//!
//! Frames are drawn only when something changed - input, a resize, a folder opening - plus the
//! animation frames while a track plays. Those are the shared loop of `audio-tap.ts`: 60 a
//! second while audio moves, one settling frame when it stops, and a wipe five seconds into
//! the silence. An animation frame repaints only the live elements (the plots, the transport's
//! waveform and clock) and hands the window just those rectangles. A window nobody is touching,
//! with nothing playing, costs nothing.

use crate::columns::{self, ColumnId, Sort};
use crate::docstore::DocStore;
use crate::layout::{Handle, Layout};
use crate::table;
use crate::library::{FileRow, Library};
use crate::player::Player;
use crate::screen::{self, Action, NowPlaying, State, View};
use crate::shell_icon::ShellIcons;
use crate::theme::Theme;
use crate::ui::Ui;
use crate::ui::tree::{Hit, render, render_live};
use crate::userdata::UserData;
use crate::visualizers::{Palette, Phase, Visuals};
use crate::waveform::Wave;

pub mod ops;
use resvg::tiny_skia::Pixmap;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::mpsc::Sender;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition};
use winit::event::{ElementState, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{CursorIcon, ResizeDirection, Window, WindowId};

/// `rateFor`: the rate a varispeed asks of a track - a tempo target over the track's own
/// tempo, or an interval - an octave either way at most, and 1 when it asks for a tempo the
/// track does not have.
pub fn rate_for(bpm: Option<f64>, varispeed: Option<(bool, f64)>) -> f64 {
    let raw = match varispeed {
        None => 1.0,
        Some((false, semitones)) => 2f64.powf(semitones / 12.0),
        Some((true, target)) => bpm.filter(|&b| b > 0.0).map_or(1.0, |b| target / b),
    };
    if raw.is_finite() { raw.clamp(0.5, 2.0) } else { 1.0 }
}

/// The shallowest part of `path` that does not exist: for a file on a network share that is not
/// mounted, the share (`/Volumes/john`), which says what to do better than the file's name does.
fn missing_part(path: &str) -> Option<std::path::PathBuf> {
    let mut levels: Vec<&std::path::Path> = std::path::Path::new(path).ancestors().filter(|a| !a.as_os_str().is_empty()).collect();
    levels.reverse();
    levels.into_iter().find(|a| !a.exists()).map(std::path::Path::to_path_buf)
}

/// Whole steps snap to the grid first: +1 from 1.2 is 2, not 2.2 (`stepFrom`).
fn step_from(value: f64, step: f64, up: bool) -> f64 {
    let units = value / step;
    let next = if up { (units + 1e-6).floor() + 1.0 } else { (units - 1e-6).ceil() - 1.0 };
    (next * step * 1000.0).round() / 1000.0
}

/// `DETAIL_OPTIONS`: what the transport's line can list, and an example of each.
pub const DETAIL_FIELDS: [(&str, &str, &str); 10] = [
    ("bpm", "Tempo", "128 BPM"),
    ("key", "Key", "F#m"),
    ("format", "Format", "44.1k · 24"),
    ("channels", "Channels", "stereo"),
    ("duration", "Length", "3:24"),
    ("size", "Size", "12.4 MB"),
    ("modified", "Modified", "07 Feb 2021 03:45 PM"),
    ("extension", "Extension", "WAV"),
    ("folder", "Folder", "…/Beats/2024"),
    ("projectTime", "Time on project", "How long the matching FL Studio project has been open"),
];

/// A row press that may turn into a drag.
struct RowDrag {
    paths: Vec<PathBuf>,
    from: winit::dpi::PhysicalPosition<f64>,
    active: bool,
}

/// The loop's frame interval: 60fps, as `FRAME_MS` caps it.
const FRAME: Duration = Duration::from_micros(16_667);

/// How long silence has to last before the panels are wiped (`IDLE_CLEAR_MS`).
const IDLE_CLEAR: Duration = Duration::from_secs(5);

/// How far in from the window's edge a press resizes the window rather than reaching what is
/// under it. The window has no OS frame - the title bar is ours - and winit gives a frameless
/// window no resize border at all, so this band is the only way to size it.
const EDGE: f64 = 5.0;

/// What other threads wake the window with.
pub enum Wake {
    /// A track's waveform peaks, decoded - or `None` when it could not be.
    Peaks(String, Option<Vec<u8>>),
    /// Something changed in the folder on screen.
    FolderChanged,
    /// How the scan is going, from the scan thread.
    Scan(crate::scan::Event),
    /// A file's analysis has started, and its result.
    Analysing(String),
    Analysed(crate::analysis::Result),
    /// The downloader's news.
    Youtube(crate::youtube::Event),
    /// LALAL.AI's news.
    Stems(crate::stems::Event),
    /// What the external key command printed for the playing track.
    KeyTest(String),
    /// A search's answer, from the search thread.
    Search(crate::search::Results),
    /// A peer's rating, tags or rescan, to be applied and answered.
    RemoteWrite(crate::server::Write, std::sync::mpsc::Sender<Result<(), String>>),
    /// The server's state or counters moved.
    Remote,
    /// The tray's menu, and a second launch asking for the window.
    Tray(crate::tray::Event),
    Show,
    /// Cmd+Q on a Mac (`tray::intercept_quit`): closing the window, not the app, in the background.
    #[cfg(target_os = "macos")]
    QuitKey,
    /// The machines on the tailnet, and whether umakbang answers on each.
    Peers(crate::tailscale::Status, Vec<crate::server::Peer>),
    /// A machine's plugin list, by its tailnet node id; None when it would not answer.
    PluginsCompared(String, Option<serde_json::Value>),
    /// A mounted library's index arrived (how many rows) or could not be fetched.
    RemoteIndexed(String, Result<usize, String>),
    /// A copy from another machine moved on, or finished (what was written, what failed).
    Copying(crate::remote::Progress),
    Copied(Vec<PathBuf>, Vec<String>),
    Packed(Result<PathBuf, String>),
    PackPreview(String, crate::remote::Preview),
    /// A zip unpacked (where), or why not.
    Extracted(Result<PathBuf, String>),
    /// Annotated paths whose file is no longer the one annotated (with what it was), and paths
    /// annotated before any record was kept (with what is there now).
    AnnotationsChecked(Vec<(String, f64, f64)>, Vec<(String, f64, f64)>),
    /// Folders anywhere in the library changed on disk (or, true, too much to say which).
    LibraryTouched(Vec<PathBuf>, bool),
    /// A bundle written, or why not.
    BundleWritten(Result<PathBuf, String>),
    /// A bundle or settings file read: restored straight in (true), or a backup for the wizard.
    BundleRead(Result<(Option<serde_json::Value>, bool, Vec<String>), String>),
    /// A peer's tags and ratings, for the wizard (its name, and what it sent).
    RemoteMetadata(String, Option<serde_json::Value>),
    /// Another machine's newer settings, adopted (its name), nothing newer, or why not; and
    /// whether this was the launch's own look rather than the button.
    SettingsSynced(Result<Option<(String, serde_json::Value)>, String>, bool),
    /// The updater's status moved.
    Updates,
}

/// Where one explorer pane is standing: everything `swap_panes` trades with the store's fields.
#[derive(Default)]
struct Pane {
    folder: Option<crate::library::FolderRow>,
    crumbs: Vec<crate::library::FolderRow>,
    folders: Vec<crate::library::FolderRow>,
    files: Vec<FileRow>,
    file_meta: Vec<crate::table::FileMeta>,
    folder_tags: HashMap<i64, Vec<String>>,
    file_tags: HashMap<String, Vec<String>>,
    file_icons: HashMap<String, Rc<Pixmap>>,
    selection: BTreeSet<usize>,
    focus: Option<usize>,
    scroll: f32,
    scroll_x: f32,
    sort: Option<Sort>,
    hover_row: Option<usize>,
    hover_star: Option<(usize, u8)>,
    view: Option<View>,
    searching: bool,
    search_total: usize,
    can_back: bool,
    can_forward: bool,
    history: Vec<i64>,
    future: Vec<i64>,
}

pub struct App {
    pub library: Library,
    pub data: UserData,
    pub theme: Theme,
    pub ui: Ui,
    pub state: State,
    shell: ShellIcons,
    /// The scale the file icons in `state.file_icons` were made at.
    icon_scale: f32,
    window: Option<Rc<Window>>,
    screen: Option<crate::present::Screen>,
    frame: Option<Pixmap>,
    pub hits: Vec<Hit<Action>>,
    hovered: Option<Action>,
    cursor: PhysicalPosition<f64>,
    history: Vec<i64>,
    future: Vec<i64>,
    last_click: Option<(Action, Instant)>,
    player: Option<Player>,
    pub proxy: Option<EventLoopProxy<Wake>>,
    /// The folder's playable files when play was pressed, and where in them we are.
    queue: Vec<FileRow>,
    queue_index: usize,
    /// The frame clock's zero, and when the next animation frame is due.
    epoch: Instant,
    next_tick: Instant,
    /// The phase the next redraw advances the visualizers by.
    pending: Option<Phase>,
    clear_at: Option<Instant>,
    /// Something other than the animation changed: the next redraw paints everything.
    full: bool,
    /// The pointer went down on the waveform and has not come up.
    scrubbing: bool,
    timing: bool,
    /// The pane sizes, where they are saved, and the drag in progress: which handle, the
    /// pointer's logical coordinate along its axis when it went down, and the size then.
    pub layout: Layout,
    pub layout_path: Option<PathBuf>,
    resizing: Option<Drag>,
    /// When the volume popover closes, once the pointer has left it and its button.
    volume_close_at: Option<Instant>,
    cursor_icon: CursorIcon,
    modifiers: ModifiersState,
    /// A Mac Ctrl-click in progress: its release is a right click's, whatever Ctrl does meanwhile.
    ctrl_click: bool,
    /// Which folders the tree has open; the virtual Library starts open, as
    /// `useState(new Set(['']))` does.
    tree_open: HashSet<i64>,
    /// The search thread, the data its filters read, and the newest query sent to it.
    search_tx: Option<Sender<crate::search::Request>>,
    pub search_shared: Arc<RwLock<crate::search::Shared>>,
    search_generation: u64,
    /// The analysis workers, what they were last asked for, and what they have finished
    /// this session (`done`).
    analysis: Option<Arc<crate::analysis::Queue>>,
    pub(crate) analysis_wanted: Vec<(String, bool)>,
    key_test: Option<String>,
    /// The shortcut listening for its new key, and why the last one was refused.
    capturing: Option<&'static str>,
    shortcut_refused: Option<String>,
    changelog_open: Option<usize>,
    /// The output devices as last asked: asking Windows costs tens of milliseconds, so only
    /// the first look and opening the list do it.
    output_devices: Option<Vec<String>>,
    /// What this machine is called on the tailnet, for "Copy to …".
    local_name: Option<String>,
    /// The tailnet server's owner, and the last look at the other machines.
    remote: Option<crate::server::Supervisor>,
    peers: Option<(crate::tailscale::Status, Vec<crate::server::Peer>)>,
    peers_busy: bool,
    /// Running in the background: the tray, what it says, whether the window is up, whether the
    /// first close has been explained, and whether this launch began windowless.
    tray: Option<crate::tray::Tray>,
    tray_status: std::sync::Arc<std::sync::Mutex<String>>,
    window_open: std::sync::Arc<std::sync::atomic::AtomicBool>,
    told_still_running: bool,
    pub start_hidden: bool,
    /// The library and profile this copy was started with, for the login item to repeat.
    pub launch_args: Vec<String>,
    /// The profile on disk, for imports and syncs that write it whole and read it back.
    pub data_path: PathBuf,
    /// A bundle being written or read, and what the last sync said.
    bundle_busy: bool,
    /// When the tour's current step began.
    tour_step_at: Option<Instant>,
    /// The library folders, watched whole.
    library_watch: Option<crate::watch::LibraryWatch>,
    /// The other half of a split explorer, parked while this one is worked in; and the screen
    /// rectangle it was last drawn in, so a press there can bring it forward first.
    parked: Option<Pane>,
    inactive_rect: Option<[f32; 4]>,
    syncing: bool,
    sync_note: Option<String>,
    /// Plugins: this machine's list and favourites as last read, and each peer compared with.
    plugin_summary: Option<(serde_json::Value, usize, usize)>,
    compared: std::collections::HashMap<String, Option<Option<serde_json::Value>>>,
    key_testing: bool,
    analysed: HashSet<String>,
    /// The rows the Stats page counts, read once per visit and after a scan.
    stat_rows: Option<Rc<Vec<crate::stats::Row>>>,
    pub downloader: Option<crate::youtube::Downloader>,
    /// The folder holding `umakbang-data.json`: the profile everything else sits beside.
    pub user_data: PathBuf,
    /// A press on a row that may become a drag: what it carries, where it began, and whether
    /// it has moved far enough to be one (`lib/drag.ts`).
    row_drag: Option<RowDrag>,
    /// What Ctrl+Z steps back through.
    pub(crate) undo_history: crate::undo::History,
    /// A press on the row already selected alone opens it - on release, and only if the press
    /// did not turn into a drag.
    pending_open: Option<usize>,
    /// The window's place and size before a compact mode took it over, to go back to.
    /// A region drag on the waveform: the end that stays put, in seconds.
    region_drag: Option<f64>,
    restore_bounds: Option<(winit::dpi::PhysicalPosition<i32>, winit::dpi::PhysicalSize<u32>, bool)>,
    contract_store: Option<crate::contracts::Store>,
    contract_fonts: Option<Rc<crate::contracts::Fonts>>,
    /// When the draft's preview is laid out again: 250ms after the typing stops.
    preview_at: Option<Instant>,
    /// When the link typed into YT2MP3 is read: 400ms after the typing stops.
    probe_at: Option<Instant>,
    /// The next spinner frame, while one is on screen.
    spin_at: Option<Instant>,
    /// When the app started: the spinners' clock.
    started: Instant,
    db_path: PathBuf,
    /// What Cut or Copy last took, for Paste.
    file_clipboard: (crate::fsops::Mode, Vec<PathBuf>),
    /// When the notice at the foot of the window goes.
    notice_until: Option<Instant>,
    /// The dice's last draws, so it does not repeat itself (`recentRandom`).
    recent_random: Vec<String>,
    watch: crate::watch::FolderWatch,
    /// When the watched folder is due its re-read: 600ms after the last change.
    reread_at: Option<Instant>,
    /// When to check that every annotation still sits on the file it was made on.
    annotation_check_at: Option<Instant>,
    /// The update version a notice has been shown for, so it is said once.
    announced_update: Option<String>,
    /// A saved view's whole list, before the search narrows it.
    view_files: Vec<FileRow>,
    /// Where changes to `umakbang-data.json` go: ratings, sorts, columns, the folder last open.
    pub doc: Option<DocStore>,
}

/// A drag in progress: which handle, the pointer's logical coordinate along its axis when it
/// went down, and the size then.
#[derive(Clone, Copy)]
enum Drag {
    Pane(Handle, f32, f32),
    Column(ColumnId, f32, f32),
    /// A settings slider, by the pointer's place along it.
    Setting(&'static str),
    /// The colour picker's field (true) or hue bar.
    Picker(bool),
    /// The split explorer's divider.
    PaneSplit,
    /// The volume slider, by the pointer's height on it.
    Volume,
}

impl App {
    pub fn new(library: Library, data: UserData, db_path: PathBuf) -> App {
        let undo_depth = data.settings.undo_depth.unwrap_or(25);
        // The first library folder, or - with none yet, on a first run - the virtual root above
        // where they will be.
        let root = library.children(None).into_iter().next().unwrap_or_else(|| library.library_root());
        let rated: Vec<String> = data.ratings.keys().cloned().collect();
        let theme = Theme::derive(data.settings.theme_primary.as_deref(), data.settings.theme_background.as_deref());
        let palette = Palette::new(&data.settings.visualizer_stops, &theme);
        let headroom_db = data.settings.visualizer_headroom_db.unwrap_or(6.0);
        let ramp = data.settings.waveform_tint.as_deref() != Some("accent");
        let layout = Layout::from_settings(&data.settings);
        let state = State {
            visuals: Rc::new(RefCell::new(Visuals::new(palette, headroom_db, ramp))),
            now: None,
            pulse: 1.0,
            crumbs: Vec::new(),
            folders: Vec::new(),
            files: Vec::new(),
            selection: BTreeSet::new(),
            focus: None,
            scroll: 0.0,
            scroll_x: 0.0,
            columns: columns::normalise(&data.settings.columns),
            sort: Sort { key: data.settings.sort_key.clone().unwrap_or_else(|| "name".into()), dir: data.settings.sort_dir.clone().unwrap_or_else(|| "asc".into()) },
            hover_row: None,
            hover_star: None,
            column_hot: None,
            ratings: data.ratings.clone(),
            file_meta: Vec::new(),
            folder_tags: HashMap::new(),
            tree: Vec::new(),
            search: screen::SearchBox::default(),
            searching: false,
            recursive: false,
            play_on_select: data.settings.play_on_select,
            auto_advance: data.settings.auto_advance,
            audio_only: data.settings.type_filter.kinds.iter().any(|k| k == "audio"),
            type_filters: data.settings.type_filter.kinds.len() + data.settings.type_filter.exts.len(),
            search_total: 0,
            tree_scroll: 0.0,
            nav_scroll: 0.0,
            tags_scroll: 0.0,
            total_files: library.total_files(),
            stars: data.star_counts(),
            rated_share: library.rated_share(&rated, &data.settings.random_exclude_dirs),
            quick: data.settings.quick_move.clone(),
            quick_dirs: data.settings.quick_move.iter().map(|q| data.relative(&q.path)).collect(),
            view: View::Folder,
            analysing: HashSet::new(),
            gone: HashSet::new(),
            settings_section: 0,
            stats: Default::default(),
            show_stats: data.settings.show_stats.unwrap_or(true),
            nav_gutter: true,
            youtube: Default::default(),
            form: Default::default(),
            contracts: Default::default(),
            stem_dialog: None,
            fl_dialog: None,
            importing: None,
            tour: None,
            split: None,
            no_library: data.settings.roots.is_empty(),
            reset_armed: data.settings.reset_on_launch,
            drop_over: None,
            color_picker: None,
            mini_player: false,
            trimming: false,
            region: None,
            // Somewhere you step into, never somewhere a launch puts you back.
            stage: false,
            stage_hover: false,
            always_on_top: data.settings.always_on_top,
            panel_open: data.settings.panel_open.unwrap_or(true),
            stem_job: None,
            stem_settings: crate::stem_dialog::StemSettings {
                key: data.settings.lalal_key.clone(),
                output_dir: data.settings.stem_output_dir.clone(),
                format: data.settings.stem_format.clone().unwrap_or_else(|| "mp3".into()),
                // A stored model the split endpoint does not accept is replaced, as the store does.
                splitter: data.settings.stem_splitter.clone().filter(|s| crate::stems::SPLITTERS.contains(&s.as_str())).unwrap_or_else(|| "perseus".into()),
                minutes: None,
                checking: false,
            },
            youtube_settings: (data.settings.youtube_format.clone().unwrap_or_else(|| "mp3".into()), data.settings.youtube_bitrate.unwrap_or(192)),
            tree_gutter: true,
            settings_scroll: 0.0,
            settings_values: Default::default(),
            transport: screen::Transport {
                volume: data.settings.volume.unwrap_or(1.0).clamp(0.0, 1.0),
                muted: false,
                volume_open: false,
                queue_open: false,
                varispeed_open: false,
                varispeed: None,
                queue: Vec::new(),
                queue_index: 0,
            },
            anchors: Vec::new(),
            scan_status: None,
            menu: None,
            sub_hover: None,
            prompt: None,
            tag_editor: None,
            note_edit: None,
            dialog: None,
            about: None,
            notice: None,
            tags: data.tag_counts(),
            tag_filter: Vec::new(),
            tag_available: Vec::new(),
            file_tags: HashMap::new(),
            file_icons: HashMap::new(),
            maximized: false,
            can_back: false,
            can_forward: false,
            version: env!("CARGO_PKG_VERSION").into(),
            sizes: layout.sizes(1360.0),
            hot: None,
            resizing: None,
            folder: root.clone(),
        };
        let now = Instant::now();
        let mut app = App {
            library,
            data,
            theme,
            ui: Ui::new(),
            state,
            shell: ShellIcons::default(),
            icon_scale: 1.0,
            window: None,
            screen: None,
            frame: None,
            hits: Vec::new(),
            hovered: None,
            cursor: PhysicalPosition::new(0.0, 0.0),
            history: Vec::new(),
            future: Vec::new(),
            last_click: None,
            player: None,
            proxy: None,
            queue: Vec::new(),
            queue_index: 0,
            epoch: now,
            next_tick: now,
            pending: None,
            clear_at: None,
            full: true,
            scrubbing: false,
            timing: std::env::var("UMAKBANG_TIMING").is_ok(),
            layout,
            layout_path: None,
            resizing: None,
            volume_close_at: None,
            cursor_icon: CursorIcon::Default,
            modifiers: ModifiersState::empty(),
            ctrl_click: false,
            tree_open: HashSet::from([crate::library::LIBRARY]),
            search_tx: None,
            search_shared: Arc::new(RwLock::new(crate::search::Shared::default())),
            search_generation: 0,
            analysis: None,
            analysis_wanted: Vec::new(),
            key_test: None,
            capturing: None,
            shortcut_refused: None,
            changelog_open: None,
            output_devices: None,
            local_name: None,
            remote: None,
            peers: None,
            peers_busy: false,
            tray: None,
            tray_status: std::sync::Arc::new(std::sync::Mutex::new("Not serving".into())),
            window_open: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            told_still_running: false,
            start_hidden: false,
            launch_args: Vec::new(),
            data_path: PathBuf::new(),
            bundle_busy: false,
            tour_step_at: None,
            library_watch: None,
            parked: None,
            inactive_rect: None,
            syncing: false,
            sync_note: None,
            plugin_summary: None,
            compared: std::collections::HashMap::new(),
            key_testing: false,
            analysed: HashSet::new(),
            stat_rows: None,
            downloader: None,
            user_data: PathBuf::new(),
            row_drag: None,
            undo_history: crate::undo::History::default(),
            pending_open: None,
            restore_bounds: None,
            region_drag: None,
            contract_store: None,
            contract_fonts: None,
            preview_at: None,
            probe_at: None,
            spin_at: None,
            started: Instant::now(),
            db_path,
            file_clipboard: (crate::fsops::Mode::Copy, Vec::new()),
            notice_until: None,
            recent_random: Vec::new(),
            watch: crate::watch::FolderWatch::new(),
            reread_at: None,
            annotation_check_at: None,
            announced_update: None,
            view_files: Vec::new(),
            doc: None,
        };
        // The folder the Electron app was left in, as it reopens there (`lastDir`).
        let start = app.data.settings.last_dir.as_deref().and_then(|dir| app.library.folder_at(dir)).unwrap_or(root);
        app.undo_history.set_limit(undo_depth);
        app.open(start.id, false);
        app.rebuild_tree();
        app.update_facets();
        app
    }

    pub fn open(&mut self, id: i64, record: bool) {
        let Some(folder) = self.library.folder(id) else { return };
        if record && self.state.folder.id != id {
            self.history.push(self.state.folder.id);
            self.future.clear();
        }
        self.state.crumbs = self.library.ancestry(id);
        self.state.folders = self.library.children(Some(id));
        // The same folder read again: what has left it stays, faded, where it was. Only files
        // of this folder itself, and only ones the disk confirms are gone - a search or a flat
        // list holds rows from elsewhere that merely are not in this listing.
        let again = self.state.view == View::Folder && self.state.folder.id == id;
        let before = if again { std::mem::take(&mut self.state.files) } else { Vec::new() };
        self.state.files = self.library.files(id);
        if again {
            let here: std::collections::HashSet<String> = self.state.files.iter().map(|f| f.path.clone()).collect();
            self.state.gone.retain(|p| !here.contains(p));
            for file in before {
                if file.dir == folder.path && !here.contains(&file.path) && !std::path::Path::new(&file.path).exists() {
                    self.state.gone.insert(file.path.clone());
                    self.state.files.push(file);
                }
            }
        } else {
            self.state.gone.clear();
        }
        // Sort is remembered per folder, falling back to the global one (`effectiveSort`).
        self.state.sort = self.data.settings.folder_sort.get(&folder.path).cloned().unwrap_or_else(|| Sort {
            key: self.data.settings.sort_key.clone().unwrap_or_else(|| "name".into()),
            dir: self.data.settings.sort_dir.clone().unwrap_or_else(|| "asc".into()),
        });
        self.sort_rows();
        self.state.selection.clear();
        self.state.focus = None;
        self.state.scroll = 0.0;
        self.state.searching = false;
        self.state.view = View::Folder;
        if record && self.data.settings.last_dir.as_deref() != Some(folder.path.as_str()) {
            self.data.settings.last_dir = Some(folder.path.clone());
            // Only the main pane says where to reopen: closing in a split must not reopen in the
            // second pane's folder.
            if !self.state.split.is_some_and(|s| s.second_active) {
                self.write_setting("lastDir", serde_json::Value::from(folder.path.clone()));
            }
        }
        self.state.folder = folder;
        self.state.can_back = !self.history.is_empty();
        self.state.can_forward = !self.future.is_empty();
        self.resolve_rows();
        // A query typed stays typed: it now searches the folder just opened, as in Electron -
        // and folders off lists it flat.
        if !self.state.search.value.trim().is_empty() || self.state.recursive {
            self.send_search();
        }
    }

    /// Switches on these tag filters - for shots.
    pub fn filter_tags(&mut self, tags: Vec<String>) {
        self.state.tag_filter = tags;
        self.refilter();
    }

    /// Re-reads whatever is on screen after a filter changed.
    fn refilter(&mut self) {
        self.update_facets();
        let scroll = self.state.scroll;
        if self.state.view != View::Folder || self.state.searching {
            if self.state.view == View::Folder {
                self.send_search();
            } else {
                let view = self.state.view;
                self.show_view(view);
            }
        } else {
            let id = self.state.folder.id;
            self.open(id, false);
        }
        self.state.scroll = scroll.min((table::row_count(&self.state) as f32 * table::ROW).max(0.0));
    }

    /// `useTagFacets`: per tag, how many tagged paths carry it and every tag already selected.
    fn update_facets(&mut self) {
        let filter = &self.state.tag_filter;
        if filter.is_empty() {
            self.state.tag_available = self.state.tags.iter().map(|(_, n)| *n).collect();
            return;
        }
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for applied in self.data.tags.values() {
            if filter.iter().all(|t| applied.contains(t)) {
                for tag in applied {
                    *counts.entry(tag.as_str()).or_default() += 1;
                }
            }
        }
        self.state.tag_available = self.state.tags.iter().map(|(tag, _)| counts.get(tag.as_str()).copied().unwrap_or(0)).collect();
    }

    /// The tag filter applied to the rows in hand, as `useVisibleRows` narrows them: every
    /// selected tag must answer for a row. A file answers by carrying it or by sitting under a
    /// folder that does; a folder answers when something tagged is at or below it, or when it
    /// is inside a tagged folder itself.
    fn narrow_by_tags(&mut self) {
        if self.state.tag_filter.is_empty() {
            return;
        }
        let lower = |s: &str| s.to_lowercase();
        let under = |path: &str, dir: &str| {
            let (p, d) = (lower(path), lower(dir));
            p == d || p.starts_with(&format!("{d}/"))
        };
        let reach: Vec<(String, Vec<String>, Vec<String>)> = self
            .state
            .tag_filter
            .iter()
            .map(|tag| {
                let paths: Vec<String> = self.data.tags.iter().filter(|(_, applied)| applied.contains(tag)).filter_map(|(path, _)| self.data.relative(path)).collect();
                let dirs: Vec<String> = paths.iter().filter(|p| self.library.folder_at(p).is_some()).cloned().collect();
                (tag.clone(), paths, dirs)
            })
            .collect();
        let tags = &self.data.tags;
        self.state.files.retain(|f| {
            reach.iter().all(|(tag, _, dirs)| tags.get(&f.path).is_some_and(|applied| applied.contains(tag)) || dirs.iter().any(|d| under(&f.dir, d)))
        });
        self.state.folders.retain(|folder| {
            reach.iter().all(|(_, paths, dirs)| paths.iter().any(|p| under(p, &folder.path)) || dirs.iter().any(|d| under(&folder.path, d)))
        });
        self.state.file_meta = self.state.files.iter().map(|f| table::meta_for(f, &self.data)).collect();
        if self.state.searching {
            self.state.search_total = self.state.files.len();
        }
    }

    /// The type filter, as `narrowed` applies it: within kinds and within extensions the
    /// entries are ORed, and the two lists ANDed. Folder rows are not file types.
    fn narrow_by_type(&mut self) {
        let filter = self.data.settings.type_filter.clone();
        if filter.kinds.is_empty() && filter.exts.is_empty() {
            return;
        }
        self.state.files.retain(|f| {
            (filter.kinds.is_empty() || filter.kinds.contains(&f.kind)) && (filter.exts.is_empty() || filter.exts.contains(&f.ext.to_lowercase()))
        });
        self.state.file_meta = self.state.files.iter().map(|f| table::meta_for(f, &self.data)).collect();
        if self.state.searching {
            self.state.search_total = self.state.files.len();
        }
    }

    /// Tags, folder tags and icons for whatever rows the table now holds.
    fn resolve_rows(&mut self) {
        self.narrow_by_tags();
        self.narrow_by_type();
        let filter = &self.data.settings.type_filter;
        self.state.audio_only = filter.kinds.iter().any(|k| k == "audio");
        self.state.type_filters = filter.kinds.len() + filter.exts.len();
        self.state.play_on_select = self.data.settings.play_on_select;
        self.state.auto_advance = self.data.settings.auto_advance;
        self.state.file_tags = self
            .state
            .files
            .iter()
            .filter_map(|f| self.data.tags.get(&f.path).map(|tags| (f.path.clone(), tags.clone())))
            .collect();
        self.state.folder_tags = self
            .state
            .folders
            .iter()
            .filter_map(|f| self.data.absolute(&f.path).and_then(|abs| self.data.tags.get(&abs)).map(|tags| (f.id, tags.clone())))
            .collect();
        self.load_file_icons();
    }

    /// Finder's or Explorer's icon for each file type the table holds that has none yet. Images
    /// are drawn at their own pixel size, so each is made at the scale of the frames it is drawn
    /// in: 28px for a 14pt box on a Retina screen.
    fn load_file_icons(&mut self) {
        if !self.data.settings.system_file_icons.unwrap_or(true) {
            return;
        }
        let px = (14.0 * self.icon_scale.max(1.0)).round() as u32;
        for file in &self.state.files {
            let ext = file.ext.to_lowercase();
            if self.state.file_icons.contains_key(&ext) {
                continue;
            }
            if let Some(icon) = self.shell.get(&ext).and_then(|p| crate::shell_icon::resized(p, px)) {
                self.state.file_icons.insert(ext, Rc::new(icon));
            }
        }
    }

    /// Remakes the file icons when frames start being drawn at another scale: the first frame
    /// (the folder opened on was read before the window existed, when the scale was a guess) and
    /// a move between a Retina screen and a standard one.
    fn match_icon_scale(&mut self, scale: f32) {
        if scale == self.icon_scale {
            return;
        }
        self.icon_scale = scale;
        self.state.file_icons.clear();
        self.load_file_icons();
        // The split view's other pane, parked, is made at the same scale.
        if let Some(mut pane) = self.parked.take() {
            pane.file_icons.clear();
            std::mem::swap(&mut self.state.files, &mut pane.files);
            std::mem::swap(&mut self.state.file_icons, &mut pane.file_icons);
            self.load_file_icons();
            std::mem::swap(&mut self.state.files, &mut pane.files);
            std::mem::swap(&mut self.state.file_icons, &mut pane.file_icons);
            self.parked = Some(pane);
        }
    }

    /// Scans every library folder in the background (`beginScan`); `full` reads every folder
    /// rather than trusting the ones whose mtime has not moved.
    pub fn start_scan(&mut self, full: bool) {
        let Some(proxy) = self.proxy.clone() else { return };
        let roots: Vec<(PathBuf, String)> = self.data.settings.roots.iter().filter(|r| r.is_local()).map(|r| (PathBuf::from(&r.path), r.label.clone())).collect();
        // Mounted libraries are fetched whether or not there is anything local to walk.
        self.fetch_remote_indexes();
        if roots.is_empty() {
            return;
        }
        self.state.scan_status = Some("checking for changes".into());
        crate::scan::spawn(self.db_path.clone(), roots, full, proxy);
    }

    /// Every mounted library's index, fetched again.
    pub(crate) fn fetch_remote_indexes(&mut self) {
        let Some(proxy) = self.proxy.clone() else { return };
        crate::remote::set_roots(&self.data.settings.roots);
        for root in self.data.settings.roots.iter().filter_map(crate::remote::RemoteRoot::from_root) {
            crate::scan::spawn_remote(self.db_path.clone(), root, proxy.clone());
        }
    }

    /* ------------------------------------------------------------ contracts */

    fn ensure_contracts(&mut self) {
        if self.contract_store.is_none() {
            self.contract_store = Some(crate::contracts::Store::load(&self.user_data));
        }
        if self.contract_fonts.is_none() {
            self.contract_fonts = crate::contracts::Fonts::load().map(Rc::new);
        }
        self.sync_contract_data();
    }

    /// The page reads a copy of the document, refreshed after every change.
    fn sync_contract_data(&mut self) {
        self.state.contracts.data = self.contract_store.as_ref().map(|s| Rc::new(s.data.clone()));
    }

    /// Your terms and the template, into their fields - unless one is being edited.
    fn fill_contract_fields(&mut self) {
        let Some(data) = self.state.contracts.data.clone() else { return };
        let p = &data.profile;
        for (key, value) in [("t.fullName", &p.full_name), ("t.alias", &p.alias), ("t.email", &p.email), ("t.governingState", &p.governing_state), ("t.fileType", &p.file_type)] {
            if self.state.form.focus != Some(key) {
                self.state.form.set(key, value.clone());
            }
        }
        if !self.state.form.fields.contains_key("tpl") {
            self.state.form.set("tpl", data.template.clone());
            if let Some(f) = self.state.form.fields.get_mut("tpl") {
                f.caret = 0;
                f.anchor = 0;
            }
        }
    }

    pub fn open_contract_draft(&mut self, titles: Vec<String>) {
        self.ensure_contracts();
        let form = &mut self.state.form;
        form.blur();
        form.set("c.titles", titles.join("\n"));
        for (key, value) in [("c.customer", ""), ("c.alias", ""), ("c.email", ""), ("c.price", "300"), ("c.writer", "25"), ("c.publisher", "25")] {
            form.set(key, value);
        }
        self.state.contracts.draft = Some(crate::contracts_page::Draft { remember: false, busy: false, preview: Rc::new(Default::default()), preview_scroll: 0.0 });
        self.refresh_preview();
        // The titles take the keyboard, caret at the start, as the dialog opens.
        self.state.form.focus("c.titles");
        if let Some(f) = self.state.form.fields.get_mut("c.titles") {
            f.caret = 0;
            f.anchor = 0;
        }
    }

    fn draft_input(&self) -> crate::contracts::Input {
        let f = &self.state.form;
        let or_zero = |v: &str| if v.trim().is_empty() { "0".to_string() } else { v.trim().to_string() };
        crate::contracts::Input {
            titles: crate::contracts_page::titles_list(&self.state),
            customer: f.value("c.customer").trim().into(),
            alias: f.value("c.alias").trim().into(),
            email: f.value("c.email").trim().into(),
            price: f.value("c.price").trim().into(),
            producer_writer: or_zero(f.value("c.writer")),
            producer_publisher: or_zero(f.value("c.publisher")),
        }
    }

    fn refresh_preview(&mut self) {
        let input = self.draft_input();
        let (Some(store), Some(fonts)) = (self.contract_store.as_ref(), self.contract_fonts.clone()) else { return };
        let width = (crate::contracts_page::PREVIEW_WIDTH - crate::contracts_page::PREVIEW_SCROLLBAR - 16.0) * 0.75;
        let page = store.preview_flow(&input, &fonts, width);
        if let Some(draft) = self.state.contracts.draft.as_mut() {
            draft.preview = Rc::new(page);
        }
    }

    fn contracts_action(&mut self, what: &str) {
        match what {
            "close" => {
                let id = self.state.folder.id;
                self.open(id, false);
            }
            "change-dir" => {
                let start = self.contract_store.as_ref().map(|s| PathBuf::from(&s.data.output_dir));
                if let Some(dir) = crate::dialogs::pick_folder("Where contracts are written", start.as_deref(), self.hwnd()) {
                    if let Some(store) = self.contract_store.as_mut() {
                        store.data.output_dir = dir.to_string_lossy().into_owned();
                        store.persist();
                    }
                    self.sync_contract_data();
                }
            }
            "add-preset" => self.add_preset(),
            "revert" => {
                if let Some(template) = self.contract_store.as_ref().map(|s| s.data.template.clone()) {
                    self.state.form.set("tpl", template);
                }
            }
            "save-template" => {
                let value = self.state.form.value("tpl").to_string();
                if !value.trim().is_empty() {
                    if let Some(store) = self.contract_store.as_mut() {
                        store.data.template = value;
                        store.persist();
                    }
                    self.sync_contract_data();
                }
            }
            "remember" => {
                if let Some(d) = self.state.contracts.draft.as_mut() {
                    d.remember = !d.remember;
                }
            }
            "cancel" | "backdrop" => {
                if !self.state.contracts.draft.as_ref().is_some_and(|d| d.busy) {
                    self.state.contracts.draft = None;
                    self.state.form.blur();
                }
            }
            "generate" => self.generate_contract(),
            _ => {}
        }
    }

    fn add_preset(&mut self) {
        let f = &self.state.form;
        let preset = crate::contracts::Preset { name: f.value("p.name").into(), alias: f.value("p.alias").into(), email: f.value("p.email").into() };
        if preset.name.trim().is_empty() && preset.alias.trim().is_empty() {
            return;
        }
        if let Some(store) = self.contract_store.as_mut() {
            store.save_preset(preset);
        }
        for key in ["p.name", "p.alias", "p.email"] {
            self.state.form.set(key, "");
        }
        self.sync_contract_data();
    }

    fn generate_contract(&mut self) {
        if !crate::contracts_page::draft_ready(&self.state) || self.state.contracts.draft.as_ref().is_none_or(|d| d.busy) {
            return;
        }
        let input = self.draft_input();
        let remember = self.state.contracts.draft.as_ref().is_some_and(|d| d.remember);
        let (Some(store), Some(fonts)) = (self.contract_store.as_mut(), self.contract_fonts.clone()) else { return };
        if remember {
            store.save_preset(crate::contracts::Preset { name: input.customer.clone(), alias: input.alias.clone(), email: input.email.clone() });
        }
        let result = store.generate(input, &fonts);
        self.sync_contract_data();
        match result {
            Ok(record) => {
                self.state.contracts.draft = None;
                self.state.form.blur();
                self.notify(match &record.pdf_path {
                    Some(_) => format!("Contract written for {}.", record.input.titles.join(" & ")),
                    None => format!("Contract written, but the PDF failed: {}", record.pdf_error.unwrap_or_else(|| "unknown error".into())),
                });
            }
            Err(problem) => self.notify(problem),
        }
    }

    /// The window, for a dialog to sit modal over.
    fn hwnd(&self) -> Option<isize> {
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        match self.window.as_ref()?.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
            _ => None,
        }
    }

    /* ------------------------------------------------------------ form fields */

    fn is_area(key: &str) -> bool {
        key == "tpl" || key == "c.titles"
    }

    fn area_style(&self, key: &str) -> crate::ui::text::TextStyle {
        if key == "tpl" { crate::contracts_page::template_style(&self.theme) } else { crate::contracts_page::titles_style(&self.theme) }
    }

    /// The text width of a field's box as last drawn: its hit less the padding and border.
    fn field_geometry(&self, key: &'static str) -> Option<([f32; 4], [f32; 2])> {
        let scale = self.scale() as f32;
        self.hits.iter().rev().find(|h| h.action == Action::Field(key)).map(|h| (h.rect.map(|v| v / scale), h.origin.map(|v| v / scale)))
    }

    fn focus_field(&mut self, key: &'static str) {
        if let Some(old) = self.state.form.focus.filter(|k| *k != key) {
            self.state.form.blur();
            self.field_left(old);
        }
        self.state.search.focused = false;
        self.state.form.focus(key);
        // Clicked into: the caret goes where the pointer is (areas) or to the end (fields).
        let Some((rect, origin)) = self.field_geometry(key) else { return };
        let scale = self.scale() as f32;
        let (x, y) = (self.cursor.x as f32 / scale, self.cursor.y as f32 / scale);
        if Self::is_area(key) {
            let style = self.area_style(key);
            let width = rect[2] - rect[0] - 18.0;
            let scroll = self.state.form.scroll.get(key).copied().unwrap_or(0.0);
            let Some(f) = self.state.form.fields.get_mut(key) else { return };
            let lines = crate::ui::tree::area_lines(&mut self.ui.text, &f.value, &style, width);
            let line = (((y - origin[1] - 7.0 + scroll) / style.line_height).floor().max(0.0) as usize).min(lines.len().saturating_sub(1));
            if let Some(range) = lines.get(line).copied() {
                f.caret = crate::form::offset_at(&mut self.ui.text, &f.value, range, &style, x - origin[0] - 9.0);
                f.anchor = f.caret;
            }
        } else if let Some(f) = self.state.form.fields.get_mut(key) {
            f.caret = f.value.len();
            f.anchor = f.caret;
        }
    }

    /// A field losing the keyboard: your terms are saved as you leave each one.
    fn field_left(&mut self, key: &'static str) {
        let value = self.state.form.value(key).to_string();
        if key == "a.keyCommand" {
            if self.data.settings.key_command.as_deref().unwrap_or("") != value {
                self.data.settings.key_command = Some(value.clone());
                if let Some(q) = &self.analysis {
                    q.set_key_command(&value);
                }
                self.write_setting("keyCommand", serde_json::Value::from(value));
            }
            return;
        }
        if key == "s.key" {
            if value != self.data.settings.lalal_key {
                self.data.settings.lalal_key = value.clone();
                self.state.stem_settings.key = value.clone();
                self.write_setting("lalalKey", serde_json::Value::from(value));
            }
            return;
        }
        let Some(store) = self.contract_store.as_mut() else { return };
        let p = &mut store.data.profile;
        let slot = match key {
            "t.fullName" => &mut p.full_name,
            "t.alias" => &mut p.alias,
            "t.email" => &mut p.email,
            "t.governingState" => &mut p.governing_state,
            "t.fileType" => &mut p.file_type,
            _ => return,
        };
        if *slot != value {
            *slot = value;
            store.persist();
            self.sync_contract_data();
        }
    }

    fn form_key(&mut self, event: &KeyEvent) {
        let Some(key) = self.state.form.focus else { return };
        let (ctrl, shift, alt) = (self.command_key(), self.modifiers.shift_key(), self.modifiers.alt_key());
        let before = self.state.form.value(key).to_string();
        let in_dialog = self.state.contracts.draft.is_some();
        if Self::is_area(key) {
            let style = self.area_style(key);
            let width = self.field_geometry(key).map_or(400.0, |(r, _)| r[2] - r[0] - 18.0);
            let height = self.field_geometry(key).map_or(400.0, |(r, _)| r[3] - r[1] - 14.0);
            let Some(f) = self.state.form.fields.get_mut(key) else { return };
            match crate::form::edit_area(f, event, ctrl, shift, alt, &mut self.ui.text, &style, width) {
                crate::form::AreaEdit::Escape if in_dialog => self.contracts_action("cancel"),
                crate::form::AreaEdit::Escape => {
                    self.state.form.blur();
                }
                _ => {}
            }
            if let Some(f) = self.state.form.fields.get(key) {
                let line = crate::form::caret_line(&mut self.ui.text, f, &style, width);
                let scroll = self.state.form.scroll.get(key).copied().unwrap_or(0.0);
                self.state.form.scroll.insert(key, crate::form::scroll_to_caret(scroll, line, style.line_height, height));
            }
        } else {
            let Some(f) = self.state.form.fields.get_mut(key) else { return };
            match ops::edit_field(f, event, ctrl, shift, alt) {
                ops::Edit::Enter => match key {
                    k if k.starts_with("c.") => self.generate_contract(),
                    k if k.starts_with("p.") => self.add_preset(),
                    _ => {
                        self.state.form.blur();
                        self.field_left(key);
                    }
                },
                ops::Edit::Escape if in_dialog => self.contracts_action("cancel"),
                ops::Edit::Escape => {
                    self.state.form.blur();
                    self.field_left(key);
                }
                _ => {}
            }
        }
        if key == "cp.hex" && self.state.form.value(key) != before {
            let typed = self.state.form.value(key).to_string();
            let taken = self.state.color_picker.as_mut().is_some_and(|p| p.take_hex(&typed));
            if taken {
                self.picker_changed();
            }
        }
        if key == "fl.q" && self.state.form.value(key) != before {
            if let Some(d) = self.state.fl_dialog.as_mut() {
                d.scroll = [0.0, 0.0];
                d.anchors = [None, None];
            }
        }
        if key.starts_with("c.") && self.state.form.value(key) != before {
            self.preview_at = Some(Instant::now() + Duration::from_millis(250));
        }
    }

    /// Re-runs analysis on these files from scratch (`recalculateAnalysis`): what was detected
    /// is cleared first, since a result never overwrites a value already there.
    fn reprocess(&mut self, paths: Vec<String>) {
        self.reprocess_in(paths, false);
    }

    fn reprocess_in(&mut self, paths: Vec<String>, bulk: bool) {
        let wants_key = self.data.settings.detect_key_from_audio.unwrap_or(true);
        let mut queued = Vec::new();
        for path in paths {
            let Some((_, file)) = self.library.file_at(&path) else { continue };
            if !file.playable {
                continue;
            }
            for (map, removed) in [("detectedBpm", self.data.detected_bpm.remove(&path).is_some()), ("detectedKey", self.data.detected_key.remove(&path).is_some()), ("detectedKeyFit", self.data.detected_key_fit.remove(&path).is_some())] {
                if removed {
                    if let Some(doc) = self.doc.as_mut() {
                        doc.set(map, &path, None);
                    }
                }
            }
            self.analysed.remove(&path);
            queued.push((path, wants_key));
        }
        if let Ok(mut shared) = self.search_shared.write() {
            shared.bpm = self.data.detected_bpm.clone();
            shared.key = self.data.detected_key.clone();
        }
        for (at, file) in self.state.files.iter().enumerate() {
            if queued.iter().any(|(p, _)| *p == file.path) {
                if let Some(meta) = self.state.file_meta.get_mut(at) {
                    *meta = table::meta_for(file, &self.data);
                }
            }
        }
        let count = queued.len();
        if let Some(queue) = &self.analysis {
            if bulk { queue.bulk(queued) } else { queue.pin(queued) }
        }
        if count > 1 {
            self.notify(format!("Reprocessing {count} files."));
        }
    }

    /* ------------------------------------------------------------ the tailnet server */

    /// This install's id on the tailnet, made once if the profile has none.
    fn device_id(&mut self) -> String {
        if let Some(id) = self.data.settings.device_id.clone().filter(|id| !id.is_empty()) {
            return id;
        }
        use sha1::{Digest, Sha1};
        let seed = format!("{:?}{}{:?}", std::time::SystemTime::now(), std::process::id(), self.user_data);
        let hex: String = Sha1::digest(seed.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        // A v4 UUID's shape, as `randomUUID` makes.
        let id = format!("{}-{}-4{}-a{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32]);
        self.data.settings.device_id = Some(id.clone());
        self.write_setting("deviceId", serde_json::Value::from(id.clone()));
        id
    }

    pub fn start_server(&mut self) {
        let Some(proxy) = self.proxy.clone() else { return };
        if self.remote.is_none() {
            let writes = proxy.clone();
            let forward: crate::server::Forward = std::sync::Arc::new(move |write| {
                let (tx, rx) = std::sync::mpsc::channel();
                if writes.send_event(Wake::RemoteWrite(write, tx)).is_err() {
                    return Err("the app is closing".into());
                }
                // The honest answer to a wedged window is that the write did not land.
                rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or_else(|_| Err("the app did not answer".into()))
            });
            let notify: crate::server::Notify = std::sync::Arc::new(move || {
                let _ = proxy.send_event(Wake::Remote);
            });
            self.remote = Some(crate::server::supervise(env!("CARGO_PKG_VERSION").to_string(), forward, notify));
        }
        self.configure_server();
    }

    /// What the server serves, again: after the library folders or the switch changed.
    pub(crate) fn configure_server(&mut self) {
        let share = self.data.settings.share_library.unwrap_or(true);
        let base = share.then(|| crate::server::Base {
            device_id: self.device_id(),
            roots: self.data.settings.roots.iter().filter(|r| r.is_local()).map(|r| (r.path.clone(), r.label.clone())).collect(),
            data_dir: self.user_data.clone(),
            db: self.db_path.clone(),
            fl_user_data: self.data.settings.fl_user_data.clone().filter(|p| !p.is_empty()).map(PathBuf::from).unwrap_or_else(crate::server::default_fl_user_data),
        });
        if let Some(remote) = &self.remote {
            let _ = remote.tx.send(crate::server::Command::Configure(base));
        }
    }

    /// A peer's write, applied as if made here, and answered.
    fn apply_remote_write(&mut self, write: crate::server::Write) -> Result<(), String> {
        match write {
            crate::server::Write::Rating { path, rating } => {
                if !rating.is_finite() {
                    return Err("not a rating".into());
                }
                self.rate(&[path], rating.round().clamp(0.0, 5.0) as u8);
            }
            crate::server::Write::Tags { path, tags } => {
                let tags: Vec<String> = tags.into_iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && t.chars().count() <= 64).collect();
                self.set_tags(&path, tags);
            }
            crate::server::Write::Rescan { path } => {
                if !self.data.settings.roots.iter().any(|r| r.is_local() && r.path.trim_end_matches(['\\', '/']) == path) {
                    return Err("this machine cannot rescan right now".into());
                }
                self.start_scan(false);
            }
        }
        Ok(())
    }

    /* ------------------------------------------------------------ running in the background */

    /// Whether the login item may be touched from this copy: never from a test build on a
    /// scratch profile, which would leave Windows starting something in a temp folder.
    fn may_register() -> bool {
        let temp = std::env::temp_dir();
        // Never a portable copy either: it would try to start from a stick that has gone home.
        // Nor a development build, which would leave the OS starting whatever was last built at login.
        let dev = std::env::current_exe().is_ok_and(|exe| {
            let lower = exe.to_string_lossy().to_lowercase().replace('\\', "/");
            lower.contains("/target/release/") || lower.contains("/target/debug/")
        });
        std::env::var("UMAKBANG_SERVE").is_err() && std::env::current_exe().is_ok_and(|exe| !exe.starts_with(&temp)) && !crate::portable::is_portable() && !dev
    }

    /// The tray up or down with the setting. `chosen` is a switch flipped here, which is the
    /// only thing that adds the login item: until somebody turns it on in this app, the Electron
    /// umakbang stays the one that starts with Windows.
    fn sync_background(&mut self, chosen: bool) {
        let on = self.data.settings.run_in_background.unwrap_or(true);
        if Self::may_register() && (chosen || crate::tray::login_item_present()) {
            crate::tray::set_login_item(on, &self.launch_args);
        }
        if on && self.tray.is_none() && self.proxy.is_some() {
            self.update_tray_status();
            let proxy = self.proxy.clone().expect("proxy");
            self.tray = crate::tray::show(self.tray_status.clone(), self.window_open.clone(), move |event| {
                let _ = proxy.send_event(Wake::Tray(event));
            });
        } else if !on {
            self.tray = None;
        }
    }

    /// Closing the window, by its X or the system's (and Cmd+Q on a Mac): in the background the
    /// app stays, serving from the tray, and only the window goes; otherwise it quits.
    fn close_window(&mut self, event_loop: &ActiveEventLoop) {
        self.flush_doc();
        if self.data.settings.run_in_background.unwrap_or(true) && self.tray.is_some() {
            self.hide_window();
        } else {
            event_loop.exit()
        }
    }

    fn set_run_in_background(&mut self, on: bool) {
        self.data.settings.run_in_background = Some(on);
        self.write_setting("runInBackground", serde_json::Value::Bool(on));
        self.sync_background(true);
        self.refresh_settings_values();
    }

    fn update_tray_status(&mut self) {
        let Some(state) = self.remote.as_ref().and_then(|r| r.state.lock().ok().map(|s| s.clone())) else { return };
        let line = if state.listening {
            format!("Serving on {}", state.address.unwrap_or_else(|| "the tailnet".into()))
        } else {
            match state.reason {
                Some(reason) => format!("Not serving: {reason}"),
                None => "Not serving".into(),
            }
        };
        if let Ok(mut status) = self.tray_status.lock() {
            *status = line;
        }
        if let Some(tray) = &self.tray {
            tray.refresh();
        }
    }

    /// Closed into the tray: the sound stops, as it does when the Electron window goes.
    fn hide_window(&mut self) {
        if let Some(player) = &self.player {
            player.pause();
        }
        self.close_overlays();
        if let Some(window) = &self.window {
            window.set_visible(false);
        }
        #[cfg(target_os = "macos")]
        crate::tray::set_in_dock(false);
        self.window_open.store(false, std::sync::atomic::Ordering::Relaxed);
        // The finished frame is the one big allocation the hidden window holds.
        self.frame = None;
        if !self.told_still_running {
            self.told_still_running = true;
            if let Some(tray) = &self.tray {
                tray.balloon();
            }
        }
    }

    fn show_window(&mut self) {
        let Some(window) = self.window.clone() else { return };
        #[cfg(target_os = "macos")]
        crate::tray::set_in_dock(true);
        window.set_visible(true);
        window.set_minimized(false);
        window.focus_window();
        self.window_open.store(true, std::sync::atomic::Ordering::Relaxed);
        self.redraw();
    }

    /// What opening a Settings section reads, for a section shown from the environment; and
    /// `UMAKBANG_FL=1`, the favourites manager open over it.
    pub fn prepare_section(&mut self) {
        if self.state.settings_section == 8 {
            self.read_plugins();
            if std::env::var("UMAKBANG_FL").is_ok() {
                let catalog = crate::fl_plugins::read_catalog(&self.fl_user_data());
                self.state.fl_dialog = Some(crate::fl_plugins::Dialog { catalog, formats: Default::default(), picked: Default::default(), anchors: [None, None], scroll: [0.0, 0.0], busy: false, note: None });
            }
        }
        self.refresh_settings_values();
    }

    fn fl_user_data(&self) -> PathBuf {
        self.data.settings.fl_user_data.clone().filter(|p| !p.is_empty()).map(PathBuf::from).unwrap_or_else(crate::server::default_fl_user_data)
    }

    /// This machine's plugin list and how many of them are favourites.
    fn read_plugins(&mut self) {
        let user_data = self.fl_user_data();
        let inventory = crate::server::plugin_inventory(&user_data);
        let catalog = crate::fl_plugins::read_catalog(&user_data);
        let favourites = catalog.plugins.iter().filter(|p| p.favourite).count();
        self.plugin_summary = Some((inventory, catalog.plugins.len(), favourites));
    }

    /* ------------------------------------------------------------ two folders at once */

    /// Trades the store's pane fields with the parked pane's: the other half becomes the one
    /// worked in. Everything reading the store then reads that half, which is the whole design.
    fn swap_panes(&mut self) {
        let Some(mut p) = self.parked.take() else { return };
        let s = &mut self.state;
        if let Some(folder) = p.folder.as_mut() {
            std::mem::swap(&mut s.folder, folder);
        }
        std::mem::swap(&mut s.crumbs, &mut p.crumbs);
        std::mem::swap(&mut s.folders, &mut p.folders);
        std::mem::swap(&mut s.files, &mut p.files);
        std::mem::swap(&mut s.file_meta, &mut p.file_meta);
        std::mem::swap(&mut s.folder_tags, &mut p.folder_tags);
        std::mem::swap(&mut s.file_tags, &mut p.file_tags);
        std::mem::swap(&mut s.file_icons, &mut p.file_icons);
        std::mem::swap(&mut s.selection, &mut p.selection);
        std::mem::swap(&mut s.focus, &mut p.focus);
        std::mem::swap(&mut s.scroll, &mut p.scroll);
        std::mem::swap(&mut s.scroll_x, &mut p.scroll_x);
        if let Some(sort) = p.sort.as_mut() {
            std::mem::swap(&mut s.sort, sort);
        }
        std::mem::swap(&mut s.hover_row, &mut p.hover_row);
        std::mem::swap(&mut s.hover_star, &mut p.hover_star);
        if let Some(view) = p.view.as_mut() {
            std::mem::swap(&mut s.view, view);
        }
        std::mem::swap(&mut s.searching, &mut p.searching);
        std::mem::swap(&mut s.search_total, &mut p.search_total);
        std::mem::swap(&mut s.can_back, &mut p.can_back);
        std::mem::swap(&mut s.can_forward, &mut p.can_forward);
        std::mem::swap(&mut self.history, &mut p.history);
        std::mem::swap(&mut self.future, &mut p.future);
        self.parked = Some(p);
    }

    /// The other half brought forward, as a press inside it does.
    fn activate_other(&mut self) {
        if self.parked.is_none() {
            return;
        }
        self.swap_panes();
        if let Some(split) = self.state.split.as_mut() {
            split.second_active = !split.second_active;
        }
        self.pending_open = None;
        self.redraw();
    }

    /// `openInOtherPane`: the folder in the other half - opening the split, with the half you
    /// were in kept as the main pane, if there was none.
    pub(crate) fn open_in_other_pane(&mut self, id: i64) {
        if self.parked.is_none() {
            // Everything this pane is, parked whole; the store's fields become the new pane.
            let s = &self.state;
            self.parked = Some(Pane {
                folder: Some(s.folder.clone()),
                crumbs: s.crumbs.clone(),
                folders: s.folders.clone(),
                files: s.files.clone(),
                file_meta: s.file_meta.clone(),
                folder_tags: s.folder_tags.clone(),
                file_tags: s.file_tags.clone(),
                file_icons: s.file_icons.clone(),
                selection: s.selection.clone(),
                focus: s.focus,
                scroll: s.scroll,
                scroll_x: s.scroll_x,
                sort: Some(s.sort.clone()),
                hover_row: None,
                hover_star: None,
                view: Some(s.view),
                searching: s.searching,
                search_total: s.search_total,
                can_back: s.can_back,
                can_forward: s.can_forward,
                history: self.history.clone(),
                future: self.future.clone(),
            });
            self.state.split = Some(screen::Split { ratio: 0.5, second_active: true });
            self.history.clear();
            self.future.clear();
            self.state.selection.clear();
            self.state.focus = None;
            self.state.searching = false;
            self.state.view = View::Folder;
            self.open(id, false);
            self.state.scroll = 0.0;
            self.redraw();
            return;
        }
        self.activate_other();
        self.state.view = View::Folder;
        self.open(id, true);
    }

    /// `closePane`: the half worked in goes and the other carries on as the main pane.
    fn close_pane(&mut self) {
        if self.parked.is_none() {
            return;
        }
        self.swap_panes();
        self.parked = None;
        self.state.split = None;
        self.inactive_rect = None;
        // The survivor may have been the second pane, which never wrote where it was standing.
        if self.state.view == View::Folder {
            let path = self.state.folder.path.clone();
            self.write_setting("lastDir", serde_json::Value::from(path));
        }
        self.redraw();
    }

    /// `swap_panes` with the split's own record of which half is which kept true.
    fn trade_panes(&mut self) {
        self.swap_panes();
        if let Some(split) = self.state.split.as_mut() {
            split.second_active = !split.second_active;
        }
    }

    fn wheel(&mut self, delta: MouseScrollDelta) {
                let (dx, lines) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (-x * 3.0 * table::ROW, -y * 3.0 * table::ROW),
                    MouseScrollDelta::PixelDelta(p) => (-p.x as f32, -p.y as f32),
                };
                // Sideways: a tilt wheel, or Shift with an ordinary one, as Chromium does.
                let (dx, lines) = if self.modifiers.shift_key() && dx == 0.0 { (lines, 0.0) } else { (dx, lines) };
                if dx != 0.0 {
                    let pane = self.pane_width();
                    let next = (self.state.scroll_x + dx).clamp(0.0, table::max_scroll_x(&self.state.columns, pane));
                    if next != self.state.scroll_x {
                        self.state.scroll_x = next;
                        self.redraw();
                    }
                }
                let scale = self.window.as_ref().map(|w| w.scale_factor() as f32).unwrap_or(1.0);
                // A textarea or the contract preview under the pointer scrolls itself.
                let (cx, cy) = (self.cursor.x as f32, self.cursor.y as f32);
                let under = self.hits.iter().rev().find(|h| cx >= h.rect[0] && cx < h.rect[2] && cy >= h.rect[1] && cy < h.rect[3]).map(|h| (h.action.clone(), h.rect));
                if let Some((Action::Field(key), rect)) = under.clone() {
                    if Self::is_area(key) {
                        let style = self.area_style(key);
                        let width = (rect[2] - rect[0]) / scale - 18.0;
                        let height = (rect[3] - rect[1]) / scale - 14.0;
                        let content = self.state.form.fields.get(key).map_or(0, |f| crate::ui::tree::area_lines(&mut self.ui.text, &f.value, &style, width).len()) as f32 * style.line_height;
                        let scroll = self.state.form.scroll.get(key).copied().unwrap_or(0.0);
                        self.state.form.scroll.insert(key, (scroll + lines).clamp(0.0, (content - height).max(0.0)));
                        self.redraw();
                        return;
                    }
                }
                if self.state.importing.is_some() {
                    let (viewport, content) = self.ui.extents.get("import").copied().unwrap_or((0.0, 0.0));
                    if let Some(w) = self.state.importing.as_mut() {
                        w.scroll = (w.scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                    }
                    self.redraw();
                    return;
                }
                if self.state.fl_dialog.is_some() {
                    let (lx, ly) = (cx / scale, cy / scale);
                    for (side, key) in [(0usize, "fl0"), (1, "fl1")] {
                        let inside = self.ui.scroll_rects.get(key).is_some_and(|r| lx >= r[0] && lx < r[2] && ly >= r[1] && ly < r[3]);
                        if inside {
                            let (viewport, content) = self.ui.extents.get(key).copied().unwrap_or((0.0, 0.0));
                            if let Some(d) = self.state.fl_dialog.as_mut() {
                                d.scroll[side] = (d.scroll[side] + lines).clamp(0.0, (content - viewport).max(0.0));
                            }
                            self.redraw();
                        }
                    }
                    return;
                }
                if self.state.contracts.draft.is_some() {
                    if matches!(under, Some((Action::ContractPreview, _))) {
                        if let Some(d) = self.state.contracts.draft.as_mut() {
                            let max = (crate::contracts_page::preview_height(&d.preview) - 620.0).max(0.0);
                            d.preview_scroll = (d.preview_scroll + lines).clamp(0.0, max);
                        }
                        self.redraw();
                    }
                    return;
                }
                if self.state.view == View::Contracts && (self.cursor.x as f32) >= self.state.sizes.sidebar * scale {
                    let (viewport, content) = self.ui.extents.get("contracts").copied().unwrap_or((0.0, 0.0));
                    let next = (self.state.contracts.scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                    if next != self.state.contracts.scroll {
                        self.state.contracts.scroll = next;
                        self.redraw();
                    }
                    return;
                }
                // YT2MP3 likewise.
                if self.state.view == View::Downloading && (self.cursor.x as f32) >= self.state.sizes.sidebar * scale {
                    let (viewport, content) = self.ui.extents.get("youtube").copied().unwrap_or((0.0, 0.0));
                    let next = (self.state.youtube.scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                    if next != self.state.youtube.scroll {
                        self.state.youtube.scroll = next;
                        self.redraw();
                    }
                    return;
                }
                // The Stats page likewise.
                if self.state.view == View::Stats && (self.cursor.x as f32) >= self.state.sizes.sidebar * scale {
                    let (viewport, content) = self.ui.extents.get("stats").copied().unwrap_or((0.0, 0.0));
                    let next = (self.state.stats.scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                    if next != self.state.stats.scroll {
                        self.state.stats.scroll = next;
                        self.state.stats.hover = None;
                        self.redraw();
                    }
                    return;
                }
                // The Settings page scrolls on its own, by what it last laid out at.
                if self.state.view == View::Settings && (self.cursor.x as f32) >= self.state.sizes.sidebar * scale {
                    let (viewport, content) = self.ui.extents.get("settings").copied().unwrap_or((0.0, 0.0));
                    let next = (self.state.settings_scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                    if next != self.state.settings_scroll {
                        self.state.settings_scroll = next;
                        self.redraw();
                    }
                    return;
                }
                // Over the sidebar's lower half the folder tree scrolls; it is the only part of
                // the sidebar long enough to need it so far.
                let split = self.hits.iter().find(|h| h.action == Action::Resize(Handle::Tags)).map(|h| h.rect[3]);
                if (self.cursor.x as f32) < self.state.sizes.sidebar * scale {
                    // Above the split: the tag strip under the pointer first, then - once it is
                    // at its end, as Chromium chains a scroll - the section holding it.
                    if split.is_none_or(|y| self.cursor.y as f32 <= y) {
                        let (lx, ly) = (cx / scale, cy / scale);
                        let inside = |r: &[f32; 4]| lx >= r[0] && lx < r[2] && ly >= r[1] && ly < r[3];
                        let mut moved = false;
                        if self.ui.scroll_rects.get("tags").is_some_and(inside) {
                            let (viewport, content) = self.ui.extents.get("tags").copied().unwrap_or((0.0, 0.0));
                            let next = (self.state.tags_scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                            moved = next != self.state.tags_scroll;
                            self.state.tags_scroll = next;
                        }
                        if !moved {
                            let (viewport, content) = self.ui.extents.get("nav").copied().unwrap_or((0.0, 0.0));
                            let next = (self.state.nav_scroll + lines).clamp(0.0, (content - viewport).max(0.0));
                            moved = next != self.state.nav_scroll;
                            self.state.nav_scroll = next;
                        }
                        if moved {
                            self.redraw();
                        }
                        return;
                    }
                    if let Some(split) = split.filter(|&y| self.cursor.y as f32 > y) {
                        let height = self.window.as_ref().map(|w| w.inner_size().height as f32).unwrap_or(860.0);
                        let viewport = (height - split) / scale - 23.0 - 6.0;
                        let max = (self.state.tree.len() as f32 * 24.0 - viewport).max(0.0);
                        let next = (self.state.tree_scroll + lines).clamp(0.0, max);
                        if next != self.state.tree_scroll {
                            self.state.tree_scroll = next;
                            self.redraw();
                        }
                    }
                    return;
                }
                let height = self.window.as_ref().map(|w| w.inner_size().height as f32 / scale).unwrap_or(860.0);
                let body = table::body_height(height, self.state.sizes.player);
                let max = (table::row_count(&self.state) as f32 * table::ROW - body).max(0.0);
                let next = (self.state.scroll + lines).clamp(0.0, max);
                if next != self.state.scroll {
                    self.state.scroll = next;
                    self.redraw();
                }
    }

    /// The window's element tree, the parked pane drawn from its own fields by trading them in
    /// for the moment it takes to build.
    fn build_tree(&mut self, viewport: (f32, f32)) -> crate::ui::tree::El<Action> {
        let mut other = None;
        self.inactive_rect = None;
        if let (Some(split), true, false) = (self.state.split, self.parked.is_some(), self.state.view.is_page() || self.state.no_library) {
            let middle = viewport.0 - self.state.sizes.sidebar - self.state.sizes.panel;
            let (left, right) = screen::pane_widths(middle, split.ratio);
            let (width, x) = if split.second_active { (left, self.state.sizes.sidebar) } else { (right, self.state.sizes.sidebar + left + 1.0) };
            self.swap_panes();
            other = Some(screen::explorer_pane(&self.state, &self.theme, viewport.1, width, false));
            self.swap_panes();
            self.inactive_rect = Some([x, 38.0, x + width, viewport.1 - self.state.sizes.player]);
        }
        screen::build(&self.state, &self.theme, viewport, other)
    }

    /// Whether the pointer is over the half not being worked in.
    fn over_inactive(&self) -> bool {
        let scale = self.scale() as f32;
        let (x, y) = (self.cursor.x as f32 / scale, self.cursor.y as f32 / scale);
        self.inactive_rect.is_some_and(|r| x >= r[0] && x < r[2] && y >= r[1] && y < r[3])
    }

    /// The pane the table works in, as wide as it is drawn: the whole middle, or its half.
    pub(crate) fn pane_width(&self) -> f32 {
        let middle = self.logical_size().0 - self.state.sizes.sidebar - self.state.sizes.panel;
        match self.state.split {
            Some(split) => {
                let (left, right) = screen::pane_widths(middle, split.ratio);
                if split.second_active { right } else { left }
            }
            None => middle,
        }
    }

    /// Where a downloaded update waits: beside the library database.
    fn updates_dir(&self) -> PathBuf {
        self.db_path.parent().map(|p| p.join("updates")).unwrap_or_default()
    }

    /// The checks, from launch (`initUpdater`).
    pub(crate) fn start_updates(&mut self) {
        let Some(proxy) = self.proxy.clone() else { return };
        crate::updater::start(self.updates_dir(), move || {
            let _ = proxy.send_event(Wake::Updates);
        });
    }

    /// Hands over to the staged version, which replaces this one and starts again with the
    /// same arguments - a login launch stays a login launch.
    fn restart_to_update(&mut self, event_loop: &ActiveEventLoop) {
        let mut args = self.launch_args.clone();
        if !self.window_open.load(std::sync::atomic::Ordering::Relaxed) {
            args.push("--background".into());
        }
        self.flush_doc();
        if crate::updater::restart_into_update(&args) {
            event_loop.exit();
        } else {
            self.notify("The update could not be started. It will be offered again.");
        }
    }

    /// A notice from outside the app's own events: the last run's crash, at launch.
    pub(crate) fn announce(&mut self, message: String) {
        self.notify(message);
    }

    /* ------------------------------------------------------------ annotations follow files */

    /// `noteAnnotatedFile`: which file a path's annotations now describe, read off the disk at
    /// the moment of annotating; forgotten once the path has none, or cannot be read (another
    /// machine's library), which only means it is never second-guessed.
    pub(crate) fn note_annotated(&mut self, path: &str) {
        let annotated = self.data.ratings.contains_key(path) || self.data.tags.contains_key(path) || self.data.notes.contains_key(path);
        let now = annotated
            .then(|| std::fs::metadata(path).ok())
            .flatten()
            .and_then(|m| Some((m.len() as f64, crate::files::node_mtime_ms(m.modified().ok()?)?)));
        match now {
            Some(record) => {
                self.data.annotated_as.insert(path.to_string(), record);
                if let Some(doc) = self.doc.as_mut() {
                    doc.set("annotatedAs", path, Some(serde_json::json!([record.0 as i64, record.1])));
                }
            }
            None => {
                if self.data.annotated_as.remove(path).is_some() {
                    if let Some(doc) = self.doc.as_mut() {
                        doc.set("annotatedAs", path, None);
                    }
                }
            }
        }
    }

    /// Debounced: a scan finishing and a folder re-read can arrive together.
    fn schedule_annotation_check(&mut self) {
        self.annotation_check_at = Some(Instant::now() + Duration::from_millis(1500));
    }

    /// `changedAnnotatedFiles`, on a thread: every annotated path in a library folder here,
    /// asked of the disk - never of the index, whose row for a swapped-out path can still
    /// describe the original, which is exactly the case this is for.
    fn check_annotations(&mut self) {
        if crate::scan::scanning() {
            return;
        }
        let Some(proxy) = self.proxy.clone() else { return };
        let roots: Vec<String> = self.data.settings.roots.iter().filter(|r| r.is_local()).map(|r| r.path.trim_end_matches(['\\', '/']).to_lowercase()).collect();
        let under = |key: &str| {
            let key = key.to_lowercase();
            roots.iter().any(|r| key.len() > r.len() && key.starts_with(r.as_str()) && matches!(key.as_bytes()[r.len()], b'\\' | b'/'))
        };
        let mut keys: Vec<String> = self.data.ratings.keys().chain(self.data.tags.keys()).chain(self.data.notes.keys()).filter(|k| under(k)).cloned().collect();
        keys.sort();
        keys.dedup();
        let records: Vec<(String, Option<(f64, f64)>)> = keys.into_iter().map(|k| {
            let was = self.data.annotated_as.get(&k).copied();
            (k, was)
        }).collect();
        std::thread::spawn(move || {
            let (mut changed, mut filled) = (Vec::new(), Vec::new());
            for (key, was) in records {
                let now = std::fs::metadata(&key).ok().and_then(|m| Some((m.len() as f64, crate::files::node_mtime_ms(m.modified().ok()?)?)));
                match (was, now) {
                    (None, Some(now)) => filled.push((key, now.0, now.1)),
                    (None, None) => {}
                    (Some(was), Some(now)) if was.0 == now.0 && crate::files::same_mtime(was.1, now.1) => {}
                    (Some(was), _) => changed.push((key, was.0, was.1)),
                }
            }
            let _ = proxy.send_event(Wake::AnnotationsChecked(changed, filled));
        });
    }

    /// `reconcileAnnotations`: annotations left behind at a path go to the file they were made
    /// on, when exactly one unannotated file elsewhere has its name, size and mtime - a move
    /// keeps a file's mtime, which is what makes the match possible. No match is left alone: a
    /// re-export of the same song keeps its stars, and the original may be in a folder no scan
    /// has reached yet.
    fn annotations_checked(&mut self, changed: Vec<(String, f64, f64)>, filled: Vec<(String, f64, f64)>) {
        for (key, size, mtime) in filled {
            self.data.annotated_as.insert(key.clone(), (size, mtime));
            if let Some(doc) = self.doc.as_mut() {
                doc.set("annotatedAs", &key, Some(serde_json::json!([size as i64, mtime])));
            }
        }
        if changed.is_empty() || crate::scan::scanning() {
            return;
        }
        let local: Vec<String> = self.data.settings.roots.iter().filter(|r| r.is_local()).map(|r| r.path.trim_end_matches(['\\', '/']).to_lowercase()).collect();
        let is_local = |path: &str| {
            let path = path.to_lowercase();
            local.iter().any(|r| path.starts_with(r.as_str()))
        };
        let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut moves: Vec<(String, String)> = Vec::new();
        for (key, size, mtime) in changed {
            let name = key.rsplit(['\\', '/']).next().unwrap_or(&key).to_string();
            let found: Vec<String> = self
                .library
                .files_matching(&name, size)
                .into_iter()
                .filter(|(path, m)| {
                    crate::files::same_mtime(*m, mtime)
                        && *path != key
                        && is_local(path)
                        && !claimed.contains(path)
                        && !self.data.ratings.contains_key(path)
                        && !self.data.tags.contains_key(path)
                        && !self.data.notes.contains_key(path)
                })
                .map(|(path, _)| path)
                .collect();
            if found.len() != 1 {
                continue;
            }
            claimed.insert(found[0].clone());
            moves.push((key, found[0].clone()));
        }
        if moves.is_empty() {
            return;
        }
        for (from, to) in &moves {
            macro_rules! follow {
                ($map:expr, $section:expr) => {{
                    if let Some(value) = $map.remove(from) {
                        if let Some(doc) = self.doc.as_mut() {
                            doc.set($section, from, None);
                            doc.set($section, to, serde_json::to_value(&value).ok());
                        }
                        $map.insert(to.clone(), value);
                    }
                }};
            }
            follow!(self.data.ratings, "ratings");
            follow!(self.data.tags, "tags");
            follow!(self.data.notes, "notes");
            self.note_annotated(from);
            self.note_annotated(to);
        }
        self.annotations_changed();
        let message = if moves.len() == 1 {
            let to = std::path::Path::new(&moves[0].1);
            let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let folder = to.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "its new folder".into());
            format!("{name}'s rating and tags followed it to {folder}.")
        } else {
            format!("Ratings and tags followed {} files that were moved outside umakbang.", moves.len())
        };
        self.notify(message);
        let view = self.state.view;
        if !self.state.searching && !view.is_page() {
            let (scroll, selection, focus) = (self.state.scroll, self.state.selection.clone(), self.state.focus);
            self.show_view(view);
            self.state.scroll = scroll;
            self.state.selection = selection;
            self.state.focus = focus;
        }
        self.redraw();
    }

    /* ------------------------------------------------------------ the library on disk */

    /// Watches every local library folder whole, again whenever the folders change.
    pub(crate) fn watch_library(&mut self) {
        let Some(proxy) = self.proxy.clone() else { return };
        let roots: Vec<PathBuf> = self.data.settings.roots.iter().filter(|r| r.is_local()).map(|r| PathBuf::from(&r.path)).collect();
        self.library_watch = None;
        if !roots.is_empty() {
            self.library_watch = Some(crate::watch::LibraryWatch::start(&roots, &proxy));
        }
    }

    /// The folders the library watch saw change, re-read and their new files probed - or, when
    /// it lost track, the whole library revalidated.
    fn library_touched(&mut self, dirs: Vec<PathBuf>, everything: bool) {
        if everything {
            self.start_scan(false);
            return;
        }
        let mut changed = false;
        let mut done = std::collections::HashSet::new();
        for dir in dirs {
            // The nearest folder the library knows: a folder that appeared is found by
            // re-reading the one it appeared in.
            let mut at = Some(dir.as_path());
            let mut found = None;
            while let Some(path) = at {
                if let Some(folder) = self.data.relative(&path.to_string_lossy()).and_then(|rel| self.library.folder_at(&rel)) {
                    found = Some((folder.id, path.to_path_buf()));
                    break;
                }
                at = path.parent();
            }
            let Some((id, abs)) = found else { continue };
            if !done.insert(id) {
                continue;
            }
            if self.library.sync_folder(id, &abs) {
                changed = true;
            }
            // After the probe, which is what reads a project's own tempo.
            let probed = self.library.probe_unread(id);
            let filled = self.library.fill_tempos_from_projects(Some(id));
            if probed + filled > 0 {
                changed = true;
            }
        }
        if changed {
            self.schedule_annotation_check();
            self.state.total_files = self.library.total_files();
            self.rebuild_tree();
            if !self.state.searching && !self.state.view.is_page() {
                let (view, scroll, selection, focus) = (self.state.view, self.state.scroll, self.state.selection.clone(), self.state.focus);
                self.show_view(view);
                self.state.scroll = scroll;
                self.state.selection = selection;
                self.state.focus = focus;
            }
            self.redraw();
        }
    }

    /* ------------------------------------------------------------ the first run */

    /// Starts the tour when its conditions hold - a library, never seen, the explorer on screen,
    /// not shrunk - moves it on every three seconds, and finds what each step points at. Not
    /// latched: Replay clears `tutorialSeen` and the tour starts again from here.
    fn update_tour(&mut self, viewport: (f32, f32)) {
        let ready = !self.state.no_library && !self.data.settings.tutorial_seen && self.state.view == View::Folder && !self.state.stage && !self.state.mini_player && (self.proxy.is_some() || std::env::var("UMAKBANG_TOUR").is_ok());
        if self.state.tour.is_none() {
            if !ready {
                return;
            }
            let first = std::env::var("UMAKBANG_TOUR").ok().and_then(|v| v.parse().ok()).unwrap_or(0usize);
            self.state.tour = Some(crate::tour::Tour { index: first.min(crate::tour::STEPS.len() - 1), progress: 0.0, target: None });
            self.tour_step_at = Some(Instant::now());
        }
        let started = *self.tour_step_at.get_or_insert_with(Instant::now);
        let elapsed = started.elapsed().as_millis();
        if elapsed >= crate::tour::STEP_MS && self.proxy.is_some() {
            let next = self.state.tour.as_ref().map_or(0, |t| t.index + 1);
            if next >= crate::tour::STEPS.len() {
                self.finish_tour();
                return;
            }
            if let Some(tour) = self.state.tour.as_mut() {
                tour.index = next;
            }
            self.tour_step_at = Some(Instant::now());
        }
        let scale = self.scale() as f32;
        let hit = |action: &Action| self.hits.iter().find(|h| &h.action == action).map(|h| h.rect.map(|v| v / scale));
        let z = self.state.sizes;
        let (w, h) = viewport;
        let Some(index) = self.state.tour.as_ref().map(|t| t.index) else { return };
        let target = match crate::tour::STEPS[index].target {
            "sidebar" => Some([0.0, 38.0, z.sidebar, h]),
            "table" => Some([z.sidebar, 38.0, w - z.panel, h - z.player]),
            "search" => hit(&Action::Search),
            "tags" => self.ui.scroll_rects.get("tags").copied(),
            "random" => hit(&Action::Tool("dices")),
            "transport" => Some([z.sidebar, h - z.player, w - z.panel, h]),
            "settings" => hit(&Action::Tool("settings")),
            _ => None,
        };
        let progress = (started.elapsed().as_millis() as f32 / crate::tour::STEP_MS as f32).min(1.0);
        if let Some(tour) = self.state.tour.as_mut() {
            tour.target = target;
            tour.progress = if self.proxy.is_some() { progress } else { 0.4 };
        }
    }

    /// Either end of the tour is a decision about it: seen, and not asked again.
    fn finish_tour(&mut self) {
        self.state.tour = None;
        self.tour_step_at = None;
        self.data.settings.tutorial_seen = true;
        self.write_setting("tutorialSeen", serde_json::Value::Bool(true));
        self.redraw();
    }

    /* ------------------------------------------------------------ backups */

    fn bundle_dir(&self) -> PathBuf {
        crate::backup::export_dir(self.data.settings.bundle_export_dir.as_deref(), &self.user_data)
    }

    /// A backup folder the Electron app left inside the Mac app bundle (`backup::in_app_bundle`):
    /// what it holds moves to the default folder, and the setting is cleared so the default is
    /// used from now on. Once, at launch.
    pub fn rescue_backups(&mut self) {
        let Some(dir) = self.data.settings.bundle_export_dir.clone().filter(|d| crate::backup::in_app_bundle(std::path::Path::new(d))) else { return };
        let to = crate::backup::default_dir(&self.user_data);
        let from = PathBuf::from(&dir);
        if from.exists() {
            if let Err(e) = crate::backup::rescue_from(&from, &to) {
                // Left where it is, and the setting with it, so the next launch tries again.
                eprintln!("umakbang: could not move backups out of {dir}: {e}");
                return;
            }
        }
        self.data.settings.bundle_export_dir = None;
        // Not through `write_setting`: the setting is this install's alone, and stamping the
        // settings changed would make this machine's win the next sync for no change of the user's.
        if let Some(doc) = self.doc.as_mut() {
            doc.set("settings", "bundleExportDir", Some(serde_json::Value::from("")));
        }
    }

    /// `exportBundle`: into the backup folder under today's name, or wherever is asked.
    fn export_bundle(&mut self, pick: bool) {
        if self.bundle_busy {
            return;
        }
        let dir = self.bundle_dir();
        let target = if pick {
            match crate::dialogs::save_file("Export umakbang library bundle", Some(&dir), &crate::backup::bundle_name(), &[("umakbang bundle", "*.umak")], "umak", self.hwnd()) {
                Some(path) => path,
                None => return,
            }
        } else {
            if let Err(e) = std::fs::create_dir_all(&dir) {
                self.notify(format!("Could not create {}: {e}", dir.display()));
                return;
            }
            dir.join(crate::backup::bundle_name())
        };
        let Some(proxy) = self.proxy.clone() else { return };
        self.flush_doc();
        self.bundle_busy = true;
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.notify(format!("Writing {name} - this takes a moment for a large library."));
        let (data, db) = (self.data_path.clone(), self.db_path.clone());
        std::thread::spawn(move || {
            let outcome = crate::backup::write_bundle(&target, &data, &db).map(|_| target);
            let _ = proxy.send_event(Wake::BundleWritten(outcome));
        });
        self.refresh_settings_values();
    }

    /// `beginImport`: a bundle or a settings file, whichever it turns out to be - sniffed, not
    /// judged by its extension.
    fn import_backup(&mut self) {
        if self.bundle_busy {
            return;
        }
        let start = self.bundle_dir();
        let Some(file) = crate::dialogs::pick_file("Import umakbang settings", &[("umakbang settings or bundle", "*.json;*.umak"), ("umakbang settings", "*.json"), ("umakbang bundle", "*.umak")], Some(&start), self.hwnd()) else { return };
        self.import_file(file);
    }

    /// A chosen backup or bundle, imported.
    pub fn import_file(&mut self, file: PathBuf) {
        if !crate::backup::looks_like_bundle(&file) {
            let parsed = std::fs::read_to_string(&file).ok().and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
            match parsed.filter(|v| v.get("kind").and_then(|k| k.as_str()) == Some("umakbang-settings") && v.get("settings").is_some_and(|s| s.is_object())) {
                Some(backup) => self.open_wizard(backup, None),
                None => self.notify("That doesn't look like a umakbang settings file."),
            }
            return;
        }
        let Some(header) = crate::backup::read_header(&file) else {
            self.notify("That doesn't look like a umakbang bundle.");
            return;
        };
        let Some(proxy) = self.proxy.clone() else { return };
        let present = crate::backup::all_present(&header);
        self.bundle_busy = true;
        self.notify("Reading the bundle…");
        let db = self.db_path.clone();
        std::thread::spawn(move || {
            let outcome = crate::backup::restore(&file, &db, present).map(|r| (r.backup, present, r.restored));
            let _ = proxy.send_event(Wake::BundleRead(outcome));
        });
        self.refresh_settings_values();
    }

    fn open_wizard(&mut self, backup: serde_json::Value, from: Option<String>) {
        let wizard = crate::import_wizard::Wizard::new(backup);
        if from.is_some() && wizard.summary.folders.is_empty() {
            self.notify(format!("{} has nothing tagged or rated yet.", from.unwrap_or_default()));
            return;
        }
        self.state.importing = Some(wizard);
    }

    /// `applyBackup`: through the mapping into the profile, then everything read again from it.
    fn apply_backup(&mut self, backup: &serde_json::Value, mapping: &crate::backup::Mapping, indexes: usize) {
        self.flush_doc();
        match crate::backup::apply(&self.data_path, backup, mapping) {
            Err(e) => self.notify(e),
            Ok((kept, dropped, opened)) => {
                self.reload();
                let mut line = if dropped.entries() > 0 {
                    format!("Settings imported. {} entries carried across, {} left behind.", crate::library::format_count(kept.entries() as i64), crate::library::format_count(dropped.entries() as i64))
                } else {
                    format!("Settings imported. {} entries carried across.", crate::library::format_count(kept.entries() as i64))
                };
                if indexes > 0 {
                    line.push_str(&format!(" {indexes} folder {} restored.", if indexes == 1 { "index" } else { "indexes" }));
                }
                if !opened.is_empty() {
                    line.push_str(&format!(" Opened {} - indexing now.", opened.join(", ")));
                }
                self.notify(line);
                self.start_scan(false);
            }
        }
    }

    /// The profile read back from disk and everything that is drawn from it worked out again:
    /// what an import or another machine's settings changed, applied without a restart.
    pub(crate) fn reload(&mut self) {
        self.flush_doc();
        self.data = UserData::load(&self.data_path);
        let s = &self.data.settings;
        self.theme = Theme::derive(s.theme_primary.as_deref(), s.theme_background.as_deref());
        {
            let mut visuals = self.state.visuals.borrow_mut();
            visuals.headroom = s.visualizer_headroom_db.unwrap_or(6.0);
            visuals.ramp = s.waveform_tint.as_deref() != Some("accent");
        }
        self.state.columns = columns::normalise(&s.columns);
        self.state.sort = Sort { key: s.sort_key.clone().unwrap_or_else(|| "name".into()), dir: s.sort_dir.clone().unwrap_or_else(|| "asc".into()) };
        self.state.play_on_select = s.play_on_select;
        self.state.auto_advance = s.auto_advance;
        self.state.audio_only = s.type_filter.kinds.iter().any(|k| k == "audio");
        self.state.type_filters = s.type_filter.kinds.len() + s.type_filter.exts.len();
        self.state.quick = s.quick_move.clone();
        self.state.quick_dirs = s.quick_move.iter().map(|q| self.data.relative(&q.path)).collect();
        self.state.show_stats = s.show_stats.unwrap_or(true);
        self.state.panel_open = s.panel_open.unwrap_or(true);
        self.state.stem_settings.key = s.lalal_key.clone();
        self.state.stem_settings.output_dir = s.stem_output_dir.clone();
        self.state.youtube_settings = (s.youtube_format.clone().unwrap_or_else(|| "mp3".into()), s.youtube_bitrate.unwrap_or(192));
        self.state.no_library = s.roots.is_empty();
        self.state.reset_armed = s.reset_on_launch;
        self.undo_history.set_limit(s.undo_depth.unwrap_or(25));
        self.state.ratings = self.data.ratings.clone();
        self.state.stars = self.data.star_counts();
        let rated: Vec<String> = self.data.ratings.keys().cloned().collect();
        self.state.rated_share = self.library.rated_share(&rated, &self.data.settings.random_exclude_dirs);
        self.state.tags = self.data.tag_counts();
        self.state.total_files = self.library.total_files();
        if let Ok(mut shared) = self.search_shared.write() {
            shared.ratings = self.data.ratings.clone();
            shared.tags = self.data.tags.clone();
            shared.bpm = self.data.detected_bpm.clone();
            shared.key = self.data.detected_key.clone();
        }
        self.rebuild_palette();
        crate::remote::set_roots(&self.data.settings.roots);
        self.rebuild_tree();
        self.configure_server();
        let view = self.state.view;
        self.show_view(view);
        self.refresh_settings_values();
        self.redraw();
    }

    /// `syncSettingsFromPeers`: every machine that is serving asked for its settings, and the
    /// newest adopted if it is newer than this one's - at launch, and from the button.
    pub(crate) fn sync_settings(&mut self, launch: bool) {
        let Some(proxy) = self.proxy.clone() else { return };
        if self.syncing || std::env::var("UMAKBANG_SERVE").is_ok() {
            return;
        }
        self.syncing = true;
        let mine = std::fs::read_to_string(&self.data_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|d| d.pointer("/settings/settingsUpdatedAt").and_then(|v| v.as_f64()))
            .unwrap_or(0.0);
        std::thread::spawn(move || {
            let (_, peers) = crate::server::list_peers();
            let serving: Vec<_> = peers.into_iter().filter(|p| p.serving && p.node.ipv4.is_some()).collect();
            let outcome = if serving.is_empty() {
                Err("No other machine is serving.".to_string())
            } else {
                let mut best: Option<(String, f64, serde_json::Value)> = None;
                for peer in serving {
                    let Some(theirs) = crate::server::ask(peer.node.ipv4.as_deref().unwrap_or(""), "/settings") else { continue };
                    let at = theirs.get("settingsUpdatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if at > mine && best.as_ref().is_none_or(|b| at > b.1) {
                        let name = if peer.node.host_name.is_empty() { peer.node.name.clone() } else { peer.node.host_name.clone() };
                        best = Some((name, at, theirs));
                    }
                }
                Ok(best.map(|(name, _, settings)| (name, settings)))
            };
            let _ = proxy.send_event(Wake::SettingsSynced(outcome, launch));
        });
        self.refresh_settings_values();
    }

    /* ------------------------------------------------------------ other machines' libraries */

    /// `remote:mountLibrary`: a peer's library as a root of this one. Labelled after the folder,
    /// with the machine's name added when this library already has a folder of that name.
    fn mount_library(&mut self, peer_index: usize, library_index: usize) {
        let Some(peer) = self.peers.as_ref().and_then(|(_, peers)| peers.iter().filter(|p| p.serving).nth(peer_index).cloned()) else { return };
        let (Some(hello), Some(host)) = (peer.hello.clone(), peer.node.ipv4.clone()) else { return };
        let Some(library) = hello.get("libraries").and_then(|l| l.as_array()).and_then(|l| l.get(library_index)).cloned() else { return };
        let text = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let (path, base, id) = (text(&library, "path"), text(&library, "label"), text(&library, "id"));
        let device_id = hello.pointer("/device/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let device_name = if peer.node.host_name.is_empty() { peer.node.name.clone() } else { peer.node.host_name.clone() };
        let already = self.data.settings.roots.iter().any(|r| r.remote.as_ref().and_then(|v| v.get("deviceId")).and_then(|v| v.as_str()) == Some(device_id.as_str()) && r.path == path);
        if already {
            return;
        }
        let taken: std::collections::HashSet<String> = self.data.settings.roots.iter().map(|r| r.label.to_lowercase()).collect();
        let mut label = base.clone();
        if taken.contains(&label.to_lowercase()) {
            label = format!("{base} ({device_name})");
            let mut n = 2;
            while taken.contains(&label.to_lowercase()) {
                label = format!("{base} ({device_name} {n})");
                n += 1;
            }
        }
        let remote = serde_json::json!({ "deviceId": device_id, "deviceName": device_name, "host": host, "libraryId": id });
        self.data.settings.roots.push(crate::userdata::Root { path, label: label.clone(), remote: Some(remote) });
        self.write_roots();
        self.rebuild_tree();
        self.notify(format!("Fetching {label} from {device_name}…"));
        self.fetch_remote_indexes();
        self.refresh_settings_values();
    }

    /// What this machine calls itself: the tailnet's name for it, or the computer's.
    fn local_name(&mut self) -> String {
        if self.local_name.is_none() {
            let status = crate::tailscale::read();
            let name = status.this.map(|n| if n.host_name.is_empty() { n.name } else { n.host_name }).filter(|n| !n.is_empty());
            self.local_name = Some(name.or_else(|| std::env::var("COMPUTERNAME").ok()).unwrap_or_else(|| "this machine".into()));
        }
        self.local_name.clone().unwrap_or_default()
    }

    /// The files picked from another machine, copied into the download folder on a thread.
    pub(crate) fn copy_here(&mut self, paths: Vec<String>) {
        let Some(destination) = self.data.settings.remote_download_dir.clone().filter(|d| !d.is_empty()) else {
            self.notify("No download folder is set - see Settings, Remote.");
            return;
        };
        let Some(proxy) = self.proxy.clone() else { return };
        std::thread::spawn(move || {
            let dir = PathBuf::from(&destination);
            let _ = std::fs::create_dir_all(&dir);
            let (mut written, mut failures) = (Vec::new(), Vec::new());
            let report = |p: crate::remote::Progress| {
                let _ = proxy.send_event(Wake::Copying(p));
            };
            for path in paths {
                let name = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_string();
                let Some((root, within)) = crate::remote::root_of(&path) else {
                    failures.push(format!("{name} is not on another machine."));
                    continue;
                };
                let target = crate::remote::free_name(&dir, &name);
                match crate::remote::copy_one(&root, &within, None, &target, &report) {
                    Ok(()) => written.push(target),
                    Err(e) => failures.push(format!("{name}: {e}")),
                }
            }
            let _ = proxy.send_event(Wake::Copied(written, failures));
        });
    }

    fn pack_preview(&mut self, flp: String) {
        let Some(proxy) = self.proxy.clone() else { return };
        let inventory = crate::server::plugin_inventory(&self.fl_user_data());
        let local: Vec<String> = inventory.get("names").and_then(|n| n.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default();
        self.state.scan_status = Some("reading the project".into());
        std::thread::spawn(move || {
            let preview = crate::remote::preview(&flp, &local);
            let _ = proxy.send_event(Wake::PackPreview(flp, preview));
        });
    }

    /// `PackDialog`: what is coming, and what will not.
    fn open_pack_dialog(&mut self, flp: String, p: crate::remote::Preview) {
        let mb = p.total_bytes as f64 / 1024.0 / 1024.0;
        let mut description = format!("{} and {} {}, {:.1} MB, packed into a zip in the download folder.", p.name, p.sample_count, if p.sample_count == 1 { "sample" } else { "samples" }, mb);
        if !p.elsewhere.is_empty() {
            description.push_str(&format!(" {} {} outside the library and will not come.", p.elsewhere.len(), if p.elsewhere.len() == 1 { "sound is" } else { "sounds are" }));
        }
        if !p.missing_plugins.is_empty() {
            description.push_str(&format!(" Not installed here: {}.", p.missing_plugins.join(", ")));
        }
        let style = crate::ui::text::TextStyle { line_height: 18.0, ..screen::style(12.0, 400, self.theme.muted_foreground) };
        let width = 380f32.min(self.logical_size().0 - 32.0) - 32.0;
        let text = &mut self.ui.text;
        let lines = crate::overlay::wrap(&description, width, &mut |s| text.width(s, &style));
        let here = self.local_name();
        self.state.dialog = Some(crate::overlay::Dialog { title: format!("Pack & copy to {here}"), confirm: "Pack".into(), destructive: false, paths: Vec::new(), pack: Some(flp), lines });
    }

    pub(crate) fn pack_here(&mut self, flp: String) {
        let Some(destination) = self.data.settings.remote_download_dir.clone().filter(|d| !d.is_empty()) else {
            self.notify("No download folder is set - see Settings, Remote.");
            return;
        };
        let Some(proxy) = self.proxy.clone() else { return };
        std::thread::spawn(move || {
            let report = |p: crate::remote::Progress| {
                let _ = proxy.send_event(Wake::Copying(p));
            };
            let outcome = crate::remote::pack(&flp, std::path::Path::new(&destination), &report);
            let _ = proxy.send_event(Wake::Packed(outcome));
        });
    }

    /// The download folder, re-read if it is in the library and on screen: nothing else would
    /// tell the window something landed there.
    fn copied_into(&mut self, dir: &str) {
        if let Some(folder) = self.data.relative(dir).and_then(|rel| self.library.folder_at(&rel)) {
            if self.library.sync_folder(folder.id, std::path::Path::new(dir)) {
                self.state.total_files = self.library.total_files();
                let (view, scroll) = (self.state.view, self.state.scroll);
                self.show_view(view);
                self.state.scroll = scroll;
            }
        }
        self.redraw();
    }

    /// The other machines on the tailnet, asked off the window's thread.
    fn refresh_peers(&mut self) {
        let Some(proxy) = self.proxy.clone() else { return };
        if self.peers_busy {
            return;
        }
        self.peers_busy = true;
        std::thread::spawn(move || {
            let (status, peers) = crate::server::list_peers();
            let _ = proxy.send_event(Wake::Peers(status, peers));
        });
        self.refresh_settings_values();
    }

    /* ------------------------------------------------------------ output */

    /// The device chosen: the native app's own choice, else the Electron app's by its label.
    /// None is the system default.
    pub(crate) fn output_name(&self) -> Option<String> {
        let s = &self.data.settings;
        match &s.native_output_device {
            Some(name) => Some(name.clone()).filter(|n| !n.is_empty()),
            None => s.output_device.as_ref().map(|d| d.label.clone()).filter(|l| !l.is_empty()),
        }
    }

    /// A new device, taken at once: the track carries on where it was, paused or not.
    pub(crate) fn set_output(&mut self, name: String) {
        self.data.settings.native_output_device = Some(name.clone());
        self.write_setting("nativeOutputDevice", serde_json::Value::from(name));
        let resume = self.player.as_ref().map(|p| (p.position(), p.is_paused()));
        let file = self.queue.get(self.queue_index).cloned();
        self.player = None;
        if let (Some((at, paused)), Some(file)) = (resume, file) {
            if let Ok(mut player) = Player::new(self.output_name().as_deref()) {
                if player.play(&file.path).is_ok() {
                    player.set_speed(rate_for(file.bpm, self.state.transport.varispeed) as f32);
                    player.seek(at);
                    if paused {
                        player.pause();
                    }
                }
                self.player = Some(player);
                self.apply_level();
            }
        }
        self.refresh_settings_values();
    }

    /* ------------------------------------------------------------ shortcuts */

    fn write_shortcuts(&mut self) {
        let map: serde_json::Map<String, serde_json::Value> = self.data.settings.shortcuts.iter().map(|(k, v)| (k.clone(), serde_json::Value::from(v.clone()))).collect();
        self.write_setting("shortcuts", serde_json::Value::Object(map));
        self.refresh_settings_values();
    }

    /// A key as the page's `KeyboardEvent.key` names it.
    fn key_name(key: &Key) -> Option<String> {
        Some(match key {
            Key::Named(NamedKey::Space) => " ".into(),
            Key::Named(NamedKey::Backspace) => "Backspace".into(),
            Key::Named(NamedKey::Delete) => "Delete".into(),
            Key::Named(NamedKey::Escape) => "Escape".into(),
            Key::Named(NamedKey::Enter) => "Enter".into(),
            Key::Named(NamedKey::Tab) => "Tab".into(),
            Key::Named(NamedKey::Insert) => "Insert".into(),
            Key::Named(NamedKey::Home) => "Home".into(),
            Key::Named(NamedKey::End) => "End".into(),
            Key::Named(NamedKey::PageUp) => "PageUp".into(),
            Key::Named(NamedKey::PageDown) => "PageDown".into(),
            Key::Named(NamedKey::ArrowUp) => "ArrowUp".into(),
            Key::Named(NamedKey::ArrowDown) => "ArrowDown".into(),
            Key::Named(NamedKey::ArrowLeft) => "ArrowLeft".into(),
            Key::Named(NamedKey::ArrowRight) => "ArrowRight".into(),
            Key::Named(named) => {
                let text = format!("{named:?}");
                if text.starts_with('F') && text[1..].chars().all(|c| c.is_ascii_digit()) { text } else { return None }
            }
            Key::Character(c) => c.to_string(),
            _ => return None,
        })
    }

    /// The listening shortcut takes this key - unless it is a chord, reserved, or another's.
    fn capture_key(&mut self, key: &Key) {
        let Some(id) = self.capturing else { return };
        if matches!(key, Key::Named(NamedKey::Escape)) {
            self.capturing = None;
            self.shortcut_refused = None;
        } else if matches!(key, Key::Named(NamedKey::Control | NamedKey::Shift | NamedKey::Alt | NamedKey::Super)) {
            return;
        } else if self.command_key() || self.modifiers.alt_key() || self.modifiers.super_key() {
            self.shortcut_refused = Some("Only keys without Ctrl, ⌘ or Alt can be changed here.".into());
        } else if let Some(name) = Self::key_name(key) {
            match crate::keys::shortcut_conflict(&self.data.settings.shortcuts, id, &name) {
                Some(why) => self.shortcut_refused = Some(why),
                None => {
                    self.data.settings.shortcuts.insert(id.to_string(), name.to_lowercase());
                    self.capturing = None;
                    self.shortcut_refused = None;
                    self.write_shortcuts();
                }
            }
        }
        self.refresh_settings_values();
    }

    /// `matchesShortcut`: which of the rebindable actions a bare key means, and whether the key
    /// is the old default of one that has been moved elsewhere (which then does nothing).
    fn shortcut_for(&self, key: &Key) -> (Option<&'static str>, bool) {
        if self.command_key() || self.modifiers.alt_key() || self.modifiers.super_key() {
            return (None, false);
        }
        let Some(name) = Self::key_name(key).map(|n| n.to_lowercase()) else { return (None, false) };
        let s = &self.data.settings.shortcuts;
        let hit = crate::keys::SHORTCUTS.iter().find(|(id, ..)| crate::keys::shortcut_key(s, id).to_lowercase() == name).map(|(id, ..)| *id);
        let vacated = hit.is_none() && crate::keys::SHORTCUTS.iter().any(|(id, _, _, default)| default.to_lowercase() == name && !crate::keys::shortcut_key(s, id).eq_ignore_ascii_case(default));
        (hit, vacated)
    }

    fn run_shortcut(&mut self, id: &str) {
        let has_selection = !self.state.selection.is_empty();
        match id {
            "playPause" => self.toggle(),
            "random" => self.play_random(),
            "tag" if has_selection => self.run(crate::overlay::Cmd::Tags),
            "rename" if self.state.selection.len() == 1 => self.run(crate::overlay::Cmd::Rename),
            "up" => self.up(),
            "trash" if has_selection => self.run(crate::overlay::Cmd::Delete),
            "clearSelection" => {
                self.close_overlays();
                if self.state.view.is_page() {
                    let id = self.state.folder.id;
                    self.open(id, false);
                } else {
                    self.state.selection.clear();
                }
            }
            _ => {}
        }
    }

    /* ------------------------------------------------------------ appearance */

    /// The gradient as it stands: the user's stops, or the default ramp they replace.
    fn current_stops(&self) -> Vec<String> {
        if self.data.settings.visualizer_stops.is_empty() { crate::visualizers::DEFAULT_STOPS.iter().map(|s| s.to_string()).collect() } else { self.data.settings.visualizer_stops.clone() }
    }

    pub fn test_pick(&mut self, kind: u8, index: usize) {
        self.open_picker(kind, index);
    }

    fn open_picker(&mut self, kind: u8, index: usize) {
        use crate::color_picker::{Picker, Target};
        let v = &self.state.settings_values;
        let (target, hex, resettable) = match kind {
            0 => (Target::Accent, v.accent_hex.clone(), true),
            1 => (Target::Background, v.background_hex.clone(), true),
            _ => (Target::Stop(index), self.current_stops().get(index).cloned().unwrap_or_else(|| "#000000".into()), self.current_stops().len() > 2),
        };
        let action = Action::Pick(kind, index);
        let scale = self.scale() as f32;
        let anchor = self.hits.iter().find(|h| h.action == action).map(|h| h.rect.map(|x| x / scale)).unwrap_or([400.0, 200.0, 414.0, 214.0]);
        let (w, h) = self.logical_size();
        // `align="end"` under the swatch, kept on screen.
        let x = (anchor[2] - 228.0).clamp(8.0, w - 236.0);
        let y = if anchor[3] + 4.0 + 270.0 > h { (anchor[1] - 274.0).max(8.0) } else { anchor[3] + 4.0 };
        self.state.color_picker = Some(Picker::open(target, &hex, x, y, resettable));
        self.state.form.set("cp.hex", hex.to_uppercase());
    }

    /// Where the pointer is on the picker's field (saturation across, brightness down) or its
    /// hue bar.
    fn picker_from_cursor(&mut self, area: bool) {
        let action = if area { Action::PickerArea } else { Action::PickerHue };
        let Some(hit) = self.hits.iter().find(|h| h.action == action) else { return };
        let (x, y) = (self.cursor.x as f32, self.cursor.y as f32);
        let fx = ((x - hit.origin[0]) / (hit.rect[2] - hit.rect[0]).max(1.0)).clamp(0.0, 1.0) as f64;
        let fy = ((y - hit.rect[1]) / (hit.rect[3] - hit.rect[1]).max(1.0)).clamp(0.0, 1.0) as f64;
        if let Some(p) = self.state.color_picker.as_mut() {
            if area {
                p.s = fx;
                p.v = 1.0 - fy;
            } else {
                p.h = fx * 360.0;
            }
        }
        self.picker_changed();
    }

    /// The picker's colour applied, live.
    fn picker_changed(&mut self) {
        let Some(p) = self.state.color_picker.clone() else { return };
        let hex = p.hex();
        if self.state.form.focus != Some("cp.hex") {
            self.state.form.set("cp.hex", hex.to_uppercase());
        }
        match p.target {
            crate::color_picker::Target::Accent => self.set_theme(Some(Some(hex)), None),
            crate::color_picker::Target::Background => self.set_theme(None, Some(Some(hex))),
            crate::color_picker::Target::Stop(i) => {
                let mut stops = self.current_stops();
                if i < stops.len() {
                    stops[i] = hex;
                    self.set_stops(stops);
                }
            }
        }
    }

    /// `themePrimary` / `themeBackground`: Some(None) clears one, None leaves it. The theme is
    /// derived again, and the visualizers' ramp with it.
    fn set_theme(&mut self, primary: Option<Option<String>>, background: Option<Option<String>>) {
        if let Some(p) = primary {
            self.data.settings.theme_primary = p.clone();
            self.write_setting("themePrimary", p.map_or(serde_json::Value::Null, serde_json::Value::from));
        }
        if let Some(b) = background {
            self.data.settings.theme_background = b.clone();
            self.write_setting("themeBackground", b.map_or(serde_json::Value::Null, serde_json::Value::from));
        }
        self.theme = Theme::derive(self.data.settings.theme_primary.as_deref(), self.data.settings.theme_background.as_deref());
        self.rebuild_palette();
        self.refresh_settings_values();
    }

    fn set_stops(&mut self, stops: Vec<String>) {
        self.data.settings.visualizer_stops = stops.clone();
        self.write_setting("visualizerStops", serde_json::Value::from(stops));
        self.rebuild_palette();
        self.refresh_settings_values();
    }

    fn rebuild_palette(&mut self) {
        let palette = Palette::new(&self.data.settings.visualizer_stops, &self.theme);
        self.state.visuals.borrow_mut().palette = palette;
        // Waveforms are tinted by the ramp, so the one in the transport is drawn again.
        if let Some(now) = &self.state.now {
            let peaks = now.wave.borrow().peaks.clone();
            now.wave.borrow_mut().set_peaks(peaks);
        }
    }

    /* ------------------------------------------------------------ trim */

    /// Where on the waveform the pointer is, in seconds.
    fn time_at_cursor(&self) -> Option<f64> {
        let hit = self.hits.iter().find(|h| h.action == Action::Seek)?;
        let now = self.state.now.as_ref()?;
        if now.duration <= 0.0 {
            return None;
        }
        let ratio = ((self.cursor.x as f32 - hit.rect[0]) / (hit.rect[2] - hit.rect[0])).clamp(0.0, 1.0);
        Some(ratio as f64 * now.duration)
    }

    fn seconds_per_pixel(&self) -> f64 {
        let width = self.hits.iter().find(|h| h.action == Action::Seek).map_or(0.0, |h| (h.rect[2] - h.rect[0]) as f64);
        let duration = self.state.now.as_ref().map_or(0.0, |n| n.duration);
        if width > 0.0 && duration > 0.0 { duration / width } else { 0.0 }
    }

    /// The region, here and on the waveform it is drawn on.
    fn set_region(&mut self, region: Option<(f64, f64)>) {
        self.state.region = region;
        if let Some(now) = &self.state.now {
            let d = now.duration;
            now.wave.borrow_mut().region = region.filter(|_| d > 0.0).map(|(a, b)| ((a / d) as f32, (b / d) as f32));
        }
    }

    /// For the shot: the scissors on and a region drawn.
    pub fn test_region(&mut self, from: f64, to: f64) {
        self.state.trimming = true;
        self.set_region(Some((from, to)));
    }

    fn prompt_save_trim(&mut self) {
        let (Some(now), Some((a, b))) = (self.state.now.as_ref(), self.state.region) else { return };
        let ext = crate::trim::output_ext(&now.file.ext);
        let name = crate::trim::trim_name(&now.file.name, a, b, ext);
        let stem_end = name.rfind('.').unwrap_or(name.len());
        let (w, h) = self.logical_size();
        self.state.prompt = Some(crate::overlay::Prompt {
            kind: crate::overlay::PromptKind::SaveTrim(PathBuf::from(&now.file.path), a, b),
            title: format!("Save {} beside {}", columns::duration_precise(Some(b - a)), now.file.name),
            confirm: "Save".into(),
            field: crate::screen::SearchBox { value: name, caret: stem_end, anchor: 0, focused: true },
            error: None,
            x: (w - self.state.sizes.panel - 380.0).max(self.state.sizes.sidebar + 16.0),
            y: (h - self.state.sizes.player - 150.0).max(60.0),
            initial: String::new(),
        });
    }

    /// The region written beside its track: never over anything (`wx`), and the folder read
    /// again so it is in the list by the time the notice is.
    pub(crate) fn save_trim(&mut self, source: &std::path::Path, from: f64, to: f64, name: &str) -> Result<(), String> {
        if let Some(error) = crate::fsops::name_error(name) {
            return Err(error);
        }
        if !source.exists() {
            return Err("The file this came from is no longer there.".into());
        }
        let dir = source.parent().ok_or("The file this came from is no longer there.")?.to_path_buf();
        let target = dir.join(name.trim());
        if target.exists() {
            return Err("Something with that name is already there.".into());
        }
        let ext = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let kbps = self.library.file_at(&source.to_string_lossy()).and_then(|(_, f)| f.bitrate).map(|b| (b as f64 / 1000.0).round() as u32);
        let bytes = crate::trim::trim(source, &ext, kbps, from, to)?;
        use std::io::Write;
        let mut file = std::fs::File::options().write(true).create_new(true).open(&target).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "Something with that name is already there.".to_string() } else { e.to_string() })?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        self.refresh_folder(&dir);
        self.notify(format!("Saved {}.", name.trim()));
        Ok(())
    }

    /* ------------------------------------------------------------ window modes */

    fn remember_bounds(&mut self) {
        let Some(window) = &self.window else { return };
        if self.restore_bounds.is_none() {
            let maximized = window.is_maximized();
            let position = window.outer_position().unwrap_or_default();
            self.restore_bounds = Some((position, window.inner_size(), maximized));
        }
    }

    fn restore_window(&mut self) {
        let Some(window) = self.window.clone() else { return };
        window.set_min_inner_size(Some(LogicalSize::new(900.0, 560.0)));
        if let Some((position, size, maximized)) = self.restore_bounds.take() {
            let _ = window.request_inner_size(size);
            window.set_outer_position(position);
            if maximized {
                window.set_maximized(true);
            }
        }
        window.set_window_level(if self.data.settings.always_on_top { winit::window::WindowLevel::AlwaysOnTop } else { winit::window::WindowLevel::Normal });
    }

    /// The mini player (`window:setMini`): a 300px square, centred 12px below the top of the
    /// screen it is on, kept above everything; and back to exactly where the window was.
    fn set_mini_player(&mut self, mini: bool) {
        // Nothing to play without a library: its only button would be the way back.
        if mini && self.data.settings.roots.is_empty() {
            return;
        }
        let Some(window) = self.window.clone() else { return };
        self.close_overlays();
        if mini {
            if self.state.stage {
                self.state.stage = false;
            } else {
                self.remember_bounds();
            }
            window.set_maximized(false);
            window.set_min_inner_size(Some(LogicalSize::new(300.0, 300.0)));
            let scale = window.scale_factor();
            if let Some(monitor) = window.current_monitor() {
                let (pos, size) = (monitor.position(), monitor.size());
                let x = pos.x + ((size.width as f64 - 300.0 * scale) / 2.0) as i32;
                window.set_outer_position(winit::dpi::PhysicalPosition::new(x, pos.y + (12.0 * scale) as i32));
            }
            let _ = window.request_inner_size(LogicalSize::new(300.0, 300.0));
            window.set_window_level(winit::window::WindowLevel::AlwaysOnTop);
            self.state.mini_player = true;
        } else {
            self.state.mini_player = false;
            self.restore_window();
        }
        self.redraw();
    }

    /// Visualizers only (`window:setCompact`): 210px tall and no wider than 1100, the plots
    /// side by side; and back.
    fn set_stage(&mut self, on: bool) {
        if on && self.data.settings.roots.is_empty() {
            return;
        }
        let Some(window) = self.window.clone() else { return };
        self.close_overlays();
        if on {
            self.remember_bounds();
            window.set_maximized(false);
            window.set_min_inner_size(Some(LogicalSize::new(360.0, 120.0)));
            let scale = window.scale_factor();
            let width = (window.inner_size().width as f64 / scale).min(1100.0);
            let _ = window.request_inner_size(LogicalSize::new(width, 210.0));
            self.state.stage = true;
            self.state.stage_hover = true;
        } else {
            self.state.stage = false;
            self.restore_window();
        }
        self.redraw();
    }

    /* ------------------------------------------------------------ library folders */

    /// `addRoot`: another folder into the library, labelled by its own name made unique -
    /// refused if it is already open, sits inside an open one, or holds one.
    fn add_root(&mut self, dir: &std::path::Path) {
        let path = dir.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        let norm = |p: &str| p.to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string();
        let under = |child: &str, parent: &str| {
            let (c, p) = (norm(child), norm(parent));
            c == p || c.starts_with(&format!("{p}\\"))
        };
        let roots = &self.data.settings.roots;
        let reason = if roots.iter().any(|r| norm(&r.path) == norm(&path)) {
            Some("already open".to_string())
        } else if let Some(parent) = roots.iter().find(|r| under(&path, &r.path)) {
            Some(format!("already inside {}", parent.label))
        } else {
            roots.iter().find(|r| under(&r.path, &path)).map(|child| format!("holds {}, which is already open", child.label))
        };
        if let Some(reason) = reason {
            self.notify(format!("That folder is {reason}."));
            return;
        }
        // `labelForRoot`: the folder's name (a drive's letter), numbered if it is taken.
        let base = path.rsplit(['\\', '/']).find(|s| !s.is_empty()).unwrap_or(&path).trim_end_matches(':').to_string();
        let stem = if base.is_empty() { "Library".to_string() } else { base };
        let taken: std::collections::HashSet<String> = roots.iter().map(|r| r.label.to_lowercase()).collect();
        let mut label = stem.clone();
        let mut n = 2;
        while taken.contains(&label.to_lowercase()) {
            label = format!("{stem} ({n})");
            n += 1;
        }
        self.data.settings.roots.push(crate::userdata::Root { path, label, remote: None });
        self.write_roots();
        self.configure_server();
        self.rebuild_tree();
        // Walked alongside what is already open; nothing else is reset.
        self.start_scan(false);
    }

    /// `removeRoot`: the folder out of the library and its rows out of the index. The files
    /// themselves are never touched.
    fn remove_root(&mut self, label: &str) {
        let Some(at) = self.data.settings.roots.iter().position(|r| r.label == label) else { return };
        // A record written against roots that no longer exist would put things back into a
        // library that has forgotten them.
        self.undo_history.forget();
        let root = self.data.settings.roots.remove(at);
        self.library.remove(&root.path, Some(&root.label), true);
        self.write_roots();
        self.state.total_files = self.library.total_files();
        self.rebuild_tree();
        let here = self.state.folder.path.clone();
        if here == root.label || here.starts_with(&format!("{}/", root.label)) {
            self.open(crate::library::LIBRARY, false);
        } else {
            let view = self.state.view;
            self.show_view(view);
        }
    }

    fn write_roots(&mut self) {
        // Whatever is watched follows what is in the library.
        let roots: Vec<PathBuf> = self.data.settings.roots.iter().filter(|r| r.is_local()).map(|r| PathBuf::from(&r.path)).collect();
        if self.library_watch.is_some() || !roots.is_empty() {
            self.watch_library();
        }
        // A mounted library keeps its `remote`: written without it, it would become a local
        // folder at a path that is on another machine.
        let value = serde_json::Value::Array(
            self.data
                .settings
                .roots
                .iter()
                .map(|r| match r.remote.as_ref().filter(|v| !v.is_null()) {
                    Some(remote) => serde_json::json!({ "path": r.path, "label": r.label, "remote": remote }),
                    None => serde_json::json!({ "path": r.path, "label": r.label }),
                })
                .collect(),
        );
        self.write_setting("roots", value);
        crate::remote::set_roots(&self.data.settings.roots);
    }

    /// A right-click on a library folder's own row in the tree: the one thing only those
    /// rows can do, which is leave the library.
    fn open_root_menu(&mut self, index: usize) -> bool {
        let Some(row) = self.state.tree.get(index) else { return false };
        let Some(folder) = self.library.folder(row.id) else { return false };
        // A library folder is a top-level row: nothing above it but the virtual root.
        if folder.parent.is_some() || row.id == crate::library::LIBRARY {
            return false;
        }
        let items = vec![
            crate::overlay::MenuItem::Label(folder.name.clone()),
            crate::overlay::MenuItem::Item { icon: "x", label: "Remove from library".into(), shortcut: None, enabled: true, cmd: crate::overlay::Cmd::RemoveRoot(folder.path.clone()) },
        ];
        self.show_menu(items);
        true
    }

    /* ------------------------------------------------------------ dragging rows */

    /// What a press on row `index` would drag: the selection if the row was already in it,
    /// else the row alone.
    fn arm_row_drag(&mut self, index: usize) {
        let path_of = |s: &Self, i: usize| -> Option<PathBuf> {
            match table::row_at(&s.state, i)? {
                table::RowRef::File(_, file) => Some(PathBuf::from(&file.path)),
                table::RowRef::Folder(folder) => s.data.absolute(&folder.path).map(PathBuf::from),
            }
        };
        let paths: Vec<PathBuf> = if self.state.selection.contains(&index) {
            self.state.selection.iter().filter_map(|i| path_of(self, *i)).collect()
        } else {
            path_of(self, index).into_iter().collect()
        };
        if !paths.is_empty() {
            self.row_drag = Some(RowDrag { paths, from: self.cursor, active: false });
        }
    }

    fn drag_moved(&mut self) {
        let scale = self.scale();
        let cursor = self.cursor;
        let Some(drag) = self.row_drag.as_mut() else { return };
        if !drag.active {
            if (cursor.x - drag.from.x).abs() + (cursor.y - drag.from.y).abs() < 5.0 * scale {
                return;
            }
            drag.active = true;
            self.pending_open = None;
            self.cursor_icon = CursorIcon::Grabbing;
            if let Some(window) = &self.window {
                window.set_cursor(CursorIcon::Grabbing);
            }
        }
        // Past the window's edge the drag becomes the system's, carrying the files themselves:
        // the only kind a DAW, a browser or Explorer can receive.
        let size = self.window.as_ref().map(|w| w.inner_size()).unwrap_or_default();
        if cursor.x <= 0.0 || cursor.y <= 0.0 || cursor.x >= size.width as f64 || cursor.y >= size.height as f64 {
            let paths = self.row_drag.take().map(|d| d.paths).unwrap_or_default();
            self.state.drop_over = None;
            self.cursor_icon = CursorIcon::Default;
            if let Some(window) = &self.window {
                window.set_cursor(CursorIcon::Default);
            }
            self.redraw();
            self.start_os_drag(paths);
            return;
        }
        let target = self.drop_target_at();
        if target != self.state.drop_over {
            self.state.drop_over = target;
            self.redraw();
        }
    }

    /// The folder under the pointer that the dragged rows could be moved into.
    fn drop_target_at(&self) -> Option<Action> {
        let (x, y) = (self.cursor.x as f32, self.cursor.y as f32);
        let dragged = self.row_drag.as_ref().map(|d| d.paths.clone()).unwrap_or_default();
        let hit = self.hits.iter().rev().find(|h| matches!(h.action, Action::Row(_) | Action::TreeRow(_) | Action::Quick(_)) && x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3])?;
        let dir = self.drop_dir(&hit.action)?;
        // Not into itself, nor into the folder a dragged folder is.
        let abs = PathBuf::from(self.data.absolute(&dir)?);
        if dragged.iter().any(|p| *p == abs) {
            return None;
        }
        Some(hit.action.clone())
    }

    /// A drop target's folder, relative to the library.
    fn drop_dir(&self, target: &Action) -> Option<String> {
        match target {
            Action::Row(i) if *i < self.state.folders.len() => Some(self.state.folders[*i].path.clone()),
            Action::TreeRow(i) => self.state.tree.get(*i).and_then(|row| self.library.folder(row.id)).map(|f| f.path).filter(|p| !p.is_empty()),
            Action::Quick(i) => self.state.quick_dirs.get(*i).cloned().flatten(),
            _ => None,
        }
    }

    /// `moveIntoFolder`: the dragged files moved into the folder they were let go over,
    /// leaving out what is already there.
    fn drop_into(&mut self, target: &Action, paths: Vec<PathBuf>) {
        let Some(dest) = self.drop_dir(target).and_then(|d| self.data.absolute(&d)).map(PathBuf::from) else { return };
        let moving: Vec<PathBuf> = paths.into_iter().filter(|p| p.parent() != Some(dest.as_path()) && *p != dest).collect();
        if moving.is_empty() {
            return;
        }
        let outcome = crate::fsops::transfer(&moving, &dest, crate::fsops::Mode::Move);
        self.undo_history.remember(crate::undo::Kind::Move, &outcome.moves);
        self.after(&outcome.moves, crate::fsops::Mode::Move);
        if let Some(error) = outcome.error {
            self.notify(error);
        }
    }

    /// The system drag, with the shell's own data object for the files - what Explorer itself
    /// drags - under a small solid square, as the Electron app draws it.
    fn start_os_drag(&mut self, paths: Vec<PathBuf>) {
        let present: Vec<PathBuf> = paths.into_iter().filter(|p| p.exists()).collect();
        let Some(window) = self.window.clone() else { return };
        if present.is_empty() {
            return;
        }
        let image = resvg::tiny_skia::Pixmap::new(32, 32)
            .and_then(|mut p| {
                p.fill(resvg::tiny_skia::Color::from_rgba8(0x5e, 0x86, 0x9a, 0xcc));
                p.encode_png().ok()
            })
            .unwrap_or_default();
        let _ = drag::start_drag(&*window, drag::DragItem::Files(present), drag::Image::Raw(image), |_, _| {}, drag::Options::default());
    }

    /* ------------------------------------------------------------ stems */

    fn stems_sender(&self) -> impl Fn(crate::stems::Event) + Send + 'static {
        let proxy = self.proxy.clone();
        move |event| {
            if let Some(proxy) = &proxy {
                let _ = proxy.send_event(Wake::Stems(event));
            }
        }
    }

    pub fn open_stem_dialog(&mut self, paths: Vec<String>) {
        let mut names = Vec::new();
        let mut durations = Vec::new();
        let mut kept = Vec::new();
        for path in paths {
            let Some((_, file)) = self.library.file_at(&path) else { continue };
            if !file.playable {
                continue;
            }
            names.push(file.name.clone());
            durations.push(file.duration);
            kept.push(path);
        }
        if kept.is_empty() {
            return;
        }
        let key = self.state.stem_settings.key.trim().to_string();
        // Only from the window: a shot or a test never sends the key anywhere.
        let asking = !key.is_empty() && self.proxy.is_some();
        self.state.stem_dialog = Some(crate::stem_dialog::StemDialog { paths: kept, names, durations, minutes: if asking { None } else { Some(None) } });
        if asking {
            let send = self.stems_sender();
            std::thread::spawn(move || send(crate::stems::Event::Minutes(crate::stems::minutes_left(&key))));
        }
    }

    fn stems_action(&mut self, what: &str) {
        match what {
            "cancel" => self.state.stem_dialog = None,
            "settings" => {
                self.state.stem_dialog = None;
                self.state.settings_section = 5;
                self.show_view(View::Settings);
            }
            "split" => {
                let Some(dialog) = self.state.stem_dialog.take() else { return };
                let st = &self.state.stem_settings;
                if st.key.trim().is_empty() {
                    self.notify("Add your LALAL.AI key in Settings → Stems first.");
                    return;
                }
                if st.output_dir.trim().is_empty() {
                    self.notify("Choose where stems should be written in Settings → Stems.");
                    return;
                }
                if self.state.stem_job.is_some() {
                    self.notify("Stem separation is already running.");
                    return;
                }
                let options = crate::stems::Options { key: st.key.clone(), output_dir: PathBuf::from(&st.output_dir), splitter: st.splitter.clone(), format: st.format.clone(), stem: "vocals".into() };
                self.state.stem_job = Some(crate::stem_dialog::StemJob { path: dialog.paths[0].clone(), phase: "uploading", percent: None, done: 0, total: dialog.paths.len() });
                crate::stems::split_all(dialog.paths, options, self.stems_sender());
            }
            "check" => {
                // What is typed, not only what was saved: Check is how a pasted key is tried.
                let key = self.state.form.value("s.key").trim().to_string();
                if key.is_empty() || self.state.stem_settings.checking {
                    return;
                }
                self.state.stem_settings.checking = true;
                let send = self.stems_sender();
                std::thread::spawn(move || send(crate::stems::Event::Minutes(crate::stems::minutes_left(&key))));
                self.refresh_settings_values();
            }
            "reprocess-all" => {
                // `reprocessCached`: everything analysed, never what a tag or a name declared.
                let mut paths: Vec<String> = self.data.detected_bpm.keys().chain(self.data.detected_key.keys()).cloned().collect();
                paths.sort();
                paths.dedup();
                self.reprocess_in(paths, true);
            }
            "model" => {
                let chosen = self.state.stem_settings.splitter.clone();
                let items = crate::stems::SPLITTERS
                    .iter()
                    .map(|name| {
                        let mut label = name[..1].to_uppercase() + &name[1..];
                        if *name == "andromeda" {
                            label.push_str(" (newest)");
                        }
                        crate::overlay::MenuItem::Item { icon: if chosen == *name { "check" } else { "" }, label, shortcut: None, enabled: true, cmd: crate::overlay::Cmd::StemSplitter(name) }
                    })
                    .collect();
                self.show_menu_below(items, Action::Stems("model"));
            }
            _ => {}
        }
    }

    fn stems_event(&mut self, event: crate::stems::Event) {
        use crate::stems::Event;
        match event {
            Event::Minutes(minutes) => {
                if let Some(d) = self.state.stem_dialog.as_mut() {
                    d.minutes = Some(minutes);
                }
                if self.state.stem_settings.checking {
                    self.state.stem_settings.checking = false;
                    self.state.stem_settings.minutes = Some(minutes);
                }
            }
            Event::Progress { path, phase, percent } => {
                if let Some(job) = self.state.stem_job.as_mut() {
                    if phase == "done" || phase == "failed" {
                        job.done += 1;
                    }
                    job.path = path;
                    job.phase = phase;
                    job.percent = percent;
                }
            }
            Event::Finished(outcomes) => {
                self.state.stem_job = None;
                let written: usize = outcomes.iter().map(|o| o.written.len()).sum();
                let failed: Vec<&crate::stems::Outcome> = outcomes.iter().filter(|o| o.error.is_some()).collect();
                // The stem folders read now: the watch is on the folder you stand in, not these.
                let mut dirs: Vec<PathBuf> = outcomes.iter().flat_map(|o| o.written.iter().filter_map(|w| w.parent().map(PathBuf::from))).collect();
                dirs.sort();
                dirs.dedup();
                for dir in dirs.iter().take(16) {
                    self.refresh_folder(dir);
                }
                let folder = PathBuf::from(&self.state.stem_settings.output_dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let plural = if written == 1 { "" } else { "s" };
                self.notify(if failed.is_empty() {
                    format!("Wrote {written} stem{plural} to {folder}.")
                } else if written > 0 {
                    format!("Wrote {written} stem{plural}; {} failed - {}", failed.len(), failed[0].error.clone().unwrap_or_default())
                } else {
                    failed[0].error.clone().unwrap_or_else(|| "Stem separation failed.".into())
                });
            }
        }
        if self.state.view == View::Settings {
            self.refresh_settings_values();
        }
    }

    /// What the downloader's threads report through.
    fn youtube_sender(&self) -> impl Fn(crate::youtube::Event) + Send + 'static {
        let proxy = self.proxy.clone();
        move |event| {
            if let Some(proxy) = &proxy {
                let _ = proxy.send_event(Wake::Youtube(event));
            }
        }
    }

    fn youtube_action(&mut self, what: &str) {
        let send = self.youtube_sender();
        match what {
            "close" => {
                let id = self.state.folder.id;
                self.open(id, false);
            }
            "link" => {
                self.state.search.focused = false;
                let link = &mut self.state.youtube.link;
                if !link.focused {
                    link.focused = true;
                    link.caret = link.value.len();
                    link.anchor = link.caret;
                }
            }
            "install" => {
                if self.state.youtube.installing.is_some() {
                    return;
                }
                self.state.youtube.installing = Some(0.0);
                self.refresh_settings_values();
                if let Some(d) = &self.downloader {
                    d.install(send);
                }
            }
            "download" => self.start_download(),
            "stop" => {
                if let Some(d) = &self.downloader {
                    d.cancel();
                }
            }
            "format" => {
                let chosen = self.state.youtube_settings.0.clone();
                let items = [("mp3", "MP3"), ("source", "The original stream"), ("video", "Video (MP4)")]
                    .into_iter()
                    .map(|(id, label)| crate::overlay::MenuItem::Item { icon: if chosen == id { "check" } else { "" }, label: label.into(), shortcut: None, enabled: true, cmd: crate::overlay::Cmd::YtFormat(id) })
                    .collect();
                self.show_menu_below(items, Action::Yt("format"));
            }
            "bitrate" => {
                let chosen = self.state.youtube_settings.1;
                let items = [128u32, 160, 192, 256, 320]
                    .into_iter()
                    .map(|k| crate::overlay::MenuItem::Item { icon: if chosen == k { "check" } else { "" }, label: format!("{k} kbps"), shortcut: None, enabled: true, cmd: crate::overlay::Cmd::YtBitrate(k) })
                    .collect();
                self.show_menu_below(items, Action::Yt("bitrate"));
            }
            _ => {}
        }
    }

    fn start_download(&mut self) {
        if !self.state.youtube.can_download() {
            return;
        }
        let send = self.youtube_sender();
        let url = self.state.youtube.link.value.trim().to_string();
        let (format, kbps) = self.state.youtube_settings.clone();
        self.state.youtube.job = Some(crate::download_page::Job { phase: "reading", percent: None, title: None });
        if let Some(d) = &self.downloader {
            d.fetch(url, format, kbps, crate::youtube::download_dir(self.data.settings.youtube_dir.as_deref()), send);
        }
    }

    /// Keys for the link field. Enter downloads when there is something to download.
    fn youtube_key(&mut self, event: &KeyEvent) {
        let before = self.state.youtube.link.value.clone();
        let (ctrl, shift, alt) = (self.command_key(), self.modifiers.shift_key(), self.modifiers.alt_key());
        match ops::edit_field(&mut self.state.youtube.link, event, ctrl, shift, alt) {
            ops::Edit::Enter => self.start_download(),
            ops::Edit::Escape => self.state.youtube.link.focused = false,
            _ => {}
        }
        if self.state.youtube.link.value != before {
            self.probe_at = Some(Instant::now() + Duration::from_millis(400));
        }
    }

    /// `probe`: forgets what the last link was, then reads this one if it is a link at all.
    fn probe_link(&mut self) {
        let y = &mut self.state.youtube;
        y.generation += 1;
        y.info = None;
        y.thumb = None;
        y.problem = None;
        y.probing = false;
        let value = y.link.value.trim().to_string();
        let looks = !value.is_empty() && !value.contains(char::is_whitespace) && (value.starts_with("http://") || value.starts_with("https://"));
        if !looks || !y.ready() {
            return;
        }
        y.probing = true;
        let generation = y.generation;
        let send = self.youtube_sender();
        if let Some(d) = &self.downloader {
            d.probe(generation, value, send);
        }
    }

    fn youtube_event(&mut self, event: crate::youtube::Event) {
        use crate::youtube::Event;
        match event {
            Event::Tool(status) => {
                let ready = status.is_ok();
                self.state.youtube.tool = Some(status);
                self.state.youtube.installing = None;
                if ready && !self.state.youtube.link.value.is_empty() {
                    self.probe_link();
                }
            }
            Event::InstallProgress(p) => self.state.youtube.installing = Some(p),
            Event::Probed(generation, result) => {
                if generation != self.state.youtube.generation {
                    return;
                }
                self.state.youtube.probing = false;
                match result {
                    Ok(mut info) => {
                        let scale = self.scale() as f32;
                        self.state.youtube.thumb = info.thumbnail.take().and_then(|(w, h, rgba)| crate::download_page::thumb_pixmap(w, h, rgba, scale)).map(Rc::new);
                        self.state.youtube.info = Some(info);
                    }
                    Err(problem) => self.state.youtube.problem = Some(problem),
                }
            }
            Event::Progress { phase, percent, title } => {
                let title = title.or_else(|| self.state.youtube.job.as_ref().and_then(|j| j.title.clone()));
                self.state.youtube.job = Some(crate::download_page::Job { phase, percent, title });
            }
            Event::Kept(title, ext) => self.notify(format!("Could not re-encode {title}; kept it as .{ext}.")),
            Event::Done(result) => {
                self.state.youtube.job = None;
                match result {
                    Ok(path) => {
                        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        self.state.youtube.got.insert(0, path.clone());
                        let y = &mut self.state.youtube;
                        y.link = Default::default();
                        y.link.focused = self.state.view == View::Downloading;
                        y.info = None;
                        y.thumb = None;
                        // The folder re-read is what puts it in the list, as a trim arrives.
                        if let Some(dir) = path.parent() {
                            self.refresh_folder(dir);
                        }
                        self.notify(format!("Downloaded {name}."));
                    }
                    Err(problem) if problem != "Cancelled." => self.notify(problem),
                    Err(_) => {}
                }
            }
        }
    }

    /// `refreshFolder`: one folder read again from the disk, now.
    fn refresh_folder(&mut self, dir: &std::path::Path) {
        let Some(rel) = self.data.relative(&dir.to_string_lossy()) else { return };
        let Some(folder) = self.library.folder_at(&rel) else { return };
        if self.library.sync_folder(folder.id, dir) {
            self.state.total_files = self.library.total_files();
            self.rebuild_tree();
            if self.state.view == View::Folder && self.state.folder.id == folder.id && !self.state.searching {
                let (scroll, selection, focus) = (self.state.scroll, self.state.selection.clone(), self.state.focus);
                self.show_view(View::Folder);
                self.state.scroll = scroll;
                self.state.selection = selection;
                self.state.focus = focus;
            }
        }
    }

    /// The Stats page's figures for the chosen range; `reload` reads the library again.
    fn refresh_stats(&mut self, reload: bool) {
        if reload || self.stat_rows.is_none() {
            self.stat_rows = Some(Rc::new(self.library.stat_rows(&self.data.detected_key)));
        }
        let Some(rows) = self.stat_rows.clone() else { return };
        let range = crate::stats::range_bounds(self.state.stats.range, crate::localtime::now());
        let stats = crate::stats::compute(&rows, range);
        let music = crate::stats::compute_music(&rows, range, &self.data.settings.random_exclude_dirs);
        self.state.stats.figures = Some(Rc::new(crate::stats_page::Figures { stats, music }));
    }

    /// The Stats page's footnotes, wrapped to the width it is about to lay out at.
    fn wrap_stats_notes(&mut self, viewport: (f32, f32)) {
        let Some(figures) = self.state.stats.figures.clone() else { return };
        let middle = viewport.0 - self.state.sizes.sidebar - self.state.sizes.panel;
        let width = crate::stats_page::content_width(middle) - 18.0;
        let style = crate::screen::style(crate::stats_page::NOTE_STYLE_SIZE, 400, self.theme.muted_foreground);
        let text = &mut self.ui.text;
        self.state.stats.notes = crate::stats_page::notes(&figures, self.state.stats.range)
            .iter()
            .enumerate()
            .map(|(i, p)| crate::overlay::wrap(p, if i == 2 { 380.0 } else { width }, &mut |s| text.width(s, &style)))
            .collect();
    }

    /// Starts the analysis workers (`analysisConcurrency`, two by default).
    pub fn start_analysis(&mut self) {
        if let Some(proxy) = self.proxy.clone() {
            let queue = crate::analysis::Queue::spawn(self.data.settings.analysis_concurrency.unwrap_or(2), proxy);
            queue.set_key_command(self.data.settings.key_command.as_deref().unwrap_or(""));
            queue.set_key_engine(self.data.settings.key_engine.as_deref().unwrap_or("essentia"), self.data.settings.key_profile.as_deref().unwrap_or("krumhansl"));
            self.analysis = Some(queue);
        }
    }

    /// The folder tags a scope can be: tags on paths that are folders in the library.
    fn folder_tags(&self) -> Vec<String> {
        let mut found: Vec<String> = Vec::new();
        for (path, tags) in &self.data.tags {
            let Some(rel) = self.data.relative(path) else { continue };
            if self.library.folder_at(&rel).is_none() {
                continue;
            }
            for tag in tags {
                if !found.iter().any(|f| f.eq_ignore_ascii_case(tag)) {
                    found.push(tag.clone());
                }
            }
        }
        found.sort_by_key(|t| t.to_lowercase());
        found
    }

    /// The files on screen that still want a tempo or a key, handed to the workers - what
    /// `FileTable` asks for per visible row. Nothing already known, nothing finished this
    /// session, nothing outside the analysis scope.
    fn request_analysis(&mut self, body_height: f32) {
        let Some(queue) = self.analysis.clone() else { return };
        let first = (self.state.scroll / table::ROW).floor().max(0.0) as usize;
        let shown = (body_height / table::ROW).ceil() as usize + 1;
        let wants_key = self.data.settings.detect_key_from_audio.unwrap_or(true);
        let folders = self.state.folders.len();
        let mut wanted = Vec::new();
        for index in first..(first + shown).min(table::row_count(&self.state)) {
            if index < folders {
                continue;
            }
            let at = index - folders;
            let (Some(file), Some(meta)) = (self.state.files.get(at), self.state.file_meta.get(at)) else { continue };
            if !file.playable || self.analysed.contains(&file.path) || file.size > 300 * 1024 * 1024 {
                continue;
            }
            let needs_bpm = meta.bpm.is_none();
            let needs_key = wants_key && meta.key.is_none();
            if (!needs_bpm && !needs_key) || !self.in_analysis_scope(&file.dir) {
                continue;
            }
            wanted.push((file.path.clone(), needs_key));
        }
        if wanted != self.analysis_wanted {
            self.analysis_wanted = wanted.clone();
            queue.want(wanted);
        }
    }

    /// `inAnalysisScope`: with a tag set, the nearest tagged folder above decides.
    fn in_analysis_scope(&self, dir: &str) -> bool {
        let Some(tag) = self.data.settings.analysis_tag.as_ref().map(|t| t.to_lowercase()) else { return true };
        let segments: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
        for depth in (1..=segments.len()).rev() {
            let Some(abs) = self.data.absolute(&segments[..depth].join("/")) else { continue };
            if let Some(applied) = self.data.tags.get(&abs).filter(|t| !t.is_empty()) {
                return applied.iter().any(|t| t.to_lowercase() == tag);
            }
        }
        false
    }

    /// `applyAnalysis`: a tempo or key worked out from the audio goes where the file has none,
    /// into the document, and onto the row.
    fn apply_analysis(&mut self, result: crate::analysis::Result) {
        let row = self.state.files.iter().position(|f| f.path == result.path);
        let file = row.and_then(|at| self.state.files.get(at)).cloned().or_else(|| self.library.file_at(&result.path).map(|(_, f)| f));
        let Some(file) = file else { return };
        let mut changed = false;
        if let Some(bpm) = result.bpm {
            if file.bpm.is_none() && !self.data.detected_bpm.contains_key(&file.path) {
                self.data.detected_bpm.insert(file.path.clone(), bpm);
                if let Some(doc) = self.doc.as_mut() {
                    doc.set("detectedBpm", &file.path, Some(serde_json::Value::from(bpm)));
                }
                changed = true;
            }
        }
        if let Some((key, fit)) = result.key {
            if file.musical_key.as_deref().is_none_or(str::is_empty) && !self.data.detected_key.contains_key(&file.path) {
                self.data.detected_key.insert(file.path.clone(), key.clone());
                if let Some(doc) = self.doc.as_mut() {
                    doc.set("detectedKey", &file.path, Some(serde_json::Value::from(key)));
                }
                // A key a command printed was stated, not estimated: it has no fit to keep.
                if !result.external {
                    self.data.detected_key_fit.insert(file.path.clone(), fit);
                    if let Some(doc) = self.doc.as_mut() {
                        doc.set("detectedKeyFit", &file.path, Some(serde_json::Value::from(fit)));
                    }
                }
                changed = true;
            }
        }
        if !changed {
            return;
        }
        if let Ok(mut shared) = self.search_shared.write() {
            shared.bpm = self.data.detected_bpm.clone();
            shared.key = self.data.detected_key.clone();
        }
        if let Some(at) = row {
            if let Some(meta) = self.state.file_meta.get_mut(at) {
                *meta = table::meta_for(&file, &self.data);
            }
        }
    }

    /// Starts the search thread over its own connection to `db`, with the filters' data.
    pub fn start_search(&mut self, db: PathBuf) {
        if let Ok(mut shared) = self.search_shared.write() {
            shared.ratings = self.data.ratings.clone();
            shared.tags = self.data.tags.clone();
            shared.bpm = self.data.detected_bpm.clone();
            shared.key = self.data.detected_key.clone();
        }
        if let Some(proxy) = &self.proxy {
            self.search_tx = crate::search::spawn(db, self.search_shared.clone(), proxy.clone());
        }
    }

    /// Sends what is typed to the search thread, or goes back to the folder when it is empty.
    fn send_search(&mut self) {
        self.search_generation += 1;
        if self.state.view != View::Folder {
            self.filter_view();
            return;
        }
        let raw = self.state.search.value.clone();
        let recursive = self.state.recursive;
        if !recursive && (raw.trim().is_empty() || crate::search::parse(&raw).is_empty()) {
            if self.state.searching {
                let id = self.state.folder.id;
                self.open(id, false);
            }
            return;
        }
        let request = crate::search::Request { generation: self.search_generation, raw, dir: self.state.folder.path.clone(), recursive, sort: self.state.sort.clone() };
        match &self.search_tx {
            Some(tx) => {
                let _ = tx.send(request);
            }
            None => {
                // No event loop (a shot): answered in place.
                if let Ok(conn) = rusqlite::Connection::open_with_flags(&self.db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
                    let results = crate::search::run(&conn, &request);
                    self.show_results(results);
                }
            }
        }
    }

    /// Shows a saved view: its whole list, narrowed by whatever is typed.
    pub fn show_view(&mut self, view: View) {
        // A page always belongs to the main pane, so it can never land in the second half's
        // history.
        if view.is_page() && self.state.split.is_some_and(|s| s.second_active) {
            self.activate_other();
        }
        let files = match view {
            View::Rated(min, max) => {
                let paths: Vec<String> = self.data.ratings.iter().filter(|(_, r)| **r >= min && **r <= max).map(|(p, _)| p.clone()).collect();
                self.library.files_at(&paths)
            }
            View::Downloads => crate::files::list_downloads(),
            View::Settings => {
                self.state.view = View::Settings;
                if self.state.form.focus != Some("s.key") {
                    let key = self.state.stem_settings.key.clone();
                    self.state.form.set("s.key", key);
                }
                self.refresh_settings_values();
                return;
            }
            View::Contracts => {
                self.ensure_contracts();
                self.state.view = View::Contracts;
                self.state.search.focused = false;
                self.fill_contract_fields();
                return;
            }
            View::Downloading => {
                self.state.view = View::Downloading;
                self.state.search.focused = false;
                // `autoFocus` on the link.
                let link = &mut self.state.youtube.link;
                link.focused = true;
                link.caret = link.value.len();
                link.anchor = link.caret;
                if self.state.youtube.tool.is_none() {
                    let send = self.youtube_sender();
                    if let Some(d) = &self.downloader {
                        d.status(send);
                    }
                }
                return;
            }
            View::Stats => {
                self.state.view = View::Stats;
                self.state.stats.scroll = 0.0;
                self.state.stats.hover = None;
                self.refresh_stats(true);
                return;
            }
            View::Folder => {
                let id = self.state.folder.id;
                self.open(id, false);
                return;
            }
        };
        self.state.view = view;
        self.view_files = files;
        // The saved views share the one global sort: they are not places.
        self.state.sort = Sort {
            key: self.data.settings.sort_key.clone().unwrap_or_else(|| "name".into()),
            dir: self.data.settings.sort_dir.clone().unwrap_or_else(|| "asc".into()),
        };
        self.state.scroll = 0.0;
        self.filter_view();
    }

    fn filter_view(&mut self) {
        let query = crate::search::parse(&self.state.search.value);
        let mut files: Vec<FileRow> = match self.search_shared.read() {
            Ok(shared) => self.view_files.iter().filter(|f| crate::search::matches(f, &query, &shared)).cloned().collect(),
            Err(_) => self.view_files.clone(),
        };
        self.state.folders = Vec::new();
        self.state.searching = !query.is_empty();
        self.state.search_total = files.len();
        if query.terms.is_empty() {
            self.state.files = files;
            self.sort_rows();
        } else {
            // Relevance first while words are typed; stable, so ties keep the column order.
            files.sort_by(|a, b| {
                let rel = |f: &FileRow| format!("{}/{}", f.dir, f.name);
                crate::search::score(&b.name, &rel(b), &query.terms).partial_cmp(&crate::search::score(&a.name, &rel(a), &query.terms)).unwrap_or(std::cmp::Ordering::Equal)
            });
            self.state.files = files;
            self.state.file_meta = self.state.files.iter().map(|f| table::meta_for(f, &self.data)).collect();
        }
        self.state.selection.clear();
        self.state.focus = None;
        self.resolve_rows();
    }

    fn show_results(&mut self, results: crate::search::Results) {
        if results.generation != self.search_generation {
            return;
        }
        self.state.folders = results.folders;
        self.state.files = results.files;
        self.state.search_total = results.total;
        self.state.searching = !self.state.search.value.trim().is_empty() || self.state.recursive;
        if results.ranked {
            // Relevance beats the column sort while words are typed - that is the point of them.
            self.state.file_meta = self.state.files.iter().map(|f| table::meta_for(f, &self.data)).collect();
        } else {
            self.sort_rows();
        }
        self.state.selection.clear();
        self.state.focus = None;
        self.state.scroll = 0.0;
        self.resolve_rows();
    }

    /// One full frame into `frame`, at the given device size and scale.
    pub fn draw(&mut self, width: u32, height: u32, scale: f32) -> &Pixmap {
        let started = Instant::now();
        self.refresh_clock();
        self.match_icon_scale(scale);
        let reuse = self.frame.as_ref().is_some_and(|f| f.width() == width && f.height() == height);
        if !reuse {
            self.frame = Pixmap::new(width.max(1), height.max(1));
        }
        let viewport = (width as f32 / scale, height as f32 / scale);
        self.state.sizes = self.layout.sizes(viewport.0);
        if !self.state.panel_open {
            self.state.sizes.panel = 0.0;
        }
        if self.state.view == View::Stats {
            self.wrap_stats_notes(viewport);
        }
        if self.state.view == View::Downloading {
            let middle = viewport.0 - self.state.sizes.sidebar - self.state.sizes.panel;
            let muted = self.theme.muted_foreground;
            let text = &mut self.ui.text;
            for (key, words, size, width) in crate::download_page::paragraphs(middle) {
                let style = crate::screen::style(size, 400, muted);
                let lines = crate::overlay::wrap(words, width, &mut |s| text.width(s, &style));
                self.state.youtube.wrapped.insert(key, lines);
            }
        }
        self.update_tour(viewport);
        let tree = self.build_tree(viewport);
        let frame = self.frame.as_mut().expect("frame");
        frame.fill(self.theme.background.skia());
        self.ui.spin = (self.started.elapsed().as_millis() % 1000) as f32 * 0.36;
        self.hits = render(&mut self.ui, &tree, frame, scale, self.hovered.as_ref());
        // A spinner on screen asks for its next frame; 30 a second is smooth for one icon.
        self.spin_at = (self.ui.spinning || self.state.tour.is_some() || self.state.about.is_some_and(|at| at.elapsed() < crate::overlay::ABOUT_TYPED)).then(|| Instant::now() + Duration::from_millis(33));
        // The sidebar's gutters follow what this frame found overflowing; a change is one
        // more frame.
        let overflows = |key: &str| self.ui.extents.get(key).is_none_or(|(viewport, content)| *content > *viewport + 0.5);
        let (nav, tree) = (overflows("nav"), overflows("tree"));
        if (nav, tree) != (self.state.nav_gutter, self.state.tree_gutter) {
            self.state.nav_gutter = nav;
            self.state.tree_gutter = tree;
            self.redraw();
        }
        self.request_analysis(table::body_height(viewport.1, self.state.sizes.player));
        self.state.anchors = self
            .hits
            .iter()
            .filter(|h| matches!(h.action, Action::Volume | Action::Queue | Action::Varispeed))
            .map(|h| (h.action.clone(), h.rect.map(|v| v / scale)))
            .collect();
        if self.timing {
            eprintln!("frame {width}x{height} in {:.1}ms", started.elapsed().as_secs_f64() * 1000.0);
        }
        self.frame.as_ref().expect("frame")
    }

    /// An animation frame: only the live elements, over the last full frame. False when that
    /// frame is gone or the layout moved, and a full one is needed.
    pub fn draw_live(&mut self, width: u32, height: u32, scale: f32) -> bool {
        let started = Instant::now();
        self.refresh_clock();
        if !self.frame.as_ref().is_some_and(|f| f.width() == width && f.height() == height) {
            return false;
        }
        let viewport = (width as f32 / scale, height as f32 / scale);
        self.state.sizes = self.layout.sizes(viewport.0);
        if !self.state.panel_open {
            self.state.sizes.panel = 0.0;
        }
        let tree = self.build_tree(viewport);
        let Some(frame) = self.frame.as_mut() else { return false };
        let ok = render_live(&mut self.ui, &tree, frame, scale, self.hovered.as_ref());
        if self.timing {
            eprintln!("live frame in {:.2}ms", started.elapsed().as_secs_f64() * 1000.0);
        }
        ok
    }

    /// Advances the visualizers by one frame of the shared loop.
    pub fn advance(&mut self, phase: Phase) {
        let time = self.epoch.elapsed().as_secs_f64() * 1000.0;
        let ring = self.player.as_ref().map(|p| p.ring.clone());
        self.state.visuals.borrow_mut().frame(phase, time, ring.as_deref());
    }

    /// The clock and the playhead, read from the player.
    fn refresh_clock(&mut self) {
        // `animate-pulse`: opacity 1 to 0.5 and back every two seconds, eased with
        // cubic-bezier(0.4, 0, 0.6, 1). Quantised, since each opacity is an icon raster.
        let t = (self.epoch.elapsed().as_secs_f64() % 2.0) as f32 / 2.0;
        let half = if t < 0.5 { t * 2.0 } else { (t - 0.5) * 2.0 };
        let eased = cubic_bezier(0.4, 0.0, 0.6, 1.0, half);
        let pulse = if t < 0.5 { 1.0 - 0.5 * eased } else { 0.5 + 0.5 * eased };
        self.state.pulse = (pulse * 64.0).round() / 64.0;
        let (Some(player), Some(now)) = (self.player.as_ref(), self.state.now.as_mut()) else { return };
        now.time = player.position();
        now.duration = player.duration.or(now.file.duration).unwrap_or(0.0);
        // The loop holds while playing: past its end, back to its start. Scrubbing a paused
        // track outside it is how the rest of the file is looked at.
        if let Some((a, b)) = self.state.region {
            if now.playing && now.time >= b {
                player.seek(a);
                now.time = a;
            }
        }
        let mut wave = now.wave.borrow_mut();
        wave.has_duration = now.duration > 0.0;
        wave.progress = if now.duration > 0.0 { (now.time / now.duration).clamp(0.0, 1.0) as f32 } else { 0.0 };
    }

    fn playing(&self) -> bool {
        self.state.now.as_ref().is_some_and(|n| n.playing)
    }

    fn hit(&self) -> Option<Action> {
        let (x, y) = (self.cursor.x as f32, self.cursor.y as f32);
        self.hits
            .iter()
            .rev()
            .find(|h| x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3])
            .map(|h| h.action.clone())
    }

    fn act(&mut self, action: Action, event_loop: &ActiveEventLoop) {
        let double = matches!(&self.last_click, Some((last, at)) if *last == action && at.elapsed().as_millis() < 450);
        self.last_click = Some((action.clone(), Instant::now()));
        let window = self.window.clone();
        match action {
            Action::Drag => {
                if let Some(window) = window {
                    if double {
                        window.set_maximized(!window.is_maximized());
                    } else {
                        let _ = window.drag_window();
                    }
                }
            }
            Action::Minimize => {
                if let Some(window) = window {
                    window.set_minimized(true);
                }
            }
            Action::Maximize => {
                if let Some(window) = window {
                    window.set_maximized(!window.is_maximized());
                }
            }
            // The title bar's own X: the same close as the system's, tray and all.
            Action::Close => self.close_window(event_loop),
            Action::UpdateCheck => {
                if let Some(proxy) = self.proxy.clone() {
                    crate::updater::check_now(self.updates_dir(), move || {
                        let _ = proxy.send_event(Wake::Updates);
                    });
                }
            }
            Action::UpdateRestart => self.restart_to_update(event_loop),
            Action::Crumb(id) => self.open(id, true),
            Action::Up => self.up(),
            Action::TreeRow(index) => {
                if let Some(node) = self.state.tree.get(index).cloned() {
                    // Clicking a folder browses it and works the disclosure as the chevron
                    // would: open one you step into, fold one you are already in.
                    if node.has_children && (!node.open || node.id == self.state.folder.id) {
                        self.toggle_tree(node.id);
                    }
                    self.open(node.id, true);
                }
            }
            Action::TreeChevron(index) => {
                if let Some(node) = self.state.tree.get(index) {
                    let id = node.id;
                    self.toggle_tree(id);
                }
            }
            Action::AddFolder => {
                if let Some(dir) = crate::dialogs::pick_folder("Choose your music folder", None, self.hwnd()) {
                    self.add_root(&dir);
                }
            }
            Action::Locate => {
                if let Some(path) = self.state.now.as_ref().map(|n| n.file.path.clone()) {
                    self.locate(&path);
                }
            }
            Action::Back => {
                if let Some(previous) = self.history.pop() {
                    self.future.push(self.state.folder.id);
                    self.open(previous, false);
                }
            }
            Action::Forward => {
                if let Some(next) = self.future.pop() {
                    self.history.push(self.state.folder.id);
                    self.open(next, false);
                }
            }
            Action::Refresh => {
                // The toolbar's re-read: the folder on screen from the disk, for a change the
                // index has not heard about (`refreshFolder`).
                if let Some(abs) = self.here() {
                    if self.library.sync_folder(self.state.folder.id, &abs) {
                        self.state.total_files = self.library.total_files();
                        self.rebuild_tree();
                    }
                }
                let (view, scroll) = (self.state.view, self.state.scroll);
                self.show_view(view);
                self.state.scroll = scroll;
            }
            Action::Row(index) => self.press_row(index, double),
            Action::Dismiss => {
                self.close_overlays();
                self.state.notice = None;
            }
            Action::MenuItem(index) => self.press_menu(index),
            Action::SubItem(index) => {
                let cmd = self.state.menu.as_ref().and_then(|m| m.sub.and_then(|(at, ..)| match m.items.get(at) {
                    Some(crate::overlay::MenuItem::Sub { items, .. }) => match items.get(index) {
                        Some(crate::overlay::MenuItem::Item { enabled: true, cmd, .. }) => Some(cmd.clone()),
                        _ => None,
                    },
                    _ => None,
                }));
                if let Some(cmd) = cmd {
                    self.run(cmd);
                }
            }
            Action::PromptConfirm => self.submit_prompt(),
            Action::DialogConfirm => self.confirm_dialog(),
            Action::About => {
                self.close_overlays();
                self.state.about = Some(Instant::now());
            }
            Action::AboutSource => ops::open_externally(std::path::Path::new(crate::overlay::REPOSITORY)),
            Action::PromptField => {}
            Action::Volume => {
                let t = &mut self.state.transport;
                // Clicking the speaker mutes; a level of zero unmuted comes back at full.
                if t.muted || t.volume > 0.0 {
                    t.muted = !t.muted;
                } else {
                    t.volume = 1.0;
                }
                self.apply_level();
            }
            Action::VolumeSlider => {
                self.resizing = Some(Drag::Volume);
                self.volume_from_cursor();
            }
            Action::VolumePanel => {}
            Action::Queue => {
                let open = !self.state.transport.queue_open;
                self.close_overlays();
                self.state.transport.queue_open = open;
            }
            Action::QueueRow(index) => {
                self.close_overlays();
                self.start(index);
            }
            Action::Varispeed => {
                let open = !self.state.transport.varispeed_open;
                self.close_overlays();
                self.state.transport.varispeed_open = open;
            }
            Action::VarispeedStep(tempo, direction) => {
                let fine = self.modifiers.shift_key();
                let step = if fine { 0.1 } else { 1.0 };
                let bpm = self.state.now.as_ref().and_then(|n| n.file.bpm);
                let rate = rate_for(bpm, self.state.transport.varispeed);
                self.state.transport.varispeed = if tempo {
                    bpm.and_then(|b| {
                        let target = step_from(b * rate, step, direction > 0).clamp(b * 0.5, b * 2.0);
                        // Landing back on the file's own tempo is off, as zero semitones is.
                        ((target - b).abs() >= 0.05).then_some((true, target))
                    })
                } else {
                    let limit = 12.0;
                    let semitones = step_from(12.0 * rate.log2(), step, direction > 0).clamp(-limit, limit);
                    (semitones.abs() > 1e-6).then_some((false, semitones))
                };
                self.apply_speed();
            }
            Action::VarispeedReset => {
                self.state.transport.varispeed = None;
                self.apply_speed();
            }
            Action::SettingsSection(index) => {
                self.state.settings_section = index;
                // Remote and Plugins ask the tailnet who is there, as the pages do when they open.
                if (index == 7 || index == 8) && self.peers.is_none() {
                    self.refresh_peers();
                }
                if index == 8 {
                    self.read_plugins();
                    self.refresh_settings_values();
                }
                self.state.settings_scroll = 0.0;
                if index == 4 && self.state.form.focus != Some("a.keyCommand") {
                    let command = self.data.settings.key_command.clone().unwrap_or_default();
                    self.state.form.set("a.keyCommand", command);
                }
                if index == 5 && self.state.form.focus != Some("s.key") {
                    let key = self.state.stem_settings.key.clone();
                    self.state.form.set("s.key", key);
                }
                // The YT2MP3 section says which downloader is installed.
                if index == 6 && self.state.youtube.tool.is_none() {
                    let send = self.youtube_sender();
                    if let Some(d) = &self.downloader {
                        d.status(send);
                    }
                }
            }
            Action::SettingsClose => {
                let id = self.state.folder.id;
                self.open(id, false);
            }
            Action::SettingSwitch(key) => self.run_setting_switch(key),
            Action::SettingChoice(key, value) => {
                match key {
                    "waveformTint" => {
                        self.data.settings.waveform_tint = Some(value.to_string());
                        let ramp = value != "accent";
                        self.state.visuals.borrow_mut().ramp = ramp;
                        if let Some(now) = &self.state.now {
                            let peaks = now.wave.borrow().peaks.clone();
                            now.wave.borrow_mut().set_peaks(peaks);
                        }
                    }
                    "queueSource" => self.data.settings.queue_source = Some(value.to_string()),
                    "keyEngine" | "keyProfile" => {
                        if key == "keyEngine" {
                            self.data.settings.key_engine = Some(value.to_string());
                        } else {
                            self.data.settings.key_profile = Some(value.to_string());
                        }
                        let s = &self.data.settings;
                        if let Some(q) = &self.analysis {
                            q.set_key_engine(s.key_engine.as_deref().unwrap_or("essentia"), s.key_profile.as_deref().unwrap_or("krumhansl"));
                        }
                        // `resetAnalysis`: what this session has analysed is asked again.
                        self.analysed.clear();
                    }
                    "analysisConcurrency" => {
                        let n: usize = value.parse().unwrap_or(2);
                        self.data.settings.analysis_concurrency = Some(n);
                        if let Some(q) = &self.analysis {
                            q.set_concurrency(n);
                        }
                        self.write_setting(key, serde_json::Value::from(n));
                        self.refresh_settings_values();
                        return;
                    }
                    "undoDepth" => {
                        let depth: usize = value.parse().unwrap_or(25);
                        self.data.settings.undo_depth = Some(depth);
                        self.undo_history.set_limit(depth);
                        self.write_setting(key, serde_json::Value::from(depth));
                        self.refresh_settings_values();
                        return;
                    }
                    "stemFormat" => {
                        self.data.settings.stem_format = Some(value.to_string());
                        self.state.stem_settings.format = value.to_string();
                    }
                    "youtubeFormat" => {
                        self.data.settings.youtube_format = Some(value.to_string());
                        self.state.youtube_settings.0 = value.to_string();
                    }
                    "youtubeBitrate" => {
                        let kbps: u32 = value.parse().unwrap_or(192);
                        self.data.settings.youtube_bitrate = Some(kbps);
                        self.state.youtube_settings.1 = kbps;
                        // A number in the document, as the Electron app writes it.
                        self.write_setting(key, serde_json::Value::from(kbps));
                        self.refresh_settings_values();
                        return;
                    }
                    _ => {}
                }
                self.write_setting(key, serde_json::Value::from(value));
                self.refresh_settings_values();
            }
            Action::SettingPick(key) => {
                let owner = self.window.as_ref().and_then(|w| {
                    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
                    match w.window_handle().ok()?.as_raw() {
                        RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
                        _ => None,
                    }
                });
                if key == "stemOutputDir" {
                    let start = Some(PathBuf::from(&self.state.stem_settings.output_dir));
                    if let Some(dir) = crate::dialogs::pick_folder("Where stems are written", start.as_deref(), owner) {
                        let dir = dir.to_string_lossy().into_owned();
                        self.data.settings.stem_output_dir = dir.clone();
                        self.state.stem_settings.output_dir = dir.clone();
                        self.write_setting(key, serde_json::Value::from(dir));
                    }
                }
                if key == "remoteDownloadDir" {
                    let start = self.data.settings.remote_download_dir.clone().map(PathBuf::from);
                    if let Some(dir) = crate::dialogs::pick_folder("Where files copied from other machines land", start.as_deref(), owner) {
                        let dir = dir.to_string_lossy().into_owned();
                        self.data.settings.remote_download_dir = Some(dir.clone());
                        self.write_setting(key, serde_json::Value::from(dir));
                    }
                }
                if key == "flUserData" {
                    let start = Some(self.fl_user_data());
                    if let Some(dir) = crate::dialogs::pick_folder("FL Studio's plugin database, or the user data folder holding it", start.as_deref(), owner) {
                        let dir = dir.to_string_lossy().into_owned();
                        self.data.settings.fl_user_data = Some(dir.clone());
                        self.write_setting(key, serde_json::Value::from(dir));
                        self.read_plugins();
                        self.configure_server();
                    }
                }
                if key == "bundleExportDir" {
                    let start = Some(self.bundle_dir());
                    if let Some(dir) = crate::dialogs::pick_folder("Where bundles are written", start.as_deref(), owner) {
                        let dir = dir.to_string_lossy().into_owned();
                        self.data.settings.bundle_export_dir = Some(dir.clone());
                        self.write_setting(key, serde_json::Value::from(dir));
                    }
                }
                if key == "youtubeDir" {
                    let start = self.data.settings.youtube_dir.clone().map(PathBuf::from);
                    if let Some(dir) = crate::dialogs::pick_folder("Where downloads are written", start.as_deref(), owner) {
                        let dir = dir.to_string_lossy().into_owned();
                        self.data.settings.youtube_dir = Some(dir.clone());
                        self.write_setting(key, serde_json::Value::from(dir));
                    }
                }
                self.refresh_settings_values();
            }
            Action::SettingSlider(key) => {
                self.resizing = Some(Drag::Setting(key));
                self.setting_from_cursor(key);
            }
            Action::SettingRemove(key, index) => {
                match key {
                    "randomExcludeDirs" => {
                        if index < self.data.settings.random_exclude_dirs.len() {
                            self.data.settings.random_exclude_dirs.remove(index);
                        }
                        let value = serde_json::Value::from(self.data.settings.random_exclude_dirs.clone());
                        self.write_setting(key, value);
                    }
                    "quickMove" => {
                        if index < self.data.settings.quick_move.len() {
                            self.data.settings.quick_move.remove(index);
                        }
                        if let Ok(value) = serde_json::to_value(&self.data.settings.quick_move) {
                            self.write_setting(key, value);
                        }
                        self.state.quick = self.data.settings.quick_move.clone();
                        self.state.quick_dirs = self.state.quick.iter().map(|q| self.data.relative(&q.path)).collect();
                    }
                    _ => {}
                }
                self.refresh_settings_values();
            }
            Action::ProjectTime => {
                if let Some(path) = self.state.now.as_ref().and_then(|n| n.project.as_ref().map(|p| p.1.clone())) {
                    self.locate(&path);
                }
            }
            Action::TagRow(index) => self.pick_tag_row(index),
            Action::TagRemove(index) => self.drop_applied_tag(index),
            Action::Note(at) => self.edit_note(at),
            Action::Tag(index) => {
                if let Some((tag, _)) = self.state.tags.get(index).cloned() {
                    if let Some(at) = self.state.tag_filter.iter().position(|t| *t == tag) {
                        self.state.tag_filter.remove(at);
                    } else {
                        self.state.tag_filter.push(tag);
                    }
                    self.refilter();
                }
            }
            Action::ClearTags => {
                self.state.tag_filter.clear();
                self.refilter();
            }
            Action::ClearFilters => {
                self.state.tag_filter.clear();
                self.update_facets();
                self.state.search = screen::SearchBox { focused: self.state.search.focused, ..Default::default() };
                self.send_search();
                self.refilter();
            }
            Action::Nav("files") => {
                let id = self.state.folder.id;
                self.open(id, false);
            }
            Action::Nav("rated") => self.show_view(View::Rated(1, 5)),
            Action::Nav("stats") => self.show_view(View::Stats),
            Action::Nav("youtube") => self.show_view(View::Downloading),
            Action::Nav("contracts") => self.show_view(View::Contracts),
            Action::Field(key) => self.focus_field(key),
            Action::Contracts(what) => self.contracts_action(what),
            Action::ContractsSection(index) => {
                self.state.contracts.section = index;
                self.state.contracts.scroll = 0.0;
            }
            Action::ContractRecord(index, what) => {
                let record = self.state.contracts.data.as_ref().and_then(|d| d.history.get(index).cloned());
                if let Some(record) = record {
                    match what {
                        0 => {
                            if let Some(pdf) = &record.pdf_path {
                                ops::open_externally(std::path::Path::new(pdf));
                            }
                        }
                        1 => {
                            // The Markdown, the one path every record is sure to have.
                            let md = PathBuf::from(&record.markdown_path);
                            ops::reveal(if md.exists() { &md } else { md.parent().unwrap_or(&md) }, md.exists());
                        }
                        _ => {
                            if let Some(store) = self.contract_store.as_mut() {
                                store.delete_record(&record.id);
                            }
                            self.sync_contract_data();
                        }
                    }
                }
            }
            Action::ContractPreset(index) => {
                let key = self.state.contracts.data.as_ref().and_then(|d| d.presets.get(index)).map(|p| if p.alias.is_empty() { p.name.clone() } else { p.alias.clone() });
                if let (Some(key), Some(store)) = (key, self.contract_store.as_mut()) {
                    store.delete_preset(&key);
                }
                self.sync_contract_data();
            }
            Action::ContractChip(index) => {
                let preset = self.state.contracts.data.as_ref().and_then(|d| d.presets.get(index).cloned());
                if let Some(p) = preset {
                    self.state.form.set("c.customer", p.name);
                    self.state.form.set("c.alias", p.alias);
                    self.state.form.set("c.email", p.email);
                    self.preview_at = Some(Instant::now());
                }
            }
            Action::ContractPreview => {}
            Action::Stems(what) => self.stems_action(what),
            Action::Pick(kind, index) => self.open_picker(kind, index),
            Action::PickerArea => {
                self.resizing = Some(Drag::Picker(true));
                self.picker_from_cursor(true);
            }
            Action::PickerHue => {
                self.resizing = Some(Drag::Picker(false));
                self.picker_from_cursor(false);
            }
            Action::PickerPreset(i) => {
                if let Some(target) = self.state.color_picker.as_ref().map(|p| p.target) {
                    let presets: &[&str] = if target == crate::color_picker::Target::Background { &crate::color_picker::SURFACE_PRESETS } else { &crate::color_picker::ACCENT_PRESETS };
                    if let Some(hex) = presets.get(i) {
                        if let Some(p) = self.state.color_picker.as_mut() {
                            p.take_hex(hex);
                        }
                        self.picker_changed();
                    }
                }
            }
            Action::PickerReset => {
                let Some(target) = self.state.color_picker.as_ref().map(|p| p.target) else { return };
                self.state.color_picker = None;
                match target {
                    crate::color_picker::Target::Accent => self.set_theme(Some(None), None),
                    crate::color_picker::Target::Background => self.set_theme(None, Some(None)),
                    crate::color_picker::Target::Stop(i) => {
                        let mut stops = self.current_stops();
                        if stops.len() > 2 {
                            stops.remove(i.min(stops.len() - 1));
                            self.set_stops(stops);
                        }
                    }
                }
            }
            Action::StopAdd => {
                // A new stop takes the last colour, so adding one changes nothing on screen until
                // it is given a colour of its own.
                let mut stops = self.current_stops();
                if stops.len() < 8 {
                    if let Some(last) = stops.last().cloned() {
                        stops.push(last);
                    }
                    self.set_stops(stops);
                }
            }
            Action::ThemeReset(0) => self.set_theme(Some(None), None),
            Action::ThemeReset(_) => self.set_theme(None, Some(None)),
            Action::StopsReset => self.set_stops(Vec::new()),
            Action::HeadroomReset => {
                self.state.visuals.borrow_mut().headroom = 6.0;
                self.data.settings.visualizer_headroom_db = Some(6.0);
                self.write_setting("visualizerHeadroomDb", serde_json::Value::from(6.0));
                self.refresh_settings_values();
            }
            Action::GradientPreset(i) => {
                if let Some((_, stops)) = crate::settings_page::GRADIENT_PRESETS.get(i) {
                    self.set_stops(stops.iter().map(|s| s.to_string()).collect());
                }
            }
            Action::PeersRefresh => self.refresh_peers(),
            Action::FlManage => {
                let catalog = crate::fl_plugins::read_catalog(&self.fl_user_data());
                self.state.form.set("fl.q", String::new());
                self.state.form.focus = Some("fl.q");
                self.state.fl_dialog = Some(crate::fl_plugins::Dialog { catalog, formats: Default::default(), picked: Default::default(), anchors: [None, None], scroll: [0.0, 0.0], busy: false, note: None });
            }
            Action::FlClose => {
                self.state.fl_dialog = None;
                self.state.form.focus = None;
                self.read_plugins();
                self.refresh_settings_values();
            }
            Action::FlRecheck => {
                let catalog = crate::fl_plugins::read_catalog(&self.fl_user_data());
                if let Some(d) = self.state.fl_dialog.as_mut() {
                    d.catalog = catalog;
                }
            }
            Action::FlFormat(i) => {
                let query = self.state.form.value("fl.q").to_string();
                let _ = query;
                if let Some(d) = self.state.fl_dialog.as_mut() {
                    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
                    for p in &d.catalog.plugins {
                        for f in &p.formats {
                            *counts.entry(f.clone()).or_default() += 1;
                        }
                    }
                    let mut counts: Vec<(String, usize)> = counts.into_iter().collect();
                    counts.sort_by(|a, b| b.1.cmp(&a.1));
                    if let Some((format, _)) = counts.get(i) {
                        if !d.formats.remove(format) {
                            d.formats.insert(format.clone());
                        }
                    }
                    d.scroll = [0.0, 0.0];
                }
            }
            Action::FlFormatsClear => {
                if let Some(d) = self.state.fl_dialog.as_mut() {
                    d.formats.clear();
                }
            }
            Action::FlPick(side, index) => {
                let query = self.state.form.value("fl.q").to_string();
                let extend = self.modifiers.shift_key();
                if let Some(d) = self.state.fl_dialog.as_mut() {
                    let list: Vec<String> = crate::fl_plugins::sides(d, &query)[side as usize].iter().map(|p| p.name.clone()).collect();
                    crate::fl_plugins::pick(d, &list, side as usize, index, extend);
                }
            }
            Action::FlSelectAll(side) => {
                let query = self.state.form.value("fl.q").to_string();
                if let Some(d) = self.state.fl_dialog.as_mut() {
                    let list: Vec<String> = crate::fl_plugins::sides(d, &query)[side as usize].iter().map(|p| p.name.clone()).collect();
                    let all = list.iter().all(|n| d.picked.contains(n));
                    for name in list {
                        if all {
                            d.picked.remove(&name);
                        } else {
                            d.picked.insert(name);
                        }
                    }
                }
            }
            Action::FlMove(wanted) => {
                let query = self.state.form.value("fl.q").to_string();
                let user_data = self.fl_user_data();
                if let Some(d) = self.state.fl_dialog.as_mut() {
                    // What is picked on the side it is leaving.
                    let names: std::collections::HashSet<String> = crate::fl_plugins::sides(d, &query)[usize::from(!wanted)].iter().filter(|p| d.picked.contains(&p.name)).map(|p| p.name.clone()).collect();
                    if !names.is_empty() {
                        let (changed, failures) = crate::fl_plugins::set_favourites(&d.catalog, &names, wanted);
                        d.note = Some(match failures.first() {
                            Some(first) => (first.clone(), true),
                            None => (format!("{} {changed}.", if wanted { "Favourited" } else { "Unfavourited" }), false),
                        });
                        d.catalog = crate::fl_plugins::read_catalog(&user_data);
                        d.picked.clear();
                        d.anchors = [None, None];
                    }
                }
            }
            Action::MountLibrary(peer_index, library_index) => self.mount_library(peer_index, library_index),
            Action::BackupExport(pick) => self.export_bundle(pick),
            Action::BackupImport => self.import_backup(),
            Action::ImportCancel => self.state.importing = None,
            Action::ImportSkip(i) => {
                if let Some(w) = self.state.importing.as_mut() {
                    w.skip(i);
                }
            }
            Action::ImportLocate(i) => {
                let label = self.state.importing.as_ref().and_then(|w| w.summary.folders.get(i)).map(|f| f.label.clone()).unwrap_or_default();
                if let Some(dir) = crate::dialogs::pick_folder(&format!("Where {label} lives now"), None, self.hwnd()) {
                    if let Some(w) = self.state.importing.as_mut() {
                        w.locate(i, &dir);
                    }
                }
            }
            Action::ImportFindAll => {
                if let Some(dir) = crate::dialogs::pick_folder("Which folder holds them all", None, self.hwnd()) {
                    if let Some(w) = self.state.importing.as_mut() {
                        w.locate_all(&dir);
                    }
                }
            }
            Action::ImportApply => {
                if let Some(w) = self.state.importing.take() {
                    self.apply_backup(&w.backup, &w.mapping, 0);
                }
            }
            Action::RemoteImport(i) => {
                let Some(peer) = self.peers.as_ref().and_then(|(_, peers)| peers.iter().filter(|p| p.serving).nth(i).cloned()) else { return };
                let (Some(host), Some(proxy)) = (peer.node.ipv4.clone(), self.proxy.clone()) else { return };
                let name = if peer.node.host_name.is_empty() { peer.node.name.clone() } else { peer.node.host_name.clone() };
                self.notify(format!("Asking {name} for its tags and ratings…"));
                std::thread::spawn(move || {
                    let _ = proxy.send_event(Wake::RemoteMetadata(name, crate::server::ask(&host, "/metadata")));
                });
            }
            Action::SyncSettings => self.sync_settings(false),
            Action::TourSkip => self.finish_tour(),
            Action::Split => {
                let id = if self.state.view == View::Folder { self.state.folder.id } else { self.data.settings.last_dir.as_deref().and_then(|d| self.library.folder_at(d)).map_or(crate::library::LIBRARY, |f| f.id) };
                self.open_in_other_pane(id);
            }
            Action::ClosePane => self.close_pane(),
            Action::PaneDivider => self.resizing = Some(Drag::PaneSplit),
            Action::PluginsCompare(i) => {
                let Some(peer) = self.peers.as_ref().and_then(|(_, peers)| peers.iter().filter(|p| p.serving).nth(i).cloned()) else { return };
                let Some(proxy) = self.proxy.clone() else { return };
                let host = peer.node.ipv4.clone().unwrap_or_else(|| peer.node.name.clone());
                self.compared.insert(peer.node.id.clone(), None);
                let id = peer.node.id.clone();
                std::thread::spawn(move || {
                    let _ = proxy.send_event(Wake::PluginsCompared(id, crate::server::ask(&host, "/plugins")));
                });
                self.refresh_settings_values();
            }
            Action::Changelog(i) => {
                self.changelog_open = if self.changelog_open == Some(i) { None } else { Some(i) };
                self.refresh_settings_values();
            }
            Action::ReplayTour => {
                self.data.settings.tutorial_seen = false;
                self.write_setting("tutorialSeen", serde_json::Value::Bool(false));
                // Back to the explorer: every step points at something only on screen there.
                let id = self.state.folder.id;
                self.open(id, false);
            }
            Action::OutputMenu => {
                let chosen = self.output_name();
                let present = crate::player::Player::devices();
                self.output_devices = Some(present.clone());
                let mut names = present.clone();
                if let Some(name) = chosen.clone().filter(|n| !names.contains(n)) {
                    names.push(name);
                }
                let mut items = vec![crate::overlay::MenuItem::Item { icon: if chosen.is_none() { "check" } else { "" }, label: "System default".into(), shortcut: None, enabled: true, cmd: crate::overlay::Cmd::OutputDevice(String::new()) }];
                for name in names {
                    let label = if present.contains(&name) { name.clone() } else { format!("{name} (not connected)") };
                    items.push(crate::overlay::MenuItem::Item { icon: if chosen.as_deref() == Some(name.as_str()) { "check" } else { "" }, label, shortcut: None, enabled: true, cmd: crate::overlay::Cmd::OutputDevice(name) });
                }
                self.show_menu_below(items, Action::OutputMenu);
            }
            Action::ShortcutBind(id) => {
                self.shortcut_refused = None;
                self.capturing = if self.capturing == Some(id) { None } else { Some(id) };
                self.refresh_settings_values();
            }
            Action::ShortcutReset(id) => {
                self.data.settings.shortcuts.remove(id);
                self.write_shortcuts();
            }
            Action::ShortcutsReset => {
                self.data.settings.shortcuts.clear();
                self.write_shortcuts();
            }
            Action::AnalysisTag => {
                let chosen = self.data.settings.analysis_tag.clone();
                let mut items = vec![crate::overlay::MenuItem::Item { icon: if chosen.is_none() { "check" } else { "" }, label: "Everything".into(), shortcut: None, enabled: true, cmd: crate::overlay::Cmd::AnalysisTag(None) }];
                for tag in self.folder_tags() {
                    let on = chosen.as_deref() == Some(tag.as_str());
                    items.push(crate::overlay::MenuItem::Item { icon: if on { "check" } else { "" }, label: tag.clone(), shortcut: None, enabled: true, cmd: crate::overlay::Cmd::AnalysisTag(Some(tag)) });
                }
                self.show_menu_below(items, Action::AnalysisTag);
            }
            Action::KeyTest => {
                let command = self.state.form.value("a.keyCommand").to_string();
                if command.trim().is_empty() || self.key_testing {
                    return;
                }
                let Some(now) = self.state.now.as_ref().map(|n| (n.file.path.clone(), n.file.name.clone())) else {
                    self.key_test = Some("Play something first. The test runs against the current track.".into());
                    self.refresh_settings_values();
                    return;
                };
                self.key_testing = true;
                let proxy = self.proxy.clone();
                std::thread::spawn(move || {
                    let answer = crate::analysis::external_key(&command, &now.0);
                    let line = match answer {
                        Some(a) => format!("{} → {}", now.1, a.chars().take(60).collect::<String>()),
                        None => "No output. The command failed or printed nothing.".to_string(),
                    };
                    if let Some(proxy) = proxy {
                        let _ = proxy.send_event(Wake::KeyTest(line));
                    }
                });
                self.refresh_settings_values();
            }
            Action::Yt(what) => self.youtube_action(what),
            Action::YtShow(which) => {
                let path = match which {
                    None => {
                        // The first download makes the folder; before it, there is nothing for
                        // Finder or Explorer to show, and they say nothing. It is made here.
                        let dir = crate::youtube::download_dir(self.data.settings.youtube_dir.as_deref());
                        if let Err(e) = std::fs::create_dir_all(&dir) {
                            self.notify(format!("{} can't be made: {e}", dir.display()));
                            return;
                        }
                        Some(dir)
                    }
                    Some(i) => self.state.youtube.got.get(i).cloned(),
                };
                if let Some(path) = path {
                    if !path.exists() {
                        self.notify(format!("{} is no longer there.", path.display()));
                    } else {
                        ops::reveal(&path, true);
                    }
                }
            }
            Action::StatsRange(index) => {
                self.state.stats.range = index;
                self.state.stats.hover = None;
                self.refresh_stats(false);
            }
            Action::StatsMetric(chart, on) => {
                if chart == 0 {
                    self.state.stats.timeline_projects = on;
                } else {
                    self.state.stats.activity_hours = on;
                }
            }
            Action::Chart(_) => {}
            Action::Stars(stars) => self.show_view(View::Rated(stars, stars)),
            Action::Nav("downloads") => self.show_view(View::Downloads),
            Action::Quick(index) => {
                match self.state.quick_dirs.get(index).cloned().flatten().and_then(|dir| self.library.folder_at(&dir)) {
                    Some(folder) => self.open(folder.id, true),
                    // A filing destination outside the library: it can only be shown in the
                    // OS file manager.
                    None => {
                        if let Some(quick) = self.state.quick.get(index) {
                            ops::reveal(std::path::Path::new(&quick.path), false);
                        }
                    }
                }
            }
            Action::Search => {
                let at = self.caret_at_cursor();
                let search = &mut self.state.search;
                if !search.focused {
                    search.focused = true;
                }
                search.caret = at;
                if !self.modifiers.shift_key() {
                    search.anchor = at;
                }
                if double {
                    search.anchor = 0;
                    search.caret = search.value.len();
                }
            }
            Action::ClearSearch => {
                self.state.search = screen::SearchBox { focused: self.state.search.focused, ..Default::default() };
                self.send_search();
            }
            Action::Tool(name) => match name {
                // Through the Settings page's own switch, which updates what the button draws
                // from as well as the setting. Flipping the setting alone left the button showing
                // the old state until the next folder change, so it looked stuck.
                "mouse-pointer-click" => self.run_setting_switch("playOnSelect"),
                "repeat" => self.run_setting_switch("autoAdvance"),
                "dices" => self.play_random(),
                "audio-lines" => self.run(crate::overlay::Cmd::ToggleKind("audio".into())),
                "folder-tree" => {
                    if self.state.view == View::Folder {
                        self.state.recursive = !self.state.recursive;
                        self.send_search();
                    }
                }
                "list-filter" => self.open_type_menu(),
                "settings" => self.show_view(View::Settings),
                "pin" => {
                    self.run_setting_switch("alwaysOnTop");
                    self.state.always_on_top = self.data.settings.always_on_top;
                }
                "panel" => {
                    self.state.panel_open = !self.state.panel_open;
                    self.data.settings.panel_open = Some(self.state.panel_open);
                    self.write_setting("panelOpen", serde_json::Value::from(self.state.panel_open));
                }
                "mini-player" => self.set_mini_player(true),
                "mini-exit" => self.set_mini_player(false),
                "stage" => self.set_stage(!self.state.stage),
                "wand-sparkles" => {
                    // Every file on screen, as the toolbar's wand does.
                    let paths: Vec<String> = self.state.files.iter().filter(|f| f.playable).map(|f| f.path.clone()).collect();
                    self.reprocess(paths);
                }
                "columns3" => self.open_columns_menu(),
                _ => {}
            },
            Action::SortBy(key) => self.act_sort(key),
            Action::ColumnResize(id) => {
                if double {
                    if let Some(column) = self.state.columns.iter_mut().find(|c| c.id == id) {
                        column.width = columns::def_of(id).default_width;
                    }
                    self.save_columns();
                } else if let Some(column) = self.state.columns.iter().find(|c| c.id == id) {
                    let x = (self.cursor.x / self.scale()) as f32;
                    self.resizing = Some(Drag::Column(id, x, column.width));
                    self.state.column_hot = Some(id);
                }
            }
            Action::Rate(at, stars) => {
                if let Some(file) = self.state.files.get(at) {
                    let path = file.path.clone();
                    // Clicking the star you are on clears the rating (`StarRating`).
                    let current = self.state.ratings.get(&path).copied().unwrap_or(0);
                    self.rate(&[path], if current == stars { 0 } else { stars });
                }
            }
            Action::Play => self.toggle(),
            Action::Next => self.next(),
            Action::Previous => self.previous(),
            Action::Seek => {
                // An edge of the region is grabbed and dragged; with the scissors on (or Alt
                // held) a drag paints a new one; otherwise it scrubs.
                let at = self.time_at_cursor();
                let grab = self.seconds_per_pixel() * 7.0;
                match (at, self.state.region) {
                    (Some(at), Some((a, b))) if (at - a).abs() <= grab => self.region_drag = Some(b),
                    (Some(at), Some((a, b))) if (at - b).abs() <= grab => self.region_drag = Some(a),
                    (Some(at), _) if self.state.trimming || self.modifiers.alt_key() => {
                        self.region_drag = Some(at);
                        self.set_region(Some((at, at)));
                    }
                    _ => {
                        self.scrubbing = true;
                        self.seek_to_cursor();
                    }
                }
            }
            Action::Trim => {
                self.state.trimming = !self.state.trimming;
                // Leaving the mode takes the loop with it: one left behind a switched-off
                // toggle is a track that mysteriously refuses to play past a point.
                if !self.state.trimming {
                    self.set_region(None);
                }
            }
            Action::TrimSave => self.prompt_save_trim(),
            Action::Resize(handle) => {
                if double {
                    // Double-click puts it back, as `onDoubleClick` does on every separator.
                    self.layout.reset(handle);
                    self.save_layout();
                } else {
                    let window = self.logical_size().0;
                    self.resizing = Some(Drag::Pane(handle, self.pointer_along(handle), self.layout.start(handle, window)));
                    self.state.resizing = Some(handle);
                }
            }
            _ => {}
        }
    }

    /// Plays file `index` of the open folder, with the rest of the folder's playable files
    /// queued behind it.
    pub fn play(&mut self, index: usize) {
        let Some(file) = self.state.files.get(index) else { return };
        if !file.playable {
            return;
        }
        let path = file.path.clone();
        let from_view = self.data.settings.queue_source.as_deref() == Some("view");
        let source: Vec<FileRow> = if from_view || self.state.view == View::Folder && !self.state.searching {
            self.state.files.clone()
        } else {
            // The file's own folder, as it sorts there.
            match self.library.folder_of(&path) {
                Some(folder) => self.library.files(folder),
                None => self.state.files.clone(),
            }
        };
        self.queue = source.into_iter().filter(|f| f.playable).collect();
        self.queue_index = self.queue.iter().position(|f| f.path == path).unwrap_or(0);
        self.start(self.queue_index);
    }

    fn start(&mut self, at: usize) {
        let Some(file) = self.queue.get(at).cloned() else { return };
        if self.player.is_none() {
            match Player::new(self.output_name().as_deref()) {
                Ok(player) => {
                    self.player = Some(player);
                    self.apply_level();
                }
                Err(e) => {
                    // Said, not swallowed: a play button that does nothing reads as broken.
                    self.notify(format!("The audio output could not be opened: {e}"));
                    return;
                }
            }
        }
        let Some(player) = self.player.as_mut() else { return };
        if let Err(e) = player.play(&file.path) {
            let not_found = e.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound);
            let message = match not_found.then(|| missing_part(&file.path)).flatten() {
                Some(gone) if gone == std::path::Path::new(&file.path) => format!("{} is no longer there.", file.name),
                // What to fix first: the notice is one short line, and a long file name pushes
                // the rest out of it.
                Some(gone) => format!("{} isn't connected, so {} can't play.", gone.display(), file.name),
                None => format!("{} could not be played: {e}", file.name),
            };
            self.notify(message);
            return;
        }
        self.queue_index = at;
        // A tempo target means a different rate for each track; an interval, the same one.
        player.set_speed(rate_for(file.bpm, self.state.transport.varispeed) as f32);
        self.state.transport.queue = self.queue.iter().map(|f| f.name.clone()).collect();
        self.state.transport.queue_index = at;
        let wave = Rc::new(RefCell::new(Wave::new()));
        // Peaks come from a full decode, so they are worked out off the window's thread and
        // arrive as a wake-up. With no event loop (a `--shot`) they are worked out in place.
        let (path, duration) = (file.path.clone(), file.duration);
        match &self.proxy {
            Some(proxy) => {
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    let peaks = crate::waveform::peaks(&path, duration);
                    let _ = proxy.send_event(Wake::Peaks(path, peaks));
                });
            }
            None => wave.borrow_mut().set_peaks(crate::waveform::peaks(&path, duration)),
        }
        let details = self.details(&file);
        let listed = self.data.settings.player_details.iter().any(|f| f == "projectTime");
        let project = if file.ext == "flp" || !listed { None } else { self.library.project_for(&file.name, &file.dir) };
        // A loop belongs to the track it was drawn on.
        self.state.region = None;
        self.state.now = Some(NowPlaying { file, details, time: 0.0, duration: 0.0, playing: true, wave, project });
        self.clear_at = None;
        self.next_tick = Instant::now();
        self.full = true;
    }

    fn toggle(&mut self) {
        let (Some(player), Some(now)) = (self.player.as_ref(), self.state.now.as_mut()) else { return };
        // A track that ran out starts again from the top.
        if player.finished() {
            self.start(self.queue_index);
            return;
        }
        player.toggle();
        now.playing = !player.is_paused();
        if now.playing {
            self.clear_at = None;
            self.next_tick = Instant::now();
        } else {
            self.stopped();
        }
    }

    /// Playback came to rest: one settling frame now, a wipe later.
    fn stopped(&mut self) {
        self.pending = Some(Phase::Idle);
        self.clear_at = Some(Instant::now() + IDLE_CLEAR);
    }

    fn next(&mut self) {
        if self.queue_index + 1 < self.queue.len() {
            self.start(self.queue_index + 1);
        } else if let (Some(player), Some(now)) = (self.player.as_ref(), self.state.now.as_mut()) {
            player.pause();
            now.playing = false;
            self.stopped();
        }
    }

    /// Back to the start of the track, unless it is barely under way.
    fn previous(&mut self) {
        let Some(player) = self.player.as_ref() else { return };
        if player.position() > 3.0 || self.queue_index == 0 {
            player.seek(0.0);
        } else {
            self.start(self.queue_index - 1);
        }
    }

    fn seek_to_cursor(&mut self) {
        let Some(hit) = self.hits.iter().find(|h| h.action == Action::Seek) else { return };
        let (Some(player), Some(now)) = (self.player.as_ref(), self.state.now.as_ref()) else { return };
        if now.duration <= 0.0 {
            return;
        }
        let ratio = ((self.cursor.x as f32 - hit.rect[0]) / (hit.rect[2] - hit.rect[0])).clamp(0.0, 1.0);
        player.seek(ratio as f64 * now.duration);
    }

    fn scale(&self) -> f64 {
        self.window.as_ref().map(|w| w.scale_factor()).unwrap_or(1.0)
    }

    /// Sorts the open folder's rows by the sort in force, and resolves what each file shows.
    fn sort_rows(&mut self) {
        let data = &self.data;
        columns::sort_folders(&mut self.state.folders, &self.state.sort);
        columns::sort_files(
            &mut self.state.files,
            &self.state.sort,
            &self.state.ratings,
            |f| f.bpm.or_else(|| data.detected_bpm.get(&f.path).copied()),
            |f| f.musical_key.clone().filter(|k| !k.is_empty()).or_else(|| data.detected_key.get(&f.path).cloned()),
        );
        self.state.file_meta = self.state.files.iter().map(|f| table::meta_for(f, &self.data)).collect();
    }

    /// Re-sorts in place, keeping the selection on the same rows.
    fn resort(&mut self) {
        let ids = |s: &State| -> Vec<String> {
            s.selection.iter().filter_map(|&i| match table::row_at(s, i) {
                Some(table::RowRef::Folder(f)) => Some(format!("dir:{}", f.path)),
                Some(table::RowRef::File(_, f)) => Some(f.path.clone()),
                None => None,
            }).collect()
        };
        let kept = ids(&self.state);
        self.sort_rows();
        let s = &self.state;
        let selection: BTreeSet<usize> = (0..table::row_count(s))
            .filter(|&i| match table::row_at(s, i) {
                Some(table::RowRef::Folder(f)) => kept.contains(&format!("dir:{}", f.path)),
                Some(table::RowRef::File(_, f)) => kept.contains(&f.path),
                None => false,
            })
            .collect();
        self.state.focus = selection.iter().next().copied();
        self.state.selection = selection;
    }

    /// One click selects; a click on the row that was already the sole selection opens it - a
    /// folder navigates in, a file plays - as does a double click. Ctrl toggles a row, Shift
    /// extends from the last one pressed.
    fn press_row(&mut self, index: usize, double: bool) {
        let ctrl = self.command_key();
        let shift = self.modifiers.shift_key();
        if shift {
            let anchor = self.state.focus.unwrap_or(index);
            let (from, to) = (anchor.min(index), anchor.max(index));
            if !ctrl {
                self.state.selection.clear();
            }
            self.state.selection.extend(from..=to);
            return;
        }
        if ctrl {
            if !self.state.selection.remove(&index) {
                self.state.selection.insert(index);
            }
            self.state.focus = Some(index);
            return;
        }
        let again = self.state.selection.len() == 1 && self.state.selection.contains(&index);
        self.state.selection = BTreeSet::from([index]);
        self.state.focus = Some(index);
        let is_file = matches!(table::row_at(&self.state, index), Some(table::RowRef::File(..)));
        if double || (self.data.settings.play_on_select && is_file && !again) {
            self.open_row(index);
        } else if again {
            self.pending_open = Some(index);
        }
    }

    fn open_row(&mut self, index: usize) {
        if let Some(table::RowRef::File(_, file)) = table::row_at(&self.state, index) {
            if self.state.gone.contains(&file.path) {
                self.notify("That file isn't there any more.");
                return;
            }
        }
        match table::row_at(&self.state, index) {
            Some(table::RowRef::Folder(folder)) => {
                let id = folder.id;
                self.open(id, true);
            }
            // What cannot be auditioned - a project, a PDF - goes to whatever Windows opens it
            // with, as the Electron table does: an .flp opens in FL Studio.
            Some(table::RowRef::File(at, _)) => match self.state.files.get(at) {
                Some(file) if !file.playable => ops::open_externally(std::path::Path::new(&file.path)),
                _ => self.play(at),
            },
            None => {}
        }
    }

    /// Where in the search text a click at the pointer lands, as a byte offset.
    fn caret_at_cursor(&mut self) -> usize {
        let Some(hit) = self.hits.iter().find(|h| h.action == Action::Search) else { return self.state.search.value.len() };
        let scale = self.scale() as f32;
        // The text starts past the border, `pl-7` and the magnifier: 28px in.
        let x = (self.cursor.x as f32 - hit.rect[0]) / scale - 28.0;
        let style = crate::ui::text::TextStyle { line_height: 16.0, ..screen::style(12.5, 400, self.theme.foreground) };
        let value = self.state.search.value.clone();
        let mut best = (0usize, f32::MAX);
        for (i, _) in value.char_indices().chain(std::iter::once((value.len(), ' '))) {
            let width = self.ui.text.width(&value[..i], &style);
            let distance = (width - x).abs();
            if distance < best.1 {
                best = (i, distance);
            }
        }
        best.0
    }

    /// Editing keys while the search box has the keyboard. True when the key was its.
    fn search_key(&mut self, event: &KeyEvent) -> bool {
        let before = self.state.search.value.clone();
        let (ctrl, shift, alt) = (self.command_key(), self.modifiers.shift_key(), self.modifiers.alt_key());
        match ops::edit_field(&mut self.state.search, event, ctrl, shift, alt) {
            // Escape empties the box and lets go of the keyboard, as `setQuery('')` and
            // `blur()` do.
            ops::Edit::Escape => self.state.search = screen::SearchBox::default(),
            ops::Edit::Enter => self.state.search.focused = false,
            ops::Edit::Ignored => return false,
            ops::Edit::Done => {}
        }
        if self.state.search.value != before {
            self.send_search();
        }
        true
    }

    /// Keys while something floats over the explorer: it has them all. True when one did.
    fn overlay_key(&mut self, event: &KeyEvent) -> bool {
        if self.state.prompt.is_some() {
            let (ctrl, shift, alt) = (self.command_key(), self.modifiers.shift_key(), self.modifiers.alt_key());
            let Some(prompt) = self.state.prompt.as_mut() else { return false };
            match ops::edit_field(&mut prompt.field, event, ctrl, shift, alt) {
                ops::Edit::Escape => self.state.prompt = None,
                ops::Edit::Enter => self.submit_prompt(),
                ops::Edit::Done => prompt.error = None,
                ops::Edit::Ignored => {}
            }
            return true;
        }
        if self.state.about.is_some() {
            if matches!(event.logical_key, Key::Named(NamedKey::Escape | NamedKey::Enter)) {
                self.state.about = None;
            }
            return true;
        }
        if self.state.dialog.is_some() {
            match &event.logical_key {
                Key::Named(NamedKey::Enter) => self.confirm_dialog(),
                Key::Named(NamedKey::Escape) => self.state.dialog = None,
                _ => {}
            }
            return true;
        }
        let Some(menu) = self.state.menu.as_mut() else { return false };
        let enabled = |item: &crate::overlay::MenuItem| matches!(item, crate::overlay::MenuItem::Item { enabled: true, .. } | crate::overlay::MenuItem::Sub { .. });
        match &event.logical_key {
            Key::Named(NamedKey::Escape) => self.close_overlays(),
            Key::Named(key @ (NamedKey::ArrowDown | NamedKey::ArrowUp)) => {
                let count = menu.items.len();
                let mut at = menu.hover.unwrap_or(if *key == NamedKey::ArrowDown { count - 1 } else { 0 });
                for _ in 0..count {
                    at = if *key == NamedKey::ArrowDown { (at + 1) % count } else { (at + count - 1) % count };
                    if enabled(&menu.items[at]) {
                        break;
                    }
                }
                menu.hover = Some(at);
            }
            Key::Named(NamedKey::ArrowRight) => {
                if let Some(at) = menu.hover {
                    self.open_sub(at);
                }
            }
            Key::Named(NamedKey::Enter) => {
                if let Some(at) = menu.hover {
                    self.press_menu(at);
                }
            }
            _ => {}
        }
        true
    }

    fn press_menu(&mut self, index: usize) {
        let item = self.state.menu.as_ref().and_then(|m| m.items.get(index).cloned());
        match item {
            Some(crate::overlay::MenuItem::Item { enabled: true, cmd, .. }) => self.run(cmd),
            Some(crate::overlay::MenuItem::Sub { .. }) => self.open_sub(index),
            _ => {}
        }
    }

    /// Puts `query` in the search box and runs it - for shots.
    pub fn type_search(&mut self, query: &str) {
        self.state.search.value = query.to_string();
        self.state.search.caret = query.len();
        self.state.search.anchor = query.len();
        self.send_search();
    }

    /// The level as set and as muted, on the output - and saved.
    fn apply_level(&mut self) {
        let t = &self.state.transport;
        let level = if t.muted || std::env::var("UMAKBANG_MUTE").is_ok() { 0.0 } else { t.volume };
        if let Some(player) = &self.player {
            player.set_volume(level);
        }
    }

    fn apply_speed(&mut self) {
        let bpm = self.state.now.as_ref().and_then(|n| n.file.bpm);
        if let Some(player) = &self.player {
            player.set_speed(rate_for(bpm, self.state.transport.varispeed) as f32);
        }
    }

    /// The slider's value from the pointer's height on it: the top is full.
    fn volume_from_cursor(&mut self) {
        let Some(hit) = self.hits.iter().find(|h| h.action == Action::VolumeSlider) else { return };
        let scale = self.scale() as f32;
        let (top, bottom) = (hit.rect[1] + 8.0 * scale, hit.rect[3] - 8.0 * scale);
        let level = ((bottom - self.cursor.y as f32) / (bottom - top)).clamp(0.0, 1.0);
        let t = &mut self.state.transport;
        t.volume = (level * 100.0).round() / 100.0;
        // Anything above zero also lifts a mute.
        if t.volume > 0.0 {
            t.muted = false;
        }
        self.apply_level();
    }

    /// What the Settings page shows, from the settings as they are now.
    fn refresh_settings_values(&mut self) {
        let s = &self.data.settings;
        self.state.settings_values = crate::settings_page::Values {
            headroom_db: self.state.visuals.borrow().headroom,
            waveform_tint: s.waveform_tint.clone().unwrap_or_else(|| "spectrum".into()),
            auto_advance: s.auto_advance,
            play_on_select: s.play_on_select,
            audition_on_arrow: s.audition_on_arrow,
            queue_from_view: s.queue_source.as_deref() == Some("view"),
            random_skip_rated: s.random_skip_rated,
            random_favour_unrated: s.random_favour_unrated,
            always_on_top: s.always_on_top,
            show_stats: s.show_stats.unwrap_or(true),
            system_file_icons: s.system_file_icons.unwrap_or(true),
            undo_depth: s.undo_depth.unwrap_or(25).to_string(),
            bindings: crate::keys::SHORTCUTS
                .iter()
                .map(|(id, label, hint, default)| {
                    let key = crate::keys::shortcut_key(&s.shortcuts, id);
                    (*id, *label, *hint, crate::keys::shortcut_label(key), !key.eq_ignore_ascii_case(default))
                })
                .collect(),
            capturing: self.capturing,
            refused: self.shortcut_refused.clone(),
            visualizer_only: self.state.stage,
            no_library: s.roots.is_empty(),
            developer_mode: s.developer_mode,
            reset_on_launch: s.reset_on_launch,
            output: self.output_name(),
            output_missing: self.output_name().is_some_and(|name| !self.output_devices.get_or_insert_with(crate::player::Player::devices).contains(&name)),
            changelog_open: self.changelog_open,
            share_library: s.share_library.unwrap_or(true),
            run_in_background: s.run_in_background.unwrap_or(true),
            remote_download_dir: s.remote_download_dir.clone(),
            server: self.remote.as_ref().and_then(|r| r.state.lock().ok().map(|s| s.clone())),
            server_stats: self.remote.as_ref().and_then(|r| r.stats.lock().ok().map(|s| s.clone())),
            bundle_dir: s.bundle_export_dir.clone().filter(|d| !d.is_empty() && !crate::backup::in_app_bundle(std::path::Path::new(d))),
            bundle_busy: self.bundle_busy,
            syncing: self.syncing,
            sync_note: self.sync_note.clone(),
            mounted_ids: s.roots.iter().filter_map(|r| Some((r.remote.as_ref()?.get("deviceId")?.as_str()?.to_string(), r.path.clone()))).collect(),
            mounted: s.roots.iter().filter(|r| !r.is_local()).map(|r| (r.label.clone(), r.remote.as_ref().and_then(|v| v.get("deviceName")).and_then(|v| v.as_str()).unwrap_or("").to_string(), r.path.clone())).collect(),
            peers: self.peers.clone(),
            peers_busy: self.peers_busy,
            plugins: self.plugin_summary.clone(),
            compared: self.compared.clone(),
            accent_hex: s.theme_primary.clone().unwrap_or_else(|| crate::theme::rgb_to_hex((self.theme.primary.r as f64, self.theme.primary.g as f64, self.theme.primary.b as f64))),
            background_hex: s.theme_background.clone().unwrap_or_else(|| crate::theme::rgb_to_hex((self.theme.background.r as f64, self.theme.background.g as f64, self.theme.background.b as f64))),
            accent_set: s.theme_primary.is_some(),
            background_set: s.theme_background.is_some(),
            stops: self.current_stops(),
            stops_set: !s.visualizer_stops.is_empty(),
            analysis_tag: s.analysis_tag.clone(),
            detect_key: s.detect_key_from_audio.unwrap_or(true),
            key_engine: s.key_engine.clone().unwrap_or_else(|| "essentia".into()),
            key_profile: s.key_profile.clone().unwrap_or_else(|| "krumhansl".into()),
            concurrency: s.analysis_concurrency.unwrap_or(2).to_string(),
            key_test: self.key_test.clone(),
            key_testing: self.key_testing,
            folder_tags: self.folder_tags(),
            undo_held: self.undo_history.depth(),
            yt_status: match &self.state.youtube.tool {
                None => "Checking…".into(),
                Some(Ok(version)) => format!("yt-dlp {version}"),
                Some(Err(_)) => "Not installed yet.".into(),
            },
            yt_button: if self.state.youtube.installing.is_some() { "Working…".into() } else if self.state.youtube.ready() { "Update now".into() } else { "Install".into() },
            yt_error: match &self.state.youtube.tool {
                Some(Err(Some(e))) => Some(e.clone()),
                _ => None,
            },
            yt_format: self.state.youtube_settings.0.clone(),
            yt_bitrate: self.state.youtube_settings.1.to_string(),
            yt_dir: s.youtube_dir.clone().filter(|d| !d.is_empty()),
            roots: s.roots.iter().map(|r| (r.label.clone(), r.path.clone())).collect(),
            excluded: s.random_exclude_dirs.clone(),
            quick: s.quick_move.iter().map(|q| (q.label.clone(), q.path.clone())).collect(),
            details: {
                let listed = |id: &str| if s.player_details.is_empty() { ["bpm", "key", "format", "channels"].contains(&id) } else { s.player_details.iter().any(|f| f == id) };
                DETAIL_FIELDS.iter().map(|(id, label, example)| (*id, *label, example.to_string(), listed(id))).collect()
            },
            // The preview is a sample track printed through the fields as they are switched on.
            preview: {
                let listed: Vec<&str> = if s.player_details.is_empty() { vec!["bpm", "key", "format", "channels"] } else { s.player_details.iter().map(String::as_str).collect() };
                let sample = |id: &str| match id {
                    "bpm" => Some("128 BPM"),
                    "key" => Some("F#m"),
                    "format" => Some("44.1k · 24"),
                    "channels" => Some("stereo"),
                    "duration" => Some("3:24"),
                    "size" => Some("40.4 MB"),
                    "modified" => Some("Feb 07, 2024 04:00 AM"),
                    "extension" => Some("WAV"),
                    "folder" => Some("…/Beats/2024"),
                    _ => None,
                };
                let mut line = listed.iter().filter_map(|id| sample(id)).collect::<Vec<_>>().join(" · ");
                if line.is_empty() {
                    line = "Nothing listed".into();
                }
                ("midnight drive.wav".into(), line, listed.contains(&"projectTime"))
            },
        };
    }

    /// A settings switch flipped, applied, and saved.
    fn run_setting_switch(&mut self, key: &'static str) {
        match key {
            "visualizerOnly" => {
                let on = !self.state.stage;
                self.set_stage(on);
                self.refresh_settings_values();
                return;
            }
            "shareLibrary" => {
                let on = !self.data.settings.share_library.unwrap_or(true);
                self.data.settings.share_library = Some(on);
                self.write_setting("shareLibrary", serde_json::Value::Bool(on));
                self.configure_server();
                self.refresh_settings_values();
                return;
            }
            "runInBackground" => {
                let on = !self.data.settings.run_in_background.unwrap_or(true);
                self.set_run_in_background(on);
                return;
            }
            "developerMode" => {
                let on = !self.data.settings.developer_mode;
                self.data.settings.developer_mode = on;
                self.write_setting("developerMode", serde_json::Value::Bool(on));
                // The reset goes off with it: armed behind a shut gate is a wipe nobody can see.
                if !on {
                    self.data.settings.reset_on_launch = false;
                    self.write_setting("resetOnLaunch", serde_json::Value::Bool(false));
                }
                self.refresh_settings_values();
                return;
            }
            "resetOnLaunch" => {
                let on = !self.data.settings.reset_on_launch;
                self.data.settings.reset_on_launch = on;
                self.write_setting("resetOnLaunch", serde_json::Value::Bool(on));
                self.refresh_settings_values();
                return;
            }
            _ => {}
        }
        let s = &mut self.data.settings;
        let value = match key {
            "autoAdvance" => { s.auto_advance = !s.auto_advance; s.auto_advance }
            "playOnSelect" => { s.play_on_select = !s.play_on_select; s.play_on_select }
            "auditionOnArrow" => { s.audition_on_arrow = !s.audition_on_arrow; s.audition_on_arrow }
            "randomSkipRated" => { s.random_skip_rated = !s.random_skip_rated; s.random_skip_rated }
            "randomFavourUnrated" => { s.random_favour_unrated = !s.random_favour_unrated; s.random_favour_unrated }
            field if DETAIL_FIELDS.iter().any(|(id, ..)| *id == field) => {
                // An empty list means the defaults, so the first change writes them out whole.
                let mut fields: Vec<String> = if s.player_details.is_empty() { ["bpm", "key", "format", "channels"].iter().map(|f| f.to_string()).collect() } else { s.player_details.clone() };
                match fields.iter().position(|f| f == field) {
                    Some(at) => {
                        fields.remove(at);
                    }
                    // In the order the list has them, not the order they were switched on.
                    None => {
                        fields.push(field.to_string());
                        fields.sort_by_key(|f| DETAIL_FIELDS.iter().position(|(id, ..)| id == f));
                    }
                }
                s.player_details = fields.clone();
                self.write_setting("playerDetails", serde_json::Value::from(fields));
                if let Some(now) = self.state.now.as_ref().map(|n| n.file.clone()) {
                    let details = self.details(&now);
                    if let Some(playing) = self.state.now.as_mut() {
                        playing.details = details;
                    }
                }
                self.refresh_settings_values();
                return;
            }
            "detectKeyFromAudio" => {
                let on = !s.detect_key_from_audio.unwrap_or(true);
                s.detect_key_from_audio = Some(on);
                self.analysis_wanted.clear();
                on
            }
            "showStats" => {
                let on = !s.show_stats.unwrap_or(true);
                s.show_stats = Some(on);
                self.state.show_stats = on;
                if !on {
                    self.stat_rows = None;
                    self.state.stats.figures = None;
                }
                on
            }
            "systemFileIcons" => {
                let on = !s.system_file_icons.unwrap_or(true);
                s.system_file_icons = Some(on);
                // Every type is looked up again the next time rows are resolved.
                self.state.file_icons.clear();
                on
            }
            "alwaysOnTop" => {
                s.always_on_top = !s.always_on_top;
                let on = s.always_on_top;
                if let Some(window) = &self.window {
                    window.set_window_level(if on { winit::window::WindowLevel::AlwaysOnTop } else { winit::window::WindowLevel::Normal });
                }
                on
            }
            _ => return,
        };
        self.state.play_on_select = self.data.settings.play_on_select;
        self.state.auto_advance = self.data.settings.auto_advance;
        if key == "systemFileIcons" {
            self.resolve_rows();
        }
        self.write_setting(key, serde_json::Value::from(value));
        self.refresh_settings_values();
    }

    /// A settings slider's value from the pointer's place along it.
    fn setting_from_cursor(&mut self, key: &'static str) {
        let Some(hit) = self.hits.iter().find(|h| h.action == Action::SettingSlider(key)) else { return };
        let fraction = ((self.cursor.x as f32 - hit.rect[0]) / (hit.rect[2] - hit.rect[0])).clamp(0.0, 1.0);
        if key == "visualizerHeadroomDb" {
            let db = (fraction * 18.0).round();
            self.state.visuals.borrow_mut().headroom = db;
            self.write_setting(key, serde_json::Value::from(db));
        }
        self.refresh_settings_values();
    }

    /// Up a level; from a library folder, to the Library above them all.
    fn up(&mut self) {
        if self.state.view != View::Folder {
            return;
        }
        match self.state.folder.parent {
            Some(parent) => self.open(parent, true),
            None if self.state.folder.id != crate::library::LIBRARY => self.open(crate::library::LIBRARY, true),
            None => {}
        }
    }

    fn toggle_tree(&mut self, id: i64) {
        if !self.tree_open.remove(&id) {
            self.tree_open.insert(id);
        }
        self.rebuild_tree();
    }

    /// The tree's rows, depth first through whatever is open, siblings alphabetical as
    /// `buildTree` holds them.
    fn rebuild_tree(&mut self) {
        self.state.no_library = self.data.settings.roots.is_empty();
        fn walk(app: &App, id: i64, depth: usize, out: &mut Vec<screen::TreeRow>) {
            let mut children = app.library.children(Some(id));
            children.sort_by(|a, b| columns::collate(&a.name, &b.name));
            for child in children {
                let open = app.tree_open.contains(&child.id);
                out.push(screen::TreeRow { id: child.id, name: child.name.clone(), depth, files: child.files, has_children: child.has_children, open });
                if open && child.has_children {
                    walk(app, child.id, depth + 1, out);
                }
            }
        }
        let root = self.library.library_root();
        let open = self.tree_open.contains(&root.id);
        let mut rows = vec![screen::TreeRow { id: root.id, name: String::new(), depth: 0, files: root.files, has_children: true, open }];
        if open {
            walk(self, root.id, 1, &mut rows);
        }
        self.state.tree = rows;
    }

    /// `revealPlayingFolder`: opens the tree down to the playing track's folder, browses it,
    /// and selects the track.
    fn locate(&mut self, path: &str) {
        let Some(folder) = self.library.folder_of(path) else { return };
        for ancestor in self.library.ancestry(folder) {
            self.tree_open.insert(ancestor.id);
        }
        self.tree_open.insert(crate::library::LIBRARY);
        self.open(folder, true);
        self.rebuild_tree();
        let index = self.state.files.iter().position(|f| f.path == path).map(|at| at + self.state.folders.len());
        if let Some(index) = index {
            self.move_focus(index);
        }
        if let Some(row) = self.state.tree.iter().position(|r| r.id == folder) {
            // Scrolled so the folder's row is in view, a few rows down from the top.
            self.state.tree_scroll = ((row as f32 - 3.0) * 24.0).max(0.0);
        }
    }

    /// Sets the rating of `paths` - 0 clears it - in the window and in the document.
    fn rate(&mut self, paths: &[String], stars: u8) {
        for path in paths {
            if stars == 0 {
                self.state.ratings.remove(path);
                self.data.ratings.remove(path);
            } else {
                self.state.ratings.insert(path.clone(), stars);
                self.data.ratings.insert(path.clone(), stars);
            }
            if let Some(doc) = self.doc.as_mut() {
                doc.set("ratings", path, (stars > 0).then(|| serde_json::Value::from(stars)));
            }
            self.note_annotated(path);
            if let Ok(mut shared) = self.search_shared.write() {
                if stars == 0 {
                    shared.ratings.remove(path);
                } else {
                    shared.ratings.insert(path.clone(), stars);
                }
            }
        }
        self.state.stars = self.data.star_counts();
        let rated: Vec<String> = self.data.ratings.keys().cloned().collect();
        self.state.rated_share = self.library.rated_share(&rated, &self.data.settings.random_exclude_dirs);
        if let View::Rated(..) = self.state.view {
            let (view, scroll) = (self.state.view, self.state.scroll);
            self.show_view(view);
            self.state.scroll = scroll;
        } else if self.state.sort.key == "rating" {
            self.resort();
        }
    }

    fn write_setting(&mut self, key: &str, value: serde_json::Value) {
        if let Some(doc) = self.doc.as_mut() {
            doc.set("settings", key, Some(value));
            // Every change is stamped, as `updateSettings` does: the stamp is how two machines
            // tell which of them changed its settings last.
            doc.set("settings", "settingsUpdatedAt", Some(serde_json::Value::from(crate::localtime::now().floor())));
        }
    }

    fn save_columns(&mut self) {
        if let Ok(value) = serde_json::to_value(columns::to_saved(&self.state.columns)) {
            self.write_setting("columns", value);
        }
    }

    /// Moves the keyboard focus to `index`, selecting it (or extending to it with Shift), and
    /// scrolls it into view.
    fn move_focus(&mut self, index: usize) {
        let total = table::row_count(&self.state);
        if total == 0 {
            return;
        }
        let index = index.min(total - 1);
        if self.modifiers.shift_key() {
            let anchor = self.state.focus.unwrap_or(index);
            self.state.selection.insert(anchor);
            self.state.selection.insert(index);
            let (from, to) = (anchor.min(index), anchor.max(index));
            self.state.selection.extend(from..=to);
        } else {
            self.state.selection = BTreeSet::from([index]);
        }
        self.state.focus = Some(index);
        if self.data.settings.audition_on_arrow && !self.modifiers.shift_key() {
            if let Some(table::RowRef::File(at, file)) = table::row_at(&self.state, index) {
                if file.playable {
                    self.play(at);
                }
            }
        }
        let body = table::body_height(self.logical_size().1, self.state.sizes.player);
        let top = index as f32 * table::ROW;
        if top < self.state.scroll {
            self.state.scroll = top;
        } else if top + table::ROW > self.state.scroll + body {
            self.state.scroll = (top + table::ROW - body).max(0.0);
        }
    }

    /// The table's keys: arrows, Home/End, PageUp/PageDown, Enter, Backspace for up, 0-5 to
    /// rate, Ctrl+A, Escape. True when the key was the table's.
    fn table_key(&mut self, key: &Key) -> bool {
        let body = table::body_height(self.logical_size().1, self.state.sizes.player);
        let page = ((body / table::ROW).floor() as usize).max(1);
        let total = table::row_count(&self.state);
        let focus = self.state.focus;
        match key {
            Key::Named(NamedKey::ArrowDown) => self.move_focus(focus.map_or(0, |f| f + 1)),
            Key::Named(NamedKey::ArrowUp) => self.move_focus(focus.map_or(0, |f| f.saturating_sub(1))),
            Key::Named(NamedKey::Home) => self.move_focus(0),
            Key::Named(NamedKey::End) => self.move_focus(total.saturating_sub(1)),
            Key::Named(NamedKey::PageDown) => self.move_focus(focus.map_or(0, |f| f + page)),
            Key::Named(NamedKey::PageUp) => self.move_focus(focus.map_or(0, |f| f.saturating_sub(page))),
            Key::Named(NamedKey::Enter) => {
                if let Some(focus) = focus {
                    self.open_row(focus);
                }
            }
            Key::Named(NamedKey::Backspace) => self.up(),
            Key::Named(NamedKey::Escape) => {
                // Escape leaves Settings, as everything modal-shaped answers to it.
                if self.state.view.is_page() {
                    let id = self.state.folder.id;
                    self.open(id, false);
                } else {
                    self.state.selection.clear();
                }
            }
            Key::Character(c) if c.as_str() == "a" && self.command_key() => {
                self.state.selection = (0..total).collect();
            }
            Key::Character(c) if !self.command_key() && c.len() == 1 && ("0".."6").contains(&c.as_str()) => {
                let stars: u8 = c.parse().unwrap_or(0);
                let paths: Vec<String> = self
                    .state
                    .selection
                    .iter()
                    .filter_map(|&i| match table::row_at(&self.state, i) {
                        Some(table::RowRef::File(_, f)) => Some(f.path.clone()),
                        _ => None,
                    })
                    .collect();
                if paths.is_empty() {
                    return false;
                }
                self.rate(&paths, stars);
            }
            _ => return false,
        }
        true
    }

    /// `setSort`: a header click, or the type menu's Sort by type. Inside a folder the sort is
    /// that folder's alone; the saved views share the global one.
    pub(super) fn act_sort(&mut self, key: &str) {
        let sort = self.state.sort.clicked(key);
        if self.state.view == View::Folder {
            let path = self.state.folder.path.clone();
            self.data.settings.folder_sort.insert(path, sort.clone());
            if let Ok(value) = serde_json::to_value(&self.data.settings.folder_sort) {
                self.write_setting("folderSort", value);
            }
        } else {
            self.data.settings.sort_key = Some(sort.key.clone());
            self.data.settings.sort_dir = Some(sort.dir.clone());
            self.write_setting("sortKey", serde_json::Value::from(sort.key.clone()));
            self.write_setting("sortDir", serde_json::Value::from(sort.dir.clone()));
        }
        self.state.sort = sort;
        if self.state.recursive && self.state.view == View::Folder {
            // A flat list is the search thread's to order, over the whole subtree.
            self.send_search();
        } else {
            self.resort();
        }
    }

    /// The window's size in logical pixels.
    fn logical_size(&self) -> (f32, f32) {
        let Some(window) = &self.window else { return (1360.0, 860.0) };
        let size = window.inner_size();
        let scale = window.scale_factor() as f32;
        (size.width as f32 / scale, size.height as f32 / scale)
    }

    /// The pointer's logical coordinate along the axis `handle` moves on.
    fn pointer_along(&self, handle: Handle) -> f32 {
        let scale = self.window.as_ref().map(|w| w.scale_factor()).unwrap_or(1.0);
        (if handle.horizontal() { self.cursor.x } else { self.cursor.y } / scale) as f32
    }

    /// Waiting with nothing animating: until the next document write or the notice's end, or
    /// for input.
    fn idle_wait(&self) -> ControlFlow {
        match self.doc.as_ref().and_then(DocStore::due).into_iter().chain(self.notice_until).chain(self.reread_at).chain(self.annotation_check_at).chain(self.volume_close_at).chain(self.probe_at).chain(self.spin_at).chain(self.preview_at).min() {
            Some(due) => ControlFlow::WaitUntil(due),
            None => ControlFlow::Wait,
        }
    }

    pub fn flush_doc(&mut self) {
        if let Some(doc) = self.doc.as_mut() {
            doc.flush(true);
        }
    }

    /// Persisted on release only, as the Electron handles write settings once per drag.
    fn save_layout(&self) {
        if let Some(path) = &self.layout_path {
            self.layout.save(path);
        }
    }

    /// Which window edge the pointer is on, if any. A maximised window has none.
    /// The shortcut modifier: Ctrl on Windows, ⌘ on a Mac (where Ctrl-click is a right click).
    pub(crate) fn command_key(&self) -> bool {
        if cfg!(target_os = "macos") { self.modifiers.super_key() } else { self.modifiers.control_key() }
    }

    fn edge(&self) -> Option<ResizeDirection> {
        // A Mac window keeps its system frame, which resizes from its own edges.
        if cfg!(target_os = "macos") {
            return None;
        }
        let window = self.window.as_ref()?;
        if window.is_maximized() {
            return None;
        }
        let size = window.inner_size();
        let band = EDGE * window.scale_factor();
        let (x, y) = (self.cursor.x, self.cursor.y);
        let (left, right) = (x < band, x >= size.width as f64 - band);
        let (top, bottom) = (y < band, y >= size.height as f64 - band);
        Some(match (left, right, top, bottom) {
            (true, _, true, _) => ResizeDirection::NorthWest,
            (_, true, true, _) => ResizeDirection::NorthEast,
            (true, _, _, true) => ResizeDirection::SouthWest,
            (_, true, _, true) => ResizeDirection::SouthEast,
            (true, ..) => ResizeDirection::West,
            (_, true, ..) => ResizeDirection::East,
            (_, _, true, _) => ResizeDirection::North,
            (_, _, _, true) => ResizeDirection::South,
            _ => return None,
        })
    }

    /// What the pointer is over, and what lights as a result: a pane handle, a column
    /// boundary, the row (`group-hover`) and the star under it.
    fn refresh_hover(&mut self) {
        // Over a window edge nothing under it is hovered: a press there resizes.
        let hovered = if self.edge().is_some() { None } else { self.hit() };
        let (x, y) = (self.cursor.x as f32, self.cursor.y as f32);
        let row = if hovered.is_none() {
            None
        } else {
            self.hits.iter().rev().find_map(|h| match h.action {
                Action::Row(i) if x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3] => Some(i),
                _ => None,
            })
        };
        let star = match (&hovered, row) {
            (Some(Action::Rate(_, n)), Some(row)) => Some((row, *n)),
            _ => None,
        };
        let over_volume = matches!(hovered, Some(Action::Volume | Action::VolumeSlider | Action::VolumePanel));
        if over_volume {
            self.volume_close_at = None;
            if !self.state.transport.volume_open {
                self.state.transport.volume_open = true;
                self.redraw();
            }
        } else if self.state.transport.volume_open && self.volume_close_at.is_none() && !matches!(self.resizing, Some(Drag::Volume)) {
            self.volume_close_at = Some(Instant::now() + Duration::from_millis(200));
        }
        if hovered != self.hovered {
            match hovered {
                Some(Action::MenuItem(index)) => {
                    let is_sub = self.state.menu.as_ref().is_some_and(|m| matches!(m.items.get(index), Some(crate::overlay::MenuItem::Sub { .. })));
                    if let Some(menu) = self.state.menu.as_mut() {
                        menu.hover = Some(index);
                        if !is_sub {
                            menu.sub = None;
                        }
                    }
                    if is_sub {
                        self.open_sub(index);
                    }
                }
                Some(Action::SubItem(index)) => self.state.sub_hover = Some(index),
                _ => {
                    if let Some(menu) = self.state.menu.as_mut() {
                        if menu.sub.is_none() {
                            menu.hover = None;
                        }
                    }
                    self.state.sub_hover = None;
                }
            }
        }
        // A chart on the Stats page: which bar or cell is under the pointer, for its tooltip.
        let chart = match hovered {
            Some(Action::Chart(id)) => {
                let scale = self.window.as_ref().map(|w| w.scale_factor() as f32).unwrap_or(1.0);
                let geom = self.state.stats.geoms.borrow().get(&id).copied();
                self.hits
                    .iter()
                    .rev()
                    .find(|h| h.action == Action::Chart(id) && x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3])
                    .zip(geom)
                    .and_then(|(h, g)| g.index_at((x - h.origin[0]) / scale, (y - h.origin[1]) / scale))
                    .map(|i| (id, i))
            }
            _ => None,
        };
        if chart != self.state.stats.hover {
            self.state.stats.hover = chart;
            self.redraw();
        }
        if hovered != self.hovered || row != self.state.hover_row || star != self.state.hover_star {
            self.state.hot = match hovered {
                Some(Action::Resize(handle)) => Some(handle),
                _ => None,
            };
            if !matches!(self.resizing, Some(Drag::Column(..))) {
                self.state.column_hot = match hovered {
                    Some(Action::ColumnResize(id)) => Some(id),
                    _ => None,
                };
            }
            if self.over_inactive() {
                self.state.hover_row = None;
                self.state.hover_star = None;
                if let Some(p) = self.parked.as_mut() {
                    p.hover_row = row;
                    p.hover_star = star;
                }
            } else {
                self.state.hover_row = row;
                self.state.hover_star = star;
                if let Some(p) = self.parked.as_mut() {
                    p.hover_row = None;
                    p.hover_star = None;
                }
            }
            self.hovered = hovered;
            self.redraw();
        }
        self.update_cursor();
    }

    /// The pointer's shape: a resize arrow over a window edge or a pane handle.
    fn update_cursor(&mut self) {
        let handle = match self.resizing {
            Some(Drag::Pane(h, ..)) => Some(h),
            Some(Drag::Column(..)) => Some(Handle::Sidebar),
            Some(Drag::Volume) | Some(Drag::Setting(_)) | Some(Drag::Picker(_)) | Some(Drag::PaneSplit) => None,
            None => self.state.hot.or(self.state.column_hot.map(|_| Handle::Sidebar)),
        };
        let icon = match (self.resizing.is_none().then(|| self.edge()).flatten(), handle) {
            (Some(ResizeDirection::NorthWest | ResizeDirection::SouthEast), _) => CursorIcon::NwseResize,
            (Some(ResizeDirection::NorthEast | ResizeDirection::SouthWest), _) => CursorIcon::NeswResize,
            (Some(ResizeDirection::East | ResizeDirection::West), _) => CursorIcon::EwResize,
            (Some(_), _) => CursorIcon::NsResize,
            (None, Some(h)) if h.horizontal() => CursorIcon::ColResize,
            (None, Some(_)) => CursorIcon::RowResize,
            (None, None) => CursorIcon::Default,
        };
        if icon != self.cursor_icon {
            self.cursor_icon = icon;
            if let Some(window) = &self.window {
                window.set_cursor(icon);
            }
        }
    }

    /// `formatDetails` over the fields the user chose for the transport's second line.
    fn details(&self, file: &FileRow) -> String {
        let fields: Vec<&str> = if self.data.settings.player_details.is_empty() {
            vec!["bpm", "key", "format", "channels"]
        } else {
            self.data.settings.player_details.iter().map(String::as_str).collect()
        };
        let detected_key = self.data.detected_key.get(&file.path);
        fields
            .iter()
            .filter_map(|field| match *field {
                "bpm" => file.bpm.or_else(|| self.data.detected_bpm.get(&file.path).copied()).map(|b| format!("{} BPM", b.round())),
                "key" => {
                    let key = file.musical_key.clone().or_else(|| detected_key.cloned())?;
                    // A guessed key is shown as its relative pair; a declared one as written.
                    Some(if detected_key.is_some() { crate::keys::relative_pair(&key) } else { key })
                }
                // `formatFormat`: "48k · 24" for PCM, "44.1k · 320k" for compressed.
                "format" => {
                    let rate = file.sample_rate.map(|rate| {
                        if rate >= 1000 {
                            if rate % 1000 == 0 { format!("{}k", rate / 1000) } else { format!("{:.1}k", rate as f64 / 1000.0) }
                        } else {
                            rate.to_string()
                        }
                    });
                    match (rate, file.bit_depth, file.bitrate) {
                        (Some(rate), Some(depth), _) => Some(format!("{rate} · {depth}")),
                        (Some(rate), None, Some(bitrate)) => Some(format!("{rate} · {}k", (bitrate as f64 / 1000.0).round())),
                        (Some(rate), None, None) => Some(rate),
                        (None, _, Some(bitrate)) => Some(format!("{}k", (bitrate as f64 / 1000.0).round())),
                        _ => None,
                    }
                }
                // `formatChannels`.
                "channels" => file.channels.map(|c| match c {
                    1 => "mono".to_string(),
                    2 => "stereo".to_string(),
                    n => format!("{n}ch"),
                }),
                "duration" => file.duration.map(format_precise),
                "size" => Some(format_size(file.size)),
                "modified" => crate::localtime::date_time(file.mtime),
                "extension" => (!file.ext.is_empty()).then(|| file.ext.to_uppercase()),
                "folder" => Some(if file.dir.is_empty() {
                    "Library root".to_string()
                } else {
                    let parts: Vec<&str> = file.dir.split('/').collect();
                    if parts.len() <= 2 { file.dir.clone() } else { format!("…/{}", parts[parts.len() - 2..].join("/")) }
                }),
                _ => None,
            })
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }

    fn redraw(&mut self) {
        self.full = true;
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }

    fn present(&mut self) {
        let Some(window) = self.window.clone() else { return };
        let size = window.inner_size();
        let (w, h) = (size.width.max(1), size.height.max(1));
        let scale = window.scale_factor() as f32;
        let started = Instant::now();
        if let Some(phase) = self.pending.take() {
            self.advance(phase);
        }
        let advanced = started.elapsed();
        let live = !self.full && self.draw_live(w, h, scale);
        if !live {
            self.draw(w, h, scale);
        }
        self.full = false;
        let (Some(screen), Some(frame)) = (self.screen.as_mut(), self.frame.as_ref()) else { return };
        screen.present(frame, live.then_some(&self.ui.damage[..]));
        if self.timing {
            eprintln!("present: advance {:.2}ms, total {:.2}ms", advanced.as_secs_f64() * 1000.0, started.elapsed().as_secs_f64() * 1000.0);
        }
    }
}

/// CSS `cubic-bezier(x1, y1, x2, y2)` at progress `x`: the curve's y where its x is `x`.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    let at = |a: f32, b: f32, t: f32| 3.0 * a * t * (1.0 - t).powi(2) + 3.0 * b * t * t * (1.0 - t) + t.powi(3);
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if at(x1, x2, mid) < x { lo = mid } else { hi = mid }
    }
    at(y1, y2, (lo + hi) / 2.0)
}

fn format_precise(seconds: f64) -> String {
    if seconds < 10.0 {
        return format!("{seconds:.2}s");
    }
    let total = seconds.floor() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// `formatSize`.
fn format_size(bytes: i64) -> String {
    if bytes < 0 {
        return "—".into();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 100.0 { format!("{} {}", value.round(), units[unit]) } else { format!("{value:.1} {}", units[unit]) }
}

impl ApplicationHandler<Wake> for App {
    /// Quitting from the Mac's app menu or Dock (Cmd+Q) ends the process through AppKit, which
    /// winit reports here and nowhere else; what has not been written yet is written now.
    #[cfg(target_os = "macos")]
    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        self.flush_doc();
    }

    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attributes = Window::default_attributes()
            .with_title("umakbang")
            .with_inner_size(LogicalSize::new(1360.0, 860.0))
            .with_min_inner_size(LogicalSize::new(900.0, 560.0))
            // The title bar is ours, as it is in the Electron app; the OS keeps the resize edges.
            .with_decorations(cfg!(target_os = "macos"))
            .with_visible(!self.start_hidden);
        // On a Mac the title bar is still ours, but drawn under a transparent system one, so the
        // traffic lights, the rounded corners and the shadow are the system's own (Electron's
        // `titleBarStyle: 'hidden'`).
        #[cfg(target_os = "macos")]
        let attributes = {
            use winit::platform::macos::WindowAttributesExtMacOS;
            attributes.with_titlebar_transparent(true).with_fullsize_content_view(true).with_title_hidden(true)
        };
        let window = Rc::new(event_loop.create_window(attributes).expect("window"));
        {
            use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
            if let Ok(RawWindowHandle::Win32(h)) = window.window_handle().map(|h| h.as_raw()) {
                crate::tray::set_window_icon(h.hwnd.get());
            }
        }
        self.window_open.store(!self.start_hidden, std::sync::atomic::Ordering::Relaxed);
        if self.data.settings.always_on_top {
            window.set_window_level(winit::window::WindowLevel::AlwaysOnTop);
        }
        self.screen = Some(crate::present::Screen::new(window.clone()));
        self.window = Some(window);
        self.sync_background(false);
        #[cfg(target_os = "macos")]
        {
            if let Some(proxy) = self.proxy.clone() {
                let proxy = std::sync::Mutex::new(proxy);
                crate::tray::intercept_quit(move || {
                    if let Ok(proxy) = proxy.lock() {
                        let _ = proxy.send_event(Wake::QuitKey);
                    }
                });
            }
            // A login launch is the menu bar item alone until the window is asked for.
            if self.start_hidden && self.tray.is_some() {
                crate::tray::set_in_dock(false);
            }
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Wake) {
        match event {
            Wake::Show => self.show_window(),
            #[cfg(target_os = "macos")]
            Wake::QuitKey => self.close_window(event_loop),
            Wake::Tray(crate::tray::Event::Open) => self.show_window(),
            Wake::Tray(crate::tray::Event::RestartToUpdate) => self.restart_to_update(event_loop),
            Wake::Updates => {
                if let crate::updater::Status::Ready(version) = crate::updater::status() {
                    // `UMAKBANG_UPDATE_APPLY`: a test restarts into it at once.
                    if std::env::var("UMAKBANG_UPDATE_APPLY").is_ok() {
                        self.restart_to_update(event_loop);
                        return;
                    }
                    if self.announced_update.as_deref() != Some(version.as_str()) {
                        self.announced_update = Some(version.clone());
                        self.notify(format!("umakbang {version} is ready. Restart from the tray icon or Settings → Updates to install it."));
                    }
                }
                if self.state.view == View::Settings {
                    self.refresh_settings_values();
                }
                self.redraw();
            }
            Wake::Tray(crate::tray::Event::Quit) => {
                self.flush_doc();
                event_loop.exit();
            }
            Wake::Tray(crate::tray::Event::BackgroundOff) => {
                self.set_run_in_background(false);
                // With no window, off means gone: nothing else would be left on screen.
                if !self.window_open.load(std::sync::atomic::Ordering::Relaxed) {
                    self.flush_doc();
                    event_loop.exit();
                }
            }
            Wake::FolderChanged => {
                self.reread_at = Some(Instant::now() + Duration::from_millis(600));
            }
            Wake::Scan(event) => {
                match event {
                    crate::scan::Event::Progress { folders } => self.state.scan_status = Some(format!("checking for changes · {}", crate::library::format_count(folders as i64))),
                    crate::scan::Event::Done { changed, folders, read, probed, seconds } => {
                        self.state.scan_status = None;
                        self.schedule_annotation_check();
                        if std::env::var("UMAKBANG_TIMING").is_ok() {
                            eprintln!("scan: {folders} folders, {read} read, {probed} probed, {seconds:.1}s");
                        }
                        if changed && self.state.view == View::Stats {
                            self.refresh_stats(true);
                        }
                        if changed {
                            // What the scan found, on screen: the counts, the tree, the rows.
                            self.state.total_files = self.library.total_files();
                            self.rebuild_tree();
                            let (view, scroll, selection, focus) = (self.state.view, self.state.scroll, self.state.selection.clone(), self.state.focus);
                            if !self.state.searching {
                                self.show_view(view);
                                self.state.scroll = scroll;
                                self.state.selection = selection;
                                self.state.focus = focus;
                            }
                        }
                    }
                }
                self.redraw();
            }
            Wake::KeyTest(line) => {
                self.key_testing = false;
                self.key_test = Some(line);
                self.refresh_settings_values();
                self.redraw();
            }
            Wake::Stems(event) => {
                self.stems_event(event);
                self.redraw();
            }
            Wake::Youtube(event) => {
                self.youtube_event(event);
                if self.state.view == View::Settings {
                    self.refresh_settings_values();
                }
                self.redraw();
            }
            Wake::Analysing(path) => {
                self.state.analysing.insert(path);
                self.redraw();
            }
            Wake::Analysed(result) => {
                self.state.analysing.remove(&result.path);
                self.analysed.insert(result.path.clone());
                self.apply_analysis(result);
                self.redraw();
            }
            Wake::Search(results) => {
                self.show_results(results);
                self.redraw();
            }
            Wake::RemoteWrite(write, reply) => {
                let outcome = self.apply_remote_write(write);
                let _ = reply.send(outcome);
                self.redraw();
            }
            Wake::Remote => {
                self.update_tray_status();
                if self.state.view == View::Settings && self.state.settings_section == 7 {
                    self.refresh_settings_values();
                    self.redraw();
                }
            }
            Wake::Peers(status, peers) => {
                self.peers = Some((status, peers));
                self.peers_busy = false;
                self.refresh_settings_values();
                self.redraw();
            }
            Wake::RemoteIndexed(label, outcome) => {
                if let Err(reason) = outcome {
                    self.notify(format!("{label}: {reason}"));
                }
                self.state.total_files = self.library.total_files();
                self.rebuild_tree();
            }
            Wake::Copying(progress) => {
                let percent = if progress.total > 0 { (progress.received as f64 / progress.total as f64 * 100.0).round() } else { 0.0 };
                self.state.scan_status = Some(if progress.verifying { format!("checking {}", progress.name) } else { format!("copying {} · {percent}%", progress.name) });
                self.redraw();
            }
            Wake::Copied(written, failures) => {
                self.state.scan_status = None;
                let to = self.data.settings.remote_download_dir.clone().unwrap_or_default();
                match failures.first() {
                    Some(first) if written.is_empty() => self.notify(first.clone()),
                    Some(first) => self.notify(format!("Copied {} to {to}. {first}", written.len())),
                    None => self.notify(format!("Copied {} to {to}.", if written.len() == 1 { "1 file".to_string() } else { format!("{} files", written.len()) })),
                }
                self.copied_into(&to);
            }
            Wake::LibraryTouched(dirs, everything) => self.library_touched(dirs, everything),
            Wake::AnnotationsChecked(changed, filled) => self.annotations_checked(changed, filled),
            Wake::Extracted(outcome) => match outcome {
                Ok(dir) => {
                    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    self.notify(format!("Unpacked into {name}."));
                    // The folder on screen gained a subfolder; this is the one moment the app
                    // knows that for certain.
                    if let Some(parent) = dir.parent() {
                        self.copied_into(&parent.to_string_lossy());
                    }
                }
                Err(e) => self.notify(e),
            },
            Wake::PackPreview(flp, preview) => {
                self.state.scan_status = None;
                if let Some(error) = preview.error {
                    self.notify(error);
                } else {
                    self.open_pack_dialog(flp, preview);
                }
            }
            Wake::Packed(outcome) => {
                self.state.scan_status = None;
                match outcome {
                    Ok(zip) => {
                        self.notify(format!("Packed into {}.", zip.display()));
                        let to = self.data.settings.remote_download_dir.clone().unwrap_or_default();
                        self.copied_into(&to);
                    }
                    Err(e) => self.notify(e),
                }
            }
            Wake::BundleWritten(outcome) => {
                self.bundle_busy = false;
                match outcome {
                    Ok(path) => self.notify(format!("Bundle written to {}.", path.display())),
                    Err(e) => self.notify(e),
                }
                self.refresh_settings_values();
            }
            Wake::BundleRead(outcome) => {
                self.bundle_busy = false;
                match outcome {
                    Err(e) => self.notify(e),
                    // Every folder it names is here: straight in, as it was.
                    Ok((Some(backup), true, restored)) => {
                        let mut identity = crate::backup::Mapping::new();
                        for root in backup.get("exportedRoots").and_then(|r| r.as_array()).into_iter().flatten() {
                            if let Some(p) = root.get("path").and_then(|p| p.as_str()) {
                                identity.insert(p.to_string(), p.to_string());
                            }
                        }
                        if let Some(p) = backup.get("exportedRoot").and_then(|p| p.as_str()) {
                            identity.entry(p.to_string()).or_insert_with(|| p.to_string());
                        }
                        self.apply_backup(&backup, &identity, restored.len());
                    }
                    Ok((Some(backup), false, _)) => self.open_wizard(backup, None),
                    Ok((None, _, _)) => self.notify("That bundle has no settings in it."),
                }
                self.refresh_settings_values();
            }
            Wake::RemoteMetadata(name, backup) => match backup.filter(|b| b.get("kind").and_then(|k| k.as_str()) == Some("umakbang-settings")) {
                None => self.notify(format!("{name} would not hand over its tags and ratings. It may be on an older umakbang.")),
                Some(backup) => self.open_wizard(backup, Some(name)),
            },
            Wake::SettingsSynced(outcome, launch) => {
                self.syncing = false;
                match outcome {
                    Ok(Some((name, theirs))) => match crate::backup::adopt_settings(&self.data_path, &theirs) {
                        Ok(()) => {
                            self.reload();
                            self.sync_note = Some(format!("Took settings from {name}."));
                            if !launch {
                                self.notify(format!("Took settings from {name}."));
                            }
                        }
                        Err(e) => self.sync_note = Some(e),
                    },
                    Ok(None) => self.sync_note = Some("Nothing newer anywhere else.".into()),
                    Err(e) => self.sync_note = Some(e),
                }
                self.refresh_settings_values();
            }
            Wake::PluginsCompared(id, inventory) => {
                self.compared.insert(id, Some(inventory));
                self.refresh_settings_values();
                self.redraw();
            }
            Wake::Peaks(path, peaks) => {
                let Some(now) = &self.state.now else { return };
                if now.file.path == path {
                    now.wave.borrow_mut().set_peaks(peaks);
                    self.redraw();
                }
            }
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // The folder on screen follows the disk: watched, re-read once its changes settle.
        let here = self.here();
        if let Some(proxy) = self.proxy.clone() {
            self.watch.watch(here.as_deref(), &proxy);
        }
        if self.preview_at.is_some_and(|at| Instant::now() >= at) {
            self.preview_at = None;
            self.refresh_preview();
            self.redraw();
        }
        if self.spin_at.is_some_and(|at| Instant::now() >= at) {
            self.spin_at = None;
            self.redraw();
        }
        if self.probe_at.is_some_and(|at| Instant::now() >= at) {
            self.probe_at = None;
            self.probe_link();
            self.redraw();
        }
        if self.reread_at.is_some_and(|at| Instant::now() >= at) {
            self.reread_at = None;
            if let Some(abs) = here {
                if self.library.sync_folder(self.state.folder.id, &abs) {
                    self.schedule_annotation_check();
                    self.state.total_files = self.library.total_files();
                    self.rebuild_tree();
                    let (scroll, selection, focus) = (self.state.scroll, self.state.selection.clone(), self.state.focus);
                    if !self.state.searching {
                        let view = self.state.view;
                        self.show_view(view);
                        self.state.scroll = scroll;
                        self.state.selection = selection;
                        self.state.focus = focus;
                    }
                    self.redraw();
                }
            }
        }
        if self.annotation_check_at.is_some_and(|at| Instant::now() >= at) {
            self.annotation_check_at = None;
            self.check_annotations();
        }
        if self.volume_close_at.is_some_and(|at| Instant::now() >= at) {
            self.volume_close_at = None;
            self.state.transport.volume_open = false;
            self.redraw();
        }
        if self.notice_until.is_some_and(|at| Instant::now() >= at) {
            self.notice_until = None;
            self.state.notice = None;
            self.redraw();
        }
        if let Some(doc) = self.doc.as_mut() {
            doc.flush(false);
        }
        // A track that ran out moves on to the next, as `ended` does.
        if self.playing() && self.player.as_ref().is_some_and(|p| p.finished()) {
            if self.data.settings.auto_advance {
                self.next();
            } else {
                // Stop at the end of each file: the transport comes to rest on it.
                if let Some(now) = self.state.now.as_mut() {
                    now.playing = false;
                }
                self.stopped();
            }
            self.redraw();
        }
        let now = Instant::now();
        if self.playing() {
            if now >= self.next_tick {
                self.pending = Some(Phase::Live);
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
                // Paced against the schedule rather than reset to now, so frames don't drift;
                // a hitch drops the backlog rather than bursting to catch up.
                self.next_tick += FRAME;
                if self.next_tick <= now {
                    self.next_tick = now + FRAME;
                }
            }
            event_loop.set_control_flow(ControlFlow::WaitUntil(self.next_tick));
        } else if let Some(at) = self.clear_at {
            if now >= at {
                self.clear_at = None;
                if self.state.visuals.borrow().painted {
                    self.pending = Some(Phase::Clear);
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
                event_loop.set_control_flow(self.idle_wait());
            } else {
                event_loop.set_control_flow(ControlFlow::WaitUntil(at));
            }
        } else {
            event_loop.set_control_flow(self.idle_wait());
        }
        // A pending settling frame (a pause) needs drawing even with nothing else due.
        if self.pending == Some(Phase::Idle) {
            if let Some(window) = &self.window {
                window.request_redraw();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        // On a Mac, Ctrl-click is the right click: the context menu, not a multi-select.
        let event = match event {
            WindowEvent::MouseInput { device_id, state, button: MouseButton::Left }
                if cfg!(target_os = "macos") && (if state == ElementState::Pressed { self.modifiers.control_key() } else { self.ctrl_click }) =>
            {
                self.ctrl_click = state == ElementState::Pressed;
                WindowEvent::MouseInput { device_id, state, button: MouseButton::Right }
            }
            other => other,
        };
        match event {
            WindowEvent::CloseRequested => self.close_window(event_loop),
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(window) = &self.window {
                    self.state.maximized = window.is_maximized();
                }
                self.redraw();
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = position;
                if self.row_drag.is_some() {
                    self.drag_moved();
                    return;
                }
                match self.resizing {
                    Some(Drag::Pane(handle, from, start)) => {
                        let window = self.logical_size().0;
                        let before = self.layout;
                        self.layout.drag(handle, start, self.pointer_along(handle) - from, window);
                        if self.layout != before {
                            self.redraw();
                        }
                        return;
                    }
                    Some(Drag::Volume) => {
                        self.volume_from_cursor();
                        self.redraw();
                        return;
                    }
                    Some(Drag::Setting(key)) => {
                        self.setting_from_cursor(key);
                        self.redraw();
                        return;
                    }
                    Some(Drag::Picker(area)) => {
                        self.picker_from_cursor(area);
                        self.redraw();
                        return;
                    }
                    Some(Drag::PaneSplit) => {
                        // Kept between a fifth and four fifths, so neither half can vanish.
                        let middle = self.logical_size().0 - self.state.sizes.sidebar - self.state.sizes.panel;
                        let x = (self.cursor.x / self.scale()) as f32 - self.state.sizes.sidebar;
                        if let Some(split) = self.state.split.as_mut() {
                            split.ratio = (x / middle.max(1.0)).clamp(0.2, 0.8);
                        }
                        self.redraw();
                        return;
                    }
                    Some(Drag::Column(id, from, start)) => {
                        let x = (self.cursor.x / self.scale()) as f32;
                        let width = (start + x - from).round().max(columns::def_of(id).min_width);
                        if let Some(column) = self.state.columns.iter_mut().find(|c| c.id == id) {
                            if column.width != width {
                                column.width = width;
                                self.redraw();
                            }
                        }
                        return;
                    }
                    None => {}
                }
                if let Some(anchor) = self.region_drag {
                    if let Some(at) = self.time_at_cursor() {
                        self.set_region(Some((anchor.min(at), anchor.max(at))));
                        self.redraw();
                    }
                    return;
                }
                if self.scrubbing {
                    self.seek_to_cursor();
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                    return;
                }
                self.refresh_hover();
            }
            WindowEvent::CursorEntered { .. } if self.state.stage => {
                self.state.stage_hover = true;
                self.redraw();
            }
            WindowEvent::CursorLeft { .. } => {
                if self.state.stage_hover {
                    self.state.stage_hover = false;
                    self.redraw();
                }
                self.state.hot = None;
                if self.hovered.take().is_some() {
                    self.redraw();
                }
                self.update_cursor();
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                if let Some(direction) = self.edge() {
                    if let Some(window) = &self.window {
                        let _ = window.drag_resize_window(direction);
                    }
                    return;
                }
                // A press in the other half brings it forward before anything in it acts.
                if self.over_inactive() {
                    self.activate_other();
                }
                let action = self.hit();
                if self.state.note_edit.is_some() && !matches!(action, Some(Action::Note(_))) {
                    self.finish_note();
                    self.redraw();
                }
                if let Some(key) = self.state.form.focus.filter(|k| action != Some(Action::Field(k))) {
                    self.state.form.blur();
                    self.field_left(key);
                    self.redraw();
                }
                if self.state.youtube.link.focused && action != Some(Action::Yt("link")) {
                    self.state.youtube.link.focused = false;
                    self.redraw();
                }
                if self.state.search.focused && !matches!(action, Some(Action::Search | Action::ClearSearch)) {
                    self.state.search.focused = false;
                    self.redraw();
                }
                if let Some(Action::Row(index)) = action {
                    self.arm_row_drag(index);
                }
                if let Some(action) = action {
                    self.act(action, event_loop);
                    self.redraw();
                }
            }
            WindowEvent::MouseInput { state: ElementState::Released, button: MouseButton::Right, .. } => {
                if self.over_inactive() {
                    self.activate_other();
                }
                self.close_overlays();
                let (x, y) = (self.cursor.x as f32, self.cursor.y as f32);
                let row = self.hits.iter().rev().find_map(|h| match h.action {
                    Action::Row(i) if x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3] => Some(i),
                    _ => None,
                });
                let tree_row = self.hits.iter().rev().find_map(|h| match h.action {
                    Action::TreeRow(i) if x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3] => Some(i),
                    _ => None,
                });
                let stop = self.hits.iter().rev().find_map(|h| match h.action {
                    Action::Pick(2, i) if x >= h.rect[0] && x < h.rect[2] && y >= h.rect[1] && y < h.rect[3] => Some(i),
                    _ => None,
                });
                if let Some(i) = stop {
                    let mut stops = self.current_stops();
                    if stops.len() > 2 {
                        stops.remove(i.min(stops.len() - 1));
                        self.set_stops(stops);
                    }
                    self.redraw();
                    return;
                }
                if let Some(index) = tree_row {
                    if self.open_root_menu(index) {
                        self.redraw();
                        return;
                    }
                }
                let scale = self.scale() as f32;
                let (w, h) = self.logical_size();
                let (lx, ly) = (x / scale, y / scale);
                let in_table = lx >= self.state.sizes.sidebar && lx < w - self.state.sizes.panel && ly >= 38.0 + 30.0 && ly < h - self.state.sizes.player;
                if row.is_some() || in_table {
                    self.open_menu(row);
                }
                self.redraw();
            }
            WindowEvent::MouseInput { state: ElementState::Released, button: MouseButton::Left, .. } => {
                self.scrubbing = false;
                if self.region_drag.take().is_some() {
                    // A click, or a drag of under three pixels, is no region.
                    let min = self.seconds_per_pixel() * 3.0;
                    if self.state.region.is_some_and(|(a, b)| b - a <= min) {
                        self.set_region(None);
                    }
                    self.redraw();
                }
                if let Some(drag) = self.row_drag.take() {
                    if drag.active {
                        self.pending_open = None;
                        if let Some(target) = self.state.drop_over.take() {
                            self.drop_into(&target, drag.paths);
                        }
                        self.cursor_icon = CursorIcon::Default;
                        if let Some(window) = &self.window {
                            window.set_cursor(CursorIcon::Default);
                        }
                        self.redraw();
                    }
                }
                if let Some(index) = self.pending_open.take() {
                    self.open_row(index);
                    self.redraw();
                }
                if let Some(drag) = self.resizing.take() {
                    self.state.resizing = None;
                    match drag {
                        Drag::Pane(..) => self.save_layout(),
                        Drag::Column(..) => {
                            self.state.column_hot = None;
                            self.save_columns();
                        }
                        Drag::Setting(_) | Drag::Picker(_) | Drag::PaneSplit => {}
                        Drag::Volume => {
                            let volume = self.state.transport.volume;
                            self.data.settings.volume = Some(volume);
                            self.write_setting("volume", serde_json::Value::from(volume));
                        }
                    }
                    // The pointer is somewhere else than where the drag began; what it is over
                    // now is what is lit, not the handle it let go of.
                    self.refresh_hover();
                    self.redraw();
                }
            }
            // Escape ends the tour wherever the keyboard is, as it does in the capture phase there.
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.state.tour.is_some() && event.logical_key == Key::Named(NamedKey::Escape) => {
                self.finish_tour();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.state.tag_editor.is_some() => {
                self.tag_key(&event);
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.state.note_edit.is_some() => {
                self.note_key(&event);
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && (self.state.menu.is_some() || self.state.prompt.is_some() || self.state.dialog.is_some() || self.state.about.is_some()) =>
            {
                if self.overlay_key(&event) {
                    self.redraw();
                }
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.state.form.focus.is_some() && self.state.menu.is_none() => {
                self.form_key(&event);
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && (self.state.contracts.draft.is_some() || self.state.stem_dialog.is_some()) && matches!(event.logical_key, Key::Named(NamedKey::Escape)) =>
            {
                if self.state.stem_dialog.is_some() {
                    self.state.stem_dialog = None;
                } else {
                    self.contracts_action("cancel");
                }
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.state.view == View::Downloading && self.state.youtube.link.focused => {
                self.youtube_key(&event);
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.state.search.focused => {
                if self.search_key(&event) {
                    self.redraw();
                }
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed
                    && self.command_key()
                    && matches!(&event.logical_key, Key::Character(c) if c.eq_ignore_ascii_case("f")) =>
            {
                // Ctrl+F (⌘F on a Mac), the View menu's Focus Search: focus it with everything selected.
                let s = &mut self.state.search;
                s.focused = true;
                s.anchor = 0;
                s.caret = s.value.len();
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && self.capturing.is_some() => {
                self.capture_key(&event.logical_key);
                self.redraw();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed && !event.repeat => {
                // The keys umakbang invented answer wherever they are bound now; a default that
                // has been moved to another key does nothing.
                match self.shortcut_for(&event.logical_key) {
                    (Some(id), _) => {
                        self.run_shortcut(id);
                        self.redraw();
                    }
                    (None, true) => {}
                    (None, false) => {
                        if self.file_key(&event.logical_key) || self.table_key(&event.logical_key) {
                            self.redraw();
                        }
                    }
                }
            }
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::MouseWheel { delta, .. } => {
                // Over the half not being worked in, that half scrolls - without being brought
                // forward, as a wheel does not change which pane you are in.
                let other = self.over_inactive();
                if other {
                    self.trade_panes();
                }
                self.wheel(delta);
                if other {
                    self.trade_panes();
                }
            }
            WindowEvent::RedrawRequested => self.present(),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::missing_part;

    #[test]
    fn missing_part_names_the_drive_not_the_file() {
        let root = std::env::temp_dir();
        let unmounted = root.join("umakbang-no-such-share").join("SECRET SAUCE").join("beat.mp3");
        assert_eq!(missing_part(&unmounted.to_string_lossy()), Some(root.join("umakbang-no-such-share")));
        let here = root.join(format!("umakbang-missing-{}.wav", std::process::id()));
        assert_eq!(missing_part(&here.to_string_lossy()), Some(here.clone()));
        assert_eq!(missing_part(&root.to_string_lossy()), None);
    }
}
