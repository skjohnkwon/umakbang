//! The search box: `shared/search.ts`'s query language, answered by SQLite on a thread of its
//! own.
//!
//! A substring match over the whole library is 90-215ms here - a scan of 328k rows - which is
//! too long to spend on the window's thread per keystroke. So the window sends each query to
//! this thread, which keeps its own read-only connection, drops any query a newer one has
//! overtaken, and sends the rows back as a wake-up. The window keeps drawing throughout.
//!
//! Ratings, tags and the tempo and key worked out from the audio live in `umakbang-data.json`,
//! not the index, so the filters on them go through SQL functions reading a shared copy the
//! window keeps current. Search sees detected values folded in, as the Electron rows have them.

use crate::app::Wake;
use crate::library::{FileRow, FolderRow};
use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OpenFlags, params_from_iter};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, RwLock};
use winit::event_loop::EventLoopProxy;

/// How many files a search lists. The count past it is still reported.
pub const LIMIT: usize = 5000;
const FOLDER_LIMIT: usize = 500;
const KINDS: [&str; 3] = ["audio", "midi", "project"];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Query {
    pub terms: Vec<String>,
    pub kinds: Vec<String>,
    pub extensions: Vec<String>,
    pub tags: Vec<String>,
    pub keys: Vec<String>,
    pub min_stars: Option<f64>,
    pub max_stars: Option<f64>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub bpm_exact: Option<f64>,
    pub min_duration: Option<f64>,
    pub max_duration: Option<f64>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        *self == Query::default()
    }
}

/// `parseQuery`. Bare words match the path; `field:value` and `field>n` narrow; all ANDed.
pub fn parse(raw: &str) -> Query {
    let mut q = Query::default();
    // Quoted phrases stay together; everything else splits on whitespace.
    let mut tokens = Vec::new();
    let mut rest = raw.trim();
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if let Some(inner) = rest.strip_prefix('"') {
            if let Some(end) = inner.find('"') {
                tokens.push(inner[..end].to_string());
                rest = &inner[end + 1..];
                continue;
            }
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        tokens.push(rest[..end].trim_matches('"').to_string());
        rest = &rest[end..];
    }

    for token in tokens.into_iter().filter(|t| !t.is_empty()) {
        if let Some((field, op, value)) = comparison(&token) {
            let is_bpm = field == "bpm";
            let is_stars = field == "stars" || field == "rating";
            // Inclusive bounds are nudged past the value by less than the data's precision, as
            // the matcher compares strictly.
            let inclusive = op.len() == 2;
            let nudge = if inclusive { 1e-4 } else { 0.0 };
            if op.starts_with('>') {
                if is_stars {
                    q.min_stars = Some(5f64.min(if inclusive { value } else { value + 1.0 }));
                } else if is_bpm {
                    q.bpm_min = Some(value - nudge);
                } else {
                    q.min_duration = Some(value - nudge);
                }
            } else if op.starts_with('<') {
                if is_stars {
                    q.max_stars = Some(0f64.max(if inclusive { value } else { value - 1.0 }));
                } else if is_bpm {
                    q.bpm_max = Some(value + nudge);
                } else {
                    q.max_duration = Some(value + nudge);
                }
            } else if is_stars {
                q.min_stars = Some(value);
                q.max_stars = Some(value);
            } else if is_bpm {
                q.bpm_exact = Some(value);
            }
            continue;
        }

        if let Some(colon) = token.find(':').filter(|&c| c > 0) {
            let field = token[..colon].to_lowercase();
            let value = token[colon + 1..].to_lowercase();
            match field.as_str() {
                "stars" | "rating" | "rated" | "fav" => {
                    let range: Vec<&str> = value.split('-').collect();
                    let digit = |s: &str| (s.len() == 1).then(|| s.parse::<f64>().ok()).flatten();
                    match (range.as_slice(), range.first().and_then(|s| digit(s))) {
                        ([_], Some(a)) => {
                            q.min_stars = Some(a);
                            q.max_stars = Some(a);
                        }
                        ([_, b], Some(a)) if digit(b).is_some() => {
                            q.min_stars = Some(a);
                            q.max_stars = digit(b);
                        }
                        _ => {
                            q.min_stars = Some(1.0);
                            q.max_stars = Some(5.0);
                        }
                    }
                    continue;
                }
                "kind" | "type" => {
                    if KINDS.contains(&value.as_str()) {
                        q.kinds.push(value);
                    }
                    continue;
                }
                "ext" | "format" => {
                    if !value.is_empty() {
                        q.extensions.push(value.trim_start_matches('.').to_string());
                    }
                    continue;
                }
                "tag" => {
                    if !value.is_empty() {
                        q.tags.push(value);
                    }
                    continue;
                }
                "key" => {
                    if !value.is_empty() {
                        q.keys.push(value);
                    }
                    continue;
                }
                "bpm" if !value.is_empty() => {
                    if let Ok(bpm) = value.parse::<f64>() {
                        q.bpm_exact = Some(bpm);
                    }
                    continue;
                }
                _ => {}
            }
        }

        // `project:` with nothing after it is a natural way to type a kind filter.
        let bare = token.trim_end_matches(':').to_lowercase();
        if token.ends_with(':') && KINDS.contains(&bare.as_str()) {
            q.kinds.push(bare);
            continue;
        }
        q.terms.push(token.to_lowercase());
    }
    q
}

