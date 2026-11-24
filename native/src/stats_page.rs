//! The Stats page (`StatsPage.tsx`, `Charts.tsx`): tiles, a timeline, bar charts and heatmaps,
//! every one coloured by the visualizer ramp - a bar ends as far up the ramp as its value
//! reaches up the axis, since one gradient spans the whole plot rather than each bar.
//!
//! Charts are painted; their labels are text elements laid over them, because only the tree
//! can draw text. Each chart registers its geometry so the app can turn a pointer position
//! into the bar or cell under it for the tooltip.

use crate::localtime::{format_day, MONTH_NAMES, WEEKDAY_NAMES};
use crate::screen::{style, tnum, Action, State};
use crate::stats::{self, format_hours, format_minutes, thousands, Music, Stats, RANGES};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::text::TextStyle;
use crate::ui::tree::{col, div, icon, paint, text, El};
use resvg::tiny_skia::{FillRule, GradientStop, LinearGradient, Paint, PathBuilder, PixmapMut, Point, SpreadMode, Stroke, Transform};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

pub struct Figures {
    pub stats: Stats,
    pub music: Music,
}

/// Where a chart's items sit, in logical pixels from its own top-left: what the app maps a
/// pointer through.
#[derive(Clone, Copy, Debug)]
pub enum Geom {
    /// `n` equal slots across `width`.
    Bars { n: usize, width: f32 },
    /// `n` points from `left`, `step` apart.
    Timeline { n: usize, left: f32, step: f32 },
    /// A grid of `rows` x `cols` cells starting at `left`, `pitch_x` and `pitch_y` apart.
    Grid { rows: usize, cols: usize, left: f32, pitch_x: f32, pitch_y: f32 },
}

