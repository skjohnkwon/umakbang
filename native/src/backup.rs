//! Backups (`shared/backup.ts`, `shared/bundle.ts`, `main/bundle.ts`, `auto-backup.ts`).
//!
//! A settings backup is everything path-keyed - tags, ratings, notes, detected tempo and key,
//! quick-access folders - plus the preferences that carry no path. Importing one from another
//! machine is a mapping problem, not a merge: `Z:\SAMPLES\...` is not a place on a Mac, so every
//! path goes through a folder mapping the wizard builds, asking only about what it cannot work
//! out, and nothing guessed is believed until the disk agrees.
//!
//! A bundle (`.umak`) is the whole profile in one gzip stream of NDJSON: a header line, then
//! sections - the settings backup, each library folder's index, the probe cache, the waveforms.
//! The format is the Electron app's exactly, so a bundle from either restores in either. Here the
//! index lines are written from the database rather than copied from a file.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub type Mapping = BTreeMap<String, String>;

/// Settings that describe this machine rather than how somebody works (`LOCAL_ONLY`): never
/// exported, never imported.
pub const LOCAL_ONLY: [&str; 16] = [
    "roots", "recentRoots", "lastDir", "windowBounds", "windowMaximized", "visualizerOnly", "keyCommand", "lalalKey", "bundleExportDir", "outputDevice", "developerMode", "resetOnLaunch", "deviceId",
    "shareLibrary", "runInBackground", "nativeOutputDevice",
];

/// Settings that are paths on one machine (`MACHINE_PATH_SETTINGS`): left out of a sync.
pub const MACHINE_PATHS: [&str; 5] = ["stemOutputDir", "remoteDownloadDir", "flUserData", "youtubeDir", "quickMove"];

/* ------------------------------------------------------------------ paths */

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Style {
    Windows,
    Posix,
}

pub fn style_of(path: &str) -> Style {
    let b = path.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if drive || path.starts_with("\\\\") || path.contains('\\') { Style::Windows } else { Style::Posix }
}

fn separator(path: &str) -> char {
    if style_of(path) == Style::Windows { '\\' } else { '/' }
}

fn trim(path: &str) -> &str {
    path.trim_end_matches(['\\', '/'])
}

fn normalise(path: &str) -> String {
    trim(path).to_lowercase()
}

/// `isUnderKey`: the same folder or inside it, either separator.
fn is_under(path: &str, folder: &str) -> bool {
    let (p, f) = (normalise(path).replace('\\', "/"), normalise(folder).replace('\\', "/"));
    p == f || (p.starts_with(&f) && p.as_bytes().get(f.len()) == Some(&b'/'))
}

pub fn last_segment(path: &str) -> String {
    path.split(['\\', '/']).filter(|s| !s.is_empty()).next_back().unwrap_or(path).to_string()
}

fn segments(path: &str) -> Vec<&str> {
    path.split(['\\', '/']).filter(|s| !s.is_empty()).collect()
}

/// The folder above, or None at a drive or a share's root.
fn parent_of(path: &str) -> Option<String> {
    let trimmed = trim(path);
    let cut = trimmed.rfind(['\\', '/'])?;
    if cut == 0 {
        return None;
    }
    let head = &trimmed[..cut];
    let hb = head.as_bytes();
    if hb.len() == 2 && hb[0].is_ascii_alphabetic() && hb[1] == b':' {
        return None;
    }
    if head.starts_with("\\\\") && !head[2..].contains('\\') {
        return None;
    }
    Some(head.to_string())
}

pub fn join_path(base: &str, parts: &[&str]) -> String {
    let sep = separator(base).to_string();
    std::iter::once(trim(base)).chain(parts.iter().copied().filter(|s| !s.is_empty())).collect::<Vec<_>>().join(&sep)
}

fn relative_under(path: &str, folder: &str) -> String {
    path.get(trim(folder).len()..).unwrap_or("").trim_start_matches(['\\', '/']).to_string()
}

fn same_name(a: &str, b: &str) -> bool {
    normalise(&last_segment(a)) == normalise(&last_segment(b))
}