/// `(bpm|dur|duration|len|length|stars|rating)([<>]=?|=)(\d+(\.\d+)?)`, case-insensitively.
fn comparison(token: &str) -> Option<(String, String, f64)> {
    let lower = token.to_lowercase();
    for field in ["duration", "length", "rating", "stars", "bpm", "dur", "len"] {
        let Some(rest) = lower.strip_prefix(field) else { continue };
        let op_len = if rest.starts_with(">=") || rest.starts_with("<=") { 2 } else if rest.starts_with(['>', '<', '=']) { 1 } else { continue };
        let (op, number) = rest.split_at(op_len);
        let valid = !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit() || c == '.')
            && number.chars().next().is_some_and(|c| c.is_ascii_digit())
            && number.matches('.').count() <= 1
            && !number.ends_with('.');
        if !valid {
            return None;
        }
        let canonical = match field {
            "duration" | "length" | "len" => "dur",
            other => other,
        };
        return Some((canonical.to_string(), op.to_string(), number.parse().ok()?));
    }
    None
}

/// `scoreMatch`: name hits beat path hits, earlier beats later, shorter names win ties.
pub fn score(name: &str, rel: &str, terms: &[String]) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }
    let (name, path) = (name.to_lowercase(), rel.to_lowercase());
    let mut score = 0.0;
    for term in terms {
        match name.find(term.as_str()) {
            Some(0) => score += 100.0,
            Some(at) => score += 60.0 - (name[..at].chars().count().min(40)) as f64,
            None => score += if path.contains(term.as_str()) { 20.0 } else { 0.0 },
        }
    }
    score - (name.chars().count().min(60)) as f64 / 20.0
}

/// `folderScore`.
fn folder_score(folder: &FolderRow, terms: &[String]) -> f64 {
    let name = folder.name.to_lowercase();
    let mut score = 0.0;
    for term in terms {
        match name.find(term.as_str()) {
            Some(0) => score += 100.0,
            Some(at) => score += 60.0 - (name[..at].chars().count().min(40)) as f64,
            None => {}
        }
    }
    if name.len() == terms.join(" ").len() {
        score += 40.0;
    }
    score - (folder.path.split('/').count().min(10)) as f64
}

/// Whether a key matches what was typed: either half of its relative pair, a prefix of one, or
/// another spelling of the same note.
fn key_matches(key: &str, wanted: &[String]) -> bool {
    let key = key.to_lowercase();
    let pair = crate::keys::relative_pair(&key).to_lowercase();
    let parts: Vec<&str> = std::iter::once(key.as_str()).chain(pair.split('/')).collect();
    wanted.iter().any(|k| parts.iter().any(|part| *part == k || part.starts_with(k.as_str()) || crate::keys::same_key(part, k)))
}

/// The user-data maps the filters read, kept current by the window.
#[derive(Default)]
pub struct Shared {
    pub ratings: HashMap<String, u8>,
    pub tags: HashMap<String, Vec<String>>,
    pub bpm: HashMap<String, f64>,
    pub key: HashMap<String, String>,
}

pub struct Request {
    pub generation: u64,
    pub raw: String,
    /// The folder searched under, label-relative; `""` is the whole library.
    pub dir: String,
    /// Folders off: with nothing typed, every file beneath `dir`, in this sort.
    pub recursive: bool,
    pub sort: crate::columns::Sort,
}

pub struct Results {
    pub generation: u64,
    pub folders: Vec<FolderRow>,
    pub files: Vec<FileRow>,
    /// Every match, of which `files` is the best `LIMIT`.
    pub total: usize,
    /// Whether the files are in relevance order (a text search) rather than wanting the
    /// column sort.
    pub ranked: bool,
}