impl Geom {
    pub fn index_at(&self, x: f32, y: f32) -> Option<usize> {
        match *self {
            Geom::Bars { n, width } if n > 0 && x >= 0.0 && x < width => Some(((x / (width / n as f32)) as usize).min(n - 1)),
            Geom::Timeline { n, left, step } if n > 0 => Some((((x - left) / step.max(1e-3)).round().max(0.0) as usize).min(n - 1)),
            Geom::Grid { rows, cols, left, pitch_x, pitch_y } if x >= left && y >= 0.0 => {
                let (c, r) = (((x - left) / pitch_x) as usize, (y / pitch_y) as usize);
                (c < cols && r < rows).then_some(r * cols + c)
            }
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct StatsState {
    pub figures: Option<Rc<Figures>>,
    pub range: usize,
    /// "Over time" plots project counts instead of hours.
    pub timeline_projects: bool,
    /// "Day by day" plots hours instead of project counts.
    pub activity_hours: bool,
    pub scroll: f32,
    pub hover: Option<(u8, usize)>,
    pub geoms: RefCell<HashMap<u8, Geom>>,
    /// The footnotes, wrapped to the page's width by the app (only it can measure text).
    pub notes: Vec<Vec<String>>,
}

/* ------------------------------------------------------------------ chart ids */

const TIMELINE: u8 = 0;
const PER_YEAR: u8 = 1;
const HOURS_YEAR: u8 = 2;
const DAY_BARS: u8 = 3;
const START_HEAT: u8 = 4;
const HISTOGRAM: u8 = 5;
const TEMPOS: u8 = 6;
const KEYS: u8 = 7;
/// One calendar per year, newest first.
const CALENDAR: u8 = 20;

/// The width the page lays out at: the pane less the scrollbar gutter, capped at 1100.
pub fn content_width(middle: f32) -> f32 {
    (middle - 10.0).min(1100.0) - 32.0
}

pub const NOTE_STYLE_SIZE: f32 = 11.0;

/// The footnotes as paragraphs, for the app to wrap.
pub fn notes(f: &Figures, range: usize) -> Vec<String> {
    let s = &f.stats;
    let mut out = Vec::new();
    out.push(
        "Tempo is read from the FL Studio projects themselves, one entry per project, where an .flp states the number exactly and a detector only estimates it. \
         Keys come from the audio, counted per track rather than per file, so a piece exported as a master and an MP3 votes once. \
         Both leave out the folders excluded from the random button (Settings → Not your own work), since a sample pack's file names would otherwise decide what you write."
            .to_string(),
    );
    let cap = s.cap_hours.map_or("the threshold".to_string(), format_hours);
    let tail = if range == 0 {
        format!("Those {} undated projects still count toward the totals here, but are left out of anything plotted against time.", thousands((s.counted - s.dated) as i64))
    } else {
        "A date range can only hold projects with a usable date, so undated ones are excluded from these figures entirely. Switch to All to count them.".to_string()
    };
    out.push(format!(
        "FL Studio counts a project as \"open\", not as \"actively worked on\", so a session left running overnight inflates its total. \
         Outliers are normalised the way the original script did it - an IQR fence - capping anything over {cap} ({} of {} projects); the uncapped figure sits under the headline. \
         Every per-project figure here is the capped one, so a window left open for days lands in the same bucket as a long session rather than setting a record. \
         Backups are excluded so nothing is counted twice, and creation dates before {} are treated as unreliable. {tail}",
        s.capped_count,
        s.counted,
        stats::ANALYSIS_START_YEAR
    ));
    out.push("These stats come from the time-tracking record FL Studio writes into every .flp. Point umakbang at a folder containing your projects to see them.".to_string());
    out
}

/* ------------------------------------------------------------------ the page */

pub fn page(s: &State, t: &Theme, middle: f32) -> El<Action> {
    let st = &s.stats;
    st.geoms.borrow_mut().clear();
    let heat: Rc<Vec<[u8; 4]>> = Rc::new(s.visuals.borrow().palette.heat.clone());
    let width = content_width(middle);
    let scanning = s.scan_status.is_some();
    let Some(f) = st.figures.clone() else {
        return div().grow();
    };
    let (stats, music) = (&f.stats, &f.music);
    let range = RANGES[st.range.min(RANGES.len() - 1)];
    let muted70 = t.muted_foreground.alpha(0.7);

    if stats.library_counted == 0 {
        let body = if scanning {
            col().items_center().gap(8.0).child(icon("loader2", 20.0, t.muted_foreground.alpha(0.6))).child(text("Reading project files - stats appear as they're parsed.", style(12.5, 400, t.muted_foreground)))
        } else {
            let mut c = col()
                .items_center()
                .gap(8.0)
                .child(icon("info", 20.0, t.muted_foreground.alpha(0.5)))
                .child(text("No FL Studio projects found.", style(12.5, 400, t.muted_foreground)));
            for line in st.notes.get(2).into_iter().flatten() {
                c = c.child(text(line.clone(), relaxed(11.5, t.muted_foreground.alpha(0.6))));
            }
            c
        };
        return div().grow().min_w(0.0).min_h0().items_center().justify_center().child(body);
    }

    let mut page = col().w(width + 32.0).p(16.0).gap(12.0);

    // Header: the title, what it counts, and the one range control the whole page answers to.
    let mut ranges = div().items_center().gap(2.0).p(2.0).rounded(6.0).border(t.border, 1.0).bg(t.card.alpha(0.4));
    for (i, (label, _)) in RANGES.iter().enumerate() {
        ranges = ranges.child(toggle(t, label, st.range == i, Action::StatsRange(i)));
    }
    let backups = if stats.backups > 0 { format!(" ({} backups excluded)", thousands(stats.backups as i64)) } else { String::new() };
    page = page.child(
        div()
            .justify_between()
            .items_start()
            .child(
                col()
                    .min_w(0.0)
                    .child(text("Production stats", style(15.0, 500, t.foreground)))
                    .child(text(format!("From FL Studio's per-project time tracking - {} projects across {}{backups}.", thousands(stats.counted as i64), range.1), style(11.5, 400, muted70))),
            )
            .child(
                div()
                    .items_center()
                    .gap(8.0)
                    .maybe(scanning, |el| el.child(div().items_center().gap(6.0).child(icon("loader2", 12.0, t.muted_foreground)).child(text("still scanning", style(11.0, 400, t.muted_foreground)))))
                    .child(ranges.mt(2.0)),
            ),
    );

    if stats.counted == 0 {
        page = page.child(
            col()
                .items_center()
                .gap(6.0)
                .py(40.0)
                .px(16.0)
                .rounded(8.0)
                .border(t.border, 1.0)
                .bg(t.card.alpha(0.4))
                .child(icon("info", 16.0, t.muted_foreground.alpha(0.5)))
                .child(text(format!("No projects created in {}.", range.1), style(12.5, 400, t.muted_foreground)))
                .child(text("Pick a wider range - “All” covers everything Umakbang has scanned.", style(11.5, 400, t.muted_foreground.alpha(0.6)))),
        );
    } else {
        page = projects(page, s, t, stats, &heat, width);
    }

    if music.library_with_key + music.library_with_tempo > 0 {
        page = music_panels(page, s, t, music, &heat, width);
        if let Some(lines) = st.notes.first() {
            page = page.child(note(t, lines));
        }
    }
    if let Some(lines) = st.notes.get(1) {
        page = page.child(note(t, lines).pb(8.0));
    }

    div()
        .grow()
        .min_w(0.0)
        .min_h0()
        .scroll_named("stats", st.scroll)
        .scrollbar(t.border)
        // Not stretched to the viewport: the page's own height is what scrolls.
        .items_start()
        .child(div().grow().min_w(0.0).justify_center().pr(10.0).child(page))
}

fn projects(mut page: El<Action>, s: &State, t: &Theme, stats: &Stats, heat: &Rc<Vec<[u8; 4]>>, width: f32) -> El<Action> {
    let st = &s.stats;
    let all = st.range == 0;
    let range = RANGES[st.range.min(RANGES.len() - 1)];

    // Tiles: `repeat(auto-fit, minmax(132px, 1fr))`, gap 8.
    let first = stats.first_created;
    let tiles: Vec<(String, String, Option<String>)> = vec![
        ("Time producing".into(), format_hours(stats.normalized_hours), Some(format!("{} before capping", format_hours(stats.raw_hours)))),
        (
            "Projects".into(),
            thousands(stats.counted as i64),
            Some(if all { format!("{} with a date", thousands(stats.dated as i64)) } else { format!("across {}", range.1) }),
        ),
        (
            "Most in a day".into(),
            stats.best_day.map_or("—".into(), |d| thousands(d.count as i64)),
            stats.best_day.map(|d| format!("{} · {}", format_day(d.ms, true, false), format_hours(d.hours))),
        ),
        ("Median project".into(), format_minutes(stats.median_minutes), Some(format!("mean {}", format_minutes(stats.mean_minutes)))),
        (
            if all { "Started".into() } else { "First in range".into() },
            first.map_or("—".into(), |ms| if all { crate::localtime::parts(ms).map_or(String::new(), |p| p.year.to_string()) } else { format_day(ms, false, false) }),
            first.map(stats::month_year),
        ),
    ];
    let per_row = (((width + 8.0) / 140.0).floor() as usize).clamp(1, tiles.len());
    let tile_w = (width - (per_row - 1) as f32 * 8.0) / per_row as f32;
    let mut grid = col().gap(8.0);
    for chunk in tiles.chunks(per_row) {
        let mut row = div().gap(8.0);
        for (label, value, hint) in chunk {
            row = row.child(
                col()
                    .w(tile_w)
                    .rounded(8.0)
                    .border(t.border, 1.0)
                    .bg(t.card.alpha(0.4))
                    .px(12.0)
                    .py(10.0)
                    .child(text(label.clone(), style(10.5, 500, t.muted_foreground)))
                    .child(text(value.clone(), TextStyle { line_height: 19.0 * 1.25, ..tnum(19.0, 600, t.foreground) }).mt(2.0))
                    .maybe(hint.is_some(), |el| el.child(text(hint.clone().unwrap_or_default(), style(11.0, 400, t.muted_foreground.alpha(0.7))).mt(2.0))),
            );
        }
        grid = grid.child(row);
    }
    page = page.child(grid);

    // Over time.
    let hours = !st.timeline_projects;
    let busiest = stats.timeline.iter().fold(None, |best: Option<&stats::Month>, m| if best.is_none_or(|b| m.count > b.count) { Some(m) } else { best });
    let points: Vec<(String, f64)> = stats.timeline.iter().map(|m| (m.label.clone(), if hours { m.hours } else { m.count as f64 })).collect();
    let fmt = move |v: f64| if hours { if v >= 10.0 { format!("{}", v.round()) } else { format!("{v:.1}") } } else { format!("{}", v.round()) };
    let chart_w = width - 26.0;
    page = page.child(panel(
        t,
        width,
        "Over time",
        busiest.map(|m| format!("Busiest month: {}, {} projects", m.label, m.count)),
        vec![toggle(t, "Hours", hours, Action::StatsMetric(0, false)), toggle(t, "Projects", !hours, Action::StatsMetric(0, true))],
        timeline(s, t, heat, points, chart_w, if hours { "hours" } else { "projects" }, &fmt),
    ));

    // Per year, side by side when there is room for two of `minmax(240px, 1fr)`.
    let two = width >= 240.0 * 2.0 + 12.0;
    let half = if two { (width - 12.0) / 2.0 } else { width };
    let year_bars = |hours: bool| -> Vec<Bar> {
        stats
            .years
            .iter()
            .map(|(y, c, h)| Bar { label: y.to_string()[2..].to_string(), caption: y.to_string(), value: if hours { *h } else { *c as f64 } })
            .collect()
    };
    let projects_fmt = |v: f64| format!("{} projects", v.round());
    let a = panel(t, half, "Projects per year", None, vec![], bar_chart(s, t, heat, PER_YEAR, year_bars(false), half - 26.0, 140.0, 1, &projects_fmt));
    let b = panel(t, half, "Hours per year", None, vec![], bar_chart(s, t, heat, HOURS_YEAR, year_bars(true), half - 26.0, 140.0, 1, &|v| format_hours(v)));
    page = page.child(if two { div().gap(12.0).child(a).child(b) } else { col().gap(12.0).child(a).child(b) });

    // Day by day: a calendar per year, or a bar per day under a month.
    let bounds = match stats.range {
        Some(r) => Some(r),
        None => stats.first_created.zip(stats.last_created).map(|(a, b)| (crate::localtime::start_of_day(a), crate::localtime::start_of_day(b))),
    };
    let days = bounds.map(|(a, b)| stats::days_in_range(&stats.daily, a, b)).unwrap_or_default();
    let (count, hours_total) = days.iter().fold((0u32, 0.0), |(c, h), d| (c + d.count, h + d.hours));
    let activity_hours = st.activity_hours;
    let format_activity = move |v: f64| if activity_hours { format_hours(v) } else { format!("{} {}", v.round(), if v == 1.0 { "project" } else { "projects" }) };
    let body = if st.range != 1 && st.range != 2 {
        let blocks: Vec<(i64, stats::Calendar)> = stats::split_by_year(&days).into_iter().map(|(y, d)| (y, stats::calendar(&d, activity_hours))).collect();
        let columns = blocks.iter().map(|(_, c)| c.column_labels.len()).max().unwrap_or(1).max(1);
        let max = days.iter().map(|d| if activity_hours { d.hours } else { d.count as f64 }).fold(1.0, f64::max);
        let mut stack = col().gap(16.0);
        for (index, (year, cal)) in blocks.iter().enumerate() {
            let rows: Vec<Vec<Option<f64>>> = cal.rows.to_vec();
            let cells = cal.cells.clone();
            let labels: Vec<String> = cal.column_labels.iter().map(|l| l.to_string()).collect();
            let row_labels: Vec<String> = WEEKDAY_NAMES.iter().enumerate().map(|(i, n)| if i % 2 == 0 { n.to_string() } else { String::new() }).collect();
            let title = move |r: usize, c: usize| cells[r].get(c).copied().flatten().map_or(String::new(), |ms| format_day(ms, true, true));
            let spec = Heat { rows, row_labels, column_labels: labels, label_every: 1, row_label_width: 24.0, cell_height: 13.0, square: Some((22.0, columns)), scale_max: Some(max), sqrt: true, legend: index == 0, left_labels: true };
            stack = stack.child(
                col().gap(4.0).child(text(year.to_string(), tnum(11.0, 500, t.muted_foreground))).child(heatmap(s, t, heat, CALENDAR + index as u8, spec, chart_w, &title, &|v| format_activity(v))),
            );
        }
        stack
    } else {
        let bars: Vec<Bar> = days
            .iter()
            .map(|d| {
                let p = crate::localtime::parts(d.ms);
                Bar {
                    label: if st.range == 1 { p.map_or(String::new(), |p| WEEKDAY_NAMES[p.weekday].to_string()) } else { p.map_or(String::new(), |p| p.day.to_string()) },
                    caption: format_day(d.ms, false, true),
                    value: if activity_hours { d.hours } else { d.count as f64 },
                }
            })
            .collect();
        let every = if bars.len() > 16 { 2 } else { 1 };
        bar_chart(s, t, heat, DAY_BARS, bars, chart_w, 160.0, every, &|v| format_activity(v))
    };
    page = page.child(panel(
        t,
        width,
        "Day by day",
        Some(format!("{} {} · {} across {}", thousands(count as i64), if count == 1 { "project" } else { "projects" }, format_hours(hours_total), range.1)),
        vec![toggle(t, "Projects", !activity_hours, Action::StatsMetric(1, false)), toggle(t, "Hours", activity_hours, Action::StatsMetric(1, true))],
        body,
    ));

    // When projects start, by weekday and hour.
    let peak_hour = (0..24).max_by_key(|h| (stats.hour[*h], std::cmp::Reverse(*h))).unwrap_or(0);
    let peak_day = (0..7).max_by_key(|d| (stats.weekday[*d], std::cmp::Reverse(*d))).unwrap_or(0);
    let spec = Heat {
        rows: stats.heat.iter().map(|r| r.iter().map(|v| Some(*v as f64)).collect()).collect(),
        row_labels: WEEKDAY_NAMES.iter().map(|n| n.to_string()).collect(),
        column_labels: (0..24).map(stats::hour_label).collect(),
        label_every: 3,
        row_label_width: 26.0,
        cell_height: 13.0,
        square: None,
        scale_max: None,
        sqrt: false,
        legend: true,
        left_labels: false,
    };
    let hour_title = |r: usize, c: usize| format!("{} · {}", WEEKDAY_NAMES[r], stats::hour_label(c));
    page = page.child(panel(
        t,
        width,
        "When you start projects",
        Some(if stats.dated > 0 { format!("Peak: {} around {}", WEEKDAY_NAMES[peak_day], stats::hour_label(peak_hour)) } else { "No dated projects in this range".into() }),
        vec![],
        heatmap(s, t, heat, START_HEAT, spec, chart_w, &hour_title, &|v| format!("{} {}", v, if v == 1.0 { "project" } else { "projects" })),
    ));

    // Time per project.
    let bars: Vec<Bar> = stats.histogram.iter().map(|(l, c)| Bar { label: l.replace('–', "-"), caption: l.to_string(), value: *c as f64 }).collect();
    page.child(panel(t, width, "Time per project", Some("How long a single project stays open, in total".into()), vec![], bar_chart(s, t, heat, HISTOGRAM, bars, chart_w, 150.0, 1, &projects_fmt)))
}

fn music_panels(mut page: El<Action>, s: &State, t: &Theme, music: &Music, heat: &Rc<Vec<[u8; 4]>>, width: f32) -> El<Action> {
    let range = RANGES[s.stats.range.min(RANGES.len() - 1)];
    let chart_w = width - 26.0;
    let files = |v: f64| format!("{} {}", v.round(), if v == 1.0 { "file" } else { "files" });
    let empty = |what: &str, noun: &str| div().h(170.0).items_center().justify_center().child(text(format!("No {noun} with a {what} in {}.", range.1), style(11.5, 400, t.muted_foreground.alpha(0.6))));

    let top: Vec<String> = music.tempos.iter().take(3).map(|(b, _)| b.to_string()).collect();
    let subtitle = if music.with_tempo > 0 {
        format!(
            "{} projects across {}{}{}",
            thousands(music.with_tempo as i64),
            range.1,
            music.median_bpm.map_or(String::new(), |m| format!(" · median {} BPM", m.round())),
            if top.is_empty() { String::new() } else { format!(" · most often {} BPM", top.join(", ")) }
        )
    } else {
        format!("Projects per BPM, across {}", range.1)
    };
    let body = if music.histogram.len() > 1 {
        let bars = music.histogram.iter().map(|(b, c)| Bar { label: b.to_string(), caption: format!("{b} BPM"), value: *c as f64 }).collect();
        bar_chart(s, t, heat, TEMPOS, bars, chart_w, 170.0, 10, &files)
    } else {
        empty("tempo", "projects")
    };
    page = page.child(panel(t, width, "Tempos you write at", Some(subtitle), vec![], body));

    let top_key = music.keys.first().map(|(k, _)| k.clone()).unwrap_or_default();
    let subtitle = if music.with_key > 0 {
        format!(
            "{} of {} tracks across {}, counted as relative pairs{}",
            thousands(music.with_key as i64),
            thousands(music.audio as i64),
            range.1,
            if top_key.is_empty() { String::new() } else { format!(" · most often {top_key}") }
        )
    } else {
        format!("Counted as relative pairs, across {}", range.1)
    };
    let body = if music.with_key > 0 {
        let bars = music.key_wheel.iter().map(|(k, c)| Bar { label: k.clone(), caption: k.clone(), value: *c as f64 }).collect();
        bar_chart(s, t, heat, KEYS, bars, chart_w, 170.0, 1, &files)
    } else {
        empty("key", "tracks")
    };
    page.child(panel(t, width, "Keys you write in", Some(subtitle), vec![], body))
}

/* ------------------------------------------------------------------ pieces */

/// `leading-relaxed`.
fn relaxed(size: f32, color: Rgba) -> TextStyle {
    TextStyle { line_height: size * 1.625, ..style(size, 400, color) }
}

fn note(t: &Theme, lines: &[String]) -> El<Action> {
    let mut body = col().min_w(0.0).grow();
    for line in lines {
        body = body.child(text(line.clone(), relaxed(NOTE_STYLE_SIZE, t.muted_foreground.alpha(0.6))));
    }
    div().items_start().gap(6.0).child(icon("info", 12.0, t.muted_foreground.alpha(0.6)).mt(3.0)).child(body)
}

/// The ghost toggle the page uses for every choice: the selected one is the only coloured
/// thing in the row.
fn toggle(t: &Theme, label: &str, active: bool, action: Action) -> El<Action> {
    div()
        .h(20.0)
        .px(6.0)
        .items_center()
        .rounded(6.0)
        .maybe(active, |el| el.bg(t.secondary))
        .maybe(!active, |el| el.hover_bg(t.accent))
        .on(action)
        .child(text(label.to_string(), style(11.0, 500, if active { t.primary } else { t.muted_foreground })))
}

fn panel(t: &Theme, width: f32, title: &str, subtitle: Option<String>, actions: Vec<El<Action>>, body: El<Action>) -> El<Action> {
    let mut heading = col().min_w(0.0).grow().child(text(title.to_string(), style(12.5, 500, t.foreground)));
    if let Some(sub) = subtitle {
        heading = heading.child(text(sub, style(11.0, 400, t.muted_foreground.alpha(0.7))));
    }
    col()
        .w(width)
        .rounded(8.0)
        .border(t.border, 1.0)
        .bg(t.card.alpha(0.4))
        .p(12.0)
        .child(div().mb(8.0).items_start().justify_between().gap(8.0).child(heading).child(div().shrink0().items_center().gap(4.0).children(actions)))
        .child(body)
}

fn axis(t: &Theme) -> TextStyle {
    TextStyle { line_height: 12.0, ..style(9.0, 400, t.muted_foreground.alpha(0.7)) }
}

/// A 9px label whose baseline sits at `baseline`, centred on `x`, or held inside `[0, width]`
/// when centring would push it out - the SVG `text-anchor` the charts choose per label.
fn label_at(t: &Theme, label: &str, x: f32, baseline: f32, width: f32, anchor: Anchor) -> El<Action> {
    const BOX: f32 = 90.0;
    let top = baseline - 9.5;
    let el = text(label.to_string(), axis(t));
    match anchor {
        Anchor::Start => div().absolute(x, top).w(BOX).child(el),
        Anchor::End => div().absolute(x - BOX, top).w(BOX).justify_end().child(el),
        Anchor::Middle => {
            let left = x - BOX / 2.0;
            let _ = width;
            div().absolute(left, top).w(BOX).justify_center().child(el)
        }
    }
}

#[derive(Clone, Copy)]
enum Anchor {
    Start,
    Middle,
    End,
}

/// The tooltip a chart shows over the item under the pointer.
fn tooltip(t: &Theme, x: f32, y: f32, width: f32, title: String, value: String) -> El<Action> {
    let flip = x > width - 120.0;
    let el = col()
        .rounded(6.0)
        .border(t.border, 1.0)
        .bg(t.popover)
        .px(8.0)
        .py(4.0)
        .shadow(4.0, 12.0, 0.3)
        .child(text(title, style(11.0, 500, t.popover_foreground)))
        .child(text(value, style(11.0, 400, t.muted_foreground)));
    let top = (y - 30.0).max(0.0);
    if flip { el.absolute_right(width - x + 10.0, top) } else { el.absolute(x + 10.0, top) }
}

fn ramp_at(heat: &[[u8; 4]], t: f32) -> Rgba {
    let at = ((t.clamp(0.0, 1.0)) * 255.0).round() as usize;
    heat.get(at).map_or(Rgba::rgb8(255, 120, 40), |c| Rgba::rgb8(c[0], c[1], c[2]))
}

/// Twelve stops of the ramp from `bottom` (quiet) up to `top` (loud), in device pixels.
fn ramp_shader(heat: &[[u8; 4]], bottom: f32, top: f32, opacity: impl Fn(f32) -> f32) -> Option<resvg::tiny_skia::Shader<'static>> {
    let stops: Vec<GradientStop> = (0..12)
        .map(|i| {
            let t = i as f32 / 11.0;
            GradientStop::new(t, ramp_at(heat, t).alpha(opacity(t)).skia())
        })
        .collect();
    LinearGradient::new(Point::from_xy(0.0, bottom), Point::from_xy(0.0, top), stops, SpreadMode::Pad, Transform::identity())
}

fn grid_color(t: &Theme) -> Rgba {
    t.muted_foreground.alpha(0.18)
}

fn hline(pm: &mut PixmapMut, x0: f32, x1: f32, y: f32, color: Rgba, scale: f32) {
    let mut pb = PathBuilder::new();
    let y = (y).floor() + 0.5 * scale.max(1.0).min(1.0);
    pb.move_to(x0, y);
    pb.line_to(x1, y);
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(color.skia());
        paint.anti_alias = true;
        pm.stroke_path(&path, &paint, &Stroke { width: scale, ..Stroke::default() }, Transform::identity(), None);
    }
}

/* ------------------------------------------------------------------ timeline */

fn timeline(s: &State, t: &Theme, heat: &Rc<Vec<[u8; 4]>>, points: Vec<(String, f64)>, width: f32, value_label: &str, format: &dyn Fn(f64) -> String) -> El<Action> {
    let height = 150.0;
    let (pad_left, pad_right, pad_top, pad_bottom) = (34.0f32, 8.0f32, 8.0f32, 18.0f32);
    let plot_w = (width - pad_left - pad_right).max(1.0);
    let plot_h = height - pad_top - pad_bottom;
    let max = points.iter().map(|p| p.1).fold(1.0, f64::max);
    let step = if points.len() > 1 { plot_w / (points.len() - 1) as f32 } else { plot_w };
    let x_at = move |i: usize| pad_left + i as f32 * step;
    let y_at = move |v: f64| pad_top + plot_h - (v / max) as f32 * plot_h;
    s.stats.geoms.borrow_mut().insert(TIMELINE, Geom::Timeline { n: points.len(), left: pad_left, step });
    let hover = s.stats.hover.filter(|(id, _)| *id == TIMELINE).map(|(_, i)| i).filter(|i| *i < points.len());

    let values: Vec<f64> = points.iter().map(|p| p.1).collect();
    let (grid, card, hot) = (grid_color(t), t.card, s.visuals.borrow().palette.hot);
    let heat_p = heat.clone();
    let painter = Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        let (ox, oy) = (r[0], r[1]);
        let at = |x: f32, y: f32| (ox + x * scale, oy + y * scale);
        for tick in [0.0, max / 2.0, max] {
            let y = oy + y_at(tick) * scale;
            hline(pm, ox + pad_left * scale, ox + (width - pad_right) * scale, y, grid, scale);
        }
        if values.is_empty() {
            return;
        }
        let bottom = oy + (pad_top + plot_h) * scale;
        let top = oy + pad_top * scale;
        let mut line = PathBuilder::new();
        for (i, v) in values.iter().enumerate() {
            let (x, y) = at(x_at(i), y_at(*v));
            if i == 0 { line.move_to(x, y) } else { line.line_to(x, y) }
        }
        let mut area = line.clone();
        let (last_x, _) = at(x_at(values.len() - 1), 0.0);
        let (first_x, _) = at(x_at(0), 0.0);
        area.line_to(last_x, bottom);
        area.line_to(first_x, bottom);
        area.close();
        if let (Some(path), Some(shader)) = (area.finish(), ramp_shader(&heat_p, bottom, top, |t| 0.04 + t * 0.3)) {
            let paint = Paint { shader, anti_alias: true, ..Paint::default() };
            pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
        }
        if let (Some(path), Some(shader)) = (line.finish(), ramp_shader(&heat_p, bottom, top, |_| 1.0)) {
            let paint = Paint { shader, anti_alias: true, ..Paint::default() };
            let stroke = Stroke { width: 2.0 * scale, line_join: resvg::tiny_skia::LineJoin::Round, ..Stroke::default() };
            pm.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
        }
        if let Some(i) = hover {
            let (x, y) = at(x_at(i), y_at(values[i]));
            let mut pb = PathBuilder::new();
            pb.move_to(x, top);
            pb.line_to(x, bottom);
            if let Some(path) = pb.finish() {
                let mut paint = Paint::default();
                paint.set_color(hot.alpha(0.5).skia());
                pm.stroke_path(&path, &paint, &Stroke { width: scale, ..Stroke::default() }, Transform::identity(), None);
            }
            let dot = ramp_at(&heat_p, 1.0 - (y - top) / (bottom - top));
            for (radius, color) in [(5.0 * scale, card), (4.0 * scale, dot)] {
                if let Some(path) = PathBuilder::from_circle(x, y, radius) {
                    let mut paint = Paint::default();
                    paint.set_color(color.skia());
                    paint.anti_alias = true;
                    pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
                }
            }
        }
    });
    let mut chart = div().w(width).h(height).child(paint(painter).absolute(0.0, 0.0).size(width, height).on(Action::Chart(TIMELINE)));
    for tick in [0.0, max / 2.0, max] {
        let y = y_at(tick) + 3.0;
        chart = chart.child(div().absolute(0.0, y - 9.5).w(pad_left - 6.0).justify_end().child(text(format(tick), axis(t))));
    }
    let label_step = ((points.len() as f32 / ((plot_w / 90.0).floor().max(1.0))).ceil() as usize).max(1);
    for (i, (label, _)) in points.iter().enumerate() {
        if i % label_step == 0 {
            chart = chart.child(label_at(t, label, x_at(i), height - 5.0, width, Anchor::Middle));
        }
    }
    if let Some(i) = hover {
        let (label, v) = &points[i];
        chart = chart.child(tooltip(t, x_at(i), y_at(*v), width, label.clone(), format!("{} {value_label}", format(*v))));
    }
    chart
}

