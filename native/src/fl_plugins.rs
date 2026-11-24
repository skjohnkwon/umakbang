//! FL Studio's plugin database (`fl-plugins.ts`, `FlPluginsDialog.tsx`): which plugins FL has
//! found, which of them are favourites - what appears when a plugin is added to a channel - and
//! moving many at once, which FL itself only does one at a time.
//!
//! A favourite is a copy of the plugin's `.fst` from `Installed/<kind>/<format>/` into
//! `<kind>/`. Every write is refused while FL is running: it rewrites this database when it quits,
//! so anything changed under it would be thrown away.

use crate::screen::{style, tnum, Action, State};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::tree::{col, div, icon, para, text, El};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Generator,
    Effect,
}

#[derive(Clone, Debug)]
pub struct Plugin {
    pub name: String,
    pub kind: Kind,
    pub formats: Vec<String>,
    pub favourite: bool,
    /// The scan's entry to copy a favourite from, the preferred format first.
    pub installed: Option<PathBuf>,
    pub favourite_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub plugins: Vec<Plugin>,
    pub from: PathBuf,
    pub missing: bool,
    pub running: bool,
}

/// Where FL keeps the database under its user data folder - or the folder itself, when that is
/// what was pointed at.
pub fn database(user_data: &Path) -> Option<PathBuf> {
    [user_data.join("Presets").join("Plugin database"), user_data.join("Plugin database"), user_data.to_path_buf()].into_iter().find(|c| c.join("Generators").exists())
}

fn fst_under(dir: &Path, into: &mut BTreeMap<String, Vec<PathBuf>>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            fst_under(&path, into, depth + 1);
        } else {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.to_lowercase().ends_with(".fst") {
                into.entry(name[..name.len() - 4].to_string()).or_default().push(path);
            }
        }
    }
}

/// The folder an installed entry sits in, which is its format: VST3, VST, Fruity...
fn format_of(path: &Path) -> String {
    path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

const FORMAT_PREFERENCE: [&str; 5] = ["VST3", "VST", "AudioUnit", "New", "Fruity"];

pub fn read_catalog(user_data: &Path) -> Catalog {
    let running = fl_running();
    let Some(from) = database(user_data) else {
        return Catalog { plugins: Vec::new(), from: user_data.join("Presets").join("Plugin database"), missing: true, running };
    };
    let mut plugins = Vec::new();
    for (dir, kind) in [("Generators", Kind::Generator), ("Effects", Kind::Effect)] {
        let (mut installed, mut favourites) = (BTreeMap::new(), BTreeMap::new());
        fst_under(&from.join("Installed").join(dir), &mut installed, 0);
        fst_under(&from.join(dir), &mut favourites, 0);
        for (name, mut paths) in installed.clone() {
            let rank = |p: &PathBuf| FORMAT_PREFERENCE.iter().position(|f| *f == format_of(p)).unwrap_or(FORMAT_PREFERENCE.len());
            paths.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
            let mut formats: Vec<String> = Vec::new();
            for p in &paths {
                let f = format_of(p);
                if !formats.contains(&f) {
                    formats.push(f);
                }
            }
            let favourite_path = favourites.get(&name).and_then(|v| v.first().cloned());
            plugins.push(Plugin { name, kind, formats, favourite: favourite_path.is_some(), installed: paths.into_iter().next(), favourite_path });
        }
        // FL's own instruments and effects are favourites with no scan entry behind them.
        for (name, paths) in favourites.iter_mut() {
            if installed.contains_key(name) {
                continue;
            }
            plugins.push(Plugin { name: name.clone(), kind, formats: vec!["Built in".into()], favourite: true, installed: None, favourite_path: paths.first().cloned() });
        }
    }
    plugins.sort_by(|a, b| crate::columns::collate(&a.name, &b.name));
    Catalog { plugins, from, missing: false, running }
}

/// Whether FL Studio is open.
#[cfg(windows)]
pub fn fl_running() -> bool {
    crate::process::quiet(&mut std::process::Command::new("tasklist"))
        .args(["/fi", "imagename eq FL64.exe", "/nh"])
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).to_lowercase().contains("fl64.exe"))
}