pub fn spawn(db: PathBuf, shared: Arc<RwLock<Shared>>, proxy: EventLoopProxy<Wake>) -> Option<Sender<Request>> {
    let (tx, rx) = channel::<Request>();
    std::thread::Builder::new()
        .name("search".into())
        .spawn(move || {
            let Ok(conn) = open(&db, shared) else { return };
            serve(&conn, &rx, &proxy);
        })
        .ok()?;
    Some(tx)
}

pub(crate) fn open(path: &PathBuf, shared: Arc<RwLock<Shared>>) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA cache_size = -8000; PRAGMA mmap_size = 0;")?;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    let s = shared.clone();
    conn.create_scalar_function("umk_rating", 1, flags, move |ctx| {
        let path: String = ctx.get(0)?;
        Ok(s.read().map(|d| d.ratings.get(&path).copied().unwrap_or(0) as i64).unwrap_or(0))
    })?;
    let s = shared.clone();
    conn.create_scalar_function("umk_bpm", 2, flags, move |ctx| {
        let own: Option<f64> = ctx.get(1)?;
        if own.is_some() {
            return Ok(own);
        }
        let path: String = ctx.get(0)?;
        Ok(s.read().ok().and_then(|d| d.bpm.get(&path).copied()))
    })?;
    let s = shared.clone();
    conn.create_scalar_function("umk_key", 3, flags, move |ctx| {
        let own: Option<String> = ctx.get(1)?;
        let wanted: String = ctx.get(2)?;
        let wanted: Vec<String> = wanted.split('\n').map(str::to_string).collect();
        let key = match own.filter(|k| !k.is_empty()) {
            Some(key) => Some(key),
            None => {
                let path: String = ctx.get(0)?;
                s.read().ok().and_then(|d| d.key.get(&path).cloned())
            }
        };
        Ok(key.is_some_and(|k| key_matches(&k, &wanted)))
    })?;
    let s = shared;
    conn.create_scalar_function("umk_tags", 2, flags, move |ctx| {
        let path: String = ctx.get(0)?;
        let wanted: String = ctx.get(1)?;
        let Ok(data) = s.read() else { return Ok(false) };
        let Some(tags) = data.tags.get(&path) else { return Ok(false) };
        let lowered: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
        Ok(wanted.split('\n').all(|t| lowered.iter().any(|have| have.contains(t))))
    })?;
    Ok(conn)
}

fn serve(conn: &Connection, rx: &Receiver<Request>, proxy: &EventLoopProxy<Wake>) {
    while let Ok(mut request) = rx.recv() {
        // Only the newest query matters: anything typed past is skipped unanswered.
        while let Ok(newer) = rx.try_recv() {
            request = newer;
        }
        let results = run(conn, &request);
        if proxy.send_event(Wake::Search(results)).is_err() {
            return;
        }
    }
}