/* ------------------------------------------------------------------ bars */

pub struct Bar {
    pub label: String,
    pub caption: String,
    pub value: f64,
}

#[allow(clippy::too_many_arguments)]
fn bar_chart(s: &State, t: &Theme, heat: &Rc<Vec<[u8; 4]>>, id: u8, bars: Vec<Bar>, width: f32, height: f32, label_every: usize, format: &dyn Fn(f64) -> String) -> El<Action> {
    let (pad_bottom, pad_top) = (18.0f32, 6.0f32);
    let plot_h = height - pad_bottom - pad_top;
    let max = bars.iter().map(|b| b.value).fold(1.0, f64::max);
    let n = bars.len();
    let slot = if n > 0 { width / n as f32 } else { width };
    let bar_w = (slot - 4.0).clamp(3.0, 38.0);
    s.stats.geoms.borrow_mut().insert(id, Geom::Bars { n, width });
    let hover = s.stats.hover.filter(|(h, _)| *h == id).map(|(_, i)| i).filter(|i| *i < n);
    let geometry: Vec<(f32, f32, f32)> = bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let h = ((b.value / max) as f32 * plot_h).max(if b.value > 0.0 { 2.0 } else { 0.0 });
            (i as f32 * slot + (slot - bar_w) / 2.0, pad_top + plot_h - h, h)
        })
        .collect();
    let (grid, heat_p) = (grid_color(t), heat.clone());
    let shapes = geometry.clone();
    let painter = Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        let (ox, oy) = (r[0], r[1]);
        hline(pm, ox, ox + width * scale, oy + (pad_top + plot_h) * scale, grid, scale);
        let Some(shader) = ramp_shader(&heat_p, oy + (pad_top + plot_h) * scale, oy + pad_top * scale, |_| 0.92) else { return };
        let mut pb = PathBuilder::new();
        for &(x, y, h) in &shapes {
            if h <= 0.0 {
                continue;
            }
            let (x, y, w, h) = (ox + x * scale, oy + y * scale, bar_w * scale, h * scale);
            let radius = (4.0 * scale).min(w / 2.0).min(h);
            pb.move_to(x, y + h);
            pb.line_to(x, y + radius);
            pb.quad_to(x, y, x + radius, y);
            pb.line_to(x + w - radius, y);
            pb.quad_to(x + w, y, x + w, y + radius);
            pb.line_to(x + w, y + h);
            pb.close();
        }
        if let Some(path) = pb.finish() {
            let paint = Paint { shader, anti_alias: true, ..Paint::default() };
            pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
        }
    });
    let mut chart = div().w(width).h(height).child(paint(painter).absolute(0.0, 0.0).size(width, height).on(Action::Chart(id)));
    // Widened until the labels fit; the caller's `label_every` is a minimum.
    let longest = bars.iter().map(|b| b.label.chars().count()).max().unwrap_or(0) as f32;
    let fit = ((width / (longest * 5.6 + 10.0)).floor() as usize).max(1);
    let step = if n > 0 && width > 0.0 { label_every.max((n as f32 / fit as f32 / label_every as f32).ceil() as usize * label_every) } else { label_every };
    for (i, bar) in bars.iter().enumerate() {
        if i % step.max(1) != 0 {
            continue;
        }
        let centre = i as f32 * slot + slot / 2.0;
        let half = bar.label.chars().count() as f32 * 5.6 / 2.0;
        let (x, anchor) = if centre - half < 0.0 {
            (0.0, Anchor::Start)
        } else if centre + half > width {
            (width, Anchor::End)
        } else {
            (centre, Anchor::Middle)
        };
        chart = chart.child(label_at(t, &bar.label, x, height - 5.0, width, anchor));
    }
    if let Some(i) = hover {
        let (x, y, _) = geometry[i];
        chart = chart.child(tooltip(t, x + bar_w / 2.0, y, width, bars[i].caption.clone(), format(bars[i].value)));
    }
    chart
}

