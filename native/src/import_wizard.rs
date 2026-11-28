//! `ImportWizard.tsx`: where each folder a backup names lives on this machine. It asks only
//! about what it cannot work out - one answer places the rest, a skip is remembered so the next
//! guess does not bring it back - and nothing guessed is believed until the disk agrees.

use crate::backup::{self, Mapping, Style, Summary};
use crate::screen::{style, tnum, Action, State};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::tree::{col, div, icon, para, text, El};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

pub struct Wizard {
    pub backup: Value,
    pub summary: Summary,
    pub foreign: bool,
    pub mapping: Mapping,
    pub guessed: HashSet<String>,
    pub refused: HashSet<String>,
    pub scroll: f32,
    /// The folders already placed are listed too. Off, the list is only what still needs an
    /// answer - with hundreds found, the two that were not are otherwise a long scroll away.
    pub show_placed: bool,
    /// What the dialog shows, worked out when the mapping changes.
    preview: Preview,
}

/// The dialog's figures and each folder's destination. Worked out once per change of mapping,
/// never per frame: `remap` copies the whole backup and walks every entry in it (15,741 entries
/// over 349 folders for a library here took the dialog to seconds a frame), and the dialog is
/// drawn again on every pointer move.
#[derive(Default)]
struct Preview {
    kept: backup::Counts,
    dropped: backup::Counts,
    mapped: usize,
    auto: usize,
    unanswered: usize,
    /// Per folder: where it was placed by hand or found, else where a placed folder above it
    /// takes it and which folder that is.
    places: Vec<(String, Option<String>, Option<String>)>,
}

/// Each folder's card is one height, so only the cards scrolled into view are built.
const CARD: f32 = 62.0;
const STRIDE: f32 = CARD + 6.0;
const LIST_MAX: f32 = 260.0;

fn on_disk(path: &str) -> bool {
    Path::new(path).is_dir()
}

impl Wizard {
    /// The backup's own paths tried first - a reinstall on the same machine needs no mapping -
    /// then whatever they imply.
    pub fn new(backup: Value) -> Wizard {
        let summary = backup::summarise(&backup);
        let foreign = summary.style != Style::Windows;
        let mut wizard = Wizard { backup, summary, foreign, mapping: Mapping::new(), guessed: HashSet::new(), refused: HashSet::new(), scroll: 0.0, show_placed: false, preview: Preview::default() };
        let mut identity = Mapping::new();
        for path in wizard.paths() {
            if on_disk(&path) {
                identity.insert(path.clone(), path.clone());
                wizard.guessed.insert(path);
            }
        }
        wizard.settle(identity, &[]);
        wizard
    }

    fn paths(&self) -> Vec<String> {
        self.summary.folders.iter().map(|f| f.path.clone()).collect()
    }

    /// Propose, check, repeat: a folder placed this round is an anchor for the next.
    fn settle(&mut self, base: Mapping, hand: &[String]) {
        let paths = self.paths();
        let mut current = base;
        let mut found = HashSet::new();
        for _ in 0..4 {
            let proposals: Vec<(String, Vec<String>)> = backup::propose(&paths, &current).into_iter().filter(|(source, _)| !self.refused.contains(source)).collect();
            let mut placed = false;
            for (source, candidates) in proposals {
                if let Some(hit) = candidates.into_iter().find(|c| on_disk(c)) {
                    current.insert(source.clone(), hit);
                    found.insert(source);
                    placed = true;
                }
            }
            if !placed {
                break;
            }
        }
        self.mapping = current;
        self.guessed.extend(found);
        for path in hand {
            self.guessed.remove(path);
        }
        self.refresh();
    }

