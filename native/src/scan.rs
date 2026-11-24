//! Keeping the index true to the disk (`scanner.ts`), on a thread of its own.
//!
//! Each library folder is walked; a folder whose own modified time matches the one recorded
//! last time is not read again - only visited, for its subfolders - because a file appearing,
//! going or being renamed moves its folder's mtime and nothing else does (`planRevalidation`).
//! A folder that did move is read: new files gain rows and are probed, changed ones are
//! probed again, gone ones lose their rows, and subfolders that appeared or went are indexed
//! or dropped whole. What the skip cannot see is a file overwritten in place, which moves only
//! its own mtime: a full scan (`full`) reads every folder for that.

use crate::app::Wake;
use crate::library::{FileRow, Library};
use std::path::{Path, PathBuf};
use std::time::Instant;
use winit::event_loop::EventLoopProxy;

#[derive(Clone, Debug)]
pub enum Event {
    /// Walking, with how many folders have been visited.
    Progress { folders: usize },
    /// Finished: whether anything changed, and what it took.
    Done { changed: bool, folders: usize, read: usize, probed: usize, seconds: f64 },
}

/// The folder table as the scan began: children by parent, and each folder's recorded mtime -
/// so a folder that has not moved costs one `stat` and no query.
struct Plan {
    children: std::collections::HashMap<Option<i64>, Vec<(i64, String, String)>>,
    mtimes: std::collections::HashMap<i64, Option<f64>>,
    unread: std::collections::HashSet<i64>,
}