/* ------------------------------------------------------------------ heatmap */

struct Heat {
    rows: Vec<Vec<Option<f64>>>,
    row_labels: Vec<String>,
    column_labels: Vec<String>,
    label_every: usize,
    row_label_width: f32,
    cell_height: f32,
    /// Square cells no wider than the first, sized as if there were the second's columns -
    /// so every year's calendar shares one cell size.
    square: Option<(f32, usize)>,
    scale_max: Option<f64>,
    sqrt: bool,
    legend: bool,
    left_labels: bool,
}

fn heatmap(s: &State, t: &Theme, heat: &Rc<Vec<[u8; 4]>>, id: u8, h: Heat, width: f32, title: &dyn Fn(usize, usize) -> String, format: &dyn Fn(f64) -> String) -> El<Action> {
    let cols = h.rows.first().map_or(h.column_labels.len(), Vec::len).max(1);
    let max = h.scale_max.unwrap_or_else(|| h.rows.iter().flatten().flatten().copied().fold(0.0, f64::max)).max(1.0);
    let gap = 2.0f32;
    let (cell_w, cell_h) = match h.square {
        Some((max_w, size_columns)) => {
            let fitted = ((width - h.row_label_width) / size_columns.max(1) as f32).floor() - 2.0;
            let size = fitted.min(max_w).max(4.0);
            (size, size)
        }
        None => ((width - h.row_label_width - cols as f32 * gap) / cols as f32, h.cell_height),
    };
    // The row's 10px label is 15px tall, so a short cell sits centred in a taller row.
    let row_h = cell_h.max(15.0);
    let left = h.row_label_width + gap;
    let (pitch_x, pitch_y) = (cell_w + gap, row_h + gap);
    s.stats.geoms.borrow_mut().insert(id, Geom::Grid { rows: h.rows.len(), cols, left, pitch_x, pitch_y });
    let hover = s.stats.hover.filter(|(g, _)| *g == id).map(|(_, i)| (i / cols, i % cols));
    let grid_h = h.rows.len() as f32 * pitch_y - gap;
    let empty = t.muted_foreground.alpha(0.08);
    let sqrt = h.sqrt;
    let shaped = move |i: f64| if sqrt { i.max(0.0).sqrt() } else { i } as f32;
    let heat_p = heat.clone();
    let color = move |intensity: f64| {
        let t = shaped(intensity);
        ramp_at(&heat_p, t).alpha(0.38 + t * 0.62)
    };
    let rows = h.rows.clone();
    let cell_color = color.clone();
    let painter = Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        for (ri, row) in rows.iter().enumerate() {
            for (ci, value) in row.iter().enumerate() {
                let Some(value) = value else { continue };
                let fill = if *value == 0.0 { empty } else { cell_color(*value / max) };
                let x = r[0] + (left + ci as f32 * pitch_x) * scale;
                let y = r[1] + (ri as f32 * pitch_y + (row_h - cell_h) / 2.0) * scale;
                crate::ui::tree::fill_rect(pm, [x / scale, y / scale, x / scale + cell_w, y / scale + cell_h], [f32::MIN, f32::MIN, f32::MAX, f32::MAX], 2.0, fill, scale);
            }
        }
    });
    let mut grid = div().w(width).h(grid_h).child(paint(painter).absolute(0.0, 0.0).size(width, grid_h).on(Action::Chart(id)));
    for (ri, label) in h.row_labels.iter().enumerate() {
        grid = grid.child(div().absolute(0.0, ri as f32 * pitch_y + (row_h - 15.0) / 2.0).w(h.row_label_width).child(text(label.clone(), style(10.0, 400, t.muted_foreground.alpha(0.7)))));
    }
    let mut labels = div().w(width).h(13.5).mt(2.0);
    for (ci, label) in h.column_labels.iter().enumerate() {
        if label.is_empty() || ci % h.label_every.max(1) != 0 {
            continue;
        }
        let x = left + ci as f32 * pitch_x;
        let el = text(label.clone(), TextStyle { line_height: 13.5, ..style(9.0, 400, t.muted_foreground.alpha(0.5)) });
        labels = labels.child(if h.left_labels { div().absolute(x, 0.0).w(60.0).child(el) } else { div().absolute(x + cell_w / 2.0 - 30.0, 0.0).w(60.0).justify_center().child(el) });
    }
    let mut out = col().w(width).child(grid).child(labels);
    if h.legend {
        let mut legend = div().mt(8.0).justify_end().items_center().gap(6.0).child(text("less", style(10.0, 400, t.muted_foreground.alpha(0.6))));
        for step in [0.0, 0.25, 0.5, 0.75, 1.0] {
            legend = legend.child(div().size(14.0, 9.0).rounded(2.0).bg(if step == 0.0 { empty } else { color(step) }));
        }
        out = out.child(legend.child(text("more", style(10.0, 400, t.muted_foreground.alpha(0.6)))));
    }
    if let Some((ri, ci)) = hover {
        if let Some(Some(value)) = h.rows.get(ri).and_then(|r| r.get(ci)) {
            let x = left + ci as f32 * pitch_x + cell_w / 2.0;
            let y = ri as f32 * pitch_y;
            let title = title(ri, ci);
            out = out.child(tooltip(t, x, y, width, if title.is_empty() { format!("{} · {}", h.row_labels[ri], h.column_labels[ci]) } else { title }, format(*value)));
        }
    }
    let _ = MONTH_NAMES;
    out
}