    fn refresh(&mut self) {
        let (_, kept, dropped) = backup::remap(&self.backup, &self.mapping);
        let places = self
            .summary
            .folders
            .iter()
            .map(|f| {
                let target = self.mapping.get(&f.path).cloned().unwrap_or_default();
                let cover = if target.is_empty() { backup::covered_by(&f.path, &self.mapping) } else { None };
                let derived = cover.as_ref().and_then(|_| backup::remap_path(&f.path, &self.mapping));
                (target, derived, cover)
            })
            .collect();
        self.preview = Preview {
            kept,
            dropped,
            mapped: self.mapping.values().filter(|v| !v.is_empty()).count(),
            auto: self.summary.folders.iter().filter(|f| self.guessed.contains(&f.path)).count(),
            unanswered: self.summary.folders.iter().filter(|f| !self.mapping.contains_key(&f.path) && backup::covered_by(&f.path, &self.mapping).is_none() && !self.refused.contains(&f.path)).count(),
            places,
        };
    }

    pub fn locate(&mut self, index: usize, picked: &Path) {
        let Some(folder) = self.summary.folders.get(index).map(|f| f.path.clone()) else { return };
        let picked = picked.to_string_lossy().into_owned();
        let target = backup::resolve_pick(&folder, &picked).into_iter().find(|c| on_disk(c)).unwrap_or(picked);
        self.refused.remove(&folder);
        let mut base = self.mapping.clone();
        base.insert(folder.clone(), target);
        self.settle(base, &[folder]);
    }

    /// One folder holding all of them: each looked for by name inside it.
    pub fn locate_all(&mut self, picked: &Path) {
        let picked = picked.to_string_lossy().into_owned();
        let mut next = self.mapping.clone();
        for path in self.paths().into_iter().filter(|p| !self.mapping.contains_key(p) && !self.refused.contains(p)) {
            if let Some(hit) = backup::candidates_under(&path, &picked, 3).into_iter().find(|c| on_disk(c)) {
                next.insert(path.clone(), hit);
                self.guessed.insert(path);
            }
        }
        self.settle(next, &[]);
    }

    pub fn skip(&mut self, index: usize) {
        let Some(folder) = self.summary.folders.get(index).map(|f| f.path.clone()) else { return };
        self.mapping.remove(&folder);
        self.guessed.remove(&folder);
        self.refused.insert(folder);
        self.refresh();
    }
}

fn button(t: &Theme, kind: &str, enabled: bool, icon_name: Option<&'static str>, label: &str, action: Action) -> El<Action> {
    let (bg, fg, border) = match kind {
        "default" => (Some(t.primary), t.primary_foreground, None),
        "secondary" => (Some(t.secondary), t.secondary_foreground, None),
        _ => (None, t.foreground, None::<Rgba>),
    };
    let mut el = div().h(24.0).px(8.0).gap(6.0).items_center().rounded(6.0).opacity(if enabled { 1.0 } else { 0.5 });
    if let Some(bg) = bg {
        el = el.bg(bg).maybe(enabled, |e| e.hover_bg(bg.alpha(0.85)));
    } else {
        el = el.maybe(enabled, |e| e.hover_bg(t.accent));
    }
    let _ = border;
    if let Some(name) = icon_name {
        el = el.child(icon(name, 14.0, fg));
    }
    el.maybe(enabled, |e| e.on(action)).child(text(label.to_string(), style(12.0, 500, fg)))
}

