//! Settings as a page (`SettingsPage.tsx`): a section list down the left, and the section's
//! rows - a label, a hint, and a control - in a 560px column. It replaces the explorer, as
//! the Electron page does; the transport and the panel stay.

use crate::screen::{Action, State, style, tnum};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::tree::{El, col, div, icon, para, text};

pub const SECTIONS: [&str; 13] =
    ["Appearance", "Player", "Shortcuts", "Library", "Analysis", "Stems", "YT2MP3", "Remote", "Plugins", "Backup", "Window", "Updates", "Developer"];

/// What a settings row's control reads: the settings' current values, resolved by the app.
#[derive(Clone, Debug, Default)]
pub struct Values {
    pub headroom_db: f32,
    pub waveform_tint: String,
    pub auto_advance: bool,
    pub play_on_select: bool,
    pub audition_on_arrow: bool,
    pub queue_from_view: bool,
    pub random_skip_rated: bool,
    pub random_favour_unrated: bool,
    pub always_on_top: bool,
    pub show_stats: bool,
    pub system_file_icons: bool,
    /// Undo: how many operations are remembered, and how many are held now.
    pub undo_depth: String,
    /// Appearance: the colours as hex, and whether each is an override.
    /// Shortcuts: id, label, hint, the key bound, whether it is changed; which is listening;
    /// why the last key was refused.
    pub bindings: Vec<(&'static str, &'static str, &'static str, String, bool)>,
    pub capturing: Option<&'static str>,
    pub refused: Option<String>,
    pub visualizer_only: bool,
    pub no_library: bool,
    pub developer_mode: bool,
    pub reset_on_launch: bool,
    /// The output device chosen (None the system default), and whether it is connected.
    pub output: Option<String>,
    pub output_missing: bool,
    pub changelog_open: Option<usize>,
    pub share_library: bool,
    pub run_in_background: bool,
    pub remote_download_dir: Option<String>,
    pub server: Option<crate::server::ServerState>,
    pub server_stats: Option<crate::server::Stats>,
    /// Libraries mounted from other machines: label, machine, path.
    pub mounted: Vec<(String, String, String)>,
    /// Which of them is which: the machine's id and the library's path there.
    pub mounted_ids: Vec<(String, String)>,
    pub peers: Option<(crate::tailscale::Status, Vec<crate::server::Peer>)>,
    pub peers_busy: bool,
    pub bundle_dir: Option<String>,
    pub bundle_busy: bool,
    pub syncing: bool,
    pub sync_note: Option<String>,
    /// This machine's plugin inventory, how many FL has found and how many are favourites; and
    /// each peer compared with (None while asking, then what it said).
    pub plugins: Option<(serde_json::Value, usize, usize)>,
    pub compared: std::collections::HashMap<String, Option<Option<serde_json::Value>>>,
    pub accent_hex: String,
    pub background_hex: String,
    pub accent_set: bool,
    pub background_set: bool,
    pub stops: Vec<String>,
    pub stops_set: bool,
    /// Analysis: the scope tag, key estimation, the detector and profile, files at once, the
    /// external command and what its last test said.
    pub analysis_tag: Option<String>,
    pub detect_key: bool,
    pub key_engine: String,
    pub key_profile: String,
    pub concurrency: String,
    pub key_test: Option<String>,
    pub key_testing: bool,
    pub folder_tags: Vec<String>,
    pub undo_held: usize,
    /// YT2MP3: the downloader's line, its button, any error, the format, bitrate and fallback folder.
    pub yt_status: String,
    pub yt_button: String,
    pub yt_error: Option<String>,
    pub yt_format: String,
    pub yt_bitrate: String,
    pub yt_dir: Option<String>,
    pub roots: Vec<(String, String)>,
    pub excluded: Vec<String>,
    pub quick: Vec<(String, String)>,
    /// The transport's detail fields: id, label, an example value, and whether it is listed.
    pub details: Vec<(&'static str, &'static str, String, bool)>,
    /// The preview: the playing file's name and its line as the fields would print it.
    pub preview: (String, String, bool),
}

fn section(t: &Theme, title: &str, hint: Option<&str>) -> El<Action> {
    // The rows below open with `mt-1.5`, and in the page the hint's `mb-1` collapses into it:
    // 6px under the header either way. Each row here carries 8px, so the header gives back 2.
    let mut el = col().mb(16.0);
    match hint {
        Some(hint) => {
            el = el.child(text(title.to_string(), style(10.5, 600, t.muted_foreground)));
            el = el.child(text(hint.to_string(), style(11.0, 400, t.muted_foreground.alpha(0.6))).mb(-2.0).min_w(0.0));
        }
        None => el = el.child(text(title.to_string(), style(10.5, 600, t.muted_foreground)).mb(-2.0)),
    }
    el
}

/// A `secondary` `sm` button.
fn secondary(t: &Theme, label: &str, action: Action) -> El<Action> {
    div().h(24.0).px(8.0).items_center().rounded(6.0).bg(t.secondary).hover_bg(t.secondary.alpha(0.8)).on(action).child(text(label.to_string(), style(12.0, 500, t.secondary_foreground)))
}

/// The visualizer gradient presets (`GRADIENT_PRESETS`).
pub const GRADIENT_PRESETS: [(&str, &[&str]); 7] = [
    ("Heat", &["#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899"]),
    ("Ice → Fire", &["#3b82f6", "#22d3ee", "#facc15", "#f97316", "#ef4444"]),
    ("Sunset", &["#1e1b4b", "#7c3aed", "#f97316", "#fde68a"]),
    ("Aurora", &["#052e16", "#14b8a6", "#38bdf8", "#e0e7ff"]),
    ("Ember", &["#18181b", "#7f1d1d", "#f59e0b", "#fef3c7"]),
    ("Teal → Magenta", &["#14b8a6", "#a3e635", "#f472b6", "#ec4899"]),
    ("Mono", &["#334155", "#94a3b8", "#f8fafc"]),
];

/// A ramp as `linear-gradient(to right, …)`.
fn gradient_bar(stops: Vec<Rgba>, w: f32, h: f32) -> El<Action> {
    let painter: crate::ui::tree::Painter = std::rc::Rc::new(move |pm: &mut resvg::tiny_skia::PixmapMut, r: [f32; 4], _scale: f32| {
        use resvg::tiny_skia::{GradientStop, LinearGradient, Paint, Point, Rect, SpreadMode, Transform};
        if stops.len() < 2 {
            return;
        }
        let gs: Vec<GradientStop> = stops.iter().enumerate().map(|(i, c)| GradientStop::new(i as f32 / (stops.len() - 1) as f32, c.skia())).collect();
        let (Some(shader), Some(rect)) = (LinearGradient::new(Point::from_xy(r[0], 0.0), Point::from_xy(r[2], 0.0), gs, SpreadMode::Pad, Transform::identity()), Rect::from_ltrb(r[0], r[1], r[2], r[3])) else { return };
        let paint = Paint { shader, anti_alias: true, ..Paint::default() };
        pm.fill_rect(rect, &paint, Transform::identity(), None);
    });
    crate::ui::tree::paint(painter).size(w, h).clip()
}

/// `RemoteSection` and `TailnetSection`: what this machine shares, and who else is there.
fn remote(t: &Theme, v: &Values) -> El<Action> {
    let server = v.server.clone().unwrap_or_default();
    let hint_muted = |s: String| text(s, style(11.0, 400, t.muted_foreground.alpha(0.7)));
    let sharing = section(t, "Sharing", Some("Only machines on your tailnet can read this library."))
        .child(row(
            t,
            "Share this library",
            Some(&if !v.share_library {
                "Off. No other machine can reach this one.".to_string()
            } else if server.listening {
                format!("Answering on {}. Read-only.", server.address.clone().unwrap_or_default())
            } else {
                server.reason.clone().unwrap_or_else(|| "Starting…".into())
            }),
            switch(t, v.share_library, "shareLibrary"),
        ))
        .child(row(
            t,
            "Run in the background",
            Some(if v.run_in_background { if cfg!(target_os = "macos") { "Starts at login and keeps serving with the window closed, from the menu bar." } else { "Starts with Windows and keeps serving with the window closed, from the tray." } } else { "Off. Closing the window quits, and other machines lose this library with it." }),
            switch(t, v.run_in_background, "runInBackground"),
        ));
    let copying = section(t, "Copying here", Some("Another machine's library is read-only, so this is always a copy."))
        .child(row(t, "Copy files to", Some(v.remote_download_dir.as_deref().filter(|d| !d.is_empty()).unwrap_or("Not set yet.")), secondary(t, "Choose…", Action::SettingPick("remoteDownloadDir"))));
    let sync = section(t, "Settings", Some("The most recently changed settings win. Runs on launch too.")).child(row(
        t,
        "Take the newest settings",
        Some(v.sync_note.as_deref().unwrap_or("Asks every machine that is serving and adopts the newest.")),
        div()
            .h(24.0)
            .px(8.0)
            .items_center()
            .rounded(6.0)
            .bg(t.secondary)
            .opacity(if v.syncing { 0.5 } else { 1.0 })
            .maybe(!v.syncing, |el| el.hover_bg(t.secondary.alpha(0.8)).on(Action::SyncSettings))
            .child(text(if v.syncing { "Checking…" } else { "Sync now" }, style(12.0, 500, t.secondary_foreground))),
    ));
    let mut others = section(t, "Libraries from other machines", None);
    if v.mounted.is_empty() {
        others = others.child(hint_muted("None yet. Tailnet below lists what is serving.".into()).mt(8.0));
    }
    for (label, device, path) in &v.mounted {
        others = others.child(row(t, label, Some(&format!("{device} · {path}")), text("Read-only", style(11.0, 400, t.muted_foreground.alpha(0.6)))));
    }

    let refresh = div()
        .h(24.0)
        .px(8.0)
        .gap(6.0)
        .items_center()
        .rounded(6.0)
        .bg(t.secondary)
        .opacity(if v.peers_busy { 0.5 } else { 1.0 })
        .maybe(!v.peers_busy, |el| el.hover_bg(t.secondary.alpha(0.8)).on(Action::PeersRefresh))
        .child(icon(if v.peers_busy { "loader2" } else { "refresh-cw" }, 14.0, t.secondary_foreground))
        .child(text("Refresh", style(12.0, 500, t.secondary_foreground)));
    let mut tailnet = section(t, "Tailnet", Some("Read-only, and no further than the tailnet.")).child(row(
        t,
        "This machine",
        Some(&if v.server.is_none() {
            "Checking.".to_string()
        } else if server.listening {
            format!("Serving on {}:{}. Tailnet only.", server.address.clone().unwrap_or_default(), server.port)
        } else {
            server.reason.clone().unwrap_or_else(|| "Not serving.".into())
        }),
        refresh,
    ));
    let names: std::collections::HashMap<String, String> = v
        .peers
        .as_ref()
        .map(|(_, peers)| peers.iter().filter_map(|p| Some((p.node.ipv4.clone()?, if p.node.host_name.is_empty() { p.node.name.clone() } else { p.node.host_name.clone() }))).collect())
        .unwrap_or_default();
    if server.listening {
        if let Some(stats) = &v.server_stats {
            tailnet = tailnet.child(monitor(t, stats, &names).mt(8.0));
        }
    }
    if let Some((status, peers)) = &v.peers {
        if status.state != crate::tailscale::State::Running {
            tailnet = tailnet.child(hint_muted(status.reason.clone().unwrap_or_else(|| "Tailscale is not running.".into())).mt(8.0));
        } else if peers.is_empty() {
            tailnet = tailnet.child(hint_muted("No other machines in this tailnet.".into()).mt(8.0));
        }
        for peer in peers {
            let name = if peer.node.host_name.is_empty() { peer.node.name.clone() } else { peer.node.host_name.clone() };
            let dot = if peer.serving { t.primary } else if peer.node.online { t.muted_foreground.alpha(0.5) } else { t.muted_foreground.alpha(0.25) };
            let right = if peer.serving {
                format!("umakbang {}", peer.hello.as_ref().and_then(|h| h.pointer("/device/version")).and_then(|v| v.as_str()).unwrap_or(""))
            } else if peer.node.online {
                peer.reason.clone().unwrap_or_else(|| "Not serving.".into())
            } else {
                "Offline".into()
            };
            let mut card = col()
                .mt(8.0)
                .px(10.0)
                .py(6.0)
                .rounded(6.0)
                .border(t.border, 1.0)
                .bg(t.card.alpha(0.4))
                .child(
                    div()
                        .items_center()
                        .gap(8.0)
                        .child(div().size(6.0, 6.0).rounded(3.0).bg(dot))
                        .child(text(name, style(11.5, 500, t.foreground)))
                        .child(text(peer.node.os.clone(), style(10.5, 400, t.muted_foreground.alpha(0.6))))
                        .child(div().grow())
                        .child(text(right, style(10.5, 400, t.muted_foreground.alpha(0.6)))),
                )
                .child(text(format!("{} · {}", peer.node.ipv4.clone().unwrap_or_else(|| "no address".into()), peer.node.name), tnum(10.5, 400, t.muted_foreground.alpha(0.5))).ml(14.0).mt(2.0));
            let libraries = peer.hello.as_ref().and_then(|h| h.get("libraries")).and_then(|l| l.as_array()).cloned().unwrap_or_default();
            let serving_index = peers.iter().filter(|p| p.serving).position(|p| p.node.id == peer.node.id);
            for (li, library) in libraries.iter().enumerate() {
                let label = library.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let scanned = library.get("generation").is_some_and(|g| !g.is_null());
                let id = if scanned { library.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string() } else { "never scanned".into() };
                let path = library.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let device = peer.hello.as_ref().and_then(|h| h.pointer("/device/id")).and_then(|v| v.as_str()).unwrap_or("");
                let mounted = v.mounted_ids.iter().any(|(d, p)| d == device && p == path);
                let enabled = !mounted && peer.node.ipv4.is_some() && scanned && serving_index.is_some();
                let add = div()
                    .h(24.0)
                    .px(8.0)
                    .items_center()
                    .rounded(6.0)
                    .bg(t.secondary)
                    .opacity(if enabled { 1.0 } else { 0.5 })
                    .maybe(enabled, |el| el.hover_bg(t.secondary.alpha(0.8)).on(Action::MountLibrary(serving_index.unwrap_or(0), li)))
                    .child(text(if mounted { "Added" } else { "Add as root" }, style(12.0, 500, t.secondary_foreground)));
                card = card.child(div().ml(14.0).mt(4.0).items_center().gap(8.0).child(text(label, style(11.0, 400, t.foreground.alpha(0.8)))).child(text(id, tnum(10.5, 400, t.muted_foreground.alpha(0.5)))).child(div().grow()).child(add));
            }
            // Under the libraries, because it is about the same files: the stars and notes put on
            // them over there, landing on this machine's copy of them.
            if let (true, Some(_), Some(si)) = (peer.serving, peer.node.ipv4.as_ref(), serving_index) {
                card = card.child(
                    div()
                        .ml(14.0)
                        .mt(4.0)
                        .items_center()
                        .gap(8.0)
                        .child(text("Tags, ratings and notes", style(11.0, 400, t.muted_foreground.alpha(0.7))))
                        .child(div().grow())
                        .child(div().h(24.0).px(8.0).items_center().rounded(6.0).bg(t.secondary).hover_bg(t.secondary.alpha(0.8)).on(Action::RemoteImport(si)).child(text("Import…", style(12.0, 500, t.secondary_foreground)))),
                );
            }
            if peer.serving && libraries.is_empty() {
                card = card.child(text("Serving, but no library is open there.", style(11.0, 400, t.muted_foreground.alpha(0.6))).ml(14.0).mt(4.0));
            }
            tailnet = tailnet.child(card);
        }
    }
    col().child(sharing).child(copying).child(sync).child(others).child(tailnet)
}

/// `PluginsSection`: what FL has found here, the favourites, and how that compares with the
/// other machines that are serving.
fn plugins(t: &Theme, v: &Values) -> El<Action> {
    let muted = |s: String| para(s, style(11.0, 400, t.muted_foreground.alpha(0.7)));
    let names_of = |inv: &serde_json::Value| -> Vec<String> { inv.get("names").and_then(|n| n.as_array()).map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    let (mine_names, hint) = match &v.plugins {
        None => (Vec::new(), "Looking…".to_string()),
        Some((inv, _, _)) => {
            let from = inv.get("from").and_then(|f| f.as_str()).unwrap_or("").to_string();
            if inv.get("missing").and_then(|m| m.as_bool()).unwrap_or(false) {
                (Vec::new(), format!("Nothing at {from}. Point this at the database or the user data folder."))
            } else {
                let names = names_of(inv);
                let hint = format!("{} plugins, read from {from}", names.len());
                (names, hint)
            }
        }
    };
    let this = section(t, "This machine", Some("Read from FL Studio's own plugin database.")).child(row(t, "Plugin database folder", Some(&hint), secondary(t, "Choose…", Action::SettingPick("flUserData"))));
    let favourites = section(t, "FL plugins", Some("What appears when you add a plugin to a channel.")).child(row(
        t,
        "Favourites",
        Some(&match &v.plugins {
            Some((_, total, favourites)) => format!("{} of {} plugins FL has found.", crate::library::format_count(*favourites as i64), crate::library::format_count(*total as i64)),
            None => "Reading…".into(),
        }),
        secondary(t, "Manage…", Action::FlManage),
    ));
    let mut others = section(t, "Other machines", Some("Each machine reports its own. It has to be running and sharing."));
    let serving: Vec<&crate::server::Peer> = v.peers.as_ref().map(|(_, peers)| peers.iter().filter(|p| p.serving).collect()).unwrap_or_default();
    if serving.is_empty() {
        others = others.child(muted("Nothing is serving. Remote → Tailnet lists what it can see.".into()).mt(8.0));
    }
    // Punctuation and case out: two installs can disagree about a space and not about a plugin.
    let flatten = |n: &str| n.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
    for (i, peer) in serving.iter().enumerate() {
        let state = v.compared.get(&peer.node.id);
        let loading = matches!(state, Some(None));
        let name = if peer.node.host_name.is_empty() { peer.node.name.clone() } else { peer.node.host_name.clone() };
        let compare = div()
            .h(24.0)
            .px(8.0)
            .items_center()
            .rounded(6.0)
            .bg(t.secondary)
            .opacity(if loading || v.plugins.is_none() { 0.5 } else { 1.0 })
            .maybe(!loading && v.plugins.is_some(), |el| el.hover_bg(t.secondary.alpha(0.8)).on(Action::PluginsCompare(i)))
            .child(text(if loading { "Comparing…" } else { "Compare" }, style(12.0, 500, t.secondary_foreground)));
        let mut card = col()
            .mt(8.0)
            .px(10.0)
            .py(8.0)
            .rounded(6.0)
            .border(t.border, 1.0)
            .bg(t.card.alpha(0.4))
            .child(div().items_center().gap(8.0).child(text(name, style(11.5, 500, t.foreground))).child(text(peer.node.os.clone(), style(10.5, 400, t.muted_foreground.alpha(0.6)))).child(div().grow()).child(compare));
        match state {
            Some(Some(None)) => card = card.child(muted("It would not answer. That machine is probably on an older umakbang.".into()).mt(4.0)),
            Some(Some(Some(theirs))) if theirs.get("missing").and_then(|m| m.as_bool()).unwrap_or(false) => {
                card = card.child(muted("No plugin database there either - FL has not scanned on that machine, or its user data folder is set wrong in its own settings.".into()).mt(4.0));
            }
            Some(Some(Some(theirs))) => {
                let their_names = names_of(theirs);
                let here: std::collections::HashSet<String> = mine_names.iter().map(|n| flatten(n)).collect();
                let there: std::collections::HashSet<String> = their_names.iter().map(|n| flatten(n)).collect();
                let missing_here: Vec<&String> = their_names.iter().filter(|n| !here.contains(&flatten(n))).collect();
                let missing_there: Vec<&String> = mine_names.iter().filter(|n| !there.contains(&flatten(n))).collect();
                card = card.child(text(format!("{} plugins there · {} here", their_names.len(), mine_names.len()), style(11.0, 400, t.muted_foreground.alpha(0.6))).mt(4.0));
                if missing_here.is_empty() && missing_there.is_empty() {
                    card = card.child(para("The same on both. Anything made on either machine opens on the other.", style(11.0, 400, t.primary)).mt(6.0));
                }
                for (title, list) in [("Not here. Their projects open stubbed.", missing_here), ("Not there. Projects made here open stubbed.", missing_there)] {
                    if list.is_empty() {
                        continue;
                    }
                    card = card
                        .child(div().mt(6.0).gap(4.0).child(text(title.to_string(), style(11.0, 500, t.foreground.alpha(0.8)))).child(text(format!("({})", list.len()), style(11.0, 400, t.muted_foreground.alpha(0.6)))))
                        .child(para(list.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "), crate::ui::text::TextStyle { line_height: 17.9, ..style(11.0, 400, t.muted_foreground) }).mt(2.0));
                }
            }
            _ => {}
        }
        others = others.child(card);
    }
    col().child(this).child(favourites).child(others)
}

/// `ServerMonitor`: the counters, and the last dozen requests.
fn monitor(t: &Theme, stats: &crate::server::Stats, names: &std::collections::HashMap<String, String>) -> El<Action> {
    let up = ((crate::localtime::now() - stats.started_at) / 1000.0).max(0.0) as u64;
    let uptime = if up < 60 { format!("{up}s") } else if up < 3600 { format!("{}m", up / 60) } else if up < 86_400 { format!("{}h {}m", up / 3600, up / 60 % 60) } else { format!("{}d {}h", up / 86_400, up / 3600 % 24) };
    let quiet = t.muted_foreground;
    let mut figures = div()
        .wrap()
        .gap(16.0)
        .child(text(format!("up {uptime}"), tnum(11.0, 400, quiet)))
        .child(text(format!("{} requests", crate::library::format_count(stats.requests as i64)), tnum(11.0, 400, quiet)))
        .child(text(format!("{} out", bytes(stats.bytes_out)), tnum(11.0, 400, quiet)));
    if stats.refused > 0 {
        figures = figures.child(text(format!("{} refused", stats.refused), tnum(11.0, 400, t.project)));
    }
    if stats.in_flight > 0 {
        figures = figures.child(text(format!("{} in flight", stats.in_flight), tnum(11.0, 400, t.primary)));
    }
    let mut card = col().px(10.0).py(8.0).rounded(6.0).border(t.border, 1.0).bg(t.card.alpha(0.4)).child(figures);
    if stats.recent.is_empty() {
        card = card.child(text("Nothing has asked for anything yet.", style(11.0, 400, quiet.alpha(0.5))).mt(6.0));
    } else {
        let mut list = col().mt(6.0).gap(1.0);
        for entry in stats.recent.iter().take(12) {
            let small = |s: String, c: Rgba| text(s, tnum(10.5, 400, c));
            list = list.child(
                div()
                    .items_center()
                    .gap(8.0)
                    .child(small(entry.status.to_string(), if entry.status >= 400 { t.project } else { quiet.alpha(0.6) }).w(28.0).shrink0())
                    .child(small(entry.path.clone(), quiet.alpha(0.8)).shrink0())
                    .child(small(entry.detail.clone().unwrap_or_default(), t.foreground.alpha(0.7)).min_w(0.0).grow())
                    .child(small(names.get(&entry.peer).cloned().unwrap_or_else(|| entry.peer.clone()), quiet.alpha(0.45)).shrink0())
                    .child(div().w(56.0).shrink0().justify_end().child(small(bytes(entry.bytes), quiet.alpha(0.45))))
                    .child(div().w(48.0).shrink0().justify_end().child(small(format!("{}ms", entry.ms), quiet.alpha(0.45)))),
            );
        }
        card = card.child(list);
    }
    card
}

/// `formatBytes`.
fn bytes(n: u64) -> String {
    let n = n as f64;
    if n < 1024.0 {
        format!("{n} B")
    } else if n < 1024.0 * 1024.0 {
        format!("{:.0} KB", n / 1024.0)
    } else if n < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} MB", n / 1024.0 / 1024.0)
    } else {
        format!("{:.2} GB", n / 1024.0 / 1024.0 / 1024.0)
    }
}

#[derive(serde::Deserialize)]
pub struct ChangelogEntry {
    pub version: String,
    pub date: String,
    pub changes: Vec<String>,
}

/// `shared/changelog.ts`, copied in by `tools/changelog.mjs`.
fn changelog() -> &'static [ChangelogEntry] {
    static LIST: std::sync::OnceLock<Vec<ChangelogEntry>> = std::sync::OnceLock::new();
    LIST.get_or_init(|| serde_json::from_str(include_str!("../assets/changelog.json")).unwrap_or_default())
}

/// `2026-11-21` as `toLocaleDateString` writes it in English: "Nov 21, 2026".
fn long_date(iso: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let parts: Vec<u32> = iso.split('-').filter_map(|p| p.parse().ok()).collect();
    match parts[..] {
        [y, m, d] if (1..=12).contains(&m) => format!("{} {d}, {y}", MONTHS[m as usize - 1]),
        _ => iso.to_string(),
    }
}

/// `Row`: the label and its hint on the left, the control on the right.
fn row(t: &Theme, label: &str, hint: Option<&str>, control: El<Action>) -> El<Action> {
    let mut left = col().min_w(0.0).grow();
    left = left.child(text(label.to_string(), style(12.5, 400, t.foreground)).min_w(0.0));
    if let Some(hint) = hint {
        left = left.child(para(hint.to_string(), style(11.0, 400, t.muted_foreground.alpha(0.6))));
    }
    div().mt(8.0).items_center().justify_between().gap(12.0).child(left).child(control.shrink0_el())
}

/// `Switch`: a 32x18 track, `bg-primary` on and `bg-input` off, the knob riding inside it.
fn switch(t: &Theme, on: bool, key: &'static str) -> El<Action> {
    div()
        .w(32.0)
        .h(18.0)
        .rounded(9.0)
        .bg(if on { t.primary } else { t.input })
        .on(Action::SettingSwitch(key))
        .child(div().absolute(if on { 16.0 } else { 2.0 }, 2.0).size(14.0, 14.0).rounded(7.0).bg(t.background))
}

/// `SegmentedControl`: the options side by side in a bordered strip, the chosen one filled.
fn segmented(t: &Theme, key: &'static str, options: &[(&'static str, &str)], chosen: &str) -> El<Action> {
    let mut strip = div().items_center().gap(1.0).p(1.0).rounded(6.0).border(t.border, 1.0).bg(t.muted.alpha(0.4));
    for &(value, label) in options {
        let on = value == chosen;
        strip = strip.child(
            div()
                .h(22.0)
                .items_center()
                .px(8.0)
                .rounded(4.0)
                .maybe(on, |el| el.bg(t.primary))
                .on(Action::SettingChoice(key, value))
                .child(text(label.to_string(), style(11.5, 400, if on { t.primary_foreground } else { t.muted_foreground }))),
        );
    }
    strip
}

