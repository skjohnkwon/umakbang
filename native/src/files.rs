//! What a file is from its extension: `shared/files.ts`.

use crate::library::FileRow;
use std::path::Path;

/// What the Electron app's `<audio>` element plays (AIFF through its rewrap). The native
/// player decodes the same set.
pub const PLAYABLE: &[&str] = &["wav", "wave", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "mp4", "aif", "aiff", "aifc", "webm"];
/// Audio indexed but not decodable: listed, greyed out, still revealable.
pub const UNPLAYABLE_AUDIO: &[&str] = &["wma", "ape", "wv", "rex", "rx2"];
pub const MIDI: &[&str] = &["mid", "midi"];
/// DAW sessions, so the library shows where the work actually lives.
pub const PROJECT: &[&str] = &[
    "als", "alp", "flp", "logicx", "ptx", "ptf", "cpr", "npr", "rpp", "song", "band", "mmp", "mmpz", "sesx", "reason", "rns", "dawproject", "bwproject", "omg", "ssnd",
];
pub const ARCHIVE: &[&str] = &["zip", "rar", "7z"];
/// Never worth walking into.
pub const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "$recycle.bin", "system volume information", ".trashes", ".trash", ".spotlight-v100", ".fseventsd", ".documentrevisions-v100",
    ".temporaryitems", "__macosx", "ableton project info", "freeze files",
];

/// `extensionOf`: lowercased, and none for a leading-dot name.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn is_indexable(ext: &str) -> bool {
    [PLAYABLE, UNPLAYABLE_AUDIO, MIDI, PROJECT, ARCHIVE].iter().any(|list| list.contains(&ext))
}

pub fn is_playable(ext: &str) -> bool {
    PLAYABLE.contains(&ext)
}

/// `classifyKind`: from the extension alone, never a guess at purpose.
pub fn kind_of(ext: &str) -> &'static str {
    if PROJECT.contains(&ext) {
        "project"
    } else if MIDI.contains(&ext) {
        "midi"
    } else if ARCHIVE.contains(&ext) {
        "archive"
    } else {
        "audio"
    }
}

/// A file on disk as a row, from its metadata alone - for folders the index does not cover,
/// like Downloads. `dir` is what the row reports as its folder.
pub fn describe(path: &Path, dir: &str) -> Option<FileRow> {
    let name = path.file_name()?.to_str()?.to_string();
    let ext = extension_of(&name);
    if !is_indexable(&ext) {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
    Some(FileRow {
        path: path.to_str()?.to_string(),
        name,
        kind: kind_of(&ext).to_string(),
        playable: is_playable(&ext),
        ext,
        size: meta.len() as i64,
        mtime,
        duration: None,
        bpm: None,
        musical_key: None,
        sample_rate: None,
        bit_depth: None,
        channels: None,
        bitrate: None,
        project_seconds: None,
        project_created: None,
        probed: false,
        dir: dir.to_string(),
    })
}

/// The OS Downloads folder, wherever the user has moved it - what `app.getPath('downloads')`
/// answers.
#[cfg(windows)]
pub fn downloads_dir() -> Option<std::path::PathBuf> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Downloads, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: the shell allocates the string; it is read up to its terminator and then freed.
    unsafe {
        if SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT as _, std::ptr::null_mut(), &mut raw) == 0 && !raw.is_null() {
            let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
            let path = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
            CoTaskMemFree(raw as *const _);
            return Some(path.into());
        }
        if !raw.is_null() {
            CoTaskMemFree(raw as *const _);
        }
    }
    std::env::var("USERPROFILE").ok().map(|home| Path::new(&home).join("Downloads"))
}

/// `~/Downloads`: macOS never moves it, it only localises the name Finder shows.
#[cfg(not(windows))]
pub fn downloads_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|home| Path::new(&home).join("Downloads"))
}

/// The Downloads folder's indexable files, newest first: listed on demand, never indexed - it
/// is a staging area you file things out of.
pub fn list_downloads() -> Vec<FileRow> {
    let Some(dir) = downloads_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut rows: Vec<FileRow> = entries.filter_map(|e| describe(&e.ok()?.path(), "")).collect();
    rows.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    rows
}

/// A file's mtime as Node's `mtimeMs` computes it - seconds times a thousand plus nanoseconds
/// over a million, in doubles - so a time recorded by the Electron app compares equal.
pub fn node_mtime_ms(time: std::time::SystemTime) -> Option<f64> {
    let d = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6)
}

/// Two mtimes the same file would give, computed by two programs' arithmetic.
pub fn same_mtime(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.01
}
