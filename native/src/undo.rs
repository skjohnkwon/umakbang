//! Undo and redo for file operations (`main/undo.ts`): moves, copies, renames and new folders.
//! Deletes are not here - they go to the Recycle Bin, which is its own undo.
//!
//! Each record keeps every file it touched with the size and mtime it had afterwards. Before
//! anything is put back, each is checked: a file that has gone, or been changed since, is left
//! where it is and said so, rather than undone over somebody's newer work. And a file is never
//! put back onto something that has appeared where it came from.

use crate::fsops::{Moved, Outcome};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Move,
    Copy,
    Rename,
    NewFolder,
}

#[allow(dead_code)]
impl Kind {
    fn verb(self) -> &'static str {
        match self {
            Kind::Move => "Move",
            Kind::Copy => "Copy",
            Kind::Rename => "Rename",
            Kind::NewFolder => "New Folder",
        }
    }
}

#[derive(Clone, Debug)]
struct Entry {
    at: PathBuf,
    size: u64,
    mtime: Option<SystemTime>,
}

#[derive(Clone, Debug)]
pub struct Record {
    pub kind: Kind,
    moves: Vec<Moved>,
    items: Vec<Entry>,
    /// Where the first thing came from: where an undone move lands the view.
    pub origin_dir: PathBuf,
}

#[allow(dead_code)]
impl Record {
    pub fn label(&self, verb: &str) -> String {
        match self.items.len() {
            0 => format!("{verb} {}", self.kind.verb()),
            1 => format!("{verb} {} (1 file)", self.kind.verb()),
            n => format!("{verb} {} ({n} files)", self.kind.verb()),
        }
    }
}

/// What reversing a record did.
#[derive(Default)]
pub struct Reversal {
    /// The moves made putting things back, for the library and the annotations to follow.
    pub moves: Vec<Moved>,
    /// Copies sent to the Recycle Bin, reported as moves to nowhere.
    pub removed: Outcome,
    pub restored: usize,
    pub total: usize,
    pub failures: Vec<String>,
    #[allow(dead_code)]
    pub kind: Option<Kind>,
    pub landed: Option<PathBuf>,
}

pub struct History {
    undo: Vec<Record>,
    redo: Vec<Record>,
    limit: usize,
}

impl Default for History {
    fn default() -> History {
        History { undo: Vec::new(), redo: Vec::new(), limit: 25 }
    }
}

fn files_under(path: &Path, out: &mut Vec<Entry>) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                files_under(&entry.path(), out);
            }
        }
    } else {
        out.push(Entry { at: path.to_path_buf(), size: meta.len(), mtime: meta.modified().ok() });
    }
}

fn is_at_or_under(path: &Path, base: &Path) -> bool {
    let (a, b) = (path.to_string_lossy().to_lowercase(), base.to_string_lossy().to_lowercase());
    let b = b.trim_end_matches(['\\', '/']);
    a == b || (a.starts_with(b) && matches!(a.as_bytes().get(b.len()), Some(b'\\') | Some(b'/')))
}

fn base_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

impl History {
    /// `undoDepth`, clamped to 1..200.
    pub fn set_limit(&mut self, limit: usize) {
        self.limit = limit.clamp(1, 200);
        let over = self.undo.len().saturating_sub(self.limit);
        self.undo.drain(..over);
    }

    pub fn depth(&self) -> usize {
        self.undo.len()
    }

    pub fn next_undo(&self) -> Option<&Record> {
        self.undo.last()
    }

    pub fn next_redo(&self) -> Option<&Record> {
        self.redo.last()
    }

    fn build(kind: Kind, moves: &[Moved]) -> Option<Record> {
        let moves: Vec<Moved> = moves.iter().filter(|m| !m.to.as_os_str().is_empty()).cloned().collect();
        let first = moves.first()?;
        let mut items = Vec::new();
        if kind != Kind::NewFolder {
            for m in &moves {
                files_under(&m.to, &mut items);
            }
        }
        Some(Record { kind, origin_dir: first.from.parent().map(PathBuf::from).unwrap_or_default(), moves, items })
    }

    /// An operation that just happened, onto the stack; anything redoable is forgotten.
    pub fn remember(&mut self, kind: Kind, moves: &[Moved]) {
        let Some(record) = Self::build(kind, moves) else { return };
        self.undo.push(record);
        let over = self.undo.len().saturating_sub(self.limit);
        self.undo.drain(..over);
        self.redo.clear();
    }