/// `anchorsFor`: a located folder as ancestor correspondences - where the names agree going up,
/// the parents agree too - and, where they differ, the source's parent as the target itself.
pub fn anchors_for(source: &str, target: &str) -> Vec<(String, String)> {
    let mut anchors = vec![(source.to_string(), target.to_string())];
    let (mut here, mut there) = (source.to_string(), target.to_string());
    while same_name(&here, &there) {
        let (Some(up), Some(up_there)) = (parent_of(&here), parent_of(&there)) else { break };
        anchors.push((up.clone(), up_there.clone()));
        here = up;
        there = up_there;
    }
    if !same_name(source, target) {
        if let Some(up) = parent_of(source) {
            anchors.push((up, target.to_string()));
        }
    }
    anchors
}

/// `candidatesUnder`: where a folder might be inside `container`, its longest tail first. Drive
/// letters are no part of a tail.
pub fn candidates_under(folder: &str, container: &str, depth: usize) -> Vec<String> {
    let parts: Vec<&str> = segments(folder).into_iter().filter(|s| !(s.len() == 2 && s.ends_with(':'))).collect();
    (1..=depth.min(parts.len())).rev().map(|take| join_path(container, &parts[parts.len() - take..])).collect()
}

/// `proposeMapping`: for every folder not yet placed, where the confirmed ones say it should be.
pub fn propose(folders: &[String], confirmed: &Mapping) -> Vec<(String, Vec<String>)> {
    let pairs: Vec<(&String, &String)> = confirmed.iter().filter(|(_, t)| !t.is_empty()).collect();
    if pairs.is_empty() {
        return Vec::new();
    }
    let mut anchors: Vec<(String, String)> = pairs.iter().flat_map(|(s, t)| anchors_for(s, t)).collect();
    anchors.sort_by(|a, b| trim(&b.0).len().cmp(&trim(&a.0).len()));
    let chosen: Vec<&String> = pairs.iter().map(|(_, t)| *t).collect();
    let mut out = Vec::new();
    for folder in folders {
        if confirmed.get(folder).is_some_and(|t| !t.is_empty()) {
            continue;
        }
        let mut candidates: Vec<String> = Vec::new();
        let mut add = |path: String| {
            if !path.is_empty() && !candidates.iter().any(|c| normalise(c) == normalise(&path)) {
                candidates.push(path);
            }
        };
        for (source, target) in &anchors {
            if !is_under(folder, source) {
                continue;
            }
            let rest = relative_under(folder, source);
            add(if rest.is_empty() { target.clone() } else { join_path(target, &segments(&rest)) });
        }
        for container in &chosen {
            for guess in candidates_under(folder, container, 3) {
                add(guess);
            }
        }
        if !candidates.is_empty() {
            out.push((folder.clone(), candidates));
        }
    }
    out
}

/// `resolvePick`: a picked folder is the folder itself when the names agree, or the folder that
/// holds it.
pub fn resolve_pick(source: &str, picked: &str) -> Vec<String> {
    if same_name(source, picked) { vec![picked.to_string()] } else { vec![join_path(picked, &[&last_segment(source)]), picked.to_string()] }
}

/// `coveredBy`: the mapped folder this one sits inside, the nearest.
pub fn covered_by(folder: &str, mapping: &Mapping) -> Option<String> {
    let mut best: Option<&String> = None;
    for (source, target) in mapping {
        if target.is_empty() || normalise(source) == normalise(folder) || !is_under(folder, source) {
            continue;
        }
        if best.is_none_or(|b| trim(source).len() > trim(b).len()) {
            best = Some(source);
        }
    }
    best.cloned()
}

fn ordered(mapping: &Mapping) -> Vec<(&String, &String)> {
    let mut pairs: Vec<(&String, &String)> = mapping.iter().filter(|(_, t)| !t.is_empty()).collect();
    // Longest source first, so a subfolder mapped on its own wins over its parent.
    pairs.sort_by(|a, b| trim(b.0).len().cmp(&trim(a.0).len()));
    pairs
}

fn rewrite(path: &str, ordered: &[(&String, &String)]) -> Option<String> {
    for (source, target) in ordered {
        if !is_under(path, source) {
            continue;
        }
        let rest = path.get(trim(source).len()..).unwrap_or("").trim_start_matches(['\\', '/']);
        if rest.is_empty() {
            return Some((*target).clone());
        }
        let sep = separator(target).to_string();
        return Some(format!("{}{sep}{}", trim(target), rest.split(['\\', '/']).collect::<Vec<_>>().join(&sep)));
    }
    None
}

