//! Production statistics (`lib/stats.ts`): FL Studio's per-project time record, and the tempos
//! and keys of your own music. Every figure answers to one date range, so no panel re-filters
//! and disagrees with its neighbours.
//!
//! Two corrections carried from the original script: backup copies are left out so a project
//! is not counted twice, and sessions inflated by a window left open overnight are capped at
//! an IQR fence. Creation dates before 2018 are treated as unreliable - still counted, never
//! plotted against time.

use crate::localtime::{self, add_days, midnight, parts, start_of_day, MONTH_NAMES};
use std::collections::{BTreeMap, HashMap};

/// One library file, as much of it as the page reads.
#[derive(Clone, Debug)]
pub struct Row {
    pub flp: bool,
    pub audio: bool,
    pub rel_dir: String,
    pub name: String,
    pub size: i64,
    pub mtime: f64,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub seconds: Option<f64>,
    pub created: Option<f64>,
}

pub const ANALYSIS_START_YEAR: i64 = 2018;

/// `STAT_RANGES`: id label, button label, and how a sentence names it.
pub const RANGES: [(&str, &str); 7] = [
    ("All", "all time"),
    ("7d", "the last 7 days"),
    ("1m", "the last month"),
    ("3m", "the last 3 months"),
    ("6m", "the last 6 months"),
    ("1y", "the last year"),
    ("YTD", "the year so far"),
];