/// Whether FL Studio is open: its Mac bundle is `FL Studio <year>.app`, whatever the year.
#[cfg(not(windows))]
pub fn fl_running() -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", "/FL Studio[^/]*\\.app/Contents/MacOS/"])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Favourites added or taken away. Failures are per plugin, so a batch keeps what worked.
pub fn set_favourites(catalog: &Catalog, names: &HashSet<String>, wanted: bool) -> (usize, Vec<String>) {
    if fl_running() {
        return (0, vec!["Close FL Studio first - it rewrites this when it quits.".into()]);
    }
    let (mut changed, mut failures) = (0, Vec::new());
    for plugin in catalog.plugins.iter().filter(|p| names.contains(&p.name)) {
        let outcome = if wanted {
            if plugin.favourite {
                continue;
            }
            let Some(source) = &plugin.installed else {
                failures.push(format!("{}: nothing in the scan to copy from.", plugin.name));
                continue;
            };
            let dir = catalog.from.join(if plugin.kind == Kind::Generator { "Generators" } else { "Effects" });
            std::fs::create_dir_all(&dir).and_then(|_| std::fs::copy(source, dir.join(format!("{}.fst", plugin.name)))).map(|_| ())
        } else {
            let Some(path) = &plugin.favourite_path else { continue };
            std::fs::remove_file(path)
        };
        match outcome {
            Ok(()) => changed += 1,
            Err(e) => failures.push(format!("{}: {e}", plugin.name)),
        }
    }
    (changed, failures)
}

/* ------------------------------------------------------------------ the dialog */

pub struct Dialog {
    pub catalog: Catalog,
    pub formats: BTreeSet<String>,
    pub picked: HashSet<String>,
    /// Where the last click on each side landed, for Shift to extend from.
    pub anchors: [Option<usize>; 2],
    pub scroll: [f32; 2],
    pub busy: bool,
    pub note: Option<(String, bool)>,
}

pub const ROW: f32 = 25.0;

/// The plugins that pass the search and the format chips, split into not-favourites (0) and
/// favourites (1).
pub fn sides<'a>(d: &'a Dialog, query: &str) -> [Vec<&'a Plugin>; 2] {
    let needle = query.trim().to_lowercase();
    let mut out: [Vec<&Plugin>; 2] = [Vec::new(), Vec::new()];
    for plugin in &d.catalog.plugins {
        if !d.formats.is_empty() && !plugin.formats.iter().any(|f| d.formats.contains(f)) {
            continue;
        }
        if !needle.is_empty() && !plugin.name.to_lowercase().contains(&needle) {
            continue;
        }
        out[usize::from(plugin.favourite)].push(plugin);
    }
    out
}

/// `range`: a click picks or unpicks one; with Shift, everything from the last click to this
/// one takes the state the first of them is about to take.
pub fn pick(d: &mut Dialog, list: &[String], side: usize, index: usize, extend: bool) {
    let from = if extend { d.anchors[side].unwrap_or(index) } else { index };
    let (lo, hi) = (from.min(index), from.max(index));
    let turning_on = list.get(from).is_some_and(|n| !d.picked.contains(n));
    for name in list.iter().take(hi + 1).skip(lo) {
        if turning_on {
            d.picked.insert(name.clone());
        } else {
            d.picked.remove(name);
        }
    }
    d.anchors[side] = Some(index);
}

fn button(t: &Theme, primary: bool, enabled: bool, label: El<Action>, action: Action) -> El<Action> {
    let (bg, _fg) = if primary { (t.primary, t.primary_foreground) } else { (t.secondary, t.secondary_foreground) };
    div()
        .h(24.0)
        .px(8.0)
        .gap(4.0)
        .items_center()
        .justify_center()
        .rounded(6.0)
        .bg(bg)
        .opacity(if enabled { 1.0 } else { 0.5 })
        .maybe(enabled, |el| el.hover_bg(bg.alpha(0.9)).on(action))
        .child(label)
}

