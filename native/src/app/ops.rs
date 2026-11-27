//! What the explorer does to files: the right-click menu, the keys that stand in for it, and
//! the operations behind both - with the index and the annotations keyed by path following
//! each one, as `applyTransfer` makes them follow in the Electron app.

use super::App;
use crate::fsops::{self, Mode, Moved};
use crate::overlay::{Cmd, Dialog, Menu, MenuItem, Prompt, PromptKind};
use crate::screen::{SearchBox, View};
use crate::table::{self, RowRef};
use std::path::{Path, PathBuf};
use winit::event::KeyEvent;
use winit::keyboard::{Key, NamedKey};

/// What a key did to a text field.
pub enum Edit {
    Done,
    Enter,
    Escape,
    Ignored,
}

/// The editing keys every one-line text field answers to: typing, deleting by character or
/// word, moving and selecting, Ctrl+A, and the clipboard.
pub fn edit_field(s: &mut SearchBox, event: &KeyEvent, ctrl: bool, shift: bool, alt: bool) -> Edit {
    let prev = |v: &str, at: usize| v[..at].char_indices().next_back().map_or(0, |(i, _)| i);
    let next = |v: &str, at: usize| v[at..].char_indices().nth(1).map_or(v.len(), |(i, _)| at + i);
    // Word boundaries, as Ctrl+arrows move on Windows: skip spaces, then a word.
    let word_left = |v: &str, at: usize| v[..at].trim_end().rfind(char::is_whitespace).map_or(0, |i| i + 1);
    let word_right = |v: &str, at: usize| {
        let rest = &v[at..];
        let skip = rest.len() - rest.trim_start().len();
        at + skip + rest[skip..].find(char::is_whitespace).unwrap_or(rest.len() - skip)
    };
    // Which modifier moves by word, and which to the ends of the line. `ctrl` is the command
    // key: Ctrl on Windows, where it also moves by word; ⌘ on a Mac, where Option moves by word
    // and ⌘ goes to the start or end.
    let (word, line) = if cfg!(target_os = "macos") { (alt, ctrl) } else { (ctrl, false) };
    let (lo, hi) = (s.caret.min(s.anchor), s.caret.max(s.anchor));
    let remove = |s: &mut SearchBox, from: usize, to: usize| {
        s.value.replace_range(from..to, "");
        s.caret = from;
        s.anchor = from;
    };
    match &event.logical_key {
        Key::Named(NamedKey::Escape) => return Edit::Escape,
        Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Tab) => return Edit::Enter,
        Key::Named(NamedKey::Backspace) => {
            if lo != hi {
                remove(s, lo, hi);
            } else if s.caret > 0 {
                let from = if line { 0 } else if word { word_left(&s.value, s.caret) } else { prev(&s.value, s.caret) };
                remove(s, from, s.caret);
            }
        }
        Key::Named(NamedKey::Delete) => {
            if lo != hi {
                remove(s, lo, hi);
            } else if s.caret < s.value.len() {
                let to = if line { s.value.len() } else if word { word_right(&s.value, s.caret) } else { next(&s.value, s.caret) };
                remove(s, s.caret, to);
            }
        }
        Key::Named(NamedKey::ArrowLeft) | Key::Named(NamedKey::ArrowRight) | Key::Named(NamedKey::Home) | Key::Named(NamedKey::End) => {
            let to = match &event.logical_key {
                Key::Named(NamedKey::Home) => 0,
                Key::Named(NamedKey::End) => s.value.len(),
                // Without Shift, an arrow over a selection collapses it to that side.
                Key::Named(NamedKey::ArrowLeft) if !shift && lo != hi => lo,
                Key::Named(NamedKey::ArrowRight) if !shift && lo != hi => hi,
                Key::Named(NamedKey::ArrowLeft) if line => 0,
                Key::Named(NamedKey::ArrowLeft) if word => word_left(&s.value, s.caret),
                Key::Named(NamedKey::ArrowLeft) => prev(&s.value, s.caret),
                _ if line => s.value.len(),
                _ if word => word_right(&s.value, s.caret),
                _ => next(&s.value, s.caret),
            };
            s.caret = to;
            if !shift {
                s.anchor = to;
            }
        }
        Key::Character(c) if ctrl && c.eq_ignore_ascii_case("a") => {
            s.anchor = 0;
            s.caret = s.value.len();
        }
        Key::Character(c) if ctrl && (c.eq_ignore_ascii_case("c") || c.eq_ignore_ascii_case("x")) => {
            if lo != hi {
                if let Ok(mut clipboard) = arboard::Clipboard::new() {
                    let _ = clipboard.set_text(s.value[lo..hi].to_string());
                }
                if c.eq_ignore_ascii_case("x") {
                    remove(s, lo, hi);
                }
            }
        }
        Key::Character(c) if ctrl && c.eq_ignore_ascii_case("v") => {
            let pasted = arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default();
            // One line: a pasted newline would be text nobody can see the end of.
            let pasted: String = pasted.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
            remove(s, lo, hi);
            s.value.insert_str(s.caret, &pasted);
            s.caret += pasted.len();
            s.anchor = s.caret;
        }
        // Option on a Mac types characters (Option-e, Option-8); it is not a shortcut there.
        _ if ctrl || (alt && !cfg!(target_os = "macos")) => return Edit::Ignored,
        _ => {
            let Some(typed) = event.text.as_ref().filter(|t| t.chars().all(|c| !c.is_control())) else { return Edit::Ignored };
            remove(s, lo, hi);
            s.value.insert_str(s.caret, typed);
            s.caret += typed.len();
            s.anchor = s.caret;
        }
    }
    Edit::Done
}

/// What a right-click or a key acts on.
pub struct Target {
    /// Absolute paths, and which of them are folders.
    pub paths: Vec<PathBuf>,
    pub dirs: Vec<bool>,
    /// The selection's one entry, if there is only one.
    pub only: Option<(PathBuf, String, bool)>,
    pub files: usize,
    pub playable: usize,
}

impl App {
    /// The folder on screen, on disk. None for the Library root and the saved views, which
    /// are not places anything can be put.
    pub(super) fn here(&self) -> Option<PathBuf> {
        if self.state.view != View::Folder || self.state.folder.id == crate::library::LIBRARY {
            return None;
        }
        // Another machine's folder is not a place on this one: nothing is watched, re-read or
        // pasted into there.
        let label = self.state.folder.path.split('/').next().unwrap_or("");
        if self.data.settings.roots.iter().any(|r| r.label == label && !r.is_local()) {
            return None;
        }
        self.data.absolute(&self.state.folder.path).map(PathBuf::from)
    }

    /// The selected rows, resolved to the disk.
    pub(super) fn target(&self) -> Target {
        let mut t = Target { paths: Vec::new(), dirs: Vec::new(), only: None, files: 0, playable: 0 };
        for &index in &self.state.selection {
            match table::row_at(&self.state, index) {
                Some(RowRef::Folder(folder)) => {
                    if let Some(abs) = self.data.absolute(&folder.path) {
                        t.paths.push(PathBuf::from(abs));
                        t.dirs.push(true);
                    }
                }
                Some(RowRef::File(_, file)) => {
                    t.paths.push(PathBuf::from(&file.path));
                    t.dirs.push(false);
                    t.files += 1;
                    t.playable += usize::from(file.playable);
                }
                None => {}
            }
        }
        if t.paths.len() == 1 {
            let name = t.paths[0].file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            t.only = Some((t.paths[0].clone(), name, t.dirs[0]));
        }
        t
    }