/// `rangeBounds`: local midnights, inclusive, anchored to today; `None` is all time.
pub fn range_bounds(index: usize, today: f64) -> Option<(f64, f64)> {
    let end = start_of_day(today);
    let p = parts(end)?;
    let (y, m, d) = (p.year, p.month, p.day);
    Some(match index {
        0 => return None,
        1 => (add_days(end, -6), end),
        2 => (midnight(y, m - 1, d + 1), end),
        3 => (midnight(y, m - 3, d + 1), end),
        4 => (midnight(y, m - 6, d + 1), end),
        6 => (midnight(y, 1, 1), end),
        _ => (midnight(y - 1, m, d + 1), end),
    })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Day {
    pub ms: f64,
    pub count: u32,
    pub hours: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Month {
    pub label: String,
    pub count: u32,
    pub hours: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub backups: usize,
    pub counted: usize,
    pub dated: usize,
    pub library_counted: usize,
    pub range: Option<(f64, f64)>,
    pub raw_hours: f64,
    pub normalized_hours: f64,
    pub cap_hours: Option<f64>,
    pub capped_count: usize,
    pub median_minutes: f64,
    pub mean_minutes: f64,
    pub first_created: Option<f64>,
    pub last_created: Option<f64>,
    pub years: Vec<(i64, u32, f64)>,
    /// Days with activity only, ascending.
    pub daily: Vec<Day>,
    pub best_day: Option<Day>,
    pub timeline: Vec<Month>,
    pub weekday: [u32; 7],
    pub hour: [u32; 24],
    pub heat: [[u32; 24]; 7],
    pub histogram: Vec<(&'static str, u32)>,
}

const HIST_BOUNDS: [f64; 11] = [0.0, 15.0, 30.0, 45.0, 60.0, 90.0, 120.0, 180.0, 240.0, 330.0, f64::INFINITY];
const HIST_LABELS: [&str; 10] = ["0–15m", "15–30m", "30–45m", "45–60m", "1–1.5h", "1.5–2h", "2–3h", "3–4h", "4–5.5h", "5.5h+"];

fn is_backup(row: &Row) -> bool {
    row.rel_dir.split('/').chain(std::iter::once(row.name.as_str())).any(|s| {
        let s = s.to_lowercase();
        s == "backup" || s == "backups"
    })
}

/// `isUnderAnyDir`, case-insensitive, the virtual root never counting.
pub fn under_any(rel_dir: &str, dirs: &[String]) -> bool {
    let target = rel_dir.to_lowercase();
    dirs.iter().any(|dir| {
        let dir = dir.to_lowercase();
        !dir.is_empty() && (target == dir || target.starts_with(&format!("{dir}/")))
    })
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let pos = (sorted.len() - 1) as f64 * q;
    let base = pos.floor() as usize;
    let rest = pos - base as f64;
    match sorted.get(base + 1) {
        Some(next) => sorted[base] + rest * (next - sorted[base]),
        None => sorted[base],
    }
}

/// `computeStats`.
pub fn compute(rows: &[Row], range: Option<(f64, f64)>) -> Stats {
    let start_ms = midnight(ANALYSIS_START_YEAR, 1, 1);
    // (seconds, created, backup) for every project with a time record.
    let all: Vec<(f64, Option<f64>, bool)> = rows
        .iter()
        .filter(|r| r.flp)
        .filter_map(|r| Some((r.seconds?, r.created.filter(|c| *c >= start_ms), is_backup(r))))
        .collect();
    let end_exclusive = range.map(|(_, end)| add_days(end, 1));
    let records: Vec<&(f64, Option<f64>, bool)> = all
        .iter()
        .filter(|(_, created, _)| match (range, created) {
            (None, _) => true,
            (Some((start, _)), Some(c)) => *c >= start && *c < end_exclusive.unwrap_or(f64::INFINITY),
            (Some(_), None) => false,
        })
        .collect();
    let counted: Vec<&&(f64, Option<f64>, bool)> = records.iter().filter(|r| !r.2).collect();
    let times: Vec<f64> = counted.iter().map(|r| r.0).collect();
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let fence = if sorted.len() >= 4 {
        let (q1, q3) = (quantile(&sorted, 0.25), quantile(&sorted, 0.75));
        q3 + 1.5 * (q3 - q1)
    } else {
        f64::INFINITY
    };
    let cap = |s: f64| s.min(fence);

    let mut s = Stats {
        backups: records.len() - counted.len(),
        counted: counted.len(),
        library_counted: all.iter().filter(|r| !r.2).count(),
        range,
        raw_hours: times.iter().sum::<f64>() / 3600.0,
        normalized_hours: times.iter().map(|t| cap(*t)).sum::<f64>() / 3600.0,
        cap_hours: fence.is_finite().then(|| fence / 3600.0),
        capped_count: times.iter().filter(|t| **t > fence).count(),
        ..Default::default()
    };

    let mut per_year: BTreeMap<i64, (u32, f64)> = BTreeMap::new();
    let mut per_month: BTreeMap<(i64, i64), (u32, f64)> = BTreeMap::new();
    let mut per_day: BTreeMap<i64, Day> = BTreeMap::new();
    for record in counted.iter().filter(|r| r.1.is_some()) {
        let created = record.1.unwrap_or_default();
        let Some(p) = parts(created) else { continue };
        s.dated += 1;
        let capped = cap(record.0);
        let year = per_year.entry(p.year).or_default();
        year.0 += 1;
        year.1 += capped;
        let month = per_month.entry((p.year, p.month)).or_default();
        month.0 += 1;
        month.1 += capped;
        let day_ms = midnight(p.year, p.month, p.day);
        let day = per_day.entry(day_ms as i64).or_insert(Day { ms: day_ms, ..Default::default() });
        day.count += 1;
        day.hours += capped / 3600.0;
        s.weekday[p.weekday] += 1;
        s.hour[p.hour] += 1;
        s.heat[p.weekday][p.hour] += 1;
        s.first_created = Some(s.first_created.map_or(created, |f| f.min(created)));
        s.last_created = Some(s.last_created.map_or(created, |l| l.max(created)));
    }
    s.years = per_year.iter().map(|(y, (c, sec))| (*y, *c, sec / 3600.0)).collect();
    // Month gaps filled, so the timeline reads as continuous time.
    if let (Some(first), Some(last)) = (per_month.keys().next().copied(), per_month.keys().last().copied()) {
        let (mut y, mut m) = first;
        while (y, m) <= last {
            let (count, seconds) = per_month.get(&(y, m)).copied().unwrap_or_default();
            s.timeline.push(Month { label: format!("{} {y}", MONTH_NAMES[m as usize - 1]), count, hours: seconds / 3600.0 });
            m += 1;
            if m > 12 {
                m = 1;
                y += 1;
            }
        }
    }
    s.daily = per_day.into_values().collect();
    // Ties go to the earlier day: the record stands until it is beaten.
    s.best_day = s.daily.iter().fold(None, |best: Option<Day>, d| if best.is_none_or(|b| d.count > b.count) { Some(*d) } else { best });
    s.histogram = HIST_LABELS.iter().map(|l| (*l, 0)).collect();
    for t in &times {
        let minutes = cap(*t) / 60.0;
        if let Some(i) = (0..HIST_BOUNDS.len() - 1).find(|i| minutes >= HIST_BOUNDS[*i] && minutes < HIST_BOUNDS[i + 1]) {
            s.histogram[i].1 += 1;
        }
    }
    let non_zero: Vec<f64> = sorted.iter().filter(|v| **v > 0.0).map(|v| cap(*v)).collect();
    if !non_zero.is_empty() {
        s.median_minutes = quantile(&non_zero, 0.5) / 60.0;
        s.mean_minutes = non_zero.iter().sum::<f64>() / non_zero.len() as f64 / 60.0;
    }
    s
}

/// `daysInRange`: a dense run of days, so a quiet stretch reads as a gap.
pub fn days_in_range(daily: &[Day], start: f64, end: f64) -> Vec<Day> {
    let index: HashMap<i64, Day> = daily.iter().map(|d| (d.ms as i64, *d)).collect();
    let mut out = Vec::new();
    let mut ms = start;
    while ms <= end && out.len() < 20_000 {
        out.push(index.get(&(ms as i64)).copied().unwrap_or(Day { ms, ..Default::default() }));
        ms = add_days(ms, 1);
    }
    out
}

/// `splitDaysByYear`, newest first.
pub fn split_by_year(days: &[Day]) -> Vec<(i64, Vec<Day>)> {
    let mut blocks: Vec<(i64, Vec<Day>)> = Vec::new();
    for day in days {
        let year = parts(day.ms).map_or(0, |p| p.year);
        match blocks.last_mut() {
            Some((y, list)) if *y == year => list.push(*day),
            _ => blocks.push((year, vec![*day])),
        }
    }
    blocks.reverse();
    blocks
}

/// `buildCalendar`: a column per week, a row per weekday with Monday on top.
pub struct Calendar {
    pub rows: [Vec<Option<f64>>; 7],
    pub cells: [Vec<Option<f64>>; 7],
    pub column_labels: Vec<&'static str>,
}

pub fn calendar(days: &[Day], hours: bool) -> Calendar {
    let mut c = Calendar { rows: Default::default(), cells: Default::default(), column_labels: Vec::new() };
    let Some(first) = days.first() else { return c };
    let lead = parts(first.ms).map_or(0, |p| p.weekday);
    let weeks = (lead + days.len()).div_ceil(7);
    let mut labelled = -1i64;
    for week in 0..weeks {
        let mut label = "";
        for dow in 0..7 {
            let index = (week * 7 + dow) as i64 - lead as i64;
            let day = (index >= 0).then(|| days.get(index as usize)).flatten();
            c.rows[dow].push(day.map(|d| if hours { d.hours } else { d.count as f64 }));
            c.cells[dow].push(day.map(|d| d.ms));
            if let Some(d) = day {
                if label.is_empty() {
                    let month = parts(d.ms).map_or(0, |p| p.month);
                    if month != labelled {
                        label = MONTH_NAMES[month as usize - 1];
                        labelled = month;
                    }
                }
            }
        }
        c.column_labels.push(label);
    }
    c
}

/// `formatHours`: "12h 30m", "45m", "5,310h".
pub fn format_hours(hours: f64) -> String {
    if !hours.is_finite() || hours <= 0.0 {
        return "0h".into();
    }
    if hours < 1.0 {
        return format!("{}m", (hours * 60.0).round());
    }
    let whole = hours.floor();
    let minutes = ((hours - whole) * 60.0).round();
    if whole >= 100.0 {
        return format!("{}h", thousands(hours.round() as i64));
    }
    if minutes > 0.0 { format!("{whole}h {minutes}m") } else { format!("{whole}h") }
}

pub fn format_minutes(minutes: f64) -> String {
    if !minutes.is_finite() || minutes <= 0.0 {
        return "—".into();
    }
    if minutes < 60.0 { format!("{}m", minutes.round()) } else { format_hours(minutes / 60.0) }
}

/// `toLocaleString` for an integer, en-US: "2,397".
pub fn thousands(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/* ------------------------------------------------------------------ key and tempo */

#[derive(Clone, Debug, Default)]
pub struct Music {
    pub audio: usize,
    pub with_key: usize,
    pub with_tempo: usize,
    pub library_with_key: usize,
    pub library_with_tempo: usize,
    pub keys: Vec<(String, u32)>,
    pub key_wheel: Vec<(String, u32)>,
    pub tempos: Vec<(i64, u32)>,
    pub histogram: Vec<(i64, u32)>,
    pub median_bpm: Option<f64>,
}

const FIFTHS: [&str; 12] = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];

/// The work a render belongs to: its folder plus its name with the render words off.
fn work_of(row: &Row) -> String {
    let stem = match row.name.rfind('.') {
        Some(at) if at > 0 => &row.name[..at],
        _ => row.name.as_str(),
    };
    format!("{}/{}", row.rel_dir, strip_render_suffix(stem).trim()).to_lowercase()
}

/// `RENDER_SUFFIX`: `(?:[_\s-]*(?:master(?:ed)?|notag|no[_\s-]?tag|final|mixdown|mixed|mix|render|export|v\d+|copy))+$`, case-insensitive.
fn strip_render_suffix(stem: &str) -> &str {
    let mut end = stem.len();
    loop {
        let lower = stem[..end].to_lowercase();
        let mut matched = None;
        // Longest words first, so "mixdown" is not read as "mix" leaving "down".
        for word in ["mastered", "mixdown", "master", "render", "export", "final", "notag", "mixed", "copy", "mix"] {
            if lower.ends_with(word) {
                matched = Some(end - word.len());
                break;
            }
        }
        if matched.is_none() {
            // no[_\s-]?tag
            for word in ["no_tag", "no tag", "no-tag"] {
                if lower.ends_with(word) {
                    matched = Some(end - word.len());
                    break;
                }
            }
        }
        if matched.is_none() {
            // v\d+
            let digits = lower.bytes().rev().take_while(u8::is_ascii_digit).count();
            if digits > 0 && lower.as_bytes().get(lower.len() - digits - 1).is_some_and(|c| *c == b'v') {
                matched = Some(end - digits - 1);
            }
        }
        let Some(mut at) = matched else { break };
        while at > 0 && matches!(stem.as_bytes()[at - 1], b'_' | b'-' | b' ' | b'\t') {
            at -= 1;
        }
        if at == end {
            break;
        }
        end = at;
    }
    &stem[..end]
}

/// `computeMusicStats`: tempo from the projects, key from the audio folded per work, both
/// leaving out the folders that are not your own work.
pub fn compute_music(rows: &[Row], range: Option<(f64, f64)>, exclude: &[String]) -> Music {
    let end_exclusive = range.map(|(_, end)| add_days(end, 1)).unwrap_or(0.0);
    let in_range = |ms: f64| range.is_none_or(|(start, _)| ms >= start && ms < end_exclusive);
    let mut m = Music::default();
    let mut tempo_counts: HashMap<i64, u32> = HashMap::new();
    let mut bpms = Vec::new();
    let mut works: HashMap<String, (&Row, Option<String>)> = HashMap::new();
    for row in rows {
        if row.flp && !is_backup(row) && !under_any(&row.rel_dir, exclude) {
            if let Some(bpm) = row.bpm.filter(|b| *b > 0.0) {
                m.library_with_tempo += 1;
                match row.created {
                    Some(c) if in_range(c) => {}
                    None if range.is_none() => {}
                    _ => continue,
                }
                m.with_tempo += 1;
                let rounded = bpm.round() as i64;
                *tempo_counts.entry(rounded).or_default() += 1;
                bpms.push(rounded);
            }
            continue;
        }
        if row.flp || !row.audio || under_any(&row.rel_dir, exclude) {
            continue;
        }
        let id = work_of(row);
        match works.get_mut(&id) {
            None => {
                works.insert(id, (row, row.key.clone()));
            }
            Some(existing) => {
                if row.size > existing.0.size {
                    existing.0 = row;
                    if row.key.is_some() {
                        existing.1 = row.key.clone();
                    }
                } else if existing.1.is_none() {
                    existing.1 = row.key.clone();
                }
            }
        }
    }
    let mut key_counts: HashMap<String, u32> = HashMap::new();
    for (row, key) in works.values() {
        if key.is_some() {
            m.library_with_key += 1;
        }
        if !in_range(row.mtime) {
            continue;
        }
        m.audio += 1;
        if let Some(key) = key {
            m.with_key += 1;
            *key_counts.entry(crate::keys::relative_pair(key)).or_default() += 1;
        }
    }
    m.keys = key_counts.iter().map(|(k, c)| (k.clone(), *c)).collect();
    m.keys.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    m.tempos = tempo_counts.iter().map(|(b, c)| (*b, *c)).collect();
    m.tempos.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    m.key_wheel = FIFTHS
        .iter()
        .map(|major| crate::keys::relative_pair(major))
        .map(|label| {
            let count = key_counts.get(&label).copied().unwrap_or(0);
            (label, count)
        })
        .filter(|(_, c)| *c > 0)
        .collect();
    if let (Some(min), Some(max)) = (bpms.iter().min(), bpms.iter().max()) {
        let low = min.div_euclid(10) * 10;
        let high = ((max + 1) as f64 / 10.0).ceil() as i64 * 10;
        m.histogram = (low..high).map(|b| (b, tempo_counts.get(&b).copied().unwrap_or(0))).collect();
    }
    bpms.sort();
    let sorted: Vec<f64> = bpms.iter().map(|b| *b as f64).collect();
    m.median_bpm = (!sorted.is_empty()).then(|| quantile(&sorted, 0.5));
    m
}

/// The hour labels along the start heatmap: 12a, 1a … 12p, 1p ….
pub fn hour_label(hour: usize) -> String {
    match hour {
        0 => "12a".into(),
        12 => "12p".into(),
        h if h < 12 => format!("{h}a"),
        h => format!("{}p", h - 12),
    }
}

/// `toLocaleDateString(undefined, { month: 'short', year: 'numeric' })`: "Jan 2018".
pub fn month_year(ms: f64) -> String {
    localtime::parts(ms).map_or(String::new(), |p| format!("{} {}", MONTH_NAMES[p.month as usize - 1], p.year))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_render_names() {
        assert_eq!(strip_render_suffix("REFLECT_Master"), "REFLECT");
        assert_eq!(strip_render_suffix("REFLECT_notag_final"), "REFLECT");
        assert_eq!(strip_render_suffix("beat v2"), "beat");
        assert_eq!(strip_render_suffix("hat (1)"), "hat (1)");
        assert_eq!(strip_render_suffix("remix"), "re");
    }

    #[test]
    fn counts_thousands() {
        assert_eq!(thousands(2397), "2,397");
        assert_eq!(thousands(328705), "328,705");
        assert_eq!(thousands(12), "12");
        assert_eq!(format_hours(5310.2), "5,310h");
        assert_eq!(format_hours(7.4833), "7h 29m");
    }
}
