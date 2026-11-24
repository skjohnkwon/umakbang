//! File operations on the disk: `src/main/fs-ops.ts`.
//!
//! Each one reports what it did as moves - from, to, and whether it was a folder - so the
//! library rows and the annotations keyed by path can follow, the way `applyTransfer` makes
//! them follow in the Electron app. Nothing here touches the index.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Move,
    Copy,
}

#[derive(Clone, Debug)]
pub struct Moved {
    pub from: PathBuf,
    pub to: PathBuf,
    pub directory: bool,
}

#[derive(Default, Debug)]
pub struct Outcome {
    pub moves: Vec<Moved>,
    pub error: Option<String>,
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
const MAX_NAME: usize = 255;

/// `nameError`: what Windows would refuse or misread as a file name.
pub fn name_error(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Some("Name cannot be empty.".into());
    }
    if trimmed.contains(['\\', '/']) {
        return Some("Name cannot contain a path separator.".into());
    }
    if trimmed.chars().any(|c| "<>:\"|?*".contains(c) || (c as u32) < 0x20) {
        return Some("Name contains a character Windows forbids.".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Some("Not a valid name.".into());
    }
    if trimmed.ends_with(['.', ' ']) {
        return Some("Name cannot end with a dot or a space.".into());
    }
    // The device rule looks at the segment before the first dot, trailing dots and spaces off.
    let device = trimmed.split('.').next().unwrap_or("").trim_end_matches(['.', ' ']).to_lowercase();
    if RESERVED.contains(&device.as_str()) {
        return Some(format!("Windows reserves \"{}\" for a device, with or without an extension.", device.to_uppercase()));
    }
    if trimmed.chars().count() > MAX_NAME {
        return Some(format!("Name is too long - {MAX_NAME} characters at most."));
    }
    None
}

/// `uniqueTarget`: "name.wav", then "name (2).wav", "name (3).wav"... A folder's counter goes
/// on the end, having no extension to keep.
pub fn unique_target(destination: &Path, base: &str, directory: bool) -> PathBuf {
    let first = destination.join(base);
    if !first.exists() {
        return first;
    }
    let dot = if directory { None } else { base.rfind('.').filter(|&d| d > 0) };
    let (stem, suffix) = match dot {
        Some(d) => (&base[..d], &base[d..]),
        None => (base, ""),
    };
    for n in 2..1000 {
        let candidate = destination.join(format!("{stem} ({n}){suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    destination.join(format!("{stem} ({stamp}){suffix}"))
}

/// True if `inner` is `outer` or anywhere beneath it.
pub fn is_inside(inner: &Path, outer: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string();
    let (a, b) = (norm(inner), norm(outer));
    a == b || a.starts_with(&format!("{b}\\"))
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

fn describe_error(error: &std::io::Error) -> String {
    error.to_string()
}

fn base_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `transfer`: moves or copies each path into `destination`, never over anything already
/// there. Stops at the first failure and says which.
pub fn transfer(paths: &[PathBuf], destination: &Path, mode: Mode) -> Outcome {
    let mut outcome = Outcome::default();
    if let Err(error) = std::fs::create_dir_all(destination) {
        outcome.error = Some(format!("Can't create {}: {}", destination.display(), describe_error(&error)));
        return outcome;
    }
    for source in paths {
        let Ok(meta) = std::fs::metadata(source) else { continue };
        let directory = meta.is_dir();
        if directory && is_inside(destination, source) {
            outcome.error = Some(format!("Can't put {} inside itself.", base_name(source)));
            return outcome;
        }
        let target = unique_target(destination, &base_name(source), directory);
        let result = match mode {
            // `rename` fails across drives; copy then remove is the fallback.
            Mode::Move => std::fs::rename(source, &target).or_else(|_| {
                copy_tree(source, &target)?;
                if directory { std::fs::remove_dir_all(source) } else { std::fs::remove_file(source) }
            }),
            Mode::Copy => copy_tree(source, &target),
        };
        if let Err(error) = result {
            let verb = if mode == Mode::Move { "move" } else { "copy" };
            outcome.error = Some(format!("Couldn't {verb} {}: {}", base_name(source), describe_error(&error)));
            return outcome;
        }
        outcome.moves.push(Moved { from: source.clone(), to: target, directory });
    }
    outcome
}

/// `trashEntries`: to the Recycle Bin, never an unlink - a misclick should be a trip to the
/// bin, not a loss.
pub fn trash(paths: &[PathBuf]) -> Outcome {
    let mut outcome = Outcome::default();
    for path in paths {
        let Ok(meta) = std::fs::metadata(path) else { continue };
        if let Err(error) = trash::delete(path) {
            outcome.error = Some(format!("Couldn't delete {}: {}", base_name(path), error));
            return outcome;
        }
        // Reported as a move to nowhere: the rows and annotations under it go.
        outcome.moves.push(Moved { from: path.clone(), to: PathBuf::new(), directory: meta.is_dir() });
    }
    outcome
}

/// `createFolder`: refuses a name already taken.
pub fn create_folder(parent: &Path, name: &str) -> Result<PathBuf, String> {
    if let Some(error) = name_error(name) {
        return Err(error);
    }
    let target = parent.join(name.trim());
    if target.exists() {
        return Err("Something with that name is already there.".into());
    }
    std::fs::create_dir_all(&target).map_err(|e| describe_error(&e))?;
    Ok(target)
}

/// `renameEntry`: in place, refusing to land on anything else - except a change of case
/// alone, which NTFS treats as a real rename and `exists` as a collision.
pub fn rename(path: &Path, new_name: &str) -> Outcome {
    let mut outcome = Outcome::default();
    if let Some(error) = name_error(new_name) {
        outcome.error = Some(error);
        return outcome;
    }
    let target = path.with_file_name(new_name.trim());
    if target == path {
        return outcome;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        outcome.error = Some("That file is no longer there.".into());
        return outcome;
    };
    let case_only = target.to_string_lossy().to_lowercase() == path.to_string_lossy().to_lowercase();
    if !case_only && target.exists() {
        outcome.error = Some("Something with that name is already there.".into());
        return outcome;
    }
    if let Err(error) = std::fs::rename(path, &target) {
        outcome.error = Some(describe_error(&error));
        return outcome;
    }
    outcome.moves.push(Moved { from: path.to_path_buf(), to: target, directory: meta.is_dir() });
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_windows_refuses() {
        assert!(name_error("beat.wav").is_none());
        assert!(name_error("nul").is_some());
        assert!(name_error("CON.tar.gz").is_some());
        assert!(name_error("trailing.").is_some());
        assert!(name_error("a/b").is_some());
        assert!(name_error("what?").is_some());
    }

    #[test]
    fn transfers_without_overwriting() {
        let root = std::env::temp_dir().join(format!("umakbang-fsops-{}", std::process::id()));
        let (src, dst) = (root.join("src"), root.join("dst"));
        std::fs::create_dir_all(src.join("kit")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("beat.wav"), b"a").unwrap();
        std::fs::write(src.join("kit").join("kick.wav"), b"b").unwrap();
        std::fs::write(dst.join("beat.wav"), b"existing").unwrap();

        let copied = transfer(&[src.join("beat.wav")], &dst, Mode::Copy);
        assert!(copied.error.is_none());
        assert_eq!(copied.moves[0].to, dst.join("beat (2).wav"));
        assert_eq!(std::fs::read(dst.join("beat.wav")).unwrap(), b"existing");

        let moved = transfer(&[src.join("kit")], &dst, Mode::Move);
        assert!(moved.error.is_none() && moved.moves[0].directory);
        assert!(dst.join("kit").join("kick.wav").exists() && !src.join("kit").exists());

        let inside = transfer(&[dst.clone()], &dst.join("kit"), Mode::Move);
        assert!(inside.error.is_some());

        let renamed = rename(&dst.join("beat (2).wav"), "Beat (2).wav");
        assert!(renamed.error.is_none(), "a change of case is a rename");
        let _ = std::fs::remove_dir_all(&root);
    }
}