    pub fn forget(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    pub fn undo(&mut self) -> Reversal {
        let limit = self.limit;
        run(&mut self.undo, &mut self.redo, "undo", limit)
    }

    pub fn redo(&mut self) -> Reversal {
        let limit = self.limit;
        run(&mut self.redo, &mut self.undo, "redo", limit)
    }
}

fn verify(entry: &Entry) -> Result<(), String> {
    let Ok(meta) = std::fs::metadata(&entry.at) else { return Err(format!("{} is no longer there.", base_name(&entry.at))) };
    let moved = match (meta.modified().ok(), entry.mtime) {
        (Some(now), Some(then)) => now.duration_since(then).or_else(|e| Ok::<_, ()>(e.duration())).map(|d| d.as_millis() > 1).unwrap_or(true),
        _ => false,
    };
    if meta.len() != entry.size || moved {
        return Err(format!("{} has changed on disk since.", base_name(&entry.at)));
    }
    Ok(())
}

/// Back where it was - never onto something that has appeared there since.
fn put_back(current: &Path, origin: &Path) -> Result<(), String> {
    if origin.exists() {
        return Err(format!("Something is already at {}.", base_name(origin)));
    }
    if let Some(parent) = origin.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(current, origin).map_err(|e| e.to_string())
}

fn run(from: &mut Vec<Record>, onto: &mut Vec<Record>, what: &str, limit: usize) -> Reversal {
    let Some(target) = from.pop() else {
        return Reversal { failures: vec![format!("There is nothing left to {what}.")], ..Default::default() };
    };
    let mut out = Reversal { total: target.items.len(), kind: Some(target.kind), ..Default::default() };
    for m in target.moves.iter().rev() {
        let group: Vec<&Entry> = target.items.iter().filter(|e| is_at_or_under(&e.at, &m.to)).collect();
        if let Some(refusal) = group.iter().find_map(|e| verify(e).err()) {
            out.failures.push(if m.directory { format!("{} was left where it is: {refusal}", base_name(&m.to)) } else { refusal });
            continue;
        }
        let done = match target.kind {
            Kind::Copy => {
                let trashed = crate::fsops::trash(std::slice::from_ref(&m.to));
                match trashed.error {
                    Some(e) => Err(e),
                    None => {
                        out.removed.moves.extend(trashed.moves);
                        Ok(())
                    }
                }
            }
            Kind::NewFolder => std::fs::remove_dir(&m.to).map_err(|_| format!("{} is not empty any more.", base_name(&m.to))),
            Kind::Move | Kind::Rename => put_back(&m.to, &m.from).map(|_| out.moves.push(Moved { from: m.to.clone(), to: m.from.clone(), directory: m.directory })),
        };
        match done {
            Ok(()) => out.restored += group.len().max(usize::from(target.kind == Kind::NewFolder)),
            Err(e) => out.failures.push(e),
        }
    }
    if out.restored > 0 && matches!(target.kind, Kind::Move | Kind::Rename) {
        out.landed = Some(target.origin_dir.clone());
    }
    // What was put back can be done again; a trashed copy or a removed folder cannot.
    match History::build(target.kind, &out.moves) {
        Some(back) => {
            onto.push(back);
            let over = onto.len().saturating_sub(limit);
            onto.drain(..over);
        }
        None => onto.clear(),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_a_move_back_and_forward_again() {
        let base = std::env::temp_dir().join(format!("umakbang-undo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("a")).unwrap();
        std::fs::create_dir_all(base.join("b")).unwrap();
        std::fs::write(base.join("a").join("x.wav"), b"one").unwrap();
        let outcome = crate::fsops::transfer(&[base.join("a").join("x.wav")], &base.join("b"), crate::fsops::Mode::Move);
        let mut history = History::default();
        history.remember(Kind::Move, &outcome.moves);
        assert_eq!(history.next_undo().unwrap().label("Undo"), "Undo Move (1 file)");
        let back = history.undo();
        assert!(back.failures.is_empty(), "{:?}", back.failures);
        assert!(base.join("a").join("x.wav").exists());
        let again = history.redo();
        assert!(again.failures.is_empty(), "{:?}", again.failures);
        assert!(base.join("b").join("x.wav").exists());
        // Changed since: left where it is, and said so.
        let back = history.undo();
        assert!(back.failures.is_empty());
        let _ = history.redo();
        std::fs::write(base.join("b").join("x.wav"), b"changed!").unwrap();
        let refused = history.undo();
        assert_eq!(refused.restored, 0);
        assert!(refused.failures[0].contains("changed on disk"), "{:?}", refused.failures);
        let _ = std::fs::remove_dir_all(&base);
    }
}