    /// Opens the menu for the row under the pointer - selecting it first if it was not
    /// already part of the selection - or, on empty space, the folder's own menu.
    pub(super) fn open_menu(&mut self, row: Option<usize>) {
        if let Some(row) = row {
            if !self.state.selection.contains(&row) {
                self.state.selection = std::collections::BTreeSet::from([row]);
                self.state.focus = Some(row);
            }
        } else {
            self.state.selection.clear();
        }
        let target = self.target();
        let here = self.here();
        let clipboard = !self.file_clipboard.1.is_empty() || !crate::clipboard::read_files().is_empty();
        let mut items = Vec::new();
        let item = |icon: &'static str, label: &str, shortcut: Option<&str>, enabled: bool, cmd: Cmd| MenuItem::Item {
            icon,
            label: label.to_string(),
            shortcut: shortcut.map(str::to_string),
            enabled,
            cmd,
        };
        if target.paths.is_empty() {
            // `FolderMenuItems`: the folder you are standing in.
            let label = if self.state.view != View::Folder {
                "This view".to_string()
            } else if self.state.folder.name.is_empty() {
                "Library root".to_string()
            } else {
                self.state.folder.name.clone()
            };
            items.push(MenuItem::Label(label));
            items.push(MenuItem::Separator);
            items.push(item("clipboard-paste", "Paste", Some("Ctrl+V"), clipboard && here.is_some(), Cmd::Paste(here.clone().unwrap_or_default())));
            items.push(item("folder-plus", "New folder…", Some("Ctrl+⇧+N"), here.is_some(), Cmd::NewFolder(here.clone().unwrap_or_default())));
            items.push(MenuItem::Separator);
            items.push(item("check", "Select all", Some("Ctrl+A"), true, Cmd::SelectAll));
            items.push(MenuItem::Separator);
            items.push(item("external-link", "Show in Explorer", None, here.is_some(), Cmd::Reveal));
            items.push(item("copy", "Copy full path", None, here.is_some(), Cmd::CopyPath));
        } else {
            // `SelectionMenuItems`, the parts of it this app does so far.
            let label = target.only.as_ref().map(|(_, name, _)| name.clone()).unwrap_or_else(|| format!("{} items", crate::library::format_count(target.paths.len() as i64)));
            items.push(MenuItem::Label(label));
            items.push(MenuItem::Separator);
            let single_dir = target.only.as_ref().is_some_and(|o| o.2);
            let single_file = target.only.as_ref().is_some_and(|o| !o.2);
            if single_dir {
                items.push(item("folder-input", "Open folder", None, true, Cmd::OpenFolder));
                // Two folders on screen at once, which is what filing from one into another wants.
                // With the split already open it is the other half that moves.
                items.push(item("columns2", if self.state.split.is_some() { "Open in other pane" } else { "Open in second pane" }, None, true, Cmd::OpenInOtherPane));
            } else {
                items.push(item("audio-lines", "Play", None, single_file && target.playable == 1, Cmd::Play));
            }
            if single_file {
                items.push(item("external-link", "Open in default app", None, !self.selection_remote(&target), Cmd::OpenExternally));
            }
            // Beside opening it: unpacking an archive is how you look inside one. Only `.zip`.
            if single_file && !self.selection_remote(&target) && target.paths[0].extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
                items.push(item("folder-archive", "Extract here", None, true, Cmd::ExtractHere));
            }
            // Another machine's library is read-only: what would change a file is left out
            // rather than greyed, and what stays only reads - or copies here.
            if self.selection_remote(&target) {
                let here = self.local_name();
                let only_flp = single_file && target.paths[0].extension().is_some_and(|e| e.eq_ignore_ascii_case("flp"));
                if only_flp {
                    items.push(item("package", &format!("Pack & copy to {here}"), None, true, Cmd::PackHere));
                }
                let files = target.paths.iter().zip(&target.dirs).filter(|(_, d)| !**d).count();
                if files > 0 {
                    let label = if files == 1 { format!("Copy to {here}") } else { format!("Copy {} to {here}", crate::library::format_count(files as i64)) };
                    items.push(item("download", &label, None, true, Cmd::CopyHere));
                }
                items.push(MenuItem::Separator);
                let tag_label = if target.only.is_some() { "Tags".to_string() } else { format!("Tag {} items", target.paths.len()) };
                items.push(item("tag", &tag_label, Some("T"), true, Cmd::Tags));
                items.push(MenuItem::Separator);
                items.push(item("copy", "Copy full path", None, true, Cmd::CopyPath));
                items.push(item("copy", "Copy name", None, true, Cmd::CopyName));
                self.show_menu(items);
                return;
            }
            // A right-click on a folder pastes into it; anywhere else, into the folder on screen.
            let paste_dir = if single_dir { target.only.as_ref().map(|o| o.0.clone()) } else { here.clone() };
            items.push(MenuItem::Separator);
            items.push(item("scissors", "Cut", Some("Ctrl+X"), true, Cmd::Cut));
            items.push(item("copy", "Copy", Some("Ctrl+C"), true, Cmd::Copy));
            items.push(item("clipboard-paste", if single_dir { "Paste into folder" } else { "Paste" }, Some("Ctrl+V"), clipboard && paste_dir.is_some(), Cmd::Paste(paste_dir.unwrap_or_default())));
            items.push(item("copy", "Duplicate", Some("Ctrl+D"), true, Cmd::Duplicate));
            items.push(MenuItem::Separator);
            items.push(item("pencil-line", "Rename…", Some("F2"), target.only.is_some(), Cmd::Rename));
            // Only the files with something to put in the name.
            let taggable = self.metadata_names(&target).len();
            if taggable > 0 {
                items.push(item("type", &if taggable == 1 { "Rename with key and BPM".to_string() } else { format!("Rename {taggable} with key and BPM") }, None, true, Cmd::RenameWithMetadata));
            }
            items.push(item("trash2", "Delete", Some("Delete"), true, Cmd::Delete));
            items.push(MenuItem::Separator);
            items.push(item("folder-plus", "New folder…", None, here.is_some(), Cmd::NewFolder(here.clone().unwrap_or_default())));
            let with = if target.paths.len() == 1 { "New folder with this item…".to_string() } else { format!("New folder with {} items…", crate::library::format_count(target.paths.len() as i64)) };
            items.push(item("folder-input", &with, None, here.is_some(), Cmd::NewFolderWithSelection(here.clone().unwrap_or_default())));
            let mut targets: Vec<MenuItem> = self.data.settings.quick_move.iter().map(|q| item("folder-input", &q.label, None, true, Cmd::MoveTo(PathBuf::from(&q.path)))).collect();
            if targets.is_empty() {
                targets.push(item("folder-input", "No folders set up yet - see Settings", None, false, Cmd::SelectAll));
            }
            targets.push(MenuItem::Separator);
            targets.push(item("folder-search", "Choose folder…", None, true, Cmd::MoveToChosen));
            items.push(MenuItem::Sub { icon: "folder-input", label: "Move to".into(), items: targets });
            // The one action that sends a file off the machine, and it costs money per audio
            // minute - so it asks before it goes.
            if target.playable > 0 {
                let label = if target.playable == 1 { "Split vocals…".to_string() } else { format!("Split vocals from {} files…", target.playable) };
                items.push(item("split", &label, None, true, Cmd::SplitStems));
            }
            // Per file, rather than the toolbar's whole-view sweep: usually one reading in doubt.
            if target.playable > 0 {
                let label = if target.playable == 1 { "Reprocess tempo and key".to_string() } else { format!("Reprocess {} files", target.playable) };
                items.push(item("wand-sparkles", &label, None, true, Cmd::Reprocess));
            }
            // A track is something you sell, so the paperwork starts where the track is.
            if target.files > 0 {
                let label = if target.files == 1 { "Generate contract".to_string() } else { format!("Generate contract for {} tracks", target.files) };
                items.push(item("file-pen-line", &label, None, true, Cmd::GenerateContract));
            }
            let dirs: Vec<String> = target.paths.iter().zip(&target.dirs).filter(|(_, d)| **d).filter_map(|(p, _)| self.data.relative(&p.to_string_lossy())).collect();
            if !dirs.is_empty() {
                let pinned = target.paths.iter().zip(&target.dirs).filter(|(_, d)| **d).all(|(p, _)| self.data.settings.quick_move.iter().any(|q| Path::new(&q.path) == p));
                items.push(item("pin", if pinned { "Unpin from quick access" } else { "Pin to quick access" }, None, true, Cmd::TogglePin));
                let excluded = dirs.iter().all(|d| self.data.settings.random_exclude_dirs.contains(d));
                items.push(item("dices", if excluded { "Include in random again" } else { "Never pick at random" }, None, true, Cmd::ToggleRandomExclude));
            }
            // Folders take tags too; the label says how many it is about.
            let tag_label = if target.only.is_some() { "Tags".to_string() } else { format!("Tag {} {}", target.paths.len(), if target.files == 0 { "folders" } else { "items" }) };
            items.push(item("tag", &tag_label, Some("T"), true, Cmd::Tags));
            items.push(MenuItem::Separator);
            if single_file {
                items.push(item("folder-input", "Go to folder", None, true, Cmd::GoToFolder));
            }
            items.push(item("external-link", "Show in Explorer", None, true, Cmd::Reveal));
            items.push(item("copy", if target.only.is_some() { "Copy full path" } else { "Copy full paths" }, None, true, Cmd::CopyPath));
            items.push(item("tag", if target.only.is_some() { "Copy name" } else { "Copy names" }, None, true, Cmd::CopyName));
        }
        self.show_menu(items);
    }

    /// The type filter (`TypeFilterMenu`): sort by type, the kinds and every extension in the
    /// library with how many of each, ticked where they filter. It stays open for picking
    /// several.
    pub fn open_type_menu(&mut self) {
        let filter = self.data.settings.type_filter.clone();
        let (kinds, exts) = self.library.type_counts();
        let mut items = vec![MenuItem::Item { icon: "arrow-up-down", label: "Sort by type".into(), shortcut: None, enabled: true, cmd: Cmd::SortByType }];
        if !filter.kinds.is_empty() || !filter.exts.is_empty() {
            items.push(MenuItem::Item { icon: "x", label: "Clear filters".into(), shortcut: None, enabled: true, cmd: Cmd::ClearTypeFilter });
        }
        items.push(MenuItem::Separator);
        items.push(MenuItem::Label("Kind".into()));
        let label = |k: &str| match k { "audio" => "Audio", "midi" => "MIDI", "project" => "Project", "archive" => "Archive", other => other }.to_string();
        for (kind, count) in kinds {
            let on = filter.kinds.contains(&kind);
            items.push(MenuItem::Item { icon: if on { "check" } else { "" }, label: label(&kind), shortcut: Some(crate::library::format_count(count)), enabled: true, cmd: Cmd::ToggleKind(kind) });
        }
        items.push(MenuItem::Separator);
        items.push(MenuItem::Label("Extension".into()));
        for (ext, count) in exts {
            let on = filter.exts.contains(&ext);
            items.push(MenuItem::Item { icon: if on { "check" } else { "" }, label: ext.to_uppercase(), shortcut: Some(crate::library::format_count(count)), enabled: true, cmd: Cmd::ToggleExt(ext) });
        }
        self.show_menu_at_tool(items, "list-filter", true);
    }

    /// The columns menu (`ColumnMenu`): each column ticked when shown - the name always is -
    /// and Reset.
    pub(super) fn open_columns_menu(&mut self) {
        let mut items = vec![MenuItem::Label("Columns".into())];
        for column in &self.state.columns {
            let def = crate::columns::def_of(column.id);
            items.push(MenuItem::Item {
                icon: if column.visible { "check" } else { "" },
                label: def.label.to_string(),
                shortcut: None,
                enabled: column.id != crate::columns::ColumnId::Name,
                cmd: Cmd::ToggleColumn(column.id),
            });
        }
        items.push(MenuItem::Separator);
        items.push(MenuItem::Item { icon: "refresh-cw", label: "Reset columns".into(), shortcut: None, enabled: true, cmd: Cmd::ResetColumns });
        self.show_menu_at_tool(items, "columns3", true);
    }

    /// A native `<select>`'s list: under the control, at least as wide as it.
    pub(super) fn show_menu_below(&mut self, items: Vec<MenuItem>, under: crate::screen::Action) {
        let scale = self.scale() as f32;
        let anchor = self.hits.iter().find(|h| h.action == under).map(|h| h.rect.map(|v| v / scale));
        let theme = self.theme;
        let text = &mut self.ui.text;
        let measured = crate::overlay::width_of(&items, &mut |s, style| text.width(s, style), &theme);
        let Some(r) = anchor else { return self.show_menu(items) };
        let width = measured.max(r[2] - r[0]);
        self.state.menu = Some(Menu { x: r[0], y: r[3] + 2.0, width, items, hover: None, sub: None, keep_open: false });
        self.state.sub_hover = None;
    }

    /// A dropdown under one of the title bar's buttons, its right edge at the button's
    /// (`align="end"`), 4px below.
    fn show_menu_at_tool(&mut self, items: Vec<MenuItem>, tool: &'static str, keep_open: bool) {
        let scale = self.scale() as f32;
        let anchor = self.hits.iter().find(|h| h.action == crate::screen::Action::Tool(tool)).map(|h| h.rect.map(|v| v / scale));
        let hover = self.state.menu.as_ref().and_then(|m| m.hover);
        let theme = self.theme;
        let text = &mut self.ui.text;
        let width = crate::overlay::width_of(&items, &mut |s, style| text.width(s, style), &theme);
        let height = crate::overlay::height_of(&items).min(self.logical_size().1 * 0.7);
        let (x, y) = match anchor {
            Some(r) => ((r[2] - width).max(4.0), r[3] + 4.0),
            None => (self.logical_size().0 - width - 8.0, 42.0),
        };
        let _ = height;
        self.state.menu = Some(Menu { x, y, width, items, hover, sub: None, keep_open });
    }

    fn type_filter_changed(&mut self) {
        if let Ok(value) = serde_json::to_value(&self.data.settings.type_filter) {
            self.write_setting("typeFilter", value);
        }
        self.refilter();
        if self.state.menu.as_ref().is_some_and(|m| m.keep_open) {
            self.open_type_menu();
        }
    }

    /// `playRandom`: a playable file from anywhere outside the excluded folders, never one of
    /// the last hundred drawn nor what is playing, revealed in its folder and played.
    pub(super) fn play_random(&mut self) {
        let mut pool = self.library.random_pool(&self.data.settings.random_exclude_dirs);
        if self.data.settings.random_skip_rated {
            pool.retain(|p| !self.data.ratings.contains_key(p));
        }
        if pool.is_empty() {
            self.notify(if self.data.settings.random_exclude_dirs.is_empty() {
                "Nothing in the library can be previewed yet."
            } else {
                "Nothing left to pick from: every playable file is in an excluded folder."
            });
            return;
        }
        // The window never eats the whole pool, or a small library would run out of beats.
        let window = 100.min(pool.len() - 1);
        let recent: std::collections::HashSet<&String> = self.recent_random.iter().rev().take(window).collect();
        let playing = self.state.now.as_ref().map(|n| n.file.path.clone());
        let fresh: Vec<&String> = pool.iter().filter(|p| !recent.contains(p) && Some(*p) != playing.as_ref()).collect();
        let draw: Vec<&String> = if fresh.is_empty() { pool.iter().collect() } else { fresh };
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7);
        let mut rng = seed ^ 0x9e37_79b9_7f4a_7c15;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        // Unrated files four times as likely when the setting favours them.
        let weight = |p: &String| if self.data.settings.random_favour_unrated && !self.data.ratings.contains_key(p) { 4u64 } else { 1 };
        let total: u64 = draw.iter().map(|p| weight(p)).sum();
        let mut ticket = next() % total.max(1);
        let mut pick = draw[draw.len() - 1].clone();
        for p in &draw {
            let w = weight(p);
            if ticket < w {
                pick = (*p).clone();
                break;
            }
            ticket -= w;
        }
        self.recent_random.push(pick.clone());
        if self.recent_random.len() > 100 {
            self.recent_random.remove(0);
        }
        self.state.search = SearchBox::default();
        self.locate(&pick);
        if let Some(at) = self.state.files.iter().position(|f| f.path == pick) {
            self.play(at);
        }
    }

    /// Places a menu at the pointer, flipped back inside the window where it would run off it.
    pub(super) fn show_menu(&mut self, items: Vec<MenuItem>) {
        let scale = self.scale() as f32;
        let (w, h) = self.logical_size();
        let theme = self.theme;
        let text = &mut self.ui.text;
        let width = crate::overlay::width_of(&items, &mut |s, style| text.width(s, style), &theme);
        let height = crate::overlay::height_of(&items);
        let (mut x, mut y) = (self.cursor.x as f32 / scale, self.cursor.y as f32 / scale);
        if x + width > w - 4.0 {
            x = (x - width).max(4.0);
        }
        if y + height > h - 4.0 {
            y = (y - height).max(4.0);
        }
        self.state.menu = Some(Menu { x, y, width, items, hover: None, sub: None, keep_open: false });
        self.state.sub_hover = None;
    }

    /// Opens the submenu of item `index` beside it.
    pub(super) fn open_sub(&mut self, index: usize) {
        let theme = self.theme;
        let (w, h) = self.logical_size();
        let Some(menu) = self.state.menu.as_ref() else { return };
        let Some(MenuItem::Sub { items, .. }) = menu.items.get(index) else { return };
        let text = &mut self.ui.text;
        let width = crate::overlay::width_of(items, &mut |s, style| text.width(s, style), &theme);
        let height = crate::overlay::height_of(items);
        let mut x = menu.x + menu.width - 4.0;
        if x + width > w - 4.0 {
            x = (menu.x - width + 4.0).max(4.0);
        }
        let y = (menu.y + crate::overlay::item_top(&menu.items, index) - crate::overlay::MENU_PAD - 1.0).min(h - height - 4.0).max(4.0);
        if let Some(menu) = self.state.menu.as_mut() {
            menu.sub = Some((index, x, y, width));
        }
    }

    pub(super) fn close_overlays(&mut self) {
        self.state.menu = None;
        self.state.sub_hover = None;
        self.state.prompt = None;
        self.state.dialog = None;
        self.state.about = None;
        self.state.tag_editor = None;
        self.state.color_picker = None;
        self.state.fl_dialog = None;
        self.state.transport.queue_open = false;
        self.state.transport.varispeed_open = false;
    }

    /// Says something briefly at the foot of the window: what failed, mostly.
    pub(super) fn notify(&mut self, message: impl Into<String>) {
        self.state.notice = Some(message.into());
        self.notice_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
    }

    pub(super) fn run(&mut self, cmd: Cmd) {
        // A tag editor opened from the menu opens where the menu was.
        let menu_at = self.state.menu.as_ref().map(|m| (m.x, m.y));
        let keep = self.state.menu.as_ref().is_some_and(|m| m.keep_open);
        if !keep {
            self.close_overlays();
        }
        let target = self.target();
        match cmd {
            Cmd::Play | Cmd::OpenFolder => {
                if let Some(focus) = self.state.focus.or_else(|| self.state.selection.iter().next().copied()) {
                    self.open_row(focus);
                }
            }
            Cmd::OpenExternally => {
                if let Some((path, ..)) = &target.only {
                    open_externally(path);
                }
            }
            Cmd::RenameWithMetadata => {
                let (mut renamed, mut failure) = (0, None);
                for (path, name) in self.metadata_names(&target) {
                    let outcome = fsops::rename(&path, &name);
                    self.undo_history.remember(crate::undo::Kind::Rename, &outcome.moves);
                    self.after(&outcome.moves, Mode::Move);
                    match outcome.error {
                        Some(e) => {
                            failure = Some(e);
                            break;
                        }
                        None => renamed += 1,
                    }
                }
                match failure {
                    Some(e) => self.notify(e),
                    None if renamed == 0 => self.notify("Nothing here has a key or tempo to add yet."),
                    None => self.notify(format!("Renamed {}.", items(renamed))),
                }
            }
            Cmd::ExtractHere => {
                if let Some((path, ..)) = &target.only {
                    self.extract(path.clone());
                }
            }
            Cmd::MoveToChosen => {
                if let Some(dir) = crate::dialogs::pick_folder("Move to", self.here().as_deref(), self.hwnd()) {
                    self.run(Cmd::MoveTo(dir));
                }
            }
            Cmd::OpenInOtherPane => {
                if let Some((path, ..)) = &target.only {
                    if let Some(folder) = self.data.relative(&path.to_string_lossy()).and_then(|rel| self.library.folder_at(&rel)) {
                        self.open_in_other_pane(folder.id);
                    }
                }
            }
            Cmd::CopyHere => {
                let paths: Vec<String> = target.paths.iter().zip(&target.dirs).filter(|(_, d)| !**d).map(|(p, _)| p.to_string_lossy().into_owned()).collect();
                self.copy_here(paths);
            }
            Cmd::PackHere => {
                if let Some((path, ..)) = &target.only {
                    self.pack_preview(path.to_string_lossy().into_owned());
                }
            }
            // Nothing that changes a file reaches another machine's library, from a shortcut
            // any more than from the menu.
            Cmd::Cut | Cmd::Paste(_) | Cmd::Duplicate | Cmd::Rename | Cmd::Delete | Cmd::NewFolder(_) | Cmd::NewFolderWithSelection(_) | Cmd::MoveTo(_)
                if self.selection_remote(&target) || matches!(&cmd, Cmd::Paste(d) | Cmd::NewFolder(d) | Cmd::NewFolderWithSelection(d) | Cmd::MoveTo(d) if crate::remote::is_remote(&d.to_string_lossy())) =>
            {
                self.notify("Another machine's library is read-only, so this is always a copy.");
            }
            Cmd::Cut => self.file_clipboard = (Mode::Move, target.paths),
            Cmd::Copy => {
                // Mirrored to the system clipboard as files, so it pastes into Discord or a
                // folder too; a cut is never mirrored (see `clipboard.rs`).
                crate::clipboard::write_files(&target.paths);
                self.file_clipboard = (Mode::Copy, target.paths);
            }
            Cmd::Paste(dir) => self.paste(&dir),
            Cmd::Duplicate => {
                let mut moves = Vec::new();
                for path in &target.paths {
                    let Some(parent) = path.parent() else { continue };
                    let outcome = fsops::transfer(std::slice::from_ref(path), parent, Mode::Copy);
                    moves.extend(outcome.moves);
                    if let Some(error) = outcome.error {
                        self.notify(error);
                        break;
                    }
                }
                self.undo_history.remember(crate::undo::Kind::Copy, &moves);
                self.after(&moves, Mode::Copy);
            }
            Cmd::Rename => {
                if let Some((path, name, directory)) = target.only.clone() {
                    let (x, y) = self.row_anchor();
                    // A file's name is selected up to its extension, as a file manager does.
                    let stem = if directory { name.len() } else { name.rfind('.').filter(|&d| d > 0).unwrap_or(name.len()) };
                    self.state.prompt = Some(Prompt {
                        kind: PromptKind::Rename(path),
                        title: if directory { "Rename folder".into() } else { "Rename file".into() },
                        confirm: "Rename".into(),
                        field: SearchBox { value: name.clone(), caret: stem, anchor: 0, focused: true },
                        error: None,
                        x,
                        y,
                        initial: name,
                    });
                }
            }
            Cmd::Delete => self.confirm_delete(&target),
            Cmd::NewFolder(dir) => self.prompt_new_folder(dir, Vec::new()),
            Cmd::NewFolderWithSelection(dir) => self.prompt_new_folder(dir, target.paths),
            Cmd::MoveTo(dir) => {
                let outcome = fsops::transfer(&target.paths, &dir, Mode::Move);
                self.undo_history.remember(crate::undo::Kind::Move, &outcome.moves);
                self.after(&outcome.moves, Mode::Move);
                if let Some(error) = outcome.error {
                    self.notify(error);
                } else if !outcome.moves.is_empty() {
                    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    self.notify(format!("Moved {} to {name}.", items(outcome.moves.len())));
                }
            }
            Cmd::TogglePin => self.toggle_pin(&target),
            Cmd::ToggleRandomExclude => self.toggle_random_exclude(&target),
            Cmd::GoToFolder => {
                if let Some((path, ..)) = &target.only {
                    self.state.search = SearchBox::default();
                    self.locate(&path.to_string_lossy());
                }
            }
            Cmd::Reveal => {
                let path = target.paths.first().cloned().or_else(|| self.here());
                if let Some(path) = path {
                    reveal(&path, !target.paths.is_empty());
                }
            }
            Cmd::CopyPath => {
                let text: Vec<String> = if target.paths.is_empty() { self.here().into_iter().map(|p| p.to_string_lossy().into_owned()).collect() } else { target.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect() };
                set_text(&text.join("\r\n"));
            }
            Cmd::CopyName => {
                let names: Vec<String> = target.paths.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
                set_text(&names.join("\r\n"));
            }
            Cmd::SelectAll => self.state.selection = (0..table::row_count(&self.state)).collect(),
            Cmd::Tags => self.open_tag_editor(menu_at),
            Cmd::ToggleKind(kind) => {
                let kinds = &mut self.data.settings.type_filter.kinds;
                if let Some(at) = kinds.iter().position(|k| *k == kind) { kinds.remove(at); } else { kinds.push(kind); }
                self.type_filter_changed();
            }
            Cmd::ToggleExt(ext) => {
                let exts = &mut self.data.settings.type_filter.exts;
                if let Some(at) = exts.iter().position(|e| *e == ext) { exts.remove(at); } else { exts.push(ext); }
                self.type_filter_changed();
            }
            Cmd::ClearTypeFilter => {
                self.data.settings.type_filter = Default::default();
                self.type_filter_changed();
                self.close_overlays();
            }
            Cmd::SortByType => {
                self.close_overlays();
                self.act_sort("kind");
            }
            Cmd::ToggleColumn(id) => {
                if let Some(column) = self.state.columns.iter_mut().find(|c| c.id == id) {
                    column.visible = !column.visible || id == crate::columns::ColumnId::Name;
                }
                self.save_columns();
                self.open_columns_menu();
            }
            Cmd::ResetColumns => {
                self.state.columns = crate::columns::normalise(&[]);
                self.save_columns();
                self.close_overlays();
            }
            Cmd::Reprocess => {
                let paths: Vec<String> = target.paths.iter().zip(&target.dirs).filter(|(_, d)| !**d).map(|(p, _)| p.to_string_lossy().into_owned()).collect();
                self.close_overlays();
                self.reprocess(paths);
            }
            Cmd::SplitStems => {
                let paths: Vec<String> = target.paths.iter().zip(&target.dirs).filter(|(_, d)| !**d).map(|(p, _)| p.to_string_lossy().into_owned()).collect();
                self.close_overlays();
                self.open_stem_dialog(paths);
            }
            Cmd::OutputDevice(name) => {
                self.close_overlays();
                self.set_output(name);
            }
            Cmd::StemSplitter(name) => {
                self.data.settings.stem_splitter = Some(name.to_string());
                self.state.stem_settings.splitter = name.to_string();
                self.write_setting("stemSplitter", serde_json::Value::from(name));
                self.close_overlays();
            }
            Cmd::AnalysisTag(tag) => {
                self.close_overlays();
                self.data.settings.analysis_tag = tag.clone();
                self.write_setting("analysisTag", tag.map_or(serde_json::Value::Null, serde_json::Value::from));
                self.analysis_wanted.clear();
                self.refresh_settings_values();
            }
            Cmd::RemoveRoot(label) => {
                self.close_overlays();
                self.remove_root(&label);
            }
            Cmd::GenerateContract => {
                // The file name without its extension: nobody sells "beat.wav".
                let titles: Vec<String> = target
                    .paths
                    .iter()
                    .zip(&target.dirs)
                    .filter(|(_, d)| !**d)
                    .map(|(p, _)| p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
                    .collect();
                self.close_overlays();
                self.open_contract_draft(titles);
            }
            Cmd::YtFormat(format) => {
                self.data.settings.youtube_format = Some(format.to_string());
                self.state.youtube_settings.0 = format.to_string();
                self.write_setting("youtubeFormat", serde_json::Value::from(format));
                self.close_overlays();
            }
            Cmd::YtBitrate(kbps) => {
                self.data.settings.youtube_bitrate = Some(kbps);
                self.state.youtube_settings.1 = kbps;
                self.write_setting("youtubeBitrate", serde_json::Value::from(kbps));
                self.close_overlays();
            }
        }
    }

    /// Where a popover about the selection opens: beside its first row (`anchorOfRow`).
    fn row_anchor(&self) -> (f32, f32) {
        let Some(&first) = self.state.selection.iter().next() else { return (240.0, 160.0) };
        let top = 38.0 + 30.0 + table::HEADER + first as f32 * table::ROW - self.state.scroll;
        let (_, h) = self.logical_size();
        (self.state.sizes.sidebar + 24.0, top.clamp(80.0, (h - 160.0).max(80.0)))
    }

    fn prompt_new_folder(&mut self, dir: PathBuf, with: Vec<PathBuf>) {
        let name = if self.state.folder.name.is_empty() { "the library root".to_string() } else { self.state.folder.name.clone() };
        let kind = if with.is_empty() { PromptKind::NewFolder(dir) } else { PromptKind::NewFolderWith(dir, with) };
        self.state.prompt = Some(Prompt {
            kind,
            title: format!("New folder in {name}"),
            confirm: "Create".into(),
            field: SearchBox { value: "New folder".into(), caret: 10, anchor: 0, focused: true },
            error: None,
            x: self.state.sizes.sidebar + 16.0,
            y: 38.0 + 30.0 + 28.0,
            initial: String::new(),
        });
    }

    /// The prompt's answer.
    pub(super) fn submit_prompt(&mut self) {
        let Some(prompt) = self.state.prompt.clone() else { return };
        let name = prompt.field.value.trim().to_string();
        if name.is_empty() {
            return;
        }
        let result: Result<(), String> = match &prompt.kind {
            PromptKind::Rename(path) => {
                if name == prompt.initial {
                    Ok(())
                } else {
                    let outcome = fsops::rename(path, &name);
                    self.undo_history.remember(crate::undo::Kind::Rename, &outcome.moves);
                    self.after(&outcome.moves, Mode::Move);
                    outcome.error.map_or(Ok(()), Err)
                }
            }
            PromptKind::SaveTrim(source, from, to) => self.save_trim(source, *from, *to, &name),
            PromptKind::NewFolder(dir) => fsops::create_folder(dir, &name).map(|made| {
                self.undo_history.remember(crate::undo::Kind::NewFolder, &[Moved { from: made.clone(), to: made.clone(), directory: true }]);
                self.after(&[Moved { from: PathBuf::new(), to: made, directory: true }], Mode::Copy);
            }),
            PromptKind::NewFolderWith(dir, paths) => fsops::create_folder(dir, &name).map(|made| {
                let outcome = fsops::transfer(paths, &made, Mode::Move);
                self.undo_history.remember(crate::undo::Kind::Move, &outcome.moves);
                let mut moves = vec![Moved { from: PathBuf::new(), to: made, directory: true }];
                moves.extend(outcome.moves);
                self.after(&moves, Mode::Move);
            }),
        };
        match result {
            Ok(()) => self.state.prompt = None,
            Err(error) => {
                if let Some(prompt) = self.state.prompt.as_mut() {
                    prompt.error = Some(error);
                }
            }
        }
    }

    /// `describeDeletion` and `deletionMessage`: what a delete takes with it, said before it
    /// happens - and what of it was worth keeping.
    fn confirm_delete(&mut self, target: &Target) {
        if target.paths.is_empty() {
            return;
        }
        let folders = target.dirs.iter().filter(|d| **d).count();
        let loose = target.paths.len() - folders;
        let (mut files, mut bytes, mut rated, mut tagged) = (0usize, 0i64, 0usize, 0usize);
        let mut count = |path: &str, size: i64, files: &mut usize, bytes: &mut i64| {
            *files += 1;
            *bytes += size;
            if self.data.ratings.get(path).is_some_and(|&r| r >= 4) {
                rated += 1;
            }
            if self.data.tags.get(path).is_some_and(|t| !t.is_empty()) {
                tagged += 1;
            }
        };
        for (path, directory) in target.paths.iter().zip(&target.dirs) {
            if *directory {
                if let Some(rel) = self.data.relative(&path.to_string_lossy()) {
                    for (size, file) in self.library.sizes_under(&rel) {
                        count(&file, size, &mut files, &mut bytes);
                    }
                }
            } else {
                let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
                count(&path.to_string_lossy(), size, &mut files, &mut bytes);
            }
        }
        let size = crate::columns::size(bytes);
        let scale = if folders == 0 {
            format!("{}, {size}.", if files == 1 { "1 file".to_string() } else { format!("{} files", crate::library::format_count(files as i64)) })
        } else {
            let subject = if loose == 0 {
                if folders == 1 { "The folder and everything in it".to_string() } else { format!("{folders} folders and everything in them") }
            } else {
                format!(
                    "{} and {}, with everything beneath",
                    if folders == 1 { "1 folder".to_string() } else { format!("{folders} folders") },
                    if loose == 1 { "1 file".to_string() } else { format!("{} files", crate::library::format_count(loose as i64)) }
                )
            };
            let beneath = if files == 0 { "nothing umakbang has indexed".to_string() } else { format!("{} indexed files, {size}", crate::library::format_count(files as i64)) };
            format!("{subject}: {beneath}.")
        };
        let is = |n: usize| if n == 1 { "is" } else { "are" };
        let worth = match (rated, tagged) {
            (0, 0) => String::new(),
            (r, 0) => format!("{} of them {} rated ★★★★ or better.", crate::library::format_count(r as i64), is(r)),
            (0, t) => format!("{} of them {} tagged.", crate::library::format_count(t as i64), is(t)),
            (r, t) => format!("{} of them {} rated ★★★★ or better, and {} {} tagged.", crate::library::format_count(r as i64), is(r), crate::library::format_count(t as i64), is(t)),
        };
        let bin = if target.paths.len() == 1 { "It goes to the Recycle Bin, so you can put it back." } else { "They go to the Recycle Bin, so you can put them back." };
        let description = [scale, worth, bin.to_string()].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
        let label = target.only.as_ref().map(|(_, name, _)| name.clone()).unwrap_or_else(|| format!("{} items", crate::library::format_count(target.paths.len() as i64)));
        let style = crate::screen::style(11.5, 400, self.theme.muted_foreground);
        let width = 380f32.min(self.logical_size().0 - 32.0) - 32.0;
        let text = &mut self.ui.text;
        let lines = crate::overlay::wrap(&description, width, &mut |s| text.width(s, &style));
        self.state.dialog = Some(Dialog { title: format!("Delete {label}?"), confirm: "Delete".into(), destructive: true, paths: target.paths.clone(), pack: None, lines });
    }

    /// The picked files that have a key or a tempo to carry, with the name each would take -
    /// the detected values where the file declares none, as the table shows them.
    pub(super) fn metadata_names(&self, target: &Target) -> Vec<(PathBuf, String)> {
        let mut out = Vec::new();
        for (path, dir) in target.paths.iter().zip(&target.dirs) {
            if *dir || crate::remote::is_remote(&path.to_string_lossy()) {
                continue;
            }
            let key_path = path.to_string_lossy().into_owned();
            let Some(file) = self.state.files.iter().find(|f| f.path == key_path) else { continue };
            let bpm = file.bpm.or_else(|| self.data.detected_bpm.get(&key_path).copied());
            let key = file.musical_key.clone().filter(|k| !k.is_empty()).or_else(|| self.data.detected_key.get(&key_path).cloned());
            if let Some(name) = crate::keys::name_with_metadata(&file.name, bpm, key.as_deref()) {
                out.push((path.clone(), name));
            }
        }
        out
    }

    /// `extractArchive`: into a folder beside it named after it, never over one already there,
    /// by the system's own unzipper on a thread - and the folder re-read once it is done.
    pub(super) fn extract(&mut self, archive: PathBuf) {
        let Some(parent) = archive.parent().map(PathBuf::from) else { return };
        let stem = archive.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "archive".into());
        let mut target = parent.join(&stem);
        let mut n = 2;
        while target.exists() {
            target = parent.join(format!("{stem} ({n})"));
            n += 1;
        }
        if let Err(e) = std::fs::create_dir_all(&target) {
            self.notify(format!("Could not make a folder for it: {e}"));
            return;
        }
        let Some(proxy) = self.proxy.clone() else { return };
        self.notify(format!("Unpacking {}…", archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        std::thread::spawn(move || {
            let output = unpack_command(&archive, &target).output();
            let outcome = match output {
                Ok(out) if out.status.success() => Ok(target),
                Ok(out) => Err(format!("Could not unpack it: {}", String::from_utf8_lossy(&out.stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("it failed").trim())),
                Err(e) => Err(format!("Could not unpack it: {e}")),
            };
            let _ = proxy.send_event(crate::app::Wake::Extracted(outcome));
        });
    }

    /// Whether anything picked is on another machine.
    pub(super) fn selection_remote(&self, target: &Target) -> bool {
        target.paths.iter().any(|p| crate::remote::is_remote(&p.to_string_lossy()))
    }

    pub(super) fn confirm_dialog(&mut self) {
        let Some(dialog) = self.state.dialog.take() else { return };
        if let Some(flp) = dialog.pack {
            self.state.scan_status = Some("packing".into());
            self.pack_here(flp);
            return;
        }
        let outcome = fsops::trash(&dialog.paths);
        let gone = outcome.moves.len();
        self.after(&outcome.moves, Mode::Move);
        match outcome.error {
            Some(error) => self.notify(error),
            None if gone > 0 => self.notify(format!("Moved {} to the Recycle Bin.", items(gone))),
            None => {}
        }
    }

    fn paste(&mut self, dir: &Path) {
        if dir.as_os_str().is_empty() {
            return;
        }
        let (mode, paths) = if self.file_clipboard.1.is_empty() {
            // Files copied in Explorer paste here too.
            (Mode::Copy, crate::clipboard::read_files())
        } else {
            self.file_clipboard.clone()
        };
        if paths.is_empty() {
            return;
        }
        let outcome = fsops::transfer(&paths, dir, mode);
        self.undo_history.remember(if mode == Mode::Move { crate::undo::Kind::Move } else { crate::undo::Kind::Copy }, &outcome.moves);
        if mode == Mode::Move {
            // A cut is used up by its paste; a copy can be pasted again.
            self.file_clipboard = (Mode::Copy, Vec::new());
        }
        self.after(&outcome.moves, mode);
        if let Some(error) = outcome.error {
            self.notify(error);
        }
    }

    /// The index and the annotations follow what an operation did, then the screen is read
    /// again, selecting what arrived in the folder on screen.
    pub(super) fn after(&mut self, moves: &[Moved], mode: Mode) {
        if moves.is_empty() {
            return;
        }
        let mut landed: Vec<String> = Vec::new();
        for moved in moves {
            let from = moved.from.to_string_lossy().to_string();
            let to = moved.to.to_string_lossy().to_string();
            let from_rel = (!from.is_empty()).then(|| self.data.relative(&from)).flatten();
            let to_rel = (!to.is_empty()).then(|| self.data.relative(&to)).flatten();
            // New rows first, while the old ones are still there to lend their metadata.
            if let Some(to_rel) = &to_rel {
                self.library.arrive(&moved.from, &moved.to, to_rel, moved.directory);
                landed.push(if moved.directory { format!("dir:{to_rel}") } else { to.clone() });
            }
            if mode == Mode::Move && !from.is_empty() {
                self.library.remove(&from, from_rel.as_deref(), moved.directory);
            }
            if !from.is_empty() && !to.is_empty() {
                self.carry_annotations(&from, &to, mode == Mode::Move);
            }
        }
        self.state.total_files = self.library.total_files();
        self.rebuild_tree();
        // The screen again, where it was, with what arrived selected.
        let scroll = self.state.scroll;
        let view = self.state.view;
        self.show_view(view);
        self.state.scroll = scroll.min((table::row_count(&self.state) as f32 * table::ROW - table::ROW).max(0.0));
        let selected: std::collections::BTreeSet<usize> = (0..table::row_count(&self.state))
            .filter(|&i| match table::row_at(&self.state, i) {
                Some(RowRef::Folder(f)) => landed.contains(&format!("dir:{}", f.path)),
                Some(RowRef::File(_, f)) => landed.contains(&f.path),
                None => false,
            })
            .collect();
        if !selected.is_empty() {
            self.state.focus = selected.iter().next().copied();
            self.state.selection = selected;
        }
    }

    /// Ratings, tags, notes and the detected tempo and key follow a file - or everything under
    /// a folder - to where it went; a copy takes copies of them.
    fn carry_annotations(&mut self, from: &str, to: &str, moving: bool) {
        let remap = |key: &str| -> Option<String> {
            if key == from {
                Some(to.to_string())
            } else {
                key.strip_prefix(&format!("{from}\\")).map(|rest| format!("{to}\\{rest}"))
            }
        };
        macro_rules! follow {
            ($map:expr, $section:expr) => {{
                let moved: Vec<(String, String)> = $map.keys().filter_map(|k| remap(k).map(|n| (k.clone(), n))).collect();
                for (old, new) in moved {
                    let value = if moving { $map.remove(&old) } else { $map.get(&old).cloned() };
                    if let Some(value) = value {
                        if let Some(doc) = self.doc.as_mut() {
                            if moving {
                                doc.set($section, &old, None);
                            }
                            doc.set($section, &new, serde_json::to_value(&value).ok());
                        }
                        $map.insert(new, value);
                    }
                }
            }};
        }
        let annotated: Vec<(String, String)> = self.data.ratings.keys().chain(self.data.tags.keys()).chain(self.data.notes.keys()).filter_map(|k| remap(k).map(|n| (k.clone(), n))).collect();
        follow!(self.data.ratings, "ratings");
        follow!(self.data.tags, "tags");
        follow!(self.data.notes, "notes");
        follow!(self.data.detected_bpm, "detectedBpm");
        follow!(self.data.detected_key, "detectedKey");
        follow!(self.data.detected_key_fit, "detectedKeyFit");
        // The record of which file each describes follows as well, read again at both ends.
        for (old, new) in annotated {
            self.note_annotated(&old);
            self.note_annotated(&new);
        }
        self.annotations_changed();
    }

    /// Everything drawn from the ratings and tags, brought up to date.
    pub(crate) fn annotations_changed(&mut self) {
        self.state.ratings = self.data.ratings.clone();
        if let Ok(mut shared) = self.search_shared.write() {
            shared.ratings = self.data.ratings.clone();
            shared.tags = self.data.tags.clone();
            shared.bpm = self.data.detected_bpm.clone();
            shared.key = self.data.detected_key.clone();
        }
        self.state.stars = self.data.star_counts();
        self.state.tags = self.data.tag_counts();
        self.update_facets();
    }

    fn toggle_pin(&mut self, target: &Target) {
        let dirs: Vec<PathBuf> = target.paths.iter().zip(&target.dirs).filter(|(_, d)| **d).map(|(p, _)| p.clone()).collect();
        let pinned = dirs.iter().all(|p| self.data.settings.quick_move.iter().any(|q| Path::new(&q.path) == p));
        if pinned {
            self.data.settings.quick_move.retain(|q| !dirs.iter().any(|p| Path::new(&q.path) == p));
        } else {
            for dir in dirs {
                if !self.data.settings.quick_move.iter().any(|q| Path::new(&q.path) == dir) {
                    let label = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    self.data.settings.quick_move.push(crate::userdata::QuickFolder { path: dir.to_string_lossy().into_owned(), label });
                }
            }
        }
        if let Ok(value) = serde_json::to_value(&self.data.settings.quick_move) {
            self.write_setting("quickMove", value);
        }
        self.state.quick = self.data.settings.quick_move.clone();
        self.state.quick_dirs = self.state.quick.iter().map(|q| self.data.relative(&q.path)).collect();
    }

    fn toggle_random_exclude(&mut self, target: &Target) {
        let dirs: Vec<String> = target.paths.iter().zip(&target.dirs).filter(|(_, d)| **d).filter_map(|(p, _)| self.data.relative(&p.to_string_lossy())).collect();
        let excluded = dirs.iter().all(|d| self.data.settings.random_exclude_dirs.contains(d));
        if excluded {
            self.data.settings.random_exclude_dirs.retain(|d| !dirs.contains(d));
        } else {
            for dir in dirs {
                if !self.data.settings.random_exclude_dirs.contains(&dir) {
                    self.data.settings.random_exclude_dirs.push(dir);
                }
            }
        }
        let value = serde_json::Value::from(self.data.settings.random_exclude_dirs.clone());
        self.write_setting("randomExcludeDirs", value);
        let rated: Vec<String> = self.data.ratings.keys().cloned().collect();
        self.state.rated_share = self.library.rated_share(&rated, &self.data.settings.random_exclude_dirs);
    }

    /// Undo (or redo) the last file operation, and say what came of it.
    pub(super) fn reverse(&mut self, undo: bool) {
        let kind = if undo { self.undo_history.next_undo() } else { self.undo_history.next_redo() }.map(|r| r.kind);
        let Some(kind) = kind else {
            self.notify(if undo { "There is nothing left to undo." } else { "There is nothing left to redo." });
            return;
        };
        let reversal = if undo { self.undo_history.undo() } else { self.undo_history.redo() };
        // The library and the annotations follow what was put back, and what was trashed.
        if !reversal.removed.moves.is_empty() {
            self.after(&reversal.removed.moves, Mode::Move);
        }
        if !reversal.moves.is_empty() {
            self.after(&reversal.moves, Mode::Move);
        }
        // An undone move lands the view where the files went back to, as Electron does.
        if let Some(dir) = reversal.landed.as_ref().and_then(|d| self.data.relative(&d.to_string_lossy())).and_then(|rel| self.library.folder_at(&rel)) {
            if self.state.view != View::Folder || self.state.folder.id != dir.id {
                self.open(dir.id, true);
                let back: Vec<String> = reversal.moves.iter().map(|m| m.to.to_string_lossy().into_owned()).collect();
                self.state.selection = (0..table::row_count(&self.state))
                    .filter(|&i| match table::row_at(&self.state, i) {
                        Some(RowRef::File(_, f)) => back.contains(&f.path),
                        Some(RowRef::Folder(f)) => self.data.absolute(&f.path).is_some_and(|p| back.contains(&p)),
                        None => false,
                    })
                    .collect();
            }
        }
        let count = |n: usize| if n == 1 { "1 file".to_string() } else { format!("{n} files") };
        let message = if !reversal.failures.is_empty() {
            let reasons = reversal.failures.join(" ");
            if reversal.total == 0 || reversal.restored == 0 { reasons } else { format!("Restored {} of {}. {reasons}", reversal.restored, reversal.total) }
        } else {
            match kind {
                crate::undo::Kind::NewFolder => "Removed the folder again.".to_string(),
                crate::undo::Kind::Copy => format!("Removed {}.", count(reversal.restored)),
                _ if undo => format!("Put {} back.", count(reversal.restored)),
                _ => format!("Moved {} forward again.", count(reversal.restored)),
            }
        };
        self.notify(message);
    }

    /// The explorer's own keys for what the menu does: Delete, F2 (and Ctrl+Enter), the
    /// clipboard trio, Duplicate and New folder. True when the key was one of them.
    pub(super) fn file_key(&mut self, key: &Key) -> bool {
        let ctrl = self.command_key();
        let shift = self.modifiers.shift_key();
        let has_selection = !self.state.selection.is_empty();
        let cmd = match key {
            Key::Named(NamedKey::Delete) if has_selection => Cmd::Delete,
            Key::Character(c) if !ctrl && c.eq_ignore_ascii_case("t") && has_selection => Cmd::Tags,
            Key::Named(NamedKey::F2) if self.state.selection.len() == 1 => Cmd::Rename,
            Key::Named(NamedKey::Enter) if ctrl && self.state.selection.len() == 1 => Cmd::Rename,
            Key::Character(c) if ctrl && shift && c.eq_ignore_ascii_case("n") => match self.here() {
                Some(dir) => Cmd::NewFolder(dir),
                None => return false,
            },
            Key::Character(c) if ctrl && c.eq_ignore_ascii_case("c") && has_selection => Cmd::Copy,
            Key::Character(c) if ctrl && c.eq_ignore_ascii_case("x") && has_selection => Cmd::Cut,
            Key::Character(c) if ctrl && c.eq_ignore_ascii_case("d") && has_selection => Cmd::Duplicate,
            Key::Character(c) if ctrl && c.eq_ignore_ascii_case("v") => match self.here() {
                Some(dir) => Cmd::Paste(dir),
                None => return false,
            },
            // Redo on both chords people reach for: Ctrl+Y, as file managers have it, and
            // Ctrl+Shift+Z, as every editor and DAW does.
            Key::Character(c) if ctrl && (c.eq_ignore_ascii_case("y") || (shift && c.eq_ignore_ascii_case("z"))) => {
                self.reverse(false);
                return true;
            }
            Key::Character(c) if ctrl && c.eq_ignore_ascii_case("z") => {
                self.reverse(true);
                return true;
            }
            _ => return false,
        };
        self.run(cmd);
        true
    }
}

fn items(n: usize) -> String {
    if n == 1 { "1 item".into() } else { format!("{} items", crate::library::format_count(n as i64)) }
}

fn set_text(text: &str) {
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        let _ = clipboard.set_text(text.to_string());
    }
}

/// The command that unpacks a zip into `target`: Windows' own `Expand-Archive`, or on a Mac
/// `ditto`, which is what Finder's Archive Utility uses and keeps names and permissions.
#[cfg(windows)]
fn unpack_command(archive: &Path, target: &Path) -> std::process::Command {
    let quote = |p: &std::path::Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("Expand-Archive -LiteralPath {} -DestinationPath {} -Force", quote(archive), quote(target))]);
    crate::process::quiet(&mut command);
    command
}

