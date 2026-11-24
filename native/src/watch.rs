//! The folder on screen, watched (`App.tsx` with main's `watchFolders`): when anything in it
//! changes, it is read again 600ms after the last change - a DAW writes, renames and touches a
//! file several times on the way to a finished export, and one re-read for the lot is enough.
//! Only the folder itself, not what is under it; the scanner covers the rest at launch.

use crate::app::Wake;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use winit::event_loop::EventLoopProxy;

pub struct FolderWatch {
    watcher: Option<RecommendedWatcher>,
    watching: Option<PathBuf>,
}

impl FolderWatch {
    pub fn new() -> FolderWatch {
        FolderWatch { watcher: None, watching: None }
    }

    /// Watches `dir` instead of whatever was watched before; `None` stops watching.
    pub fn watch(&mut self, dir: Option<&Path>, proxy: &EventLoopProxy<Wake>) {
        if self.watching.as_deref() == dir {
            return;
        }
        if let (Some(watcher), Some(old)) = (self.watcher.as_mut(), self.watching.take()) {
            let _ = watcher.unwatch(&old);
        }
        let Some(dir) = dir else { return };
        if self.watcher.is_none() {
            let proxy = proxy.clone();
            self.watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    // Reads are reported as changes on Windows; only what alters the folder counts.
                    if !matches!(event.kind, notify::EventKind::Access(_)) {
                        let _ = proxy.send_event(Wake::FolderChanged);
                    }
                }
            })
            .ok();
        }
        if let Some(watcher) = self.watcher.as_mut() {
            if watcher.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                self.watching = Some(dir.to_path_buf());
            }
        }
    }
}

/// The whole library, watched all the time (`library-watch.ts`, now with the window open too):
/// one recursive watch per library folder, the changed folders batched until `SETTLE` of quiet,
/// then handed over to be re-read - not a rescan, just those folders. A phone can only be as
/// current as the index here, and somebody producing at the desk exports into folders they are
/// not looking at.
pub struct LibraryWatch {
    _watchers: Vec<RecommendedWatcher>,
}

/// An FL export is several writes over a second or two; five seconds covers that and still
/// batches an unzip, and is most of the delay a peer then sees.
const SETTLE: std::time::Duration = std::time::Duration::from_secs(5);

impl LibraryWatch {
    pub fn start(roots: &[PathBuf], proxy: &EventLoopProxy<Wake>) -> LibraryWatch {
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex};
        use std::time::{Instant, SystemTime};
        // The folders touched since the last batch, when the last event came, and when the last
        // batch went - before which a "change" to a file is Windows reporting a read.
        let pending: Arc<Mutex<(HashSet<PathBuf>, Option<Instant>, bool)>> = Arc::new(Mutex::new((HashSet::new(), None, false)));
        let last_batch = Arc::new(Mutex::new(SystemTime::now()));
        let mut watchers = Vec::new();
        for root in roots {
            let (pending, last_batch) = (pending.clone(), last_batch.clone());
            let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(mut p) = pending.lock() else { return };
                let event = match event {
                    Ok(event) => event,
                    // A lost event buffer: nothing for it but to look everywhere.
                    Err(_) => {
                        p.2 = true;
                        p.1 = Some(Instant::now());
                        return;
                    }
                };
                if event.need_rescan() {
                    p.2 = true;
                    p.1 = Some(Instant::now());
                    return;
                }
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let since = last_batch.lock().map(|t| *t).unwrap_or(SystemTime::UNIX_EPOCH);
                for path in &event.paths {
                    if matches!(event.kind, notify::EventKind::Modify(notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Metadata(_) | notify::event::ModifyKind::Any)) {
                        // A file the last re-read already saw, "changed" by being read.
                        let older = std::fs::metadata(path).and_then(|m| m.modified()).is_ok_and(|m| m + std::time::Duration::from_secs(1) < since);
                        if older {
                            continue;
                        }
                    }
                    if let Some(dir) = path.parent() {
                        p.0.insert(dir.to_path_buf());
                    }
                    if path.is_dir() {
                        p.0.insert(path.clone());
                    }
                }
                p.1 = Some(Instant::now());
            });
            if let Ok(mut watcher) = watcher {
                if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
                    watchers.push(watcher);
                }
            }
        }
        let proxy = proxy.clone();
        std::thread::Builder::new()
            .name("library-watch".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let batch = {
                    let Ok(mut p) = pending.lock() else { return };
                    match p.1 {
                        Some(at) if at.elapsed() >= SETTLE => {
                            let dirs: Vec<PathBuf> = p.0.drain().collect();
                            let everything = std::mem::take(&mut p.2);
                            p.1 = None;
                            Some((dirs, everything))
                        }
                        _ => None,
                    }
                };
                if let Some((dirs, everything)) = batch {
                    if let Ok(mut t) = last_batch.lock() {
                        *t = SystemTime::now();
                    }
                    if proxy.send_event(Wake::LibraryTouched(dirs, everything)).is_err() {
                        return;
                    }
                }
            })
            .ok();
        LibraryWatch { _watchers: watchers }
    }
}