/// A list of paths with a remove button each: the exclusions, quick access.
fn path_list(t: &Theme, key: &'static str, items: &[(String, String)], empty: &str, removable: bool) -> El<Action> {
    let mut list = col().mt(6.0).gap(2.0);
    if items.is_empty() {
        return list.child(text(empty.to_string(), style(11.0, 400, t.muted_foreground.alpha(0.6))).min_w(0.0));
    }
    for (i, (label, detail)) in items.iter().enumerate() {
        list = list.child(
            div()
                .h(26.0)
                .items_center()
                .gap(8.0)
                .px(8.0)
                .rounded(4.0)
                .bg(t.secondary.alpha(0.3))
                .child(icon("folder", 14.0, t.muted_foreground))
                .child(text(label.clone(), style(12.0, 500, t.foreground)).shrink0())
                .child(text(detail.clone(), style(11.0, 400, t.muted_foreground.alpha(0.6))).min_w(0.0))
                .maybe(removable, |el| el.child(div().ml_auto().size(20.0, 20.0).shrink0().items_center().justify_center().rounded(4.0).hover_bg(t.accent).on(Action::SettingRemove(key, i)).child(icon("x", 12.0, t.muted_foreground)))),
        );
    }
    list
}

/// The headroom slider: a track with the value filled in the accent, and its readout.
fn headroom(t: &Theme, db: f32) -> El<Action> {
    let fraction = (db / 18.0).clamp(0.0, 1.0);
    div()
        .w(220.0)
        .items_center()
        .gap(8.0)
        .child(
            div()
                .w(160.0)
                .h(16.0)
                .items_center()
                .on(Action::SettingSlider("visualizerHeadroomDb"))
                .child(div().w(160.0).h(4.0).rounded(2.0).bg(t.border).child(div().w(160.0 * fraction).h(4.0).rounded(2.0).bg(t.primary)))
                .child(div().absolute(160.0 * fraction - 7.0, 1.0).size(14.0, 14.0).rounded(7.0).bg(t.primary)),
        )
        .child(text(format!("{db} dB"), tnum(11.0, 400, t.muted_foreground)).w(40.0))
}