pub fn dialog(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let Some(w) = &s.importing else { return Vec::new() };
    let width = 620f32.min(viewport.0 - 32.0);
    let p = &w.preview;
    let (kept, dropped, mapped, auto, unanswered) = (&p.kept, &p.dropped, p.mapped, p.auto, p.unanswered);
    let opening: Vec<&backup::Folder> = w.summary.folders.iter().filter(|f| f.library && w.mapping.contains_key(&f.path)).collect();
    let (total, lost) = (kept.entries(), dropped.entries());

    let header = col()
        .px(16.0)
        .py(12.0)
        .border_b(t.border)
        .child(text("Import settings", style(13.0, 500, t.popover_foreground)))
        .child(para(
            format!(
                "{} Point one folder at where it lives now and the rest are worked out from it.",
                if w.foreign { format!("This backup was written on {}, and its paths don't exist here.", if w.summary.style == Style::Windows { "Windows" } else { "macOS or Linux" }) } else { "This backup came from a machine like this one.".to_string() }
            ),
            style(11.5, 400, t.muted_foreground),
        ));
    let mut body = col().px(16.0).py(12.0).gap(12.0);
    if w.foreign {
        let amber = Rgba::rgb8(245, 158, 11);
        body = body.child(
            div()
                .gap(6.0)
                .px(8.0)
                .py(6.0)
                .rounded(4.0)
                .border(amber.alpha(0.4), 1.0)
                .bg(amber.alpha(0.1))
                .child(icon("alert-triangle", 14.0, Rgba::rgb8(253, 230, 138)).mt(2.0))
                .child(para("If the files are on this machine - synced, copied, or on an external drive - choose the folder they live in and everything about them comes across. If they aren't here, skip: tags and ratings for files that don't exist would be dead weight.", crate::ui::text::TextStyle { line_height: 18.7, ..style(11.5, 400, Rgba::rgb8(253, 230, 138)) }).grow()),
        );
    }
    if w.summary.folders.len() > 1 {
        let status: El<Action> = if auto > 0 {
            let mut line = format!("{auto} found automatically");
            if unanswered > 0 {
                line.push_str(&format!(", {unanswered} still to place"));
            }
            line.push('.');
            div().gap(6.0).items_center().child(icon("sparkles", 12.0, t.primary)).child(text(line, style(11.5, 400, t.primary)))
        } else {
            text(format!("{} folders to place.", w.summary.folders.len()), style(11.5, 400, t.muted_foreground))
        };
        let mut row = div().items_center().justify_between().gap(8.0).child(status);
        if unanswered > 0 {
            row = row.child(button(t, "secondary", true, Some("wand2"), "Find them all in one folder", Action::ImportFindAll));
        }
        body = body.child(row);
    }

    // The body's padding either side, and the scrollbar's gutter.
    let inner = width - 32.0 - 10.0;
    // What still needs an answer - placed nowhere, or skipped, which can be taken back - and
    // the placed ones only when asked for.
    let settled_at = |i: usize| p.places.get(i).is_some_and(|(target, derived, _)| !target.is_empty() || derived.is_some());
    let listed: Vec<usize> = (0..w.summary.folders.len()).filter(|&i| w.show_placed || !settled_at(i)).collect();
    let placed = w.summary.folders.len() - (0..w.summary.folders.len()).filter(|&i| !settled_at(i)).count();
    let count = listed.len();
    let list_h = (count as f32 * STRIDE - 6.0).clamp(0.0, LIST_MAX);
    if w.summary.folders.is_empty() {
        body = body.child(text("Nothing in this backup is tied to a folder - settings only.", style(12.0, 400, t.muted_foreground)));
    } else if count == 0 {
        body = body.child(text("Every folder has a place.", style(12.0, 400, t.muted_foreground)));
    }
    let mut list = div().w(inner).h((count as f32 * STRIDE - 6.0).max(0.0)).shrink0();
    let first = (w.scroll / STRIDE).floor().max(0.0) as usize;
    let shown = (LIST_MAX / STRIDE).ceil() as usize + 2;
    for (row, &i) in listed.iter().enumerate().skip(first).take(shown) {
        let folder = &w.summary.folders[i];
        let (target, derived, cover) = p.places.get(i).cloned().unwrap_or_default();
        let settled = !target.is_empty() || derived.is_some();
        let mut name = div().gap(6.0).items_center().min_w(0.0).child(text(folder.label.clone(), style(12.5, 500, t.foreground)).min_w(0.0));
        if folder.library {
            name = name.child(div().px(4.0).rounded(2.0).bg(t.secondary).shrink0().child(text("library folder", style(10.0, 400, t.secondary_foreground))));
        }
        if w.guessed.contains(&folder.path) {
            name = name.child(div().px(4.0).gap(2.0).items_center().rounded(2.0).bg(t.primary.alpha(0.15)).shrink0().child(icon("sparkles", 10.0, t.primary)).child(text("found", style(10.0, 400, t.primary))));
        }
        let mut detail = folder.path.clone();
        if folder.entries > 0 {
            detail.push_str(&format!(" · {} entries", crate::library::format_count(folder.entries as i64)));
        }
        let mut top = div()
            .items_center()
            .gap(8.0)
            .child(col().grow().min_w(0.0).child(name).child(text(detail, style(11.0, 400, t.muted_foreground)).min_w(0.0)))
            .child(button(t, "secondary", true, Some("folder-search"), if settled { "Change" } else { "Locate" }, Action::ImportLocate(i)));
        if !target.is_empty() {
            top = top.child(button(t, "ghost", true, None, "Skip", Action::ImportSkip(i)));
        }
        // Every card has the second line, so every card is one height: where it goes, or why
        // it goes nowhere yet.
        let line = if settled {
            let shown = if target.is_empty() { derived.clone().unwrap_or_default() } else { target.clone() };
            let colour = if target.is_empty() { t.muted_foreground } else { t.primary };
            let mut line = div().gap(4.0).items_center().child(icon("arrow-right", 12.0, colour)).child(text(shown, style(11.0, 400, colour)).min_w(0.0));
            if let (true, Some(cover)) = (target.is_empty(), &cover) {
                line = line.child(text(format!("· with {}", backup::last_segment(cover)), style(10.0, 400, colour)).shrink0());
            }
            line
        } else if w.refused.contains(&folder.path) {
            div().child(text("Skipped: nothing of it comes across.", style(11.0, 400, t.muted_foreground.alpha(0.7))))
        } else {
            div().child(text("Not here yet. Locate it, or leave it out.", style(11.0, 400, t.muted_foreground.alpha(0.7))))
        };
        let card = col()
            .absolute(0.0, row as f32 * STRIDE)
            .w(inner)
            .h(CARD)
            .px(8.0)
            .py(6.0)
            .rounded(4.0)
            .border(if settled { t.primary.alpha(0.5) } else { t.border.alpha(0.7) }, 1.0)
            .maybe(settled, |e| e.bg(t.primary.alpha(0.05)))
            .child(top)
            .child(line.mt(4.0));
        list = list.child(card);
    }
    if count > 0 {
        body = body.child(div().h(list_h).shrink0().scroll_named("import", w.scroll).scrollbar(t.border).child(list));
    }
    if placed > 0 {
        let label = if w.show_placed { "Hide the placed folders".to_string() } else { format!("Show the {placed} placed folder{} too", if placed == 1 { "" } else { "s" }) };
        body = body.child(div().child(button(t, "ghost", true, Some(if w.show_placed { "chevron-up" } else { "chevron-down" }), &label, Action::ImportShowPlaced)));
    }

    let mut tally = col()
        .px(8.0)
        .py(6.0)
        .rounded(4.0)
        .border(t.border, 1.0)
        .bg(t.card.alpha(0.4))
        .child(div().gap(6.0).items_center().child(icon("check", 14.0, t.primary)).child(text(
            format!(
                "{} of {} entries will come across{}.",
                crate::library::format_count(total as i64),
                crate::library::format_count((total + lost) as i64),
                if mapped > 0 { format!(" from {mapped} folder{}", if mapped == 1 { "" } else { "s" }) } else { String::new() }
            ),
            style(11.5, 400, t.foreground),
        )));
    let quiet = |s: String| text(s, style(11.5, 400, t.muted_foreground)).ml(20.0).mt(2.0);
    if lost > 0 {
        tally = tally.child(quiet(format!(
            "{} left out: {} tagged, {} rated, {} analysed.",
            crate::library::format_count(lost as i64),
            crate::library::format_count(dropped.tags as i64),
            crate::library::format_count(dropped.ratings as i64),
            crate::library::format_count((dropped.detected_bpm + dropped.detected_key) as i64)
        )));
    }
    if w.summary.orphans > 0 {
        tally = tally.child(quiet(format!("{} entries had no folder to place them in.", crate::library::format_count(w.summary.orphans as i64))));
    }
    if !opening.is_empty() {
        let names: Vec<&str> = opening.iter().map(|f| f.label.as_str()).collect();
        tally = tally.child(div().mt(2.0).gap(6.0).items_center().child(icon("folder-open", 14.0, t.primary)).child(text(format!("{} will be opened as your library and indexed.", names.join(", ")), style(11.5, 400, t.foreground))));
    }
    tally = tally.child(quiet("Preferences - colours, columns, player, analysis - come across either way.".into()));
    body = body.child(tally);

    let footer = div()
        .items_center()
        .justify_end()
        .gap(6.0)
        .px(16.0)
        .py(10.0)
        .border_t(t.border)
        .child(button(t, "ghost", true, None, "Cancel", Action::ImportCancel))
        .child(button(t, "default", true, None, if mapped == 0 && total == 0 { "Import preferences only" } else { "Import" }, Action::ImportApply));
    let panel = col().w(width).rounded(8.0).border(t.border, 1.0).bg(t.popover).shadow(16.0, 40.0, 0.35).child(header).child(body).child(footer).child(
        div().absolute(width - 32.0, 10.0).size(22.0, 22.0).items_center().justify_center().rounded(4.0).hover_bg(t.accent).on(Action::ImportCancel).child(icon("x", 14.0, t.muted_foreground)),
    );
    let height = 72.0 + 40.0 + list_h + if placed > 0 { 36.0 } else { 0.0 } + 110.0 + if w.foreign { 70.0 } else { 0.0 } + 45.0;
    let _ = tnum;
    vec![
        div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).bg(Rgba::rgb8(0, 0, 0).alpha(0.5)).on(Action::ImportCancel),
        panel.absolute(((viewport.0 - width) / 2.0).round(), ((viewport.1 - height) / 2.0).max(8.0).round()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_located_folder_places_its_neighbours() {
        let base = std::env::temp_dir().join(format!("umakbang-wizard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("SECRET SAUCE").join("Completed")).unwrap();
        std::fs::create_dir_all(base.join("Drums")).unwrap();
        let backup = serde_json::json!({
            "kind": "umakbang-settings", "version": 2, "settings": {},
            "exportedRoots": [{ "path": "/Users/jk/Music/SECRET SAUCE", "label": "SECRET SAUCE" }, { "path": "/Users/jk/Music/Drums", "label": "Drums" }],
            "tags": { "/Users/jk/Music/SECRET SAUCE/Completed/a.wav": ["keeper"], "/Users/jk/Music/Drums/k.wav": ["kick"] },
            "ratings": {}, "detectedBpm": {}, "detectedKey": {}
        });
        let mut wizard = Wizard::new(backup);
        assert!(wizard.foreign);
        let at = wizard.summary.folders.iter().position(|f| f.path.ends_with("SECRET SAUCE")).unwrap();
        wizard.locate(at, &base.join("SECRET SAUCE"));
        // Drums sat beside it, so it is found beside the answer.
        let drums = wizard.mapping.get("/Users/jk/Music/Drums").cloned().unwrap_or_default();
        assert_eq!(std::path::Path::new(&drums), base.join("Drums"));
        assert!(wizard.guessed.contains("/Users/jk/Music/Drums"));
        let (_, kept, dropped) = backup::remap(&wizard.backup, &wizard.mapping);
        assert_eq!((kept.tags, dropped.tags), (2, 0));
        let _ = std::fs::remove_dir_all(&base);
    }
}