fn pane(t: &Theme, title: &str, plugins: &[&Plugin], d: &Dialog, side: usize, height: f32) -> El<Action> {
    let chosen = plugins.iter().filter(|p| d.picked.contains(&p.name)).count();
    let mut count = crate::library::format_count(plugins.len() as i64);
    if chosen > 0 {
        count.push_str(&format!(" · {chosen} picked"));
    }
    let header = div()
        .h(26.0)
        .shrink0()
        .px(10.0)
        .gap(8.0)
        .items_center()
        .border_b(t.border)
        .child(text(title.to_string(), style(11.0, 500, t.foreground)))
        .child(text(count, tnum(10.5, 400, t.muted_foreground.alpha(0.6))))
        .child(div().grow())
        .child(
            div()
                .h(20.0)
                .px(6.0)
                .items_center()
                .rounded(4.0)
                .opacity(if d.busy || plugins.is_empty() { 0.5 } else { 1.0 })
                .maybe(!d.busy && !plugins.is_empty(), |el| el.hover_bg(t.accent).on(Action::FlSelectAll(side as u8)))
                .child(text("Select all", style(10.5, 500, t.foreground))),
        );
    let body = if plugins.is_empty() {
        div().child(text("Nothing here.", style(11.0, 400, t.muted_foreground.alpha(0.5))).px(10.0).py(8.0))
    } else {
        // Only the rows in view are built: a thousand plugins a side.
        let scroll = d.scroll[side];
        let first = ((scroll / ROW).floor() as usize).saturating_sub(2);
        let last = (((scroll + height) / ROW).ceil() as usize + 2).min(plugins.len());
        let mut rows = div().w_full().h(plugins.len() as f32 * ROW).shrink0();
        for (i, plugin) in plugins.iter().enumerate().take(last).skip(first) {
            let on = d.picked.contains(&plugin.name);
            rows = rows.child(
                div()
                    .absolute(0.0, i as f32 * ROW)
                    .w_full()
                    .h(ROW)
                    .px(10.0)
                    .gap(8.0)
                    .items_center()
                    .maybe(on, |el| el.bg(t.primary.alpha(0.15)))
                    .maybe(!on, |el| el.hover_bg(t.secondary.alpha(0.6)))
                    .on(Action::FlPick(side as u8, i))
                    .child(div().size(12.0, 12.0).shrink0().rounded(3.0).border(if on { t.primary } else { t.muted_foreground.alpha(0.4) }, 1.0).maybe(on, |el| el.bg(t.primary)))
                    .child(text(plugin.name.clone(), style(11.5, 400, t.foreground)).min_w(0.0).grow())
                    .child(text(plugin.formats.join(" + "), style(10.5, 400, t.muted_foreground.alpha(0.5))).shrink0()),
            );
        }
        rows
    };
    col()
        .grow()
        .min_w(0.0)
        .min_h0()
        .rounded(6.0)
        .border(t.border, 1.0)
        .bg(t.card.alpha(0.4))
        .child(header)
        .child(div().grow().min_h0().scroll_named(if side == 0 { "fl0" } else { "fl1" }, d.scroll[side]).scrollbar(t.border).child(body))
}

