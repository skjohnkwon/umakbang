//! `umakbang-data.json`, read as the Electron app writes it - the native app shares the file, so
//! switching between the two is never a migration. Only what the explorer screen draws so far.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct OutputDevice {
    pub id: String,
    pub label: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub quick_move: Vec<QuickFolder>,
    pub random_exclude_dirs: Vec<String>,
    /// The visualizer ramp, quiet to loud, as hex. Empty means the built-in five.
    pub visualizer_stops: Vec<String>,
    /// Absent means the app's default of 6dB.
    pub visualizer_headroom_db: Option<f32>,
    /// The transport's detail line, in order; empty means the built-in default.
    pub player_details: Vec<String>,
    /// `accent` draws waveforms in the first stop; anything else runs the ramp.
    pub waveform_tint: Option<String>,
    /// The pane sizes, read once as the native layout's starting point (`layout.rs`).
    pub sidebar_width: Option<f32>,
    pub tags_height: Option<f32>,
    pub panel_width: Option<f32>,
    pub player_height: Option<f32>,
    pub player_split: Option<f32>,
    /// The table's columns in order, and the sort: global, and remembered per folder.
    pub columns: Vec<crate::columns::SavedColumn>,
    pub sort_key: Option<String>,
    pub sort_dir: Option<String>,
    pub folder_sort: HashMap<String, crate::columns::Sort>,
    /// The library folders: where each is, and the label its relative paths start with.
    pub roots: Vec<Root>,
    /// The folder the explorer was left in, label-relative.
    pub last_dir: Option<String>,
    /// Playback from browsing: play on a click, carry on into the next file.
    pub play_on_select: bool,
    pub audition_on_arrow: bool,
    pub auto_advance: bool,
    /// Kinds and extensions the table is narrowed to (`typeFilter`), persisted.
    pub type_filter: TypeFilter,
    /// The dice: favour what has not been rated yet, or leave rated files out entirely.
    pub random_favour_unrated: bool,
    pub random_skip_rated: bool,
    /// The output level, 0..1; absent is full.
    pub volume: Option<f32>,
    /// What a play queues: the file's folder, or the list on screen.
    pub queue_source: Option<String>,
    pub always_on_top: bool,
    /// Developer: the gate, and the switch that makes the next launch a new install.
    pub developer_mode: bool,
    pub reset_on_launch: bool,
    /// Whether the first-run tour has been seen or skipped.
    pub tutorial_seen: bool,
    /// The Electron app's output choice, whose label the native app follows until it is given
    /// one of its own (`nativeOutputDevice`; empty there is an explicit system default). Kept
    /// apart because the Electron id is Chromium's, which a native device has no way to name.
    pub output_device: Option<OutputDevice>,
    pub native_output_device: Option<String>,
    /// This install's identity on the tailnet; never imported, never shared.
    pub device_id: Option<String>,
    /// Serve this library to the tailnet; keep doing it with the window closed. Absent is on.
    pub share_library: Option<bool>,
    pub run_in_background: Option<bool>,
    /// FL Studio's user data folder, for the plugin list; absent is where FL puts it.
    pub fl_user_data: Option<String>,
    /// Where files copied from other machines land.
    pub remote_download_dir: Option<String>,
    /// Where bundles are written; absent is beside the executable.
    pub bundle_export_dir: Option<String>,
    /// Whether the Stats page is in the sidebar; absent is yes.
    pub show_stats: Option<bool>,
    /// YT2MP3: "mp3", "source" or "video", and the MP3 bitrate.
    pub youtube_format: Option<String>,
    pub youtube_bitrate: Option<u32>,
    pub youtube_dir: Option<String>,
    /// LALAL.AI: the licence key (never exported), where stems go, their format and model.
    pub lalal_key: String,
    /// How many operations Undo remembers.
    pub undo_depth: Option<usize>,
    /// The visualizer panel beside the explorer (`panelOpen`); absent is open.
    pub panel_open: Option<bool>,
    /// The accent and background the theme is derived from; absent is the stock theme.
    pub theme_primary: Option<String>,
    pub theme_background: Option<String>,
    pub stem_output_dir: String,
    pub stem_format: Option<String>,
    pub stem_splitter: Option<String>,
    /// Rebound keys, by action id.
    pub shortcuts: HashMap<String, String>,
    /// The folder tag that nominates folders for analysis, or none for everything.
    pub analysis_tag: Option<String>,
    /// Whether keys are guessed from the audio at all; absent is yes.
    pub detect_key_from_audio: Option<bool>,
    /// An external key detector, `{file}` its path; how many files are analysed at once; which
    /// detector and profile (Essentia's, in the Electron app).
    pub key_command: Option<String>,
    pub analysis_concurrency: Option<usize>,
    pub key_engine: Option<String>,
    pub key_profile: Option<String>,
}