/// `LIKE` with its wildcards taken literally.
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn run(conn: &Connection, request: &Request) -> Results {
    let q = parse(&request.raw);
    // Nothing typed lists nothing, unless folders are off and the subtree is the list.
    if q.is_empty() && !request.recursive {
        return Results { generation: request.generation, folders: Vec::new(), files: Vec::new(), total: 0, ranked: false };
    }
    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<rusqlite::types::Value> = Vec::new();
    let arg = |v: rusqlite::types::Value, args: &mut Vec<rusqlite::types::Value>| {
        args.push(v);
        format!("?{}", args.len())
    };
    use rusqlite::types::Value as V;

    // Everything at or below the folder: its own path, or anything under `path/`, as a range on
    // the unique index ('0' sorts straight after '/').
    if !request.dir.is_empty() {
        let own = arg(V::Text(request.dir.clone()), &mut args);
        let from = arg(V::Text(format!("{}/", request.dir)), &mut args);
        let to = arg(V::Text(format!("{}0", request.dir)), &mut args);
        clauses.push(format!("(f.path = {own} OR (f.path >= {from} AND f.path < {to}))"));
    }
    for term in &q.terms {
        let p = arg(V::Text(format!("%{}%", like_escape(term))), &mut args);
        clauses.push(format!("(f.path || '/' || t.name) LIKE {p} ESCAPE '\\'"));
    }
    if !q.kinds.is_empty() {
        let list: Vec<String> = q.kinds.iter().map(|k| arg(V::Text(k.clone()), &mut args)).collect();
        clauses.push(format!("t.kind IN ({})", list.join(",")));
    }
    if !q.extensions.is_empty() {
        let list: Vec<String> = q.extensions.iter().map(|e| arg(V::Text(e.clone()), &mut args)).collect();
        clauses.push(format!("lower(t.ext) IN ({})", list.join(",")));
    }
    if let Some(min) = q.min_duration {
        clauses.push(format!("t.duration > {}", arg(V::Real(min), &mut args)));
    }
    if let Some(max) = q.max_duration {
        clauses.push(format!("t.duration < {}", arg(V::Real(max), &mut args)));
    }
    if q.min_stars.is_some() || q.max_stars.is_some() {
        let (lo, hi) = (q.min_stars.unwrap_or(1.0), q.max_stars.unwrap_or(5.0));
        clauses.push(format!("umk_rating(t.path) BETWEEN {} AND {}", arg(V::Real(lo), &mut args), arg(V::Real(hi), &mut args)));
    }
    if let Some(exact) = q.bpm_exact {
        // Tempo detection and tags disagree by a hair often enough to tolerate rounding.
        clauses.push(format!("abs(umk_bpm(t.path, t.bpm) - {}) <= 0.5", arg(V::Real(exact), &mut args)));
    }
    if let Some(min) = q.bpm_min {
        clauses.push(format!("umk_bpm(t.path, t.bpm) > {}", arg(V::Real(min), &mut args)));
    }
    if let Some(max) = q.bpm_max {
        clauses.push(format!("umk_bpm(t.path, t.bpm) < {}", arg(V::Real(max), &mut args)));
    }
    if !q.keys.is_empty() {
        clauses.push(format!("umk_key(t.path, t.musical_key, {})", arg(V::Text(q.keys.join("\n")), &mut args)));
    }
    if !q.tags.is_empty() {
        clauses.push(format!("umk_tags(t.path, {})", arg(V::Text(q.tags.join("\n")), &mut args)));
    }
    let filter = if clauses.is_empty() { "1".to_string() } else { clauses.join(" AND ") };

    // With words typed, the best matches by `scoreMatch`; without, the column sort - a filter
    // like `ext:wav`, or folders off at the top, can match most of the library, and the first
    // `LIMIT` of it in the wrong order would be the wrong files.
    let ranked = !q.terms.is_empty();
    let by_column = format!(
        "{} {}",
        match request.sort.key.as_str() {
            "name" => "t.name COLLATE NOCASE",
            "kind" => "lower(t.ext)",
            "size" => "t.size",
            "duration" => "t.duration IS NULL, t.duration",
            "bpm" => "umk_bpm(t.path, t.bpm) IS NULL, umk_bpm(t.path, t.bpm)",
            "sampleRate" => "t.sample_rate IS NULL, t.sample_rate",
            "rating" => "umk_rating(t.path)",
            _ => "t.mtime",
        },
        if request.sort.ascending() { "ASC" } else { "DESC" }
    );
    let order = if ranked {
        let terms = q.terms.clone();
        let _ = conn.create_scalar_function("umk_score", 2, FunctionFlags::SQLITE_UTF8, move |ctx| {
            let name: String = ctx.get(0)?;
            let rel: String = ctx.get(1)?;
            Ok(score(&name, &rel, &terms))
        });
        // Ties keep the newest first, which is the order the Electron index usually holds them in.
        "umk_score(t.name, f.path || '/' || t.name) DESC, t.mtime DESC"
    } else {
        by_column.as_str()
    };
    let sql = format!(
        "SELECT {}, f.path FROM tracks t JOIN folders f ON f.id = t.folder WHERE {filter} ORDER BY {order} LIMIT {}",
        crate::library::FILE_COLUMNS,
        LIMIT + 1
    );
    let mut files: Vec<FileRow> = conn
        .prepare(&sql)
        .and_then(|mut statement| {
            statement
                .query_map(params_from_iter(args.iter()), |row| {
                    crate::library::file_row(row, row.get(crate::library::DIR_COLUMN)?)
                })
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();
    let total = if files.len() > LIMIT {
        files.truncate(LIMIT);
        conn.query_row(&format!("SELECT count(*) FROM tracks t JOIN folders f ON f.id = t.folder WHERE {filter}"), params_from_iter(args.iter()), |row| row.get::<_, i64>(0))
            .map(|n| n as usize)
            .unwrap_or(LIMIT)
    } else {
        files.len()
    };

    // Folders match too, by name, so searching finds the drum kit as well as what is in it -
    // only on a text search, since `bpm>120` is a question about files.
    let mut folders = Vec::new();
    if ranked {
        let mut fargs: Vec<V> = Vec::new();
        let mut fclauses = Vec::new();
        if !request.dir.is_empty() {
            fargs.push(V::Text(format!("{}/", request.dir)));
            fargs.push(V::Text(format!("{}0", request.dir)));
            fclauses.push("f.path >= ?1 AND f.path < ?2".to_string());
        }
        for term in &q.terms {
            fargs.push(V::Text(format!("%{}%", like_escape(term))));
            fclauses.push(format!("f.name LIKE ?{} ESCAPE '\\'", fargs.len()));
        }
        let sql = format!("SELECT {} FROM folders f WHERE {} LIMIT 20000", crate::library::FOLDER_COLUMNS, fclauses.join(" AND "));
        folders = conn
            .prepare(&sql)
            .and_then(|mut statement| statement.query_map(params_from_iter(fargs.iter()), crate::library::folder_row).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        folders.sort_by(|a, b| folder_score(b, &q.terms).partial_cmp(&folder_score(a, &q.terms)).unwrap_or(std::cmp::Ordering::Equal));
        folders.truncate(FOLDER_LIMIT);
    }
    Results { generation: request.generation, folders, files, total, ranked }
}

/// `matchesQuery` over a row already in hand - for the lists that are not a folder of the
/// index (a saved view, Downloads), where filtering what is listed beats asking the database.
pub fn matches(file: &FileRow, q: &Query, shared: &Shared) -> bool {
    if q.min_stars.is_some() || q.max_stars.is_some() {
        let rating = shared.ratings.get(&file.path).copied().unwrap_or(0) as f64;
        if rating < q.min_stars.unwrap_or(1.0) || rating > q.max_stars.unwrap_or(5.0) {
            return false;
        }
    }
    if !q.kinds.is_empty() && !q.kinds.contains(&file.kind) {
        return false;
    }
    if !q.extensions.is_empty() && !q.extensions.contains(&file.ext.to_lowercase()) {
        return false;
    }
    if !q.keys.is_empty() {
        let key = file.musical_key.clone().filter(|k| !k.is_empty()).or_else(|| shared.key.get(&file.path).cloned());
        if !key.is_some_and(|k| key_matches(&k, &q.keys)) {
            return false;
        }
    }
    if !q.tags.is_empty() {
        let Some(tags) = shared.tags.get(&file.path) else { return false };
        let lowered: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
        if !q.tags.iter().all(|t| lowered.iter().any(|have| have.contains(t.as_str()))) {
            return false;
        }
    }
    let bpm = file.bpm.or_else(|| shared.bpm.get(&file.path).copied());
    if let Some(exact) = q.bpm_exact {
        if !bpm.is_some_and(|b| (b - exact).abs() <= 0.5) {
            return false;
        }
    }
    if q.bpm_min.is_some_and(|min| !bpm.is_some_and(|b| b > min)) || q.bpm_max.is_some_and(|max| !bpm.is_some_and(|b| b < max)) {
        return false;
    }
    if q.min_duration.is_some_and(|min| !file.duration.is_some_and(|d| d > min)) || q.max_duration.is_some_and(|max| !file.duration.is_some_and(|d| d < max)) {
        return false;
    }
    let rel = if file.dir.is_empty() { file.name.to_lowercase() } else { format!("{}/{}", file.dir, file.name).to_lowercase() };
    q.terms.iter().all(|term| rel.contains(term.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_language() {
        let q = parse(r#"vox project: bpm>=120 key:Am ext:.WAV tag:keeper fav: "two words" dur<30"#);
        assert_eq!(q.terms, vec!["vox", "two words"]);
        assert_eq!(q.kinds, vec!["project"]);
        assert_eq!(q.extensions, vec!["wav"]);
        assert_eq!(q.tags, vec!["keeper"]);
        assert_eq!(q.keys, vec!["am"]);
        assert_eq!((q.min_stars, q.max_stars), (Some(1.0), Some(5.0)));
        assert!((q.bpm_min.unwrap() - (120.0 - 1e-4)).abs() < 1e-9);
        assert!((q.max_duration.unwrap() - 30.0).abs() < 1e-9);
        let q = parse("stars:3-5 bpm:140 rating>2");
        assert_eq!((q.min_stars, q.max_stars, q.bpm_exact), (Some(3.0), Some(5.0), Some(140.0)));
        assert!(parse("   ").is_empty());
    }

    #[test]
    fn keys_match_either_half_and_spelling() {
        assert!(key_matches("Cm", &["eb".into()]));
        assert!(key_matches("Ebm", &["d#m".into()]));
        assert!(!key_matches("Am", &["f".into()]));
    }
}