pub fn remap_path(path: &str, mapping: &Mapping) -> Option<String> {
    rewrite(path, &ordered(mapping))
}

/* ------------------------------------------------------------------ what a backup holds */

#[derive(Clone, Debug)]
pub struct Folder {
    pub path: String,
    pub label: String,
    pub library: bool,
    pub entries: usize,
}

#[derive(Clone, Debug)]
pub struct Summary {
    pub style: Style,
    pub folders: Vec<Folder>,
    pub orphans: usize,
}

const KEYED: [&str; 5] = ["tags", "ratings", "notes", "detectedBpm", "detectedKey"];

fn exported_roots(backup: &Value) -> Vec<(String, String)> {
    let mut roots: Vec<(String, String)> = backup
        .get("exportedRoots")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|r| Some((r.get("path")?.as_str()?.to_string(), r.get("label").and_then(Value::as_str).unwrap_or("").to_string()))).collect())
        .unwrap_or_default();
    if roots.is_empty() {
        if let Some(root) = backup.get("exportedRoot").and_then(Value::as_str) {
            roots.push((root.to_string(), last_segment(root)));
        }
    }
    roots
}

/// `summariseBackup`: the folders a backup refers to, library folders first among equals, and
/// how much hangs off each.
pub fn summarise(backup: &Value) -> Summary {
    let roots: Vec<String> = exported_roots(backup).into_iter().map(|(p, _)| p).collect();
    let keyed: Vec<String> = KEYED.iter().flat_map(|k| backup.get(*k).and_then(Value::as_object).map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()).collect();
    let settings = backup.get("settings").cloned().unwrap_or(json!({}));
    let mut extras: Vec<String> = settings.get("quickMove").and_then(Value::as_array).map(|a| a.iter().filter_map(|q| q.get("path")?.as_str().map(str::to_string)).collect()).unwrap_or_default();
    for key in ["stemOutputDir", "youtubeDir"] {
        if let Some(p) = settings.get(key).and_then(Value::as_str).filter(|p| !p.is_empty()) {
            extras.push(p.to_string());
        }
    }
    let sample = keyed.first().or(extras.first()).or(roots.first()).cloned().unwrap_or_default();
    let mut folders: Vec<Folder> = Vec::new();
    let remember = |path: &str, library: bool, folders: &mut Vec<Folder>| -> usize {
        if let Some(at) = folders.iter().position(|f| normalise(&f.path) == normalise(path)) {
            return at;
        }
        folders.push(Folder { path: path.to_string(), label: last_segment(path), library, entries: 0 });
        folders.len() - 1
    };
    for root in &roots {
        remember(root, true, &mut folders);
    }
    let mut orphans = 0;
    for path in &keyed {
        let folder = roots.iter().find(|r| is_under(path, r)).cloned().or_else(|| path.rfind(['\\', '/']).filter(|&c| c > 0).map(|c| path[..c].to_string()));
        match folder {
            Some(folder) => {
                let at = remember(&folder, false, &mut folders);
                folders[at].entries += 1;
            }
            None => orphans += 1,
        }
    }
    for path in &extras {
        remember(path, false, &mut folders);
    }
    folders.sort_by(|a, b| b.entries.cmp(&a.entries).then_with(|| a.path.cmp(&b.path)));
    Summary { style: style_of(&sample), folders, orphans }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Counts {
    pub tags: usize,
    pub ratings: usize,
    pub notes: usize,
    pub detected_bpm: usize,
    pub detected_key: usize,
    pub quick_move: usize,
}

impl Counts {
    pub fn entries(&self) -> usize {
        self.tags + self.ratings + self.detected_bpm + self.detected_key
    }
}

/// `remapBackup`: every path through the mapping; what has nowhere to go is dropped and counted.
pub fn remap(backup: &Value, mapping: &Mapping) -> (Value, Counts, Counts) {
    let order = ordered(mapping);
    let (mut kept, mut dropped) = (Counts::default(), Counts::default());
    let mut out = backup.clone();
    for key in KEYED {
        let mut next = Map::new();
        let mut moved = 0;
        let mut lost = 0;
        for (path, value) in backup.get(key).and_then(Value::as_object).into_iter().flatten() {
            match rewrite(path, &order) {
                Some(p) => {
                    next.insert(p, value.clone());
                    moved += 1;
                }
                None => lost += 1,
            }
        }
        let (k, d) = match key {
            "tags" => (&mut kept.tags, &mut dropped.tags),
            "ratings" => (&mut kept.ratings, &mut dropped.ratings),
            "notes" => (&mut kept.notes, &mut dropped.notes),
            "detectedBpm" => (&mut kept.detected_bpm, &mut dropped.detected_bpm),
            _ => (&mut kept.detected_key, &mut dropped.detected_key),
        };
        *k += moved;
        *d += lost;
        out[key] = Value::Object(next);
    }
    if let Some(settings) = out.get_mut("settings").and_then(Value::as_object_mut) {
        if let Some(quick) = settings.get("quickMove").and_then(Value::as_array).cloned() {
            let moved: Vec<Value> = quick
                .into_iter()
                .filter_map(|mut q| {
                    let next = q.get("path").and_then(Value::as_str).and_then(|p| rewrite(p, &order));
                    match next {
                        Some(p) => {
                            kept.quick_move += 1;
                            q["path"] = Value::from(p);
                            Some(q)
                        }
                        None => {
                            dropped.quick_move += 1;
                            None
                        }
                    }
                })
                .collect();
            settings.insert("quickMove".into(), Value::Array(moved));
        }
        for key in ["stemOutputDir", "youtubeDir"] {
            if let Some(p) = settings.get(key).and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string) {
                match rewrite(&p, &order) {
                    Some(next) => {
                        settings.insert(key.into(), Value::from(next));
                    }
                    None => {
                        settings.remove(key);
                    }
                }
            }
        }
    }
    (out, kept, dropped)
}