pub fn dialog(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let Some(d) = &s.fl_dialog else { return Vec::new() };
    let width = 1000f32.min(viewport.0 - 32.0);
    let height = (viewport.1 * 0.8).round();
    let frame = |inner: El<Action>, h: Option<f32>| {
        let close = div().absolute(width - 34.0, 10.0).size(22.0, 22.0).items_center().justify_center().rounded(4.0).hover_bg(t.accent).on(Action::FlClose).child(icon("x", 14.0, t.muted_foreground));
        let mut panel = col().w(width).p(16.0).rounded(8.0).border(t.border, 1.0).bg(t.popover).shadow(16.0, 40.0, 0.35).child(inner).child(close);
        if let Some(h) = h {
            panel = panel.h(h);
        }
        let top = h.map_or(viewport.1 / 3.0, |h| (viewport.1 - h) / 2.0);
        vec![
            div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).bg(Rgba::rgb8(0, 0, 0).alpha(0.5)).on(Action::FlClose),
            panel.absolute(((viewport.0 - width) / 2.0).round(), top.max(8.0).round()),
        ]
    };
    let title = text("FL plugins", style(15.0, 600, t.popover_foreground));
    if d.catalog.missing {
        return frame(col().child(title).child(para(format!("Nothing at {}. Point the plugin database folder at FL's before managing anything.", d.catalog.from.display()), style(12.0, 400, t.muted_foreground)).mt(8.0)), None);
    }

    let query = s.form.value("fl.q").to_string();
    let [others, favourites] = sides(d, &query);
    let mut body = col()
        .grow()
        .min_h0()
        .child(title)
        .child(para("A favourite is what appears when you add a plugin to a channel. FL adds them one at a time; this does not.", style(11.5, 400, t.muted_foreground)).mt(4.0));
    if d.catalog.running {
        body = body.child(
            div()
                .mt(8.0)
                .px(10.0)
                .py(6.0)
                .gap(8.0)
                .items_center()
                .rounded(6.0)
                .border(t.primary.alpha(0.4), 1.0)
                .bg(t.primary.alpha(0.1))
                .child(para("FL Studio is open. It rewrites the plugin database when it quits, so anything changed now would be thrown away - close it first.", style(11.5, 400, t.foreground)).grow())
                .child(button(t, false, true, div().gap(4.0).items_center().child(icon("refresh-cw", 12.0, t.secondary_foreground)).child(text("Check again", style(11.0, 500, t.secondary_foreground))), Action::FlRecheck)),
        );
    }
    body = body.child(div().mt(8.0).child(crate::form::field(s, t, "fl.q", &format!("Search {} plugins", d.catalog.plugins.len()), 28.0).grow()));

    // The format chips, most common first.
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for plugin in &d.catalog.plugins {
        for f in &plugin.formats {
            *counts.entry(f.as_str()).or_default() += 1;
        }
    }
    let mut counts: Vec<(&str, usize)> = counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    let mut chips_height = 0.0;
    if counts.len() > 1 {
        let mut chips = div().mt(6.0).wrap().gap(4.0).items_center();
        for (i, (format, count)) in counts.iter().enumerate() {
            let on = d.formats.contains(*format);
            chips = chips.child(
                div()
                    .h(18.0)
                    .px(6.0)
                    .gap(4.0)
                    .items_center()
                    .rounded(4.0)
                    .border(if on { t.primary.alpha(0.3) } else { t.border.alpha(0.6) }, 1.0)
                    .maybe(on, |el| el.bg(t.primary.alpha(0.15)))
                    .maybe(!on, |el| el.hover_bg(t.secondary.alpha(0.6)))
                    .on(Action::FlFormat(i))
                    .child(text(format.to_string(), style(10.5, 400, if on { t.primary } else { t.muted_foreground })))
                    .child(text(count.to_string(), tnum(10.5, 400, t.muted_foreground.alpha(0.5)))),
            );
        }
        if !d.formats.is_empty() {
            chips = chips.child(div().px(4.0).on(Action::FlFormatsClear).child(text("clear", style(10.5, 400, t.muted_foreground.alpha(0.6)))));
        }
        body = body.child(chips);
        chips_height = 24.0;
    }

    let picked_in = |list: &[&Plugin]| list.iter().filter(|p| d.picked.contains(&p.name)).count();
    let (to_favourite, to_remove) = (picked_in(&others), picked_in(&favourites));
    let blocked = d.busy || d.catalog.running;
    let arrow = |name: &'static str, n: usize, fg: Rgba| div().gap(4.0).items_center().child(icon(if d.busy && name == "chevron-right" { "loader2" } else { name }, 14.0, fg)).maybe(n > 0, |el| el.child(text(n.to_string(), tnum(12.0, 500, fg))));
    // Rows in view: the panel less its padding, the heading, the search, the chips, the pane
    // headings and the footer.
    let rows_height = height - 32.0 - 60.0 - 36.0 - chips_height - 26.0 - 40.0 - if d.catalog.running { 48.0 } else { 0.0 };
    body = body.child(
        div()
            .mt(8.0)
            .grow()
            .min_h0()
            .gap(8.0)
            .child(pane(t, "Not favourites", &others, d, 0, rows_height))
            .child(
                col()
                    .shrink0()
                    .justify_center()
                    .items_center()
                    .gap(6.0)
                    .child(button(t, true, !blocked && to_favourite > 0, arrow("chevron-right", to_favourite, t.primary_foreground), Action::FlMove(true)))
                    .child(button(t, false, !blocked && to_remove > 0, arrow("chevron-left", to_remove, t.secondary_foreground), Action::FlMove(false))),
            )
            .child(pane(t, "Favourites", &favourites, d, 1, rows_height)),
    );
    let favourite_count = d.catalog.plugins.iter().filter(|p| p.favourite).count();
    let note = match &d.note {
        Some((text_, bad)) => text(text_.clone(), style(11.0, 400, if *bad { t.primary } else { t.muted_foreground.alpha(0.7) })),
        None => text(format!("{favourite_count} favourites of {}", d.catalog.plugins.len()), style(11.0, 400, t.muted_foreground.alpha(0.7))),
    };
    body = body.child(div().mt(8.0).items_center().gap(8.0).child(note.min_w(0.0)).child(div().grow()).child(button(t, false, true, text("Done", style(12.0, 500, t.secondary_foreground)), Action::FlClose)));
    frame(body, Some(height))
}