#[cfg(not(windows))]
fn unpack_command(archive: &Path, target: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("/usr/bin/ditto");
    command.arg("-x").arg("-k").arg(archive).arg(target);
    command
}

/// Opens a file with whatever Windows has registered for it.
/// ShellExecute's "open", which is what a double click in Explorer does - the file's own
/// registered app, not Explorer guessing from a command line.
#[cfg(windows)]
pub(super) fn open_externally(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "open ".encode_utf16().collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL);
    }
}

/// Opens a file in its default app, as a double click in Finder does.
#[cfg(not(windows))]
pub(super) fn open_externally(path: &Path) {
    let _ = std::process::Command::new("/usr/bin/open").arg(path).spawn();
}

/// Shows a path in Finder: selected inside its folder (`open -R`), or the folder itself.
#[cfg(not(windows))]
pub(super) fn reveal(path: &Path, select: bool) {
    let mut command = std::process::Command::new("/usr/bin/open");
    if select {
        command.arg("-R");
    }
    let _ = command.arg(path).spawn();
}

/// Shows a path in Explorer: selected inside its folder, or the folder itself.
#[cfg(windows)]
pub(super) fn reveal(path: &Path, select: bool) {
    let mut command = std::process::Command::new("explorer.exe");
    if select {
        // Explorer wants `/select,` and the path as one argument, quoted.
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("/select,\"{}\"", path.display()));
    } else {
        command.arg(path);
    }
    let _ = command.spawn();
}