/* ------------------------------------------------------------------ applying */

/// `importBackup` and `adoptExportedRoots`, into the profile on disk: preferences merged over
/// this machine's (less what describes a machine), the path-keyed maps merged entry by entry,
/// and each library folder the mapping located opened - under the label the exporting machine
/// gave it, since its sorts, pins and exclusions were imported keyed by that label.
pub fn apply(data_path: &Path, backup: &Value, mapping: &Mapping) -> Result<(Counts, Counts, Vec<String>), String> {
    let (remapped, kept, dropped) = remap(backup, mapping);
    let raw = std::fs::read_to_string(data_path).unwrap_or_else(|_| "{}".into());
    let mut doc: Value = serde_json::from_str(&raw).map_err(|_| "The profile could not be read, so nothing was imported.".to_string())?;
    if !doc.is_object() {
        doc = json!({});
    }
    {
        let settings = doc.as_object_mut().unwrap().entry("settings").or_insert_with(|| json!({}));
        if let (Some(mine), Some(theirs)) = (settings.as_object_mut(), remapped.get("settings").and_then(Value::as_object)) {
            for (key, value) in theirs {
                if !LOCAL_ONLY.contains(&key.as_str()) {
                    mine.insert(key.clone(), value.clone());
                }
            }
        }
    }
    for key in KEYED {
        let section = doc.as_object_mut().unwrap().entry(key).or_insert_with(|| json!({}));
        if let (Some(mine), Some(theirs)) = (section.as_object_mut(), remapped.get(key).and_then(Value::as_object)) {
            for (path, value) in theirs {
                mine.insert(path.clone(), value.clone());
            }
        }
    }
    // The library folders it located, opened.
    let mut opened = Vec::new();
    let roots = doc["settings"].get("roots").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut roots = roots;
    for (source, label) in exported_roots(backup) {
        let Some(target) = mapping.get(&source).filter(|t| !t.is_empty()) else { continue };
        let open = roots.iter().any(|r| r.get("remote").is_none_or(Value::is_null) && r.get("path").and_then(Value::as_str).is_some_and(|p| is_under(target, p) || is_under(p, target)));
        if open || !Path::new(target).is_dir() {
            continue;
        }
        let taken: HashSet<String> = roots.iter().filter_map(|r| r.get("label")?.as_str().map(str::to_lowercase)).collect();
        let base = if label.is_empty() { last_segment(target) } else { label.clone() };
        let mut name = base.clone();
        let mut n = 2;
        while taken.contains(&name.to_lowercase()) {
            name = format!("{base} ({n})");
            n += 1;
        }
        roots.push(json!({ "path": target, "label": name }));
        opened.push(name);
    }
    doc["settings"]["roots"] = Value::Array(roots);
    write_atomic(data_path, &doc)?;
    Ok((kept, dropped, opened))
}

