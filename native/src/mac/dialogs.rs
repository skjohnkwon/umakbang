//! The OS's own pickers on a Mac: NSOpenPanel and NSSavePanel, through `rfd`. Same signatures
//! as the Windows `dialogs.rs`; `owner` is accepted and ignored, since the panels are
//! application-modal and come up over the key window anyway.

use std::path::{Path, PathBuf};

/// `("umakbang bundle", "*.umak;*.json")` -> `("umakbang bundle", ["umak", "json"])`.
fn extensions(spec: &str) -> Vec<String> {
    spec.split(';').filter_map(|p| p.trim().strip_prefix("*.")).filter(|e| *e != "*").map(str::to_string).collect()
}

fn with_filters(mut dialog: rfd::FileDialog, filters: &[(&str, &str)]) -> rfd::FileDialog {
    for (name, spec) in filters {
        let exts = extensions(spec);
        if !exts.is_empty() {
            dialog = dialog.add_filter(*name, &exts);
        }
    }
    dialog
}

pub fn pick_folder(title: &str, start: Option<&Path>, _owner: Option<isize>) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title(title);
    if let Some(start) = start.filter(|p| p.is_dir()) {
        dialog = dialog.set_directory(start);
    }
    dialog.pick_folder()
}

pub fn pick_file(title: &str, filters: &[(&str, &str)], start: Option<&Path>, _owner: Option<isize>) -> Option<PathBuf> {
    let mut dialog = with_filters(rfd::FileDialog::new().set_title(title), filters);
    if let Some(start) = start.filter(|p| p.is_dir()) {
        dialog = dialog.set_directory(start);
    }
    dialog.pick_file()
}

pub fn save_file(title: &str, dir: Option<&Path>, name: &str, filters: &[(&str, &str)], extension: &str, _owner: Option<isize>) -> Option<PathBuf> {
    let mut dialog = with_filters(rfd::FileDialog::new().set_title(title).set_file_name(name), filters);
    if let Some(dir) = dir.filter(|p| p.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    let path = dialog.save_file()?;
    // NSSavePanel adds the extension when a filter is set, but a typed name without one and
    // no filter would otherwise come back bare.
    Some(if path.extension().is_none() && !extension.is_empty() { path.with_extension(extension) } else { path })
}
