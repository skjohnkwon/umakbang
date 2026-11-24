//! The table's columns (`lib/columns.ts`), its sort (`compareTracks`, `useVisibleRows`) and
//! what each cell says (`lib/format.ts`).

use crate::library::{FileRow, FolderRow};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum ColumnId {
    Name,
    Rating,
    Type,
    Bpm,
    Key,
    Time,
    Format,
    Size,
    Modified,
    Notes,
    Waveform,
}

pub struct ColumnDef {
    pub id: ColumnId,
    pub key: &'static str,
    pub label: &'static str,
    pub sort: Option<&'static str>,
    pub right: bool,
    pub default_width: f32,
    pub min_width: f32,
    pub hidden_by_default: bool,
}

const fn def(id: ColumnId, key: &'static str, label: &'static str, sort: Option<&'static str>, right: bool, default_width: f32, min_width: f32, hidden: bool) -> ColumnDef {
    ColumnDef { id, key, label, sort, right, default_width, min_width, hidden_by_default: hidden }
}

pub const DEFS: [ColumnDef; 11] = [
    def(ColumnId::Name, "name", "Name", Some("name"), false, 210.0, 120.0, false),
    def(ColumnId::Rating, "rating", "Rating", Some("rating"), true, 76.0, 72.0, false),
    def(ColumnId::Type, "type", "Type", Some("kind"), true, 66.0, 48.0, false),
    def(ColumnId::Bpm, "bpm", "BPM", Some("bpm"), true, 48.0, 40.0, false),
    def(ColumnId::Key, "key", "Key", Some("musicalKey"), true, 44.0, 36.0, false),
    def(ColumnId::Time, "time", "Time", Some("duration"), true, 58.0, 44.0, false),
    def(ColumnId::Format, "format", "Format", Some("sampleRate"), true, 76.0, 52.0, true),
    def(ColumnId::Size, "size", "Size", Some("size"), true, 64.0, 48.0, true),
    def(ColumnId::Modified, "modified", "Modified", Some("mtimeMs"), true, 140.0, 134.0, true),
    def(ColumnId::Notes, "notes", "Notes", None, false, 200.0, 90.0, false),
    def(ColumnId::Waveform, "waveform", "Waveform", None, false, 120.0, 60.0, false),
];

pub fn def_of(id: ColumnId) -> &'static ColumnDef {
    DEFS.iter().find(|d| d.id == id).unwrap_or(&DEFS[0])
}

/// One column as saved: `Settings.columns`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SavedColumn {
    pub id: String,
    pub width: f32,
    #[serde(default = "yes")]
    pub visible: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Column {
    pub id: ColumnId,
    pub width: f32,
    pub visible: bool,
}

/// `normalizeColumns`: unknown ids dropped, new ones appended, widths clamped to their minimum,
/// the saved order kept.
pub fn normalise(saved: &[SavedColumn]) -> Vec<Column> {
    let mut out: Vec<Column> = Vec::new();
    for entry in saved {
        let Some(d) = DEFS.iter().find(|d| d.key == entry.id) else { continue };
        if out.iter().any(|c| c.id == d.id) {
            continue;
        }
        let width = if entry.width.is_finite() && entry.width > 0.0 { entry.width.round() } else { d.default_width };
        out.push(Column { id: d.id, width: width.max(d.min_width), visible: d.id == ColumnId::Name || entry.visible });
    }
    for d in &DEFS {
        if !out.iter().any(|c| c.id == d.id) {
            out.push(Column { id: d.id, width: d.default_width, visible: !d.hidden_by_default });
        }
    }
    out
}

pub fn to_saved(columns: &[Column]) -> Vec<SavedColumn> {
    columns.iter().map(|c| SavedColumn { id: def_of(c.id).key.to_string(), width: c.width, visible: c.visible }).collect()
}

/* ------------------------------------------------------------------ sort */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sort {
    pub key: String,
    pub dir: String,
}

impl Sort {
    pub fn ascending(&self) -> bool {
        self.dir != "desc"
    }

    /// `setSort`: the active column flips; a new one starts ascending, except Modified and Size,
    /// where "most" is the interesting end.
    pub fn clicked(&self, key: &str) -> Sort {
        let dir = if self.key == key {
            if self.ascending() { "desc" } else { "asc" }
        } else if key == "mtimeMs" || key == "size" {
            "desc"
        } else {
            "asc"
        };
        Sort { key: key.to_string(), dir: dir.to_string() }
    }
}