/// Another machine's newer preferences (`syncSettingsFromPeers`), less anything that describes a
/// machine or is a path on one, keeping the time *they* were changed - stamped with now, two
/// machines would take turns copying each other.
pub fn adopt_settings(data_path: &Path, theirs: &Value) -> Result<(), String> {
    let raw = std::fs::read_to_string(data_path).unwrap_or_else(|_| "{}".into());
    let mut doc: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let settings = doc.as_object_mut().ok_or("not an object")?.entry("settings").or_insert_with(|| json!({}));
    let mine = settings.as_object_mut().ok_or("not an object")?;
    for (key, value) in theirs.as_object().into_iter().flatten() {
        if !LOCAL_ONLY.contains(&key.as_str()) && !MACHINE_PATHS.contains(&key.as_str()) {
            mine.insert(key.clone(), value.clone());
        }
    }
    write_atomic(data_path, &doc)
}

fn write_atomic(path: &Path, doc: &Value) -> Result<(), String> {
    let text = serde_json::to_string(doc).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// `exportBackup`: the settings backup, version 2, from the profile on disk.
pub fn export_backup(data_path: &Path) -> Result<Value, String> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(data_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut settings = doc.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
    let roots = settings.get("roots").cloned().unwrap_or(json!([]));
    for key in LOCAL_ONLY {
        settings.remove(key);
    }
    let field = |k: &str| doc.get(k).cloned().unwrap_or(json!({}));
    Ok(json!({
        "kind": "umakbang-settings",
        "version": 2,
        "exportedAt": crate::localtime::iso_utc(crate::localtime::now()),
        "exportedRoot": roots.get(0).and_then(|r| r.get("path")).cloned().unwrap_or(Value::Null),
        "exportedRoots": roots,
        "settings": settings,
        "tags": field("tags"),
        "ratings": field("ratings"),
        "notes": field("notes"),
        "detectedBpm": field("detectedBpm"),
        "detectedKey": field("detectedKey"),
    }))
}

/* ------------------------------------------------------------------ bundles */

pub const AUTO_FILE: &str = "umakbang-auto.umak";

/// One bundle at a time: the daily one waits for a manual one, and the other way round.
static WRITING: AtomicBool = AtomicBool::new(false);

/// `umakbang-2026-07-27.umak`, in local time.
pub fn bundle_name() -> String {
    let p = crate::localtime::parts(crate::localtime::now());
    match p {
        Some(p) => format!("umakbang-{:04}-{:02}-{:02}.umak", p.year, p.month, p.day),
        None => "umakbang.umak".into(),
    }
}

/// Where bundles go when nobody has said: beside the executable, as the Electron app keeps them,
/// or the profile's folder when that is not writable.
pub fn default_dir(data_dir: &Path) -> PathBuf {
    if let Some(beside) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("backups"))) {
        // Writability proved by writing, not by asking.
        let probe = beside.join(".umakbang-write-test");
        if std::fs::create_dir_all(&beside).is_ok() && std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return beside;
        }
    }
    data_dir.join("backups")
}

pub fn looks_like_bundle(file: &Path) -> bool {
    let mut head = [0u8; 2];
    std::fs::File::open(file).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)).is_ok() && head == [0x1f, 0x8b]
}

fn lines(file: &Path) -> std::io::Result<impl Iterator<Item = std::io::Result<String>>> {
    let reader = std::io::BufReader::with_capacity(1 << 20, flate2::read::GzDecoder::new(std::fs::File::open(file)?));
    Ok(reader.lines())
}

pub fn read_header(file: &Path) -> Option<Value> {
    let first = lines(file).ok()?.find(|l| l.as_ref().is_ok_and(|l| !l.is_empty()))?.ok()?;
    let header: Value = serde_json::from_str(&first).ok()?;
    (header.get("kind").and_then(Value::as_str) == Some("umakbang-bundle") && header.get("version").and_then(Value::as_u64) == Some(1)).then_some(header)
}