#[derive(Deserialize, serde::Serialize, Clone, Default, Debug, PartialEq)]
pub struct TypeFilter {
    pub kinds: Vec<String>,
    pub exts: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub struct Root {
    pub path: String,
    pub label: String,
    /// Set on a library mounted from another machine (`root.remote`): not a folder here.
    #[serde(default)]
    pub remote: Option<serde_json::Value>,
}

impl Root {
    pub fn is_local(&self) -> bool {
        self.remote.as_ref().is_none_or(serde_json::Value::is_null)
    }
}

#[derive(Deserialize, serde::Serialize, Clone)]
pub struct QuickFolder {
    pub path: String,
    pub label: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UserData {
    pub settings: Settings,
    pub ratings: HashMap<String, u8>,
    pub tags: HashMap<String, Vec<String>>,
    /// Tempo and key worked out from the audio, folded in where a file declares none.
    #[serde(rename = "detectedBpm")]
    pub detected_bpm: HashMap<String, f64>,
    #[serde(rename = "detectedKey")]
    pub detected_key: HashMap<String, String>,
    /// How well the detected key fitted; under 0.55 it is drawn dimmed.
    #[serde(rename = "detectedKeyFit")]
    pub detected_key_fit: HashMap<String, f64>,
    pub notes: HashMap<String, String>,
    /// `annotatedAs`: the size and mtime of the file each rating, tag and note was made on, so a
    /// file moved outside umakbang can be told from a different one saved at the same path.
    #[serde(rename = "annotatedAs")]
    pub annotated_as: HashMap<String, (f64, f64)>,
}

impl UserData {
    /// A label-relative folder path (`SECRET SAUCE/2022`) as the absolute one tags are keyed by.
    pub fn absolute(&self, rel: &str) -> Option<String> {
        let (label, rest) = rel.split_once('/').unwrap_or((rel, ""));
        let root = self.settings.roots.iter().find(|r| r.label == label)?;
        let sep = if root.path.contains('\\') { '\\' } else { '/' };
        if rest.is_empty() {
            return Some(root.path.clone());
        }
        let mut path = root.path.trim_end_matches(['\\', '/']).to_string();
        for segment in rest.split('/') {
            path.push(sep);
            path.push_str(segment);
        }
        Some(path)
    }

    /// An absolute path as a label-relative one, if it is inside a library folder.
    pub fn relative(&self, absolute: &str) -> Option<String> {
        let lower = absolute.to_lowercase().replace('\\', "/");
        for root in &self.settings.roots {
            let base = root.path.to_lowercase().replace('\\', "/");
            let base = base.trim_end_matches('/');
            if lower == base {
                return Some(root.label.clone());
            }
            if let Some(rest) = lower.strip_prefix(&format!("{base}/")) {
                // Cut from the original spelling, not the lowercased one.
                let tail = &absolute.replace('\\', "/")[absolute.len() - rest.len()..];
                return Some(format!("{}/{}", root.label, tail));
            }
        }
        None
    }

    /// `resetOnLaunch` (`enterFirstRun` / `leaveFirstRun` in `store.ts`): before anything is
    /// read, the real profile is moved aside as `umakbang-data.stashed.json` - once, never over
    /// a stash already there - and the app runs on a fresh document; with the switch off and a
    /// stash present, it is moved back with the switch forced off.
    pub fn prepare(path: &Path) {
        let Some(dir) = path.parent() else { return };
        let stash = dir.join("umakbang-data.stashed.json");
        let armed = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|doc| doc.get("settings")?.get("resetOnLaunch")?.as_bool())
            .unwrap_or(false);
        if armed {
            // A profile that could not be set aside is a reason not to proceed.
            if !stash.exists() && path.exists() && std::fs::rename(path, &stash).is_err() {
                return;
            }
            let fresh = serde_json::json!({ "settings": { "developerMode": true, "resetOnLaunch": true }, "tags": {}, "ratings": {}, "notes": {}, "detectedBpm": {}, "detectedKey": {}, "detectedKeyFit": {}, "annotatedAs": {} });
            let _ = std::fs::write(path, serde_json::to_string_pretty(&fresh).unwrap_or_default());
        } else if stash.exists() {
            if path.exists() && std::fs::rename(path, dir.join("umakbang-data.discarded-first-run.json")).is_err() {
                return;
            }
            if std::fs::rename(&stash, path).is_err() {
                return;
            }
            if let Some(mut doc) = std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok()) {
                if let Some(settings) = doc.get_mut("settings").and_then(|s| s.as_object_mut()) {
                    settings.insert("resetOnLaunch".into(), serde_json::Value::Bool(false));
                }
                let _ = std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap_or_default());
            }
        }
    }

    pub fn load(path: &Path) -> UserData {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Files per star, five first - the sidebar's rating rows.
    pub fn star_counts(&self) -> [usize; 5] {
        let mut counts = [0usize; 5];
        for &rating in self.ratings.values() {
            if (1..=5).contains(&rating) {
                counts[5 - rating as usize] += 1;
            }
        }
        counts
    }

    /// Every tag with how many files and folders carry it, most used first - the tag strip.
    pub fn tag_counts(&self) -> Vec<(String, usize)> {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for tags in self.tags.values() {
            for tag in tags {
                *counts.entry(tag).or_default() += 1;
            }
        }
        let mut list: Vec<(String, usize)> = counts.into_iter().map(|(t, n)| (t.to_string(), n)).collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        list
    }
}