fn pending(t: &Theme, what: &str) -> El<Action> {
    col().child(text(what.to_string(), style(12.0, 400, t.muted_foreground)).min_w(0.0)).child(
        text("Not in the native app yet - it is on the way. The Electron app has it meanwhile.", style(11.0, 400, t.muted_foreground.alpha(0.6))).mt(4.0).min_w(0.0),
    )
}

pub fn page(s: &State, t: &Theme, v: &Values) -> El<Action> {
    // The section list: narrow and quiet, a table of contents rather than a second sidebar.
    let mut nav = col().w(168.0).shrink0().pt(8.0).pb(8.0).border_r(t.border).bg(t.card.alpha(0.3)).child(
        div()
            .h(19.0)
            .items_center()
            .px(12.0)
            .pb(4.0)
            .child(text("Settings", style(10.0, 600, t.muted_foreground.alpha(0.7))))
            .child(div().ml_auto().size(16.0, 16.0).items_center().justify_center().rounded(2.0).hover_bg(t.accent).on(Action::SettingsClose).child(icon("x", 12.0, t.muted_foreground.alpha(0.7)))),
    );
    for (i, name) in SECTIONS.iter().enumerate() {
        let on = s.settings_section == i;
        nav = nav.child(
            div()
                .h(30.0)
                .shrink0()
                .items_center()
                .px(12.0)
                .maybe(on, |el| el.bg(t.accent))
                .hover_bg(if on { t.accent } else { t.accent.alpha(0.5) })
                .on(Action::SettingsSection(i))
                .child(text(name.to_string(), style(12.5, if on { 500 } else { 400 }, if on { t.foreground } else { t.muted_foreground }))),
        );
    }

    let body = match s.settings_section {
        0 => {
            // `ResetButton`: there but invisible until there is something to reset.
            let reset = |shown: bool, action: Action| {
                div().size(24.0, 24.0).items_center().justify_center().rounded(6.0).opacity(if shown { 1.0 } else { 0.0 }).maybe(shown, |el| el.hover_bg(t.accent).on(action)).child(icon("rotate-ccw", 12.0, t.muted_foreground))
            };
            let theme_row = |hex: &str, set: bool, kind: u8| div().items_center().gap(6.0).child(crate::color_picker::swatch(t, hex, Action::Pick(kind, 0))).child(reset(set, Action::ThemeReset(kind)));
            let mut gradient = div().wrap().items_center().gap(4.0);
            for (i, stop) in v.stops.iter().enumerate() {
                gradient = gradient.child(crate::color_picker::swatch(t, stop, Action::Pick(2, i)));
            }
            let ramp: Vec<Rgba> = v.stops.iter().filter_map(|h| Rgba::from_hex(h)).collect();
            gradient = gradient
                .child(div().size(22.0, 22.0).items_center().justify_center().rounded(4.0).border(t.border.alpha(0.8), 1.0).opacity(if v.stops.len() >= 8 { 0.3 } else { 1.0 }).maybe(v.stops.len() < 8, |el| el.hover_bg(t.accent).on(Action::StopAdd)).child(icon("plus", 12.0, t.muted_foreground)))
                .child(gradient_bar(ramp, 64.0, 14.0).rounded(3.0).border(t.border.alpha(0.8), 1.0))
                .child(reset(v.stops_set, Action::StopsReset));
            let mut presets = div().mt(6.0).wrap().gap(4.0);
            for (i, (_, stops)) in GRADIENT_PRESETS.iter().enumerate() {
                let on = stops.len() == v.stops.len() && stops.iter().zip(&v.stops).all(|(a, b)| a.eq_ignore_ascii_case(b));
                let ramp: Vec<Rgba> = stops.iter().filter_map(|h| Rgba::from_hex(h)).collect();
                presets = presets.child(gradient_bar(ramp, 48.0, 20.0).rounded(4.0).border(if on { t.primary } else { t.border.alpha(0.7) }, 1.0).on(Action::GradientPreset(i)));
            }
            let tint = |value: &'static str, label: &str| {
                let on = v.waveform_tint == value;
                div()
                    .px(8.0)
                    .py(2.0)
                    .rounded(4.0)
                    .border(if on { t.primary } else { t.border.alpha(0.7) }, 1.0)
                    .maybe(on, |el| el.bg(t.primary.alpha(0.15)))
                    .maybe(!on, |el| el.hover_bg(t.accent))
                    .on(Action::SettingChoice("waveformTint", value))
                    .child(text(label.to_string(), style(11.5, 400, if on { t.foreground } else { t.muted_foreground })))
            };
            col()
                .child(
                    section(t, "Theme", None)
                        .child(row(t, "Accent", Some("Buttons, selection, focus rings."), theme_row(&v.accent_hex, v.accent_set, 0)))
                        .child(row(t, "Background", Some("Surfaces derive from this."), theme_row(&v.background_hex, v.background_set, 1)))
                        .child(row(
                            t,
                            "System file icons",
                            Some(if cfg!(target_os = "macos") { "Finder's icon for each file type. Off shows umakbang's, coloured by kind." } else { "Explorer's icon for each file type. Off shows umakbang's, coloured by kind." }),
                            switch(t, v.system_file_icons, "systemFileIcons"),
                        )),
                )
                .child(
                    section(t, "Visualizers", Some("Quiet on the left, loud on the right."))
                        .child(row(t, "Gradient", None, gradient))
                        .child(text("Right-click a colour to remove it.", style(11.0, 400, t.muted_foreground.alpha(0.7))).mt(4.0))
                        .child(row(t, "Headroom", Some("Headroom above 0dB in the visualizers."), div().items_center().gap(4.0).child(headroom(t, v.headroom_db)).child(reset(v.headroom_db != 6.0, Action::HeadroomReset))))
                        .child(row(t, "Waveform colour", Some("Tints each column by where its energy sits."), div().items_center().gap(4.0).child(tint("spectrum", "Spectrum")).child(tint("accent", "Accent"))))
                        .child(presets),
                )
        }
        1 => col()
            .child({
                // `PlayerDetailSection`: the preview is the component itself, then a switch per
                // field in two columns, each with what it would say.
                let mut grid = div().wrap().gap(0.0);
                for (id, label, example, on) in &v.details {
                    grid = grid.child(
                        div()
                            .w(280.0)
                            .h(44.0)
                            .items_center()
                            .pr(4.0)
                            .child(col().min_w(0.0).grow().child(text(label.to_string(), style(12.5, 400, t.foreground))).child(text(example.clone(), style(11.0, 400, t.muted_foreground.alpha(0.6))).min_w(0.0)))
                            .child(switch(t, *on, id)),
                    );
                }
                section(t, "Track details", Some("What the player lists under the name."))
                    .child(
                        col()
                            .mt(6.0)
                            .p(10.0)
                            .rounded(6.0)
                            .border(t.border, 1.0)
                            .bg(t.card.alpha(0.5))
                            .child(text(v.preview.0.clone(), style(12.0, 500, t.foreground)).min_w(0.0))
                            .child(
                                div()
                                    .mt(2.0)
                                    .items_center()
                                    .gap(6.0)
                                    .child(text(v.preview.1.clone(), tnum(10.5, 400, t.muted_foreground)).min_w(0.0))
                                    .maybe(v.preview.2, |el| el.child(div().items_center().gap(2.0).child(icon("clock", 10.0, t.muted_foreground)).child(text("4h 12m", tnum(10.5, 400, t.muted_foreground))))),
                            )
                            .child(text("Preview", style(10.0, 400, t.muted_foreground.alpha(0.5))).mt(6.0)),
                    )
                    .child(grid.mt(8.0))
            })
            .child(
            section(t, "Playback", None)
                .child(row(t, "Auto-advance", Some("Continue to the next track when one ends."), switch(t, v.auto_advance, "autoAdvance")))
                .child(row(t, "Play on select", Some("Clicking an audio file starts it playing."), switch(t, v.play_on_select, "playOnSelect")))
                .child(row(t, "Play while arrowing", Some("Up and down play each file as you reach it."), switch(t, v.audition_on_arrow, "auditionOnArrow")))
                .child(row(t, "Queue from", None, segmented(t, "queueSource", &[("folder", "Folder"), ("view", "Current list")], if v.queue_from_view { "view" } else { "folder" }))),
        )
        .child(
            section(t, "Output", None).child(row(
                t,
                "Play through",
                Some(if v.output.is_some() { "Only umakbang moves. Other apps keep their own output." } else { "Follows whatever the system is set to." }),
                div()
                    .h(28.0)
                    .px(8.0)
                    .gap(8.0)
                    .items_center()
                    .rounded(6.0)
                    .border(t.border, 1.0)
                    .bg(t.background)
                    .hover_bg(t.accent)
                    .on(Action::OutputMenu)
                    .child(text(match &v.output { Some(name) if v.output_missing => format!("{name} (not connected)"), Some(name) => name.clone(), None => "System default".into() }, style(12.0, 400, t.foreground)).min_w(0.0))
                    .child(icon("chevron-down", 14.0, t.foreground)),
            )),
        ),
        2 => {
            let mut list = section(t, "Shortcuts", Some("The keys umakbang invented. Ctrl/⌘ combinations are left to the system."));
            for (id, label, hint, key, changed) in &v.bindings {
                let listening = v.capturing == Some(*id);
                let mut control = div().items_center().gap(6.0);
                if *changed {
                    control = control.child(div().size(24.0, 24.0).items_center().justify_center().rounded(6.0).hover_bg(t.accent).on(Action::ShortcutReset(id)).child(icon("rotate-ccw", 12.0, t.muted_foreground)));
                }
                let (bg, fg) = if listening { (t.primary, t.primary_foreground) } else { (t.secondary, t.secondary_foreground) };
                control = control.child(
                    div()
                        .h(24.0)
                        .min_w(68.0)
                        .px(8.0)
                        .items_center()
                        .justify_center()
                        .rounded(6.0)
                        .bg(bg)
                        .hover_bg(bg.alpha(0.9))
                        .on(Action::ShortcutBind(id))
                        .child(text(if listening { "Press a key".to_string() } else { key.clone() }, tnum(12.0, 500, fg))),
                );
                list = list.child(row(t, label, Some(if listening { "Press a key, Esc to cancel." } else { hint }), control));
            }
            if let Some(refused) = &v.refused {
                list = list.child(text(refused.clone(), style(11.0, 400, t.destructive)).mt(6.0));
            }
            if v.bindings.iter().any(|b| b.4) {
                list = list.child(div().mt(8.0).child(div().h(24.0).px(8.0).items_center().rounded(6.0).border(t.border, 1.0).hover_bg(t.accent).on(Action::ShortcutsReset).child(text("Reset all to defaults", style(12.0, 500, t.foreground)))));
            }
            col().child(list)
        }
        3 => col()
            .child(section(t, "Library folders", Some("Every folder umakbang indexes.")).child(path_list(t, "roots", &v.roots, "No folders yet.", false)))
            .child(
                section(t, "Random beat", Some("The folders that are not your own work: the dice, the stats and Rated leave them out."))
                    .child(path_list(t, "randomExcludeDirs", &v.excluded.iter().map(|d| (d.rsplit('/').next().unwrap_or(d).to_string(), d.clone())).collect::<Vec<_>>(), "Nothing excluded.", true))
                    .child(row(t, "Skip rated files", Some("The dice never lands on something already rated."), switch(t, v.random_skip_rated, "randomSkipRated")))
                    .child(row(t, "Favour unrated", Some("Unrated files come up four times as often."), switch(t, v.random_favour_unrated, "randomFavourUnrated"))),
            )
            .child(section(t, "Quick access", Some("The folders you file into, and open, most.")).child(path_list(t, "quickMove", &v.quick, "Nothing pinned yet.", true)))
            .child(section(t, "Undo", Some("Steps back through moves, copies, renames and new folders. Deletes go to the Recycle Bin.")).child(row(
                t,
                "Operations to remember",
                Some(&if v.undo_held > 0 { format!("{} {} to step back through right now.", v.undo_held, if v.undo_held == 1 { "operation" } else { "operations" }) } else { "Nothing to undo at the moment.".to_string() }),
                segmented(t, "undoDepth", &[("5", "5"), ("10", "10"), ("25", "25"), ("50", "50"), ("100", "100"), ("200", "200")], &v.undo_depth),
            ))),
        4 => {
            let analyse = div()
                .h(28.0)
                .px(8.0)
                .gap(8.0)
                .items_center()
                .rounded(6.0)
                .border(t.border, 1.0)
                .bg(t.background)
                .hover_bg(t.accent)
                .on(Action::AnalysisTag)
                .child(text(v.analysis_tag.clone().unwrap_or_else(|| "Everything".into()), style(12.0, 400, t.foreground)))
                .child(icon("chevron-down", 14.0, t.foreground));
            let mut body = section(t, "Tempo and key analysis", Some("Tag a folder, then pick that tag here. Subfolders included."))
                .child(row(
                    t,
                    "Analyse",
                    Some(&match &v.analysis_tag {
                        Some(tag) => format!("Only files under folders tagged “{tag}”."),
                        None => "Everything you browse gets decoded once.".to_string(),
                    }),
                    analyse,
                ))
                .child(row(t, "Estimate key from audio", Some("Tempo is accurate. Key is a guess and often wrong."), switch(t, v.detect_key, "detectKeyFromAudio")));
            if v.detect_key {
                body = body
                    .child(row(
                        t,
                        "Key detector",
                        Some("Right on cases the built-in detector splits. Switching re-analyses everything."),
                        segmented(t, "keyEngine", &[("builtin", "Built-in"), ("essentia", "Essentia")], &v.key_engine),
                    ))
                    .maybe(v.key_engine == "essentia", |el| {
                        el.child(row(
                            t,
                            "Key profile",
                            Some("What the chroma is scored against. bgate and edma suit electronic music."),
                            segmented(t, "keyProfile", &[("edma", "edma"), ("bgate", "bgate"), ("temperley", "temperley"), ("krumhansl", "krumhansl")], &v.key_profile),
                        ))
                    });
            }
            body = body
                .child(row(
                    t,
                    "Reprocess analysed files",
                    Some("Re-runs tempo and key. Values from tags and file names are left alone."),
                    div().h(24.0).px(8.0).gap(6.0).items_center().rounded(6.0).bg(t.secondary).hover_bg(t.secondary.alpha(0.8)).on(Action::Stems("reprocess-all")).child(icon("refresh-cw", 14.0, t.secondary_foreground)).child(text("Reprocess all", style(12.0, 500, t.secondary_foreground))),
                ))
                .child(row(t, "Files at once", Some("How many are analysed at once. More is faster and uses more memory."), segmented(t, "analysisConcurrency", &[("1", "1"), ("2", "2"), ("4", "4"), ("6", "6"), ("10", "10")], &v.concurrency)))
                .child(
                    col()
                        .mt(8.0)
                        .gap(6.0)
                        .child(text("External key detector", style(12.5, 400, t.foreground)))
                        .child(para("Run once per file, with {file} as its path. What it prints is the key. Empty uses the built-in detector.", style(11.0, 400, t.muted_foreground.alpha(0.6))))
                        .child(
                            div()
                                .items_center()
                                .gap(6.0)
                                .child(crate::form::field(s, t, "a.keyCommand", "mytool --key \"{file}\"", 28.0).grow())
                                .child(secondary(t, if v.key_testing { "Testing…" } else { "Test" }, Action::KeyTest)),
                        )
                        .maybe(v.key_test.is_some(), |el| el.child(text(v.key_test.clone().unwrap_or_default(), style(11.0, 400, t.muted_foreground)))),
                );
            if v.folder_tags.is_empty() {
                body = body.child(para("No folder carries a tag yet. Right-click one and choose “Edit tags…”.", style(11.0, 400, t.muted_foreground.alpha(0.6))).mt(8.0));
            }
            col().child(body)
        }
        5 => {
            let st = &s.stem_settings;
            let minutes = match st.minutes {
                None => None,
                Some(None) => Some("The service would not answer. Check the key.".to_string()),
                Some(Some(m)) => Some(format!("{m:.1} minutes left on the account.")),
            };
            let model = |name: &str| {
                let mut label = name[..1].to_uppercase() + &name[1..];
                if name == "andromeda" {
                    label.push_str(" (newest)");
                }
                label
            };
            col().child(
                section(t, "Stems", Some("Splits vocals from the instrumental with LALAL.AI. Billed by the minute."))
                    .child(
                        col()
                            .mt(4.0)
                            .gap(6.0)
                            .child(text("Licence key", style(12.5, 400, t.foreground)))
                            .child(
                                div()
                                    .items_center()
                                    .gap(6.0)
                                    .child(crate::form::password_field(s, t, "s.key", "from lalal.ai account settings", 28.0).grow())
                                    .child(secondary(t, if st.checking { "Checking…" } else { "Check" }, Action::Stems("check"))),
                            )
                            .maybe(minutes.is_some(), |el| el.child(text(minutes.clone().unwrap_or_default(), style(11.0, 400, t.muted_foreground))))
                            .child(text("Kept out of settings exports.", style(11.0, 400, t.muted_foreground.alpha(0.6)))),
                    )
                    .child(row(t, "Write stems to", Some(if st.output_dir.is_empty() { "Not set yet." } else { &st.output_dir }), secondary(t, "Choose…", Action::SettingPick("stemOutputDir"))))
                    .child(row(t, "Format", Some("What the stems come back as."), segmented(t, "stemFormat", &[("wav", "WAV"), ("flac", "FLAC"), ("mp3", "MP3")], &st.format)))
                    .child(row(
                        t,
                        "Model",
                        Some("All four split vocals. Try another if a voice comes out badly."),
                        div()
                            .h(28.0)
                            .px(8.0)
                            .gap(8.0)
                            .items_center()
                            .rounded(6.0)
                            .border(t.border, 1.0)
                            .bg(t.background)
                            .hover_bg(t.accent)
                            .on(Action::Stems("model"))
                            .child(text(model(&st.splitter), style(12.0, 400, t.foreground)))
                            .child(icon("chevron-down", 14.0, t.foreground)),
                    )),
            )
        }
        6 => col().child(
            section(t, "YT2MP3", Some("Pulls the audio off a link into the folder you are browsing."))
                .child(
                    col()
                        .mt(4.0)
                        .gap(6.0)
                        .child(text("Downloader", style(12.5, 400, t.foreground)))
                        .child(div().items_center().gap(6.0).child(text(v.yt_status.clone(), style(11.5, 400, t.muted_foreground)).grow()).child(secondary(t, &v.yt_button, Action::Yt("install"))))
                        .maybe(v.yt_error.is_some(), |el| el.child(text(v.yt_error.clone().unwrap_or_default(), style(11.0, 400, t.destructive))))
                        .child(text("Fetched rather than bundled, and updated weekly. It lives beside umakbang’s own data, not in your library.", style(11.0, 400, t.muted_foreground.alpha(0.6)))),
                )
                .child(row(
                    t,
                    "Save as",
                    Some("MP3 re-encodes what came down. The original stream is better audio. Video keeps the picture too."),
                    segmented(t, "youtubeFormat", &[("mp3", "MP3"), ("source", "Original"), ("video", "Video")], &v.yt_format),
                ))
                .maybe(v.yt_format == "mp3", |el| {
                    el.child(row(
                        t,
                        "Bitrate",
                        Some("Already lossy, so a higher rate mostly buys file size."),
                        segmented(t, "youtubeBitrate", &[("128", "128k"), ("192", "192k"), ("256", "256k"), ("320", "320k")], &v.yt_bitrate),
                    ))
                })
                .child(row(t, "Fallback folder", Some(v.yt_dir.as_deref().unwrap_or("Where a download goes when you are not in a folder.")), secondary(t, "Choose…", Action::SettingPick("youtubeDir")))),
        ),
        7 => remote(t, v),
        8 => plugins(t, v),
        9 => {
            let outline = |label: &str, icon_name: &'static str, action: Action| {
                div()
                    .h(24.0)
                    .px(8.0)
                    .gap(6.0)
                    .items_center()
                    .rounded(6.0)
                    .border(t.border, 1.0)
                    .opacity(if v.bundle_busy { 0.5 } else { 1.0 })
                    .maybe(!v.bundle_busy, |el| el.hover_bg(t.accent).on(action))
                    .child(icon(icon_name, 14.0, t.foreground))
                    .child(text(label.to_string(), style(12.0, 500, t.foreground)))
            };
            col().child(
                section(t, "Backup", Some("Everything umakbang remembers, in one .umak file."))
                    .child(row(t, "Write bundles to", Some(v.bundle_dir.as_deref().unwrap_or("Not set yet.")), secondary(t, "Choose…", Action::SettingPick("bundleExportDir"))))
                    .child(
                        div()
                            .mt(8.0)
                            .gap(6.0)
                            .items_center()
                            .child(outline("Export", if v.bundle_busy { "loader2" } else { "package" }, Action::BackupExport(false)))
                            .child(outline("Export to…", "folder-output", Action::BackupExport(true)))
                            .child(outline("Import…", "download", Action::BackupImport)),
                    )
                    .child(para("A bundle opens indexed instead of rescanning. One is written on its own once a day as umakbang-auto.umak. Importing asks where each folder lives here. Older .json settings still import.", crate::ui::text::TextStyle { line_height: 15.1, ..style(11.0, 400, t.muted_foreground.alpha(0.6)) }).mt(8.0)),
            )
        }
        10 => col().child(
            section(t, "Window", None)
                .child(row(t, "Pin on top", Some("Keep umakbang above other applications."), switch(t, v.always_on_top, "alwaysOnTop")))
                .child(row(
                    t,
                    "Visualizers only",
                    Some(if v.no_library { "Open a folder first." } else { "Hide the library and fill the window." }),
                    switch(t, v.visualizer_only, "visualizerOnly").opacity(if v.no_library { 0.5 } else { 1.0 }),
                )),
        ),
        11 => {
            let version = env!("CARGO_PKG_VERSION");
            use crate::updater::Status;
            let status = crate::updater::status();
            let line = match &status {
                Status::Disabled(why) => why.clone(),
                Status::Idle => "Checked 30 seconds after launch, then twice a day.".into(),
                Status::Checking => "Checking…".into(),
                Status::UpToDate => "Up to date.".into(),
                Status::NoBuild(v) => format!("{v} is out, without a Windows build of this app yet."),
                Status::Downloading(v, f) => format!("Downloading {v}… {}%", (f * 100.0).round()),
                Status::Ready(v) => format!("{v} is downloaded and checked. Restart to install it."),
                Status::Failed(e) => format!("Could not check: {e}"),
            };
            let ready = matches!(status, Status::Ready(_));
            let enabled = !matches!(status, Status::Disabled(_) | Status::Checking | Status::Downloading(..));
            let check = div()
                .h(24.0)
                .px(8.0)
                .gap(6.0)
                .items_center()
                .rounded(6.0)
                .border(t.border, 1.0)
                .maybe(ready, |el| el.bg(t.primary))
                .opacity(if enabled { 1.0 } else { 0.5 })
                .maybe(enabled, |el| el.hover_bg(if ready { t.primary.alpha(0.85) } else { t.accent }).on(if ready { Action::UpdateRestart } else { Action::UpdateCheck }))
                .child(icon("rotate-ccw", 14.0, if ready { t.primary_foreground } else { t.foreground }))
                .child(text(if ready { "Restart to update" } else { "Check now" }, style(12.0, 500, if ready { t.primary_foreground } else { t.foreground })));
            let mut list = col().mt(4.0).gap(4.0);
            for (i, entry) in changelog().iter().enumerate() {
                let open = v.changelog_open == Some(i);
                let mut head = div()
                    .px(10.0)
                    .py(6.0)
                    .gap(8.0)
                    .items_center()
                    .on(Action::Changelog(i))
                    .child(icon(if open { "chevron-down" } else { "chevron-right" }, 14.0, t.muted_foreground.alpha(0.6)))
                    .child(text(entry.version.clone(), tnum(12.5, 500, t.foreground)));
                if entry.version == version {
                    head = head.child(div().px(4.0).py(1.0).rounded(4.0).bg(t.primary.alpha(0.15)).child(text("installed", style(10.0, 400, t.primary))));
                }
                head = head.child(div().grow()).child(text(long_date(&entry.date), style(11.0, 400, t.muted_foreground.alpha(0.6))));
                let mut card = col().rounded(6.0).border(t.border, 1.0).bg(t.card.alpha(0.4)).child(head);
                if open {
                    let mut items = col().pl(28.0).pr(10.0).pb(8.0).gap(4.0);
                    for change in &entry.changes {
                        items = items.child(
                            div()
                                .min_w(0.0)
                                .child(div().absolute(-10.0, 0.0).child(text("•", style(11.5, 400, t.muted_foreground.alpha(0.4)))))
                                .child(para(change.clone(), crate::ui::text::TextStyle { line_height: 18.7, ..style(11.5, 400, t.muted_foreground) }).grow()),
                        );
                    }
                    card = card.child(items);
                }
                list = list.child(card);
            }
            col().child(
                section(t, "Updates", Some("Downloaded in the background, installed when you restart."))
                    .child(row(t, "Version", Some(line.as_str()), div().items_center().gap(6.0).child(text(version.to_string(), tnum(12.5, 400, t.muted_foreground))).child(check)))
                    .child(list),
            )
        }
        12 => {
            let mut developer = section(t, "Developer", Some("For testing umakbang, not for using it.")).child(row(t, "Developer mode", Some("Shows the switches below. Never travels in a backup."), switch(t, v.developer_mode, "developerMode")));
            if v.developer_mode {
                developer = developer.child(row(
                    t,
                    "Start fresh on next launch",
                    Some(if v.reset_on_launch { "On. Every launch opens as a new install. Your real profile is moved aside, not deleted." } else { "Next launch comes up as a new install. Reversible." }),
                    switch(t, v.reset_on_launch, "resetOnLaunch"),
                ));
            }
            let replay = div()
                .h(24.0)
                .px(8.0)
                .gap(6.0)
                .items_center()
                .rounded(6.0)
                .bg(t.secondary)
                .opacity(if v.no_library { 0.5 } else { 1.0 })
                .maybe(!v.no_library, |el| el.hover_bg(t.secondary.alpha(0.8)).on(Action::ReplayTour))
                .child(icon("rotate-ccw", 14.0, t.secondary_foreground))
                .child(text("Replay", style(12.0, 500, t.secondary_foreground)));
            col()
                .child(developer)
                .child(section(t, "Pages", None).child(row(t, "Stats", Some("Off takes it out of the sidebar and stops it computing."), switch(t, v.show_stats, "showStats"))))
                .child(section(t, "Tour", None).child(row(t, "Show the tutorial again", Some(if v.no_library { "Open a folder first." } else { "Seven steps, stoppable at any point." }), replay)))
        }
        other => col().child(section(t, SECTIONS[other], None).child(pending(t, &format!("{} settings", SECTIONS[other])))),
    };

    div().grow().min_w(0.0).min_h0().child(nav).child(
        div().grow().min_w(0.0).min_h0().scroll_named("settings", s.settings_scroll).scrollbar(t.border).child(div().grow().min_w(0.0).justify_center().px(20.0).py(16.0).child(body.w(560.0).min_w(0.0))),
    )
}


trait Extra {
    fn shrink0_el(self) -> Self;
}

impl Extra for El<Action> {
    fn shrink0_el(mut self) -> Self {
        self.style.flex_shrink = 0.0;
        self
    }
}
