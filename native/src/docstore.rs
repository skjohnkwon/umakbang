//! Writing `umakbang-data.json` - the one file nobody can rebuild: months of ratings, tags and
//! notes.
//!
//! The Electron app owns the same document, and while both exist either can be running (the
//! Electron one lives in the tray from login). So nothing here writes a whole document from
//! memory. Each change is recorded as a patch - set or remove one entry - and a flush re-reads
//! the file from disk, applies the patches on top, and writes that. Whatever the other app wrote
//! in between survives, apart from the entries this one changed. (The Electron app is not so
//! careful: it writes its own copy whole, so a change made here while it runs is lost on its
//! next save. Quitting it from the tray is what makes edits here stick.)
//!
//! The first write of a session is preceded by a snapshot under the Electron app's own backup
//! name (`umakbang-data.backup-<stamp>.json`, newest twelve kept), so the two share one place to
//! look and one trim.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_BACKUPS: usize = 12;
const BACKUP_PREFIX: &str = "umakbang-data.backup-";
/// Changes are batched: a burst of ratings is one write, as the Electron store debounces.
pub const DEBOUNCE: Duration = Duration::from_millis(400);

/// One entry of the document: `["ratings", "<path>"]`, `["settings", "folderSort"]`.
struct Patch {
    at: [String; 2],
    value: Option<Value>,
}

pub struct DocStore {
    path: PathBuf,
    pending: Vec<Patch>,
    due: Option<Instant>,
    backed_up: bool,
}

impl DocStore {
    pub fn new(path: &Path) -> DocStore {
        DocStore { path: path.to_path_buf(), pending: Vec::new(), due: None, backed_up: false }
    }

    /// Sets `section.key` to `value`, or removes it for `None`.
    pub fn set(&mut self, section: &str, key: &str, value: Option<Value>) {
        // A later change to the same entry replaces an earlier one still waiting.
        self.pending.retain(|p| !(p.at[0] == section && p.at[1] == key));
        self.pending.push(Patch { at: [section.to_string(), key.to_string()], value });
        self.due = Some(Instant::now() + DEBOUNCE);
    }

    /// When the next write is due, for the event loop's timer.
    pub fn due(&self) -> Option<Instant> {
        self.due
    }

    /// Writes now if the debounce has run out (or `force`, on the way out).
    pub fn flush(&mut self, force: bool) {
        let Some(due) = self.due else { return };
        if !force && Instant::now() < due {
            return;
        }
        self.due = None;
        let raw = std::fs::read_to_string(&self.path).unwrap_or_default();
        let mut doc: Value = serde_json::from_str(&raw).unwrap_or_else(|_| Value::Object(Map::new()));
        // A document that exists and does not parse is left alone: writing over it would turn a
        // read error into lost data.
        if !raw.trim().is_empty() && !doc.is_object() {
            return;
        }
        if !raw.is_empty() && !self.backed_up {
            self.backup(&raw);
            self.backed_up = true;
        }
        let Some(root) = doc.as_object_mut() else { return };
        for patch in self.pending.drain(..) {
            let section = root.entry(patch.at[0].clone()).or_insert_with(|| Value::Object(Map::new()));
            if !section.is_object() {
                *section = Value::Object(Map::new());
            }
            let Some(section) = section.as_object_mut() else { continue };
            match patch.value {
                Some(value) => {
                    section.insert(patch.at[1].clone(), value);
                }
                None => {
                    section.remove(&patch.at[1]);
                }
            }
        }
        let Ok(text) = serde_json::to_string(&doc) else { return };
        // Through a temporary file, as `writeJsonAtomic` does, so a crash mid-write cannot
        // truncate the real one.
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    fn backup(&self, raw: &str) {
        let Some(dir) = self.path.parent() else { return };
        let stamp = crate::localtime::stamp();
        let _ = std::fs::write(dir.join(format!("{BACKUP_PREFIX}{stamp}.json")), raw);
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut kept: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|name| name.starts_with(BACKUP_PREFIX) && name.ends_with(".json"))
            .collect();
        // Fixed-width, big-endian stamps: lexical order is chronological.
        kept.sort();
        for stale in kept.iter().take(kept.len().saturating_sub(MAX_BACKUPS)) {
            let _ = std::fs::remove_file(dir.join(stale));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_land_on_what_is_on_disk() {
        let dir = std::env::temp_dir().join(format!("umakbang-docstore-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("umakbang-data.json");
        std::fs::write(&path, r#"{"ratings":{"a":3,"b":2},"settings":{"x":1}}"#).unwrap();
        let mut store = DocStore::new(&path);
        store.set("ratings", "a", Some(Value::from(5)));
        // The other app writes in between: its change must survive ours.
        std::fs::write(&path, r#"{"ratings":{"a":3,"b":4},"settings":{"x":2}}"#).unwrap();
        store.set("ratings", "b", None);
        store.set("ratings", "c", Some(Value::from(1)));
        store.flush(true);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["ratings"], serde_json::json!({"a": 5, "c": 1}));
        assert_eq!(doc["settings"]["x"], 2);
        let backups = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(BACKUP_PREFIX)).count();
        assert_eq!(backups, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