impl App {
    /// Opens the tag editor on the selection, beside its first row.
    pub(super) fn open_tag_editor(&mut self, at: Option<(f32, f32)>) {
        let target = self.target();
        if target.paths.is_empty() {
            return;
        }
        let paths: Vec<String> = target.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let label = target.only.as_ref().map(|o| o.1.clone()).unwrap_or_else(|| format!("{} items", crate::library::format_count(paths.len() as i64)));
        let (x, y) = at.unwrap_or_else(|| self.row_anchor());
        let (w, h) = self.logical_size();
        let mut editor = crate::overlay::TagEditor {
            paths,
            label,
            field: SearchBox { focused: true, ..Default::default() },
            applied: Vec::new(),
            rows: Vec::new(),
            highlight: 0,
            x: x.min(w - 296.0).max(4.0),
            y: y.min(h - 300.0).max(4.0),
        };
        self.fill_tag_editor(&mut editor);
        self.state.tag_editor = Some(editor);
    }

    /// What the editor shows: the tags on the selection, and every other tag ranked against
    /// what is typed - exact, then prefix, then substring, then by how much carries it.
    fn fill_tag_editor(&self, editor: &mut crate::overlay::TagEditor) {
        let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for path in &editor.paths {
            for tag in self.data.tags.get(path).into_iter().flatten() {
                *counts.entry(tag.clone()).or_default() += 1;
            }
        }
        editor.applied = counts.into_iter().collect();
        let whole = editor.paths.len();
        let typed = editor.field.value.trim().to_lowercase();
        let rank = |tag: &str| {
            let lower = tag.to_lowercase();
            if typed.is_empty() { 3 } else if lower == typed { 0 } else if lower.starts_with(&typed) { 1 } else { 2 }
        };
        let mut rows: Vec<(String, i64)> = self
            .data
            .tag_counts()
            .into_iter()
            .filter(|(tag, _)| !editor.applied.iter().any(|(t, n)| t == tag && *n == whole))
            .filter(|(tag, _)| typed.is_empty() || tag.to_lowercase().contains(&typed))
            .map(|(tag, n)| (tag, n as i64))
            .collect();
        rows.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then(b.1.cmp(&a.1)).then_with(|| a.0.cmp(&b.0)));
        // Typing an existing tag in another case offers that one rather than a near twin.
        let raw = editor.field.value.trim().to_string();
        let exists = self.data.tag_counts().iter().any(|(t, _)| t.to_lowercase() == typed) || editor.applied.iter().any(|(t, _)| t.to_lowercase() == typed);
        if !raw.is_empty() && !exists {
            rows.insert(0, (raw, -1));
        }
        editor.rows = rows;
        editor.highlight = editor.highlight.min(editor.rows.len().saturating_sub(1));
    }

    fn refill_tag_editor(&mut self) {
        if let Some(mut editor) = self.state.tag_editor.take() {
            self.fill_tag_editor(&mut editor);
            self.state.tag_editor = Some(editor);
        }
    }

    /// `addTags`: each tag onto every path, once, after what it already has. A comma typed
    /// separates tags.
    pub(super) fn add_tags(&mut self, paths: &[String], raw: &str) {
        let cleaned: Vec<String> = raw.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        if cleaned.is_empty() {
            return;
        }
        for path in paths {
            let tags = self.data.tags.entry(path.clone()).or_default();
            for tag in &cleaned {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            let value = serde_json::to_value(&*tags).ok();
            if let Some(doc) = self.doc.as_mut() {
                doc.set("tags", path, value);
            }
            self.note_annotated(path);
        }
        self.tags_changed();
    }

    /// `removeTag`: off every path; a path left with none loses its entry.
    pub(super) fn remove_tag(&mut self, paths: &[String], tag: &str) {
        for path in paths {
            let Some(tags) = self.data.tags.get_mut(path) else { continue };
            tags.retain(|t| t != tag);
            let value = (!tags.is_empty()).then(|| serde_json::to_value(&*tags).ok()).flatten();
            if tags.is_empty() {
                self.data.tags.remove(path);
            }
            if let Some(doc) = self.doc.as_mut() {
                doc.set("tags", path, value);
            }
            self.note_annotated(path);
        }
        self.tags_changed();
    }

    /// `setTags`: the whole list for one path, as a peer sends it; empty clears the entry.
    pub(super) fn set_tags(&mut self, path: &str, tags: Vec<String>) {
        let value = (!tags.is_empty()).then(|| serde_json::to_value(&tags).ok()).flatten();
        if tags.is_empty() {
            self.data.tags.remove(path);
        } else {
            self.data.tags.insert(path.to_string(), tags);
        }
        if let Some(doc) = self.doc.as_mut() {
            doc.set("tags", path, value);
        }
        self.note_annotated(path);
        self.tags_changed();
    }

    /// Everything that shows tags, brought up to date.
    fn tags_changed(&mut self) {
        self.state.tags = self.data.tag_counts();
        self.update_facets();
        if let Ok(mut shared) = self.search_shared.write() {
            shared.tags = self.data.tags.clone();
        }
        self.resolve_rows();
        self.refill_tag_editor();
    }

    /// Keys while the tag editor is open. Escape keeps a half-typed tag rather than losing it.
    pub(super) fn tag_key(&mut self, event: &KeyEvent) {
        let (ctrl, shift, alt) = (self.command_key(), self.modifiers.shift_key(), self.modifiers.alt_key());
        let Some(editor) = self.state.tag_editor.as_mut() else { return };
        match &event.logical_key {
            Key::Named(NamedKey::ArrowDown) | Key::Named(NamedKey::ArrowUp) => {
                if !editor.rows.is_empty() {
                    let n = editor.rows.len();
                    // Wraps: a list this short is quicker to walk round than back.
                    editor.highlight = if event.logical_key == Key::Named(NamedKey::ArrowDown) { (editor.highlight + 1) % n } else { (editor.highlight + n - 1) % n };
                }
                return;
            }
            Key::Named(NamedKey::Backspace) if editor.field.value.is_empty() => {
                if let Some((tag, _)) = editor.applied.last().cloned() {
                    let paths = editor.paths.clone();
                    self.remove_tag(&paths, &tag);
                }
                return;
            }
            _ => {}
        }
        let before = editor.field.value.clone();
        match edit_field(&mut editor.field, event, ctrl, shift, alt) {
            Edit::Escape => {
                let (paths, draft) = (editor.paths.clone(), editor.field.value.clone());
                self.state.tag_editor = None;
                self.add_tags(&paths, &draft);
            }
            Edit::Enter => {
                // The highlighted row wins over the raw text: `dr` and Enter gives `drums`.
                let chosen = editor.rows.get(editor.highlight).map(|r| r.0.clone()).unwrap_or_else(|| editor.field.value.clone());
                let paths = editor.paths.clone();
                editor.field = SearchBox { focused: true, ..Default::default() };
                editor.highlight = 0;
                self.add_tags(&paths, &chosen);
            }
            Edit::Done if editor.field.value != before => {
                editor.highlight = 0;
                self.refill_tag_editor();
            }
            _ => {}
        }
    }

    pub(super) fn pick_tag_row(&mut self, index: usize) {
        let Some(editor) = self.state.tag_editor.as_mut() else { return };
        let Some((tag, _)) = editor.rows.get(index).cloned() else { return };
        let paths = editor.paths.clone();
        editor.field = SearchBox { focused: true, ..Default::default() };
        editor.highlight = 0;
        self.add_tags(&paths, &tag);
    }

    pub(super) fn drop_applied_tag(&mut self, index: usize) {
        let Some(editor) = self.state.tag_editor.as_ref() else { return };
        let Some((tag, _)) = editor.applied.get(index).cloned() else { return };
        let paths = editor.paths.clone();
        self.remove_tag(&paths, &tag);
    }

    /// Starts typing in a Notes cell, caret at the end of what is there.
    pub(super) fn edit_note(&mut self, at: usize) {
        self.finish_note();
        let Some(file) = self.state.files.get(at) else { return };
        let value = self.data.notes.get(&file.path).cloned().unwrap_or_default();
        let end = value.len();
        self.state.note_edit = Some((file.path.clone(), SearchBox { value, caret: end, anchor: end, focused: true }));
    }

    pub(super) fn finish_note(&mut self) {
        self.state.note_edit = None;
    }

    /// Keys in a Notes cell: they are the cell's, so a "3" in a note does not rate the file.
    /// Each change is saved as it is typed; an emptied note is deleted rather than kept as "".
    pub(super) fn note_key(&mut self, event: &KeyEvent) {
        let (ctrl, shift, alt) = (self.command_key(), self.modifiers.shift_key(), self.modifiers.alt_key());
        let Some((path, field)) = self.state.note_edit.as_mut() else { return };
        let before = field.value.clone();
        match edit_field(field, event, ctrl, shift, alt) {
            Edit::Enter | Edit::Escape => self.finish_note(),
            _ => {
                if field.value != before {
                    let (path, note) = (path.clone(), field.value.clone());
                    if note.is_empty() {
                        self.data.notes.remove(&path);
                    } else {
                        self.data.notes.insert(path.clone(), note.clone());
                    }
                    if let Some(doc) = self.doc.as_mut() {
                        doc.set("notes", &path, (!note.is_empty()).then(|| serde_json::Value::from(note.clone())));
                    }
                    self.note_annotated(&path);
                    if let Some(at) = self.state.files.iter().position(|f| f.path == path) {
                        if let Some(meta) = self.state.file_meta.get_mut(at) {
                            meta.note = note;
                        }
                    }
                }
            }
        }
    }
}