/// `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`, near enough: case- and
/// accent-blind, with runs of digits compared as numbers.
pub fn collate(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) if p.is_ascii_digit() && q.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(&c) = it.peek() {
                        if !c.is_ascii_digit() {
                            break;
                        }
                        digits.push(c);
                        it.next();
                    }
                    digits
                };
                let (m, n) = (take(&mut x), take(&mut y));
                let (m, n) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let order = m.len().cmp(&n.len()).then_with(|| m.cmp(n));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(p), Some(q)) => {
                let order = weight(p).cmp(&weight(q));
                if order != Ordering::Equal {
                    return order;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// ICU's root order for what is not a letter or a digit: space first, then this punctuation in
/// this order, then digits, then letters. Measured against `Intl.Collator` in Node, which is
/// what the Electron table and the server sort by - `_` comes before `!`, and `a b` before `ab`.
const PUNCTUATION: &str = r#"_-,;:!?.'"()[]{}@*/\&#%`^+<=>|~$"#;

/// Where a character sorts: its group, then its place in it.
fn weight(c: char) -> (u8, u32) {
    if c.is_whitespace() {
        return (0, c as u32);
    }
    if let Some(at) = PUNCTUATION.find(c) {
        return (1, at as u32);
    }
    if c.is_ascii_digit() {
        return (2, c as u32);
    }
    let folded = fold(c);
    if folded.is_alphanumeric() {
        (3, folded as u32)
    } else {
        // Other symbols sit with the punctuation, after the ASCII ones.
        (1, 0x100 + c as u32)
    }
}

/// Base letters only: case and the common Latin accents fold away, as `sensitivity: 'base'`.
fn fold(c: char) -> char {
    let lower = c.to_lowercase().next().unwrap_or(c);
    match lower {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

/// Missing values sink to the bottom whichever way the column sorts; the direction applies
/// only between two real values (`compareOptionalNumber`).
fn optional<T: PartialOrd>(a: Option<T>, b: Option<T>, names: Ordering, sign: Ordering) -> Ordering {
    let apply = |o: Ordering| if sign == Ordering::Less { o.reverse() } else { o };
    match (a, b) {
        (None, None) => apply(names),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => apply(a.partial_cmp(&b).unwrap_or(Ordering::Equal).then(names)),
    }
}

/// Sorts a folder's files in place by `sort`, as `useVisibleRows` does.
pub fn sort_files(files: &mut [FileRow], sort: &Sort, ratings: &HashMap<String, u8>, bpm_of: impl Fn(&FileRow) -> Option<f64>, key_of: impl Fn(&FileRow) -> Option<String>) {
    let sign = if sort.ascending() { Ordering::Greater } else { Ordering::Less };
    let apply = |o: Ordering| if sign == Ordering::Less { o.reverse() } else { o };
    files.sort_by(|a, b| {
        let names = collate(&a.name, &b.name);
        match sort.key.as_str() {
            "name" => apply(names),
            "kind" => apply(collate(&a.ext, &b.ext).then(names)),
            "musicalKey" => {
                let (x, y) = (key_of(a).filter(|k| !k.is_empty()), key_of(b).filter(|k| !k.is_empty()));
                match (x, y) {
                    (None, None) => apply(names),
                    (None, Some(_)) => Ordering::Greater,
                    (Some(_), None) => Ordering::Less,
                    (Some(x), Some(y)) => apply(collate(&x, &y).then(names)),
                }
            }
            "duration" => optional(a.duration, b.duration, names, sign),
            "bpm" => optional(bpm_of(a), bpm_of(b), names, sign),
            "sampleRate" => optional(a.sample_rate, b.sample_rate, names, sign),
            "size" => apply(a.size.cmp(&b.size).then(names)),
            "mtimeMs" => apply(a.mtime.partial_cmp(&b.mtime).unwrap_or(Ordering::Equal).then(names)),
            "rating" => {
                let (x, y) = (ratings.get(&a.path).copied().unwrap_or(0), ratings.get(&b.path).copied().unwrap_or(0));
                if x != y { apply(x.cmp(&y)) } else { names }
            }
            _ => Ordering::Equal,
        }
    });
}

/// Folders above files, alphabetical, following the sort only where a folder row has a value:
/// Modified (its newest file) and Name.
pub fn sort_folders(folders: &mut [FolderRow], sort: &Sort) {
    folders.sort_by(|a, b| collate(&a.name, &b.name));
    match sort.key.as_str() {
        "mtimeMs" => folders.sort_by(|a, b| {
            let order = a.latest.partial_cmp(&b.latest).unwrap_or(Ordering::Equal);
            let order = if sort.ascending() { order } else { order.reverse() };
            order.then_with(|| collate(&a.name, &b.name))
        }),
        "name" if !sort.ascending() => folders.reverse(),
        _ => {}
    }
}

/* ------------------------------------------------------------------ cells */

/// `formatDuration`: m:ss, or h:mm:ss past the hour.
pub fn duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "—".into();
    }
    let total = seconds.floor() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// `formatDurationPrecise`: hundredths under ten seconds, where 0:00 would say nothing.
pub fn duration_precise(seconds: Option<f64>) -> String {
    match seconds {
        Some(s) if s.is_finite() && s < 10.0 => format!("{s:.2}s"),
        Some(s) => duration(s),
        None => "—".into(),
    }
}

/// `formatSize`.
pub fn size(bytes: i64) -> String {
    if bytes < 0 {
        return "—".into();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 100.0 { format!("{} {}", value.round(), units[unit]) } else { format!("{value:.1} {}", units[unit]) }
}

/// `formatFormat`, from what the index holds: the sample rate.
pub fn format(rate: Option<i64>) -> String {
    match rate {
        Some(rate) if rate >= 1000 => {
            if rate % 1000 == 0 { format!("{}k", rate / 1000) } else { format!("{:.1}k", rate as f64 / 1000.0) }
        }
        Some(rate) => rate.to_string(),
        None => "—".into(),
    }
}

/// `dayPosition`: how far through the day, as a hill peaking at noon.
pub fn day_position(ms: f64) -> f32 {
    1.0 - (12.0 - crate::localtime::hours(ms)).abs() / 12.0
}

/// `tempoPosition`: 60 to 200 BPM across the ramp.
pub fn tempo_position(bpm: f64) -> f32 {
    ((bpm - 60.0) / 140.0) as f32
}

#[cfg(test)]
mod collate_tests {
    #[test]
    fn as_intl_collator() {
        // `[...].sort(new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'}).compare)`
        let mut names = vec!["ab", "a10", "a.b", "a!b", "a_b", "a(b", "a9", "a-b", "a1b", "a b"];
        names.sort_by(|a, b| super::collate(a, b));
        assert_eq!(names, vec!["a b", "a_b", "a-b", "a!b", "a.b", "a(b", "a1b", "a9", "a10", "ab"]);
        assert_eq!(super::collate("A", "a"), std::cmp::Ordering::Equal);
        assert_eq!(super::collate("_a", "!a"), std::cmp::Ordering::Less);
    }
}