struct Stats {
    folders: usize,
    read: usize,
    probed: usize,
    changed: bool,
    last_report: Instant,
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let meta = std::fs::metadata(path).ok()?;
    Some(meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

/// A file described and probed: what a new or changed row is written with.
fn read_file(path: &Path, rel_dir: &str) -> Option<FileRow> {
    let mut row = crate::files::describe(path, rel_dir)?;
    probe_into(&mut row);
    Some(row)
}

pub fn probe_into(row: &mut FileRow) {
    let meta = crate::probe::probe(Path::new(&row.path), &row.ext);
    row.duration = meta.duration;
    row.sample_rate = meta.sample_rate;
    row.bit_depth = meta.bit_depth;
    row.channels = meta.channels;
    row.bitrate = meta.bitrate;
    row.bpm = meta.bpm;
    row.musical_key = meta.key;
    row.project_seconds = meta.project_seconds;
    row.project_created = meta.project_created;
    row.probed = true;
}

/// Scans running now. A bundle copies the index out of the database, and the daily one waits
/// for a scan to finish rather than catching it half way.
static SCANS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn scanning() -> bool {
    SCANS.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// Starts a scan of `roots` (absolute path and label each) on its own thread.
pub fn spawn(db: PathBuf, roots: Vec<(PathBuf, String)>, full: bool, proxy: EventLoopProxy<Wake>) {
    let _ = std::thread::Builder::new().name("scan".into()).spawn(move || {
        let Ok(library) = Library::open(&db) else { return };
        SCANS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let started = Instant::now();
        let (folders, unread) = library.scan_plan();
        let mut plan = Plan { children: std::collections::HashMap::new(), mtimes: std::collections::HashMap::new(), unread };
        for (id, parent, name, path, mtime) in folders {
            plan.children.entry(parent).or_default().push((id, name, path));
            plan.mtimes.insert(id, mtime);
        }
        let mut stats = Stats { folders: 0, read: 0, probed: 0, changed: false, last_report: Instant::now() };
        for (path, label) in &roots {
            walk(&library, &plan, path, label, None, full, &mut stats, &proxy);
        }
        if library.fill_tempos_from_projects(None) > 0 {
            stats.changed = true;
        }
        SCANS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        let _ = proxy.send_event(Wake::Scan(Event::Done {
            changed: stats.changed,
            folders: stats.folders,
            read: stats.read,
            probed: stats.probed,
            seconds: started.elapsed().as_secs_f64(),
        }));
    });
}

/// A mounted library's index, downloaded and filed (`scanRemote`). Its machine has already
/// probed every file, so nothing here reads a byte of audio.
pub fn spawn_remote(db: PathBuf, root: crate::remote::RemoteRoot, proxy: EventLoopProxy<Wake>) {
    let _ = std::thread::Builder::new().name("remote-index".into()).spawn(move || {
        let started = Instant::now();
        let fetched = crate::remote::fetch_index(&root);
        let outcome = match fetched {
            Ok(rows) => match Library::open(&db) {
                Ok(library) => {
                    library.replace_remote(&root.label, &rows);
                    Ok(rows.len())
                }
                Err(e) => Err(e.to_string()),
            },
            Err(e) => Err(e),
        };
        let changed = outcome.is_ok();
        let _ = proxy.send_event(Wake::RemoteIndexed(root.label.clone(), outcome));
        let _ = proxy.send_event(Wake::Scan(Event::Done { changed, folders: 0, read: 0, probed: 0, seconds: started.elapsed().as_secs_f64() }));
    });
}

#[allow(clippy::too_many_arguments)]
fn walk(library: &Library, plan: &Plan, abs: &Path, rel: &str, parent: Option<i64>, full: bool, stats: &mut Stats, proxy: &EventLoopProxy<Wake>) {
    // A folder that cannot be read - an unplugged drive, a permission - is left exactly as the
    // index has it rather than emptied.
    let Some(mtime) = mtime_ms(abs) else { return };
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let known = plan.children.get(&parent).and_then(|siblings| siblings.iter().find(|(_, _, path)| path == rel)).map(|(id, ..)| *id);
    let Some(id) = known.or_else(|| library.ensure_folder(parent, name, rel)) else { return };
    stats.folders += 1;
    if stats.last_report.elapsed().as_millis() > 200 {
        stats.last_report = Instant::now();
        let _ = proxy.send_event(Wake::Scan(Event::Progress { folders: stats.folders }));
    }

    let recorded = plan.mtimes.get(&id).copied().flatten();
    if !full && recorded.is_some_and(|m| (m - mtime).abs() < 1.0) {
        // Unchanged: only its subfolders need visiting, and the index already names them.
        for (_, child_name, child_path) in plan.children.get(&Some(id)).into_iter().flatten() {
            walk(library, plan, &abs.join(child_name), child_path, Some(id), full, stats, proxy);
        }
        // Rows the prober never reached (an import of files Electron had not probed yet).
        let unread: Vec<FileRow> = if plan.unread.contains(&id) { library.files(id).into_iter().filter(|f| !f.probed).collect() } else { Vec::new() };
        if !unread.is_empty() {
            library.begin();
            for mut row in unread {
                probe_into(&mut row);
                library.put_file(id, &row);
                stats.probed += 1;
            }
            library.commit();
            library.recount(id);
            stats.changed = true;
        }
        return;
    }

    let Ok(entries) = std::fs::read_dir(abs) else { return };
    stats.read += 1;
    let mut files = std::collections::HashMap::new();
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let entry_name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !crate::files::IGNORED_DIRS.contains(&entry_name.to_lowercase().as_str()) {
                dirs.push(entry_name);
            }
        } else if crate::files::is_indexable(&crate::files::extension_of(&entry_name)) {
            files.insert(abs.join(&entry_name).to_string_lossy().to_string(), entry.path());
        }
    }

    let mut changed = false;
    library.begin();
    for row in library.files(id) {
        match files.remove(&row.path) {
            None => {
                library.delete_file(&row.path);
                changed = true;
            }
            Some(path) => {
                let Ok(meta) = std::fs::metadata(&path) else { continue };
                let size = meta.len() as i64;
                let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
                // Re-read only what moved, or what was never read.
                if size != row.size || (mtime - row.mtime).abs() > 1.0 || !row.probed {
                    if let Some(fresh) = read_file(&path, rel) {
                        library.put_file(id, &fresh);
                        stats.probed += 1;
                        changed = true;
                    }
                }
            }
        }
    }
    for path in files.values() {
        if let Some(row) = read_file(path, rel) {
            library.put_file(id, &row);
            stats.probed += 1;
            changed = true;
        }
    }
    library.commit();

    let known: Vec<_> = library.children(Some(id));
    for child in &known {
        if !dirs.contains(&child.name) {
            library.remove("", Some(&child.path), true);
            changed = true;
        }
    }
    for dir in &dirs {
        let child_rel = format!("{rel}/{dir}");
        walk(library, plan, &abs.join(dir), &child_rel, Some(id), full, stats, proxy);
    }
    if !known.iter().map(|c| &c.name).eq(dirs.iter()) && dirs.iter().any(|d| !known.iter().any(|c| &c.name == d)) {
        changed = true;
    }
    library.set_folder_mtime(id, mtime);
    if changed {
        library.recount(id);
        stats.changed = true;
    }
}