/// `writeBundle`: header, the settings backup, each local library folder's index (written from
/// the database, in `Track` lines), an empty journal after each since the database has none, the
/// Electron app's probe cache and waveforms when they are there. Written to `.part` and renamed,
/// so a failed export never sits on disk looking complete.
pub fn write_bundle(file: &Path, data_path: &Path, db: &Path) -> Result<(), String> {
    if WRITING.swap(true, Ordering::SeqCst) {
        return Err("A bundle is already being written.".into());
    }
    let result = write_inner(file, data_path, db);
    WRITING.store(false, Ordering::SeqCst);
    result
}

fn write_inner(file: &Path, data_path: &Path, db: &Path) -> Result<(), String> {
    let backup = export_backup(data_path)?;
    let data_dir = data_path.parent().unwrap_or(Path::new("."));
    let roots: Vec<(String, String)> = backup
        .get("exportedRoots")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|r| r.get("remote").is_none_or(Value::is_null)).filter_map(|r| Some((r.get("path")?.as_str()?.to_string(), r.get("label")?.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    let metadata = data_dir.join("umakbang-metadata-cache.ndjson");
    let peaks: Vec<(String, Value)> = std::fs::read_to_string(data_dir.join("umakbang-peaks-cache.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .map(|m| m.into_iter().filter_map(|(p, e)| Some((p, e.get("data")?.clone()))).collect())
        .unwrap_or_default();
    let count = |k: &str| backup.get(k).and_then(Value::as_object).map_or(0, |m| m.len());
    let header = json!({
        "kind": "umakbang-bundle",
        "version": 1,
        "exportedAt": crate::localtime::iso_utc(crate::localtime::now()),
        "app": env!("CARGO_PKG_VERSION"),
        "style": "windows",
        "exportedRoots": backup.get("exportedRoots").cloned().unwrap_or(json!([])),
        "counts": { "tags": count("tags"), "ratings": count("ratings"), "detectedBpm": count("detectedBpm"), "detectedKey": count("detectedKey"), "peaks": peaks.len(), "cacheBytes": std::fs::metadata(&metadata).map(|m| m.len()).unwrap_or(0) },
    });
    let part = PathBuf::from(format!("{}.part", file.display()));
    let outcome = (|| -> Result<(), String> {
        let out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut gz = flate2::write::GzEncoder::new(std::io::BufWriter::with_capacity(1 << 20, out), flate2::Compression::default());
        let line = |gz: &mut flate2::write::GzEncoder<std::io::BufWriter<std::fs::File>>, value: &Value| -> Result<(), String> {
            serde_json::to_writer(&mut *gz, value).map_err(|e| e.to_string())?;
            gz.write_all(b"\n").map_err(|e| e.to_string())
        };
        line(&mut gz, &header)?;
        line(&mut gz, &json!({ "section": "settings" }))?;
        line(&mut gz, &backup)?;
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
        for (path, label) in &roots {
            line(&mut gz, &json!({ "section": "index", "root": path }))?;
            let sql = format!("SELECT {} FROM tracks t JOIN folders f ON f.id = t.folder WHERE f.path = ?1 OR (f.path >= ?2 AND f.path < ?3)", crate::server::TRACK_COLUMNS);
            let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows = statement.query(rusqlite::params![label, format!("{label}/"), format!("{label}0")]).map_err(|e| e.to_string())?;
            while let Ok(Some(row)) = rows.next() {
                if let Ok(track) = crate::server::track_of(row) {
                    serde_json::to_writer(&mut gz, &track).map_err(|e| e.to_string())?;
                    gz.write_all(b"\n").map_err(|e| e.to_string())?;
                }
            }
            line(&mut gz, &json!({ "section": "indexPatch", "root": path }))?;
        }
        line(&mut gz, &json!({ "section": "metadata" }))?;
        if let Ok(file) = std::fs::File::open(&metadata) {
            for l in std::io::BufReader::new(file).lines().map_while(Result::ok).filter(|l| !l.is_empty()) {
                gz.write_all(l.as_bytes()).and_then(|_| gz.write_all(b"\n")).map_err(|e| e.to_string())?;
            }
        }
        line(&mut gz, &json!({ "section": "peaks" }))?;
        for (p, d) in &peaks {
            line(&mut gz, &json!({ "p": p, "d": d }))?;
        }
        let mut inner = gz.finish().map_err(|e| e.to_string())?;
        inner.flush().map_err(|e| e.to_string())
    })();
    if let Err(e) = outcome {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, file).map_err(|e| e.to_string())
}

pub struct Restored {
    pub backup: Option<Value>,
    /// Library folders whose index went straight into the database.
    pub restored: Vec<String>,
    /// Ones that are not on this machine, left for a scan.
    pub skipped: Vec<String>,
}

/// `restoreBundle`, for a bundle whose library folders are all here: the settings backup, and
/// each folder's index into the database so it opens indexed rather than rescanning. With any
/// folder missing, only the settings are read - the wizard places them first.
pub fn restore(file: &Path, db: &Path, take_indexes: bool) -> Result<Restored, String> {
    let header = read_header(file).ok_or("That doesn't look like a umakbang bundle.")?;
    let mut out = Restored { backup: None, restored: Vec::new(), skipped: Vec::new() };
    let labels: BTreeMap<String, String> = header
        .get("exportedRoots")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|r| Some((r.get("path")?.as_str()?.to_string(), r.get("label")?.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    let mut section = String::new();
    let mut root: Option<String> = None;
    let mut rows: Vec<Value> = Vec::new();
    let library = if take_indexes { Some(crate::library::Library::open(db).map_err(|e| e.to_string())?) } else { None };
    let commit = |root: &Option<String>, rows: &mut Vec<Value>, out: &mut Restored| {
        if let (Some(root), Some(library)) = (root, library.as_ref()) {
            let label = labels.get(root).cloned().unwrap_or_else(|| last_segment(root));
            let filed = crate::remote::rows_from_tracks(std::mem::take(rows), root, &label);
            library.replace_remote(&label, &filed);
            if !out.restored.contains(root) {
                out.restored.push(root.clone());
            }
        }
        rows.clear();
    };
    for (i, line) in lines(file).map_err(|e| e.to_string())?.enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        if i == 0 || line.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(next) = parsed.get("section").and_then(Value::as_str) {
            if section == "index" {
                commit(&root, &mut rows, &mut out);
            }
            section = next.to_string();
            root = None;
            if next == "index" {
                let path = parsed.get("root").and_then(Value::as_str).unwrap_or("").to_string();
                if take_indexes && Path::new(&path).is_dir() {
                    root = Some(path);
                } else if !out.skipped.contains(&path) && !path.is_empty() {
                    out.skipped.push(path);
                }
            }
            continue;
        }
        match section.as_str() {
            "settings" => out.backup = Some(parsed),
            "index" if root.is_some() => rows.push(parsed),
            _ => {}
        }
    }
    if section == "index" {
        commit(&root, &mut rows, &mut out);
    }
    Ok(out)
}

/// Whether every library folder a bundle names is on this machine.
pub fn all_present(header: &Value) -> bool {
    header.get("exportedRoots").and_then(Value::as_array).is_none_or(|a| a.iter().filter(|r| r.get("remote").is_none_or(Value::is_null)).all(|r| r.get("path").and_then(Value::as_str).is_some_and(|p| Path::new(p).is_dir())))
}

/* ------------------------------------------------------------------ the daily backup */

/// `initAutoBackup`: once a day, a bundle on its own. The clock is the file's own mtime, so
/// nothing is stored; the check is hourly, the first five minutes in, never over a scan.
pub fn auto_backup(data_path: PathBuf, db: PathBuf) {
    let _ = std::thread::Builder::new().name("auto-backup".into()).spawn(move || {
        let hurry = std::env::var("UMAKBANG_BACKUP_NOW").is_ok();
        std::thread::sleep(std::time::Duration::from_secs(if hurry { 2 } else { 300 }));
        loop {
            let due = (|| -> Option<PathBuf> {
                let doc: Value = serde_json::from_str(&std::fs::read_to_string(&data_path).ok()?).ok()?;
                if doc.pointer("/settings/roots").and_then(Value::as_array).is_none_or(|r| r.is_empty()) || crate::scan::scanning() {
                    return None;
                }
                let parent = data_path.parent()?;
                let dir = doc.pointer("/settings/bundleExportDir").and_then(Value::as_str).filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| default_dir(parent));
                let file = dir.join(AUTO_FILE);
                let fresh = std::fs::metadata(&file).and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age.as_secs() < 24 * 3600);
                if fresh {
                    return None;
                }
                std::fs::create_dir_all(&dir).ok()?;
                Some(file)
            })();
            if let Some(file) = due {
                let _ = write_bundle(&file, &data_path, &db);
            }
            std::thread::sleep(std::time::Duration::from_secs(if hurry { 2 } else { 3600 }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_walk_up_while_names_agree() {
        let a = anchors_for(r"Z:\SAMPLES\Drums", "/Users/jk/Music/Drums");
        assert!(a.contains(&(r"Z:\SAMPLES".to_string(), "/Users/jk/Music".to_string())));
    }

    #[test]
    fn one_answer_places_the_rest() {
        let folders = vec![r"Z:\SAMPLES\Drums".to_string(), r"Z:\SAMPLES\Keys".to_string()];
        let mut confirmed = Mapping::new();
        confirmed.insert(folders[0].clone(), "/Users/jk/Music/Drums".into());
        let proposals = propose(&folders, &confirmed);
        assert_eq!(proposals[0].0, folders[1]);
        assert_eq!(proposals[0].1[0], "/Users/jk/Music/Keys");
    }

    #[test]
    fn remaps_longest_first_and_drops_the_rest() {
        let backup = json!({ "settings": { "quickMove": [{ "path": "Z:\\SAMPLES\\Kicks", "label": "Kicks" }] }, "tags": { "Z:\\SAMPLES\\a.wav": ["x"], "Y:\\other\\b.wav": ["y"] }, "ratings": { "Z:\\SAMPLES\\Kicks\\k.wav": 4 } });
        let mut mapping = Mapping::new();
        mapping.insert("Z:\\SAMPLES".into(), "/Users/jk/S".into());
        mapping.insert("Z:\\SAMPLES\\Kicks".into(), "/Volumes/K".into());
        let (out, kept, dropped) = remap(&backup, &mapping);
        assert_eq!(out["tags"]["/Users/jk/S/a.wav"], json!(["x"]));
        assert_eq!(out["ratings"]["/Volumes/K/k.wav"], json!(4));
        assert_eq!(out["settings"]["quickMove"][0]["path"], json!("/Volumes/K"));
        assert_eq!((kept.tags, dropped.tags, kept.ratings), (1, 1, 1));
    }

    #[test]
    fn applies_into_a_profile() {
        let dir = std::env::temp_dir().join(format!("umakbang-apply-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Library")).unwrap();
        let data = dir.join("umakbang-data.json");
        std::fs::write(&data, serde_json::to_string(&json!({ "settings": { "deviceId": "mine", "lalalKey": "secret", "roots": [] }, "tags": { r"C:\x.wav": ["old"] }, "ratings": {} })).unwrap()).unwrap();
        let backup = json!({ "kind": "umakbang-settings", "version": 2, "exportedRoots": [{ "path": "/Users/jk/Library", "label": "My Library" }],
            "settings": { "deviceId": "theirs", "lalalKey": "theirs", "themePrimary": "#123456" }, "tags": { "/Users/jk/Library/a.wav": ["new"] }, "ratings": { "/Users/jk/Library/a.wav": 4 }, "detectedBpm": {}, "detectedKey": {} });
        let target = dir.join("Library").to_string_lossy().into_owned();
        let mapping = Mapping::from([("/Users/jk/Library".to_string(), target.clone())]);
        let (kept, _, opened) = apply(&data, &backup, &mapping).unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&data).unwrap()).unwrap();
        assert_eq!(doc["settings"]["deviceId"], json!("mine"));
        assert_eq!(doc["settings"]["lalalKey"], json!("secret"));
        assert_eq!(doc["settings"]["themePrimary"], json!("#123456"));
        assert_eq!(doc["tags"][r"C:\x.wav"], json!(["old"]));
        assert_eq!(doc["tags"][format!("{target}{}a.wav", std::path::MAIN_SEPARATOR)], json!(["new"]));
        assert_eq!(doc["settings"]["roots"][0]["label"], json!("My Library"));
        assert_eq!((kept.tags, kept.ratings, opened.len()), (1, 1, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn candidates_skip_drive_letters() {
        assert_eq!(candidates_under(r"Z:\SAMPLES\Drums", "/m", 3), vec!["/m/SAMPLES/Drums".to_string(), "/m/Drums".to_string()]);
        assert_eq!(covered_by(r"Z:\S\a", &Mapping::from([(r"Z:\S".to_string(), "/x".to_string())])).as_deref(), Some(r"Z:\S"));
    }
}
