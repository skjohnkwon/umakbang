//! The tailnet server (`remote-process.ts`, `remote-browse.ts`, `remote-routes.ts`): this
//! library, read-only, to the other machines on the tailnet and the phone. Protocol 3, so an
//! Electron umakbang on another machine and the phone app talk to this one as to themselves.
//!
//! Security lives at the bind. The address is the one Tailscale reports for this machine and is
//! used exactly as given: there is no wildcard and no fallback, because a server that quietly
//! listens on the wrong interface is serving somebody's whole library to an airport.
//!
//! The rows come from the native index (`library.db`) rather than the Electron app's NDJSON
//! files. That index is kept current by every scan and file operation here, so there is no
//! journal to fold in: `/index` is always the library as it is, and `/index/patch` is empty.
//!
//! Nothing that arrives over the wire renames, moves, copies or deletes a file. The only writes
//! are a rating, a set of tags and a request to look at the disk again, and those are handed to
//! the app - the one writer of `umakbang-data.json` - and answered on what it says happened.

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PORT: u16 = 47828;
/// 4: folder hash trees, ETags on `/list` and `/wait` (`v0.6-tree-hashes.md`). All additive: a
/// protocol-3 peer ignores the new fields and never sends what would use them.
pub const PROTOCOL: u32 = 4;

/// How many answered requests the monitor remembers: a window for watching a transfer happen,
/// not a log.
const RECENT_LIMIT: usize = 50;
/// The only bodies accepted are a rating and a few tags.
const MAX_BODY: u64 = 64 * 1024;

/* ------------------------------------------------------------------ configuration */

#[derive(Clone, Debug)]
pub struct Library {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub os: String,
    pub version: String,
}

/// What the app hands the supervisor: everything but where to listen.
#[derive(Clone, Debug)]
pub struct Base {
    pub device_id: String,
    pub roots: Vec<(String, String)>,
    pub data_dir: PathBuf,
    pub db: PathBuf,
    pub fl_user_data: PathBuf,
}

/// `libraryId`: the same id Electron gives the same folder, so a peer that knows this library
/// from before still recognises it.
pub fn library_id(device_id: &str, path: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(format!("{device_id}:{path}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string()
}

/// FL Studio's user data folder where it puts it by default.
pub fn default_fl_user_data() -> PathBuf {
    crate::portable::home().join("Documents").join("Image-Line").join("FL Studio")
}

/// A write arriving from a peer, on its way to the app.
#[derive(Debug)]
pub enum Write {
    Rating { path: String, rating: f64 },
    Tags { path: String, tags: Vec<String> },
    Rescan { path: String },
}

/// Hands a write to the app and waits for what it says happened.
pub type Forward = Arc<dyn Fn(Write) -> Result<(), String> + Send + Sync>;
/// The counters moved: the monitor may want drawing again.
pub type Notify = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct Log {
    pub peer: String,
    pub path: String,
    pub detail: Option<String>,
    pub status: u16,
    pub bytes: u64,
    pub ms: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub started_at: f64,
    pub requests: u64,
    pub bytes_out: u64,
    pub refused: u64,
    pub in_flight: u64,
    pub recent: VecDeque<Log>,
}

#[derive(Clone, Debug, Default)]
pub struct ServerState {
    pub listening: bool,
    pub address: Option<String>,
    pub port: u16,
    pub reason: Option<String>,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn mtime_ms(path: &Path) -> Option<f64> {
    std::fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs_f64() * 1000.0)
}

/* ------------------------------------------------------------------ the running server */

struct Ctx {
    libraries: Vec<Library>,
    device: Device,
    data_dir: PathBuf,
    db: PathBuf,
    fl_user_data: PathBuf,
    forward: Forward,
    notify: Notify,
    stats: Arc<Mutex<Stats>>,
    /// `umakbang-data.json`'s annotations, parsed again only when the file changes.
    notes: Mutex<Option<(SystemTime, Arc<Notes>)>>,
    peaks: Mutex<Option<(SystemTime, Arc<Value>)>>,
    /// One hash computation at a time; and the libraries whose tree is being built in the
    /// background for a `/hello` that could not wait for it.
    hashing: Arc<Mutex<()>>,
    building: Arc<Mutex<std::collections::HashSet<String>>>,
}

#[derive(Default)]
struct Notes {
    ratings: Map<String, Value>,
    tags: Map<String, Value>,
    detected_bpm: Map<String, Value>,
    detected_key: Map<String, Value>,
    /// The same, shaped for the search connection's functions.
    shared: Arc<RwLock<crate::search::Shared>>,
}

pub struct Running {
    server: Arc<tiny_http::Server>,
    accept: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(handle) = self.accept.take() {
            let _ = handle.join();
        }
    }
}

fn start(address: &str, port: u16, base: &Base, device: Device, forward: Forward, notify: Notify, stats: Arc<Mutex<Stats>>) -> Result<Running, String> {
    let server = tiny_http::Server::http((address, port)).map_err(|e| {
        // Most likely the Electron umakbang, which serves on the same port from the tray.
        let taken = e.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::AddrInUse) || e.to_string().contains("10048");
        if taken { format!("Another umakbang is already serving on {address}. This one takes over when it stops.") } else { format!("Could not listen on {address}: {e}") }
    })?;
    let server = Arc::new(server);
    let libraries = base
        .roots
        .iter()
        .map(|(path, label)| Library { id: library_id(&base.device_id, path), label: label.clone(), path: path.trim_end_matches(['\\', '/']).to_string() })
        .collect();
    let ctx = Arc::new(Ctx {
        libraries,
        device,
        data_dir: base.data_dir.clone(),
        db: base.db.clone(),
        fl_user_data: base.fl_user_data.clone(),
        forward,
        notify,
        stats,
        notes: Mutex::new(None),
        peaks: Mutex::new(None),
        hashing: Arc::new(Mutex::new(())),
        building: Arc::new(Mutex::new(std::collections::HashSet::new())),
    });
    if let Ok(mut s) = ctx.stats.lock() {
        *s = Stats { started_at: now_ms(), ..Stats::default() };
    }
    (ctx.notify)();
    let accepting = server.clone();
    let accept = std::thread::Builder::new()
        .name("server".into())
        .spawn(move || {
            for request in accepting.incoming_requests() {
                let ctx = ctx.clone();
                // A thread a request: a ranged audition and a 240MB index must not queue
                // behind each other, and a panic in one costs that one socket only.
                let _ = std::thread::Builder::new().name("request".into()).spawn(move || serve(&ctx, request));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Running { server, accept: Some(accept) })
}

/* ------------------------------------------------------------------ replies */

enum Body {
    Empty,
    Bytes(Vec<u8>),
    Reader(Box<dyn Read + Send>, Option<usize>),
}

struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Body,
}

fn bare(status: u16) -> Reply {
    Reply { status, headers: Vec::new(), body: Body::Empty }
}

fn json_reply(value: &impl Serialize, status: u16) -> Reply {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    Reply { status, headers: vec![("Content-Type", "application/json".into())], body: Body::Bytes(bytes) }
}

/// Counts what goes out, for the monitor.
struct Counting<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, AtomicOrdering::Relaxed);
        Ok(n)
    }
}

fn serve(ctx: &Ctx, mut request: tiny_http::Request) {
    let started = Instant::now();
    let url = request.url().to_string();
    let method = request.method().as_str().to_string();
    let peer = request.remote_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let (path, query) = url.split_once('?').map_or((url.as_str(), ""), |(p, q)| (p, q));
    let path = path.to_string();
    let params = parse_query(query);
    if let Ok(mut s) = ctx.stats.lock() {
        s.in_flight += 1;
    }

    // An allowlist of exact pathnames for the only writes there are; adding a route below does
    // not make it writable.
    let writable = matches!(path.as_str(), "/metadata/rating" | "/metadata/tags" | "/rescan");
    let reply = match method.as_str() {
        "GET" | "HEAD" => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| route(ctx, &request, &path, &params))).unwrap_or_else(|_| bare(500)),
        "POST" if writable => write(ctx, &mut request, &path, &params),
        _ => bare(405),
    };

    let status = reply.status;
    let count = Arc::new(AtomicU64::new(0));
    let mut headers: Vec<tiny_http::Header> = reply.headers.iter().filter_map(|(k, v)| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).ok()).collect();
    let (reader, length): (Box<dyn Read + Send>, Option<usize>) = match reply.body {
        Body::Empty => (Box::new(std::io::empty()), Some(0)),
        Body::Bytes(bytes) => {
            let n = bytes.len();
            (Box::new(std::io::Cursor::new(bytes)), Some(n))
        }
        Body::Reader(reader, length) => (reader, length),
    };
    headers.retain(|h| !h.field.equiv("Content-Length"));
    let response = tiny_http::Response::new(tiny_http::StatusCode(status), headers, Counting { inner: reader, count: count.clone() }, length, None);
    let _ = request.respond(response);

    let detail = params.get("rel").and_then(|r| r.first()).map(|r| r.rsplit(['/', '\\']).next().unwrap_or(r).to_string()).or_else(|| {
        let id = params.get("library").and_then(|v| v.first())?;
        Some(ctx.libraries.iter().find(|l| &l.id == id).map_or_else(|| id.clone(), |l| l.label.clone()))
    });
    if let Ok(mut s) = ctx.stats.lock() {
        s.in_flight = s.in_flight.saturating_sub(1);
        s.requests += 1;
        let bytes = count.load(AtomicOrdering::Relaxed);
        s.bytes_out += bytes;
        if status >= 400 {
            s.refused += 1;
        }
        s.recent.push_front(Log { peer, path, detail, status, bytes, ms: started.elapsed().as_millis() as u64 });
        s.recent.truncate(RECENT_LIMIT);
    }
    (ctx.notify)();
}

/// `URLSearchParams`, each name to every value it was given.
fn parse_query(query: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.entry(decode(k)).or_default().push(decode(v));
    }
    out
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn param<'a>(params: &'a HashMap<String, Vec<String>>, name: &str) -> Option<&'a str> {
    params.get(name).and_then(|v| v.first()).map(String::as_str)
}

fn library_of<'a>(ctx: &'a Ctx, params: &HashMap<String, Vec<String>>) -> Option<&'a Library> {
    let id = param(params, "library")?;
    ctx.libraries.iter().find(|l| l.id == id)
}

/* ------------------------------------------------------------------ paths */

fn canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// `resolveUnder`: a path off the wire, inside `root` or nothing. `..` is refused outright and
/// links are followed before the check, so neither can step outside. Returns the path as the
/// library spells it, which is what the annotation maps are keyed by.
fn resolve_under(root: &str, rel: &str) -> Option<PathBuf> {
    if root.is_empty() || rel.is_empty() || rel.contains('\0') {
        return None;
    }
    let within = rel.replace('\\', "/");
    let within = within.trim_start_matches('/');
    if within.split('/').any(|s| s == "..") || within.contains(':') {
        return None;
    }
    let joined = Path::new(root).join(within.replace('/', "\\"));
    let (base, real) = (canonical(Path::new(root))?, canonical(&joined)?);
    if real != base && !real.starts_with(&base) {
        return None;
    }
    Some(joined)
}

fn resolve_in_library(library: &Library, rel: &str) -> Option<PathBuf> {
    resolve_under(&library.path, rel)
}

/// `relativeToLibrary`: an absolute path recorded somewhere (a project's sample list) as a
/// path within the library, by prefix or, failing that, by where the library's own folder name
/// appears in it - the same library on another machine, under another drive letter.
fn relative_to_library(library: &Library, absolute: &str) -> Option<String> {
    let fold = |v: &str| v.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let (root, target) = (fold(&library.path), fold(absolute));
    let slashed = absolute.replace('\\', "/");
    if target == root {
        return Some(String::new());
    }
    if target.starts_with(&format!("{root}/")) {
        return Some(slashed[library.path.len()..].trim_start_matches('/').to_string());
    }
    let base = root.rsplit('/').next().filter(|b| !b.is_empty())?;
    let marker = format!("/{base}/");
    target.find(&marker).map(|at| slashed[at + marker.len()..].to_string())
}

/// `folderParam`: a folder within the library, no `..`, no NUL; `""` is the library itself.
fn folder_param(raw: Option<&str>) -> Option<String> {
    let value = raw.unwrap_or("").replace('\\', "/");
    let value = value.trim_start_matches('/').trim_end_matches('/').to_string();
    if value.contains('\0') || value.split('/').any(|s| s == "..") {
        return None;
    }
    Some(value)
}

/// `parseRange`: `bytes=a-b`, `bytes=a-` or `bytes=-n`.
fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else { return Ok(None) };
    let spec = header.trim().strip_prefix("bytes=").ok_or(())?;
    let (a, b) = spec.split_once('-').ok_or(())?;
    if a.is_empty() && b.is_empty() || !a.chars().all(|c| c.is_ascii_digit()) || !b.chars().all(|c| c.is_ascii_digit()) {
        return Err(());
    }
    if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        return Ok(Some((size.saturating_sub(n), size.saturating_sub(1))));
    }
    let start: u64 = a.parse().map_err(|_| ())?;
    let end = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<u64>().map_err(|_| ())?.min(size.saturating_sub(1)) };
    if start >= size || end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

/* ------------------------------------------------------------------ the index */

fn connect(ctx: &Ctx) -> Option<Connection> {
    let conn = Connection::open_with_flags(&ctx.db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let _ = conn.execute_batch("PRAGMA cache_size = -4000; PRAGMA mmap_size = 0; PRAGMA busy_timeout = 5000;");
    Some(conn)
}

/// What moves when the library does: the newest write to the index. Absent when this library
/// has nothing in the index yet - "never scanned", not "empty".
fn generation(ctx: &Ctx, conn: &Connection, library: &Library) -> Option<f64> {
    let present: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE path = ?1)", params![library.label], |r| r.get(0)).unwrap_or(false);
    if !present {
        return None;
    }
    let wal = PathBuf::from(format!("{}-wal", ctx.db.display()));
    let stamp = [mtime_ms(&ctx.db), mtime_ms(&wal)].into_iter().flatten().fold(0.0, f64::max);
    Some(stamp.floor())
}

/// A row as `/index` sends a `Track`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackOut {
    path: String,
    rel: String,
    dir: String,
    rel_dir: String,
    name: String,
    ext: String,
    size: i64,
    mtime_ms: f64,
    kind: String,
    playable: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    probed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_rate: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bit_depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channels: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bitrate: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bpm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    musical_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_created_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_seconds: Option<f64>,
}

pub(crate) const TRACK_COLUMNS: &str = "t.path, t.name, t.ext, t.kind, t.size, t.mtime, t.duration, t.bpm, t.musical_key, t.playable, t.sample_rate, t.bit_depth, t.channels, t.bitrate, t.project_seconds, t.probed, f.path, t.project_created";

pub(crate) fn track_of(row: &rusqlite::Row) -> rusqlite::Result<TrackOut> {
    let path: String = row.get(0)?;
    let name: String = row.get(1)?;
    let rel_dir: String = row.get(16)?;
    let dir = path.rfind(['\\', '/']).map_or_else(String::new, |at| path[..at].to_string());
    Ok(TrackOut {
        rel: format!("{rel_dir}/{name}"),
        dir,
        rel_dir,
        name,
        ext: row.get::<_, String>(2)?.to_lowercase(),
        kind: row.get(3)?,
        size: row.get(4)?,
        mtime_ms: row.get(5)?,
        duration: row.get(6)?,
        bpm: row.get(7)?,
        musical_key: row.get::<_, Option<String>>(8)?.filter(|k| !k.is_empty()),
        playable: row.get(9)?,
        sample_rate: row.get(10)?,
        bit_depth: row.get(11)?,
        channels: row.get(12)?,
        bitrate: row.get(13)?,
        project_seconds: row.get(14)?,
        probed: row.get::<_, Option<bool>>(15)?.unwrap_or(false),
        project_created_ms: row.get(17)?,
        path,
    })
}

/// The SQL that keeps a query to a folder and everything below it, by its label-relative path.
fn scope_clause(first: usize) -> String {
    format!("(f.path = ?{first} OR (f.path >= ?{} AND f.path < ?{}))", first + 1, first + 2)
}

fn scope_args(path: &str) -> [String; 3] {
    [path.to_string(), format!("{path}/"), format!("{path}0")]
}

fn db_path(library: &Library, dir: &str) -> String {
    if dir.is_empty() { library.label.clone() } else { format!("{}/{dir}", library.label) }
}

/// The index and nothing else, gzipped and streamed as it is read: NDJSON compresses five to
/// ten times, and buffering a quarter of a gigabyte to find its length is what streaming is for.
fn send_index(ctx: &Ctx, library: &Library) -> Reply {
    let Some(conn) = connect(ctx) else { return bare(500) };
    if generation(ctx, &conn, library).is_none() {
        return bare(204);
    }
    drop(conn);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(8);
    let db = ctx.db.clone();
    let label = library.label.clone();
    std::thread::spawn(move || {
        let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return };
        let _ = conn.execute_batch("PRAGMA cache_size = -4000; PRAGMA mmap_size = 0;");
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t JOIN folders f ON f.id = t.folder WHERE {}", scope_clause(1));
        let Ok(mut statement) = conn.prepare(&sql) else { return };
        let [a, b, c] = scope_args(&label);
        let Ok(mut rows) = statement.query(params![a, b, c]) else { return };
        let mut gz = flate2::write::GzEncoder::new(ChunkWriter { tx: tx.clone(), buf: Vec::with_capacity(64 * 1024) }, flate2::Compression::fast());
        while let Ok(Some(row)) = rows.next() {
            let Ok(track) = track_of(row) else { continue };
            let Ok(mut line) = serde_json::to_vec(&track) else { continue };
            line.push(b'\n');
            if std::io::Write::write_all(&mut gz, &line).is_err() {
                return; // The other end went away.
            }
        }
        if let Ok(mut inner) = gz.finish() {
            let _ = std::io::Write::flush(&mut inner);
        }
    });
    Reply {
        status: 200,
        headers: vec![("Content-Type", "application/x-ndjson".into()), ("Content-Encoding", "gzip".into())],
        body: Body::Reader(Box::new(ChannelReader { rx, at: Vec::new(), pos: 0 }), None),
    }
}

struct ChunkWriter {
    tx: SyncSender<Vec<u8>>,
    buf: Vec<u8>,
}

impl std::io::Write for ChunkWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= 64 * 1024 {
            self.flush()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if !self.buf.is_empty() {
            let chunk = std::mem::replace(&mut self.buf, Vec::with_capacity(64 * 1024));
            self.tx.send(chunk).map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
        }
        Ok(())
    }
}

struct ChannelReader {
    rx: Receiver<Vec<u8>>,
    at: Vec<u8>,
    pos: usize,
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.at.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.at = chunk;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.at.len() - self.pos);
        buf[..n].copy_from_slice(&self.at[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/* ------------------------------------------------------------------ annotations */

fn notes(ctx: &Ctx) -> Arc<Notes> {
    let file = ctx.data_dir.join("umakbang-data.json");
    let stamp = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
    let mut held = ctx.notes.lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(stamp), Some((at, value))) = (stamp, held.as_ref()) {
        if *at == stamp {
            return value.clone();
        }
    }
    let parsed = std::fs::read_to_string(&file).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let Some(doc) = parsed else {
        // A half-written document is no reason to forget what was read last.
        return held.as_ref().map(|(_, v)| v.clone()).unwrap_or_default();
    };
    let map = |key: &str| doc.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
    let (ratings, tags, detected_bpm, detected_key) = (map("ratings"), map("tags"), map("detectedBpm"), map("detectedKey"));
    let shared = crate::search::Shared {
        ratings: ratings.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()? as u8))).collect(),
        tags: tags.iter().map(|(k, v)| (k.clone(), v.as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()).unwrap_or_default())).collect(),
        bpm: detected_bpm.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()?))).collect(),
        key: detected_key.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
    };
    let value = Arc::new(Notes { ratings, tags, detected_bpm, detected_key, shared: Arc::new(RwLock::new(shared)) });
    if let Some(stamp) = stamp {
        *held = Some((stamp, value.clone()));
    }
    value
}

/// Each row's stars, tags and detected tempo and key, for the rows on this page only.
fn meta_for(rows: &[TrackOut], notes: &Notes) -> Map<String, Value> {
    let mut meta = Map::new();
    for track in rows {
        let key = &track.path;
        let mut entry = Map::new();
        if let Some(v) = notes.ratings.get(key) {
            entry.insert("rating".into(), v.clone());
        }
        if let Some(v) = notes.tags.get(key) {
            entry.insert("tags".into(), v.clone());
        }
        if let Some(v) = notes.detected_bpm.get(key) {
            entry.insert("detectedBpm".into(), v.clone());
        }
        if let Some(v) = notes.detected_key.get(key) {
            entry.insert("detectedKey".into(), v.clone());
        }
        if !entry.is_empty() {
            meta.insert(key.clone(), Value::Object(entry));
        }
    }
    meta
}

/* ------------------------------------------------------------------ routes */

fn count_param(raw: Option<&str>, fallback: usize, max: usize) -> usize {
    match raw.map(str::parse::<i64>) {
        Some(Ok(n)) if n >= 0 => (n as usize).min(max),
        _ => fallback,
    }
}

const SORT_KEYS: [&str; 9] = ["name", "kind", "duration", "size", "mtimeMs", "bpm", "musicalKey", "sampleRate", "rating"];

fn route(ctx: &Ctx, request: &tiny_http::Request, path: &str, params: &HashMap<String, Vec<String>>) -> Reply {
    match path {
        "/hello" => {
            let conn = connect(ctx);
            let meta = meta_revision(ctx);
            let libraries: Vec<Value> = ctx
                .libraries
                .iter()
                .map(|l| {
                    let mut v = json!({ "id": l.id, "label": l.label, "path": l.path, "metaRevision": meta });
                    if let Some(g) = conn.as_ref().and_then(|c| generation(ctx, c, l)) {
                        v["generation"] = json!(g);
                    }
                    // `tree` only when it is already known: `/hello` is the probe a phone gives
                    // two and a half seconds, and must never wait on a full build. A missing
                    // tree reads as "unknown", and the next `/hello` has it.
                    // A change stales only the branch above it, a few folders worked out in a
                    // millisecond or two; only a whole tree - a fresh database, a full rescan -
                    // is left to the background.
                    let tree = conn.as_ref().and_then(|c| match stored_root_hash(c, l) {
                        Some(tree) => Some(tree),
                        None if stale_folders(c) <= INLINE_STALE => root_of(c, l).and_then(|r| tree_hash(ctx, r)),
                        None => None,
                    });
                    match tree {
                        Some(tree) => v["tree"] = json!(tree),
                        None => build_in_background(ctx, l),
                    }
                    v
                })
                .collect();
            json_reply(
                &json!({ "app": "umakbang", "protocol": PROTOCOL, "device": { "id": ctx.device.id, "name": ctx.device.name, "os": ctx.device.os, "version": ctx.device.version }, "libraries": libraries }),
                200,
            )
        }
        "/list" => list(ctx, request, params),
        "/wait" => wait(ctx, params),
        "/search" => search(ctx, params),
        "/random" => random(ctx, params),
        "/stat" => stat(ctx, params),
        "/index" => match library_of(ctx, params) {
            Some(library) => send_index(ctx, library),
            None => bare(404),
        },
        // The index is always current here, so there is never a journal to send.
        "/index/patch" => match library_of(ctx, params) {
            Some(_) => bare(204),
            None => bare(404),
        },
        "/hash" => match file_param(ctx, params) {
            Some(file) => hash(&file),
            None => bare(404),
        },
        "/file" => match file_param(ctx, params) {
            Some(file) => send_file(request, &file),
            None => bare(404),
        },
        "/settings" => settings(ctx),
        "/metadata" => metadata(ctx),
        "/peaks" => peaks(ctx, params),
        "/plugins" => json_reply(&plugin_inventory(&ctx.fl_user_data), 200),
        "/pack" => pack(ctx, params),
        _ => bare(404),
    }
}

/// `rel` inside a library, or inside the FL user data folder with `scope=fl` - a different
/// root, not a looser rule.
fn file_param(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Option<PathBuf> {
    let rel = param(params, "rel")?;
    if param(params, "scope") == Some("fl") {
        return resolve_under(&ctx.fl_user_data.to_string_lossy(), rel);
    }
    resolve_in_library(library_of(ctx, params)?, rel)
}

fn rows(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Vec<TrackOut> {
    conn.prepare(sql).and_then(|mut s| s.query_map(args, track_of).map(|r| r.filter_map(Result::ok).collect())).unwrap_or_default()
}

fn list(ctx: &Ctx, request: &tiny_http::Request, params: &HashMap<String, Vec<String>>) -> Reply {
    let Some(library) = library_of(ctx, params) else { return bare(404) };
    let Some(dir) = folder_param(param(params, "dir")) else { return bare(400) };
    let Some(conn) = connect(ctx) else { return bare(500) };
    let Some(generation) = generation(ctx, &conn, library) else { return bare(404) };
    let at = db_path(library, &dir);
    let Ok(folder) = conn.query_row("SELECT id FROM folders WHERE path = ?1", params![at], |r| r.get::<_, i64>(0)) else { return bare(404) };
    // The folder's hash covers every count in the listing, since a change anywhere below moves
    // it; the stars in `meta` are covered by the profile's revision. Asked again unchanged, the
    // answer is a 304 and a few hundred bytes.
    let hash = tree_hash(ctx, folder);
    let etag = hash.as_ref().map(|h| format!("\"{h}-{}\"", meta_revision(ctx)));
    let sent = request.headers().iter().find(|h| h.field.equiv("If-None-Match")).map(|h| h.value.as_str().to_string());
    if let (Some(etag), Some(sent)) = (&etag, &sent) {
        if sent.split(',').any(|t| t.trim() == etag) {
            return Reply { status: 304, headers: vec![("ETag", etag.clone())], body: Body::Empty };
        }
    }

    let audio_only = param(params, "audioOnly") == Some("1");
    let sort = param(params, "sort").filter(|s| SORT_KEYS.contains(s)).unwrap_or("mtimeMs").to_string();
    let order = if param(params, "order") == Some("asc") { "asc" } else { "desc" };
    let offset = count_param(param(params, "offset"), 0, usize::MAX);
    let limit = count_param(param(params, "limit"), 500, 2000);
    let notes = notes(ctx);

    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.folder = ?1{}", if audio_only { " AND t.kind = 'audio'" } else { "" });
    let mut files = rows(&conn, &sql, &[&folder]);
    let ratings: HashMap<String, u8> = notes.ratings.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()? as u8))).collect();
    sort_tracks(&mut files, &sort, order == "asc", &ratings);
    let total = files.len();
    let page: Vec<TrackOut> = files.into_iter().skip(offset).take(limit).collect();

    let mut folders: Vec<(String, i64, i64, Option<String>)> = conn
        .prepare("SELECT name, files, audio, hash FROM folders WHERE parent = ?1")
        .and_then(|mut s| s.query_map(params![folder], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map(|r| r.filter_map(Result::ok).collect()))
        .unwrap_or_default();
    folders.sort_by(|a, b| crate::columns::collate(&a.0, &b.0));
    let folders: Vec<Value> = folders
        .into_iter()
        .map(|(name, files, audio, hash)| {
            let mut v = json!({ "name": name, "files": files, "audio": audio });
            if let Some(hash) = hash {
                v["hash"] = json!(hash);
            }
            v
        })
        .collect();
    let meta = meta_for(&page, &notes);
    let mut body = json!({ "dir": dir, "folders": folders, "files": page, "total": total, "meta": meta, "generation": generation });
    if let Some(hash) = &hash {
        body["hash"] = json!(hash);
    }
    let mut reply = json_reply(&body, 200);
    if let Some(etag) = etag {
        reply.headers.push(("ETag", etag));
    }
    reply
}

/* ------------------------------------------------------------------ the tree */

/// `metaRevision`: the profile's mtime, which moves whenever a tag, rating or note does.
fn meta_revision(ctx: &Ctx) -> i64 {
    mtime_ms(&ctx.data_dir.join("umakbang-data.json")).map_or(0, |m| m.floor() as i64)
}

fn root_of(conn: &Connection, library: &Library) -> Option<i64> {
    conn.query_row("SELECT id FROM folders WHERE path = ?1 AND parent IS NULL", params![library.label], |r| r.get(0)).ok()
}

/// How many stale folders `/hello` will hash itself rather than leave for the next ask.
const INLINE_STALE: i64 = 2000;

fn stale_folders(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM folders WHERE hash IS NULL", [], |r| r.get(0)).unwrap_or(i64::MAX)
}

/// The library's root hash if it is known now, without working anything out.
fn stored_root_hash(conn: &Connection, library: &Library) -> Option<String> {
    let root = root_of(conn, library)?;
    conn.query_row("SELECT hash FROM folders WHERE id = ?1", params![root], |r| r.get::<_, Option<String>>(0)).ok().flatten()
}

fn build_in_background(ctx: &Ctx, library: &Library) {
    let fresh = ctx.building.lock().map(|mut b| b.insert(library.id.clone())).unwrap_or(false);
    if !fresh {
        return;
    }
    // The request is answered without it; the thread holds the state it needs past that.
    let (db, hashing, building) = (ctx.db.clone(), ctx.hashing.clone(), ctx.building.clone());
    let (id, label) = (library.id.clone(), library.label.clone());
    std::thread::spawn(move || {
        let root = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()
            .and_then(|c| c.query_row("SELECT id FROM folders WHERE path = ?1 AND parent IS NULL", params![label], |r| r.get::<_, i64>(0)).ok());
        if let Some(root) = root {
            let _ = hash_at(&db, &hashing, root);
        }
        if let Ok(mut b) = building.lock() {
            b.remove(&id);
        }
    });
}

/// A folder's tree hash, working it out - and every stale folder below it - where the
/// triggers have cleared it. In one immediate transaction, so a file arriving half way through
/// cannot leave a hash written over a change it never saw.
fn tree_hash(ctx: &Ctx, folder: i64) -> Option<String> {
    hash_at(&ctx.db, &ctx.hashing, folder)
}

fn hash_at(db: &Path, hashing: &Mutex<()>, folder: i64) -> Option<String> {
    let _one = hashing.lock().unwrap_or_else(|e| e.into_inner());
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_WRITE).ok()?;
    conn.execute_batch("PRAGMA busy_timeout = 10000; PRAGMA journal_size_limit = 67108864; BEGIN IMMEDIATE").ok()?;
    let out = hash_of(&conn, folder);
    let _ = conn.execute_batch(if out.is_some() { "COMMIT" } else { "ROLLBACK" });
    out
}

/// The hash of a folder's sorted entries - `f <name>\0<size>\0<mtimeMs>\n` per file, `d <name>\0
/// <hash>\n` per subfolder - by plain UTF-16 order, as JavaScript compares strings: collation is
/// a display rule and may change, and this has to come out the same on every run. SHA-1, cut
/// to sixteen hex characters; this is change detection, not security.
fn hash_of(conn: &Connection, id: i64) -> Option<String> {
    let stored: Option<String> = conn.query_row("SELECT hash FROM folders WHERE id = ?1", params![id], |r| r.get(0)).ok()?;
    if let Some(hash) = stored {
        return Some(hash);
    }
    let children: Vec<(i64, String)> = conn
        .prepare_cached("SELECT id, name FROM folders WHERE parent = ?1")
        .ok()?
        .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok()?
        .filter_map(Result::ok)
        .collect();
    let mut entries: Vec<(Vec<u16>, u8, String)> = Vec::new();
    for (child, name) in children {
        let hash = hash_of(conn, child)?;
        entries.push((name.encode_utf16().collect(), 1, format!("d {name}\0{hash}\n")));
    }
    let files: Vec<(String, i64, f64)> = conn
        .prepare_cached("SELECT name, size, mtime FROM tracks WHERE folder = ?1")
        .ok()?
        .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .ok()?
        .filter_map(Result::ok)
        .collect();
    for (name, size, mtime) in files {
        entries.push((name.encode_utf16().collect(), 0, format!("f {name}\0{size}\0{}\n", js_number(mtime))));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    for (_, _, line) in &entries {
        hasher.update(line.as_bytes());
    }
    let hash: String = hasher.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    conn.execute("UPDATE folders SET hash = ?1 WHERE id = ?2", params![hash, id]).ok()?;
    Some(hash)
}

/// `String(number)`: the shortest digits that read back as the same double and, where two
/// such strings exist, the one nearest the exact value; no `.0` on a whole number. Rust's
/// `Display` is shortest but not always nearest - `1637993826117.7812` comes out `...7813` - so
/// the digits are serde_json's (ryu), which choose as JavaScript does. Exponent forms do not
/// arise for millisecond times.
fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 { format!("{}", v as i64) } else { serde_json::Number::from_f64(v).map_or_else(|| format!("{v}"), |n| n.to_string()) }
}

/// `/wait`: held open until the library's root hash or the profile's revision differs from
/// what was sent, then answered with both; after 25 seconds of nothing, a 204 and the peer asks
/// again. A tree sent empty is answered at once. Checked twice a second, which batches a run
/// of changes into one wake-up the way the watcher's settle time does.
fn wait(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Reply {
    let Some(library) = library_of(ctx, params) else { return bare(404) };
    let (tree, meta) = (param(params, "tree").unwrap_or("").to_string(), param(params, "meta").unwrap_or("").to_string());
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let root = connect(ctx).and_then(|c| root_of(&c, library));
        let now_tree = root.and_then(|r| tree_hash(ctx, r));
        let now_meta = meta_revision(ctx);
        // Read leniently: whatever form the peer echoes back, the same instant is the same.
        let meta_moved = meta.parse::<f64>().map_or(true, |m| m.floor() as i64 != now_meta);
        if tree.is_empty() || now_tree.as_deref() != Some(tree.as_str()) || meta_moved {
            let mut body = json!({ "metaRevision": now_meta });
            if let Some(t) = now_tree {
                body["tree"] = json!(t);
            }
            return json_reply(&body, 200);
        }
        if Instant::now() >= deadline {
            return bare(204);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// `compareTracks`: the direction applies only between two real values, so files with no tempo
/// sit at the end whichever way the column is sorted.
fn sort_tracks(files: &mut [TrackOut], key: &str, ascending: bool, ratings: &HashMap<String, u8>) {
    use std::cmp::Ordering;
    let apply = |o: Ordering| if ascending { o } else { o.reverse() };
    // `compareOptionalNumber`: both missing sorts by name in the column's direction, one missing
    // sinks whichever way, two values compare and then their names - all in that direction.
    let optional = |a: Option<f64>, b: Option<f64>, names: Ordering| match (a, b) {
        (None, None) => apply(names),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => apply(x.partial_cmp(&y).unwrap_or(Ordering::Equal).then(names)),
    };
    files.sort_by(|a, b| {
        let names = crate::columns::collate(&a.name, &b.name);
        match key {
            "name" => apply(names),
            "kind" => apply(crate::columns::collate(&a.ext, &b.ext).then(names)),
            "duration" => optional(a.duration, b.duration, names),
            "bpm" => optional(a.bpm, b.bpm, names),
            "sampleRate" => optional(a.sample_rate.map(|v| v as f64), b.sample_rate.map(|v| v as f64), names),
            "size" => apply(a.size.cmp(&b.size).then(names)),
            "musicalKey" => match (&a.musical_key, &b.musical_key) {
                (None, None) => apply(names),
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(x), Some(y)) => apply(crate::columns::collate(x, y).then(names)),
            },
            // The stars in the column's direction; ties by name, always A to Z.
            "rating" => {
                let (x, y) = (ratings.get(&a.path).copied().unwrap_or(0), ratings.get(&b.path).copied().unwrap_or(0));
                if x != y { apply(x.cmp(&y)) } else { names }
            }
            _ => apply(a.mtime_ms.partial_cmp(&b.mtime_ms).unwrap_or(Ordering::Equal).then(names)),
        }
    });
}

fn search(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Reply {
    let Some(library) = library_of(ctx, params) else { return bare(404) };
    let q = param(params, "q").unwrap_or("").trim().to_string();
    if q.is_empty() {
        return bare(400);
    }
    let Some(within) = folder_param(param(params, "within")) else { return bare(400) };
    if crate::search::parse(&q).is_empty() {
        return bare(400);
    }
    let audio_only = param(params, "audioOnly") == Some("1");
    let limit = count_param(param(params, "limit"), 300, 1000);
    let notes = notes(ctx);
    let Ok(conn) = crate::search::open(&ctx.db, notes.shared.clone()) else { return bare(500) };
    let Some(generation) = generation(ctx, &conn, library) else { return bare(404) };
    let request = crate::search::Request {
        generation: 0,
        raw: if audio_only { format!("{q} kind:audio") } else { q },
        dir: db_path(library, &within),
        recursive: false,
        sort: crate::columns::Sort { key: "name".into(), dir: "asc".into() },
    };
    let found = crate::search::run(&conn, &request);
    // Best match first, ties by name A to Z (`scoreMatch`, then `compareTracks` by name).
    let terms = crate::search::parse(&request.raw).terms;
    let mut ranked: Vec<(f64, &crate::library::FileRow)> = found.files.iter().map(|f| (if terms.is_empty() { 0.0 } else { crate::search::score(&f.name, &format!("{}/{}", f.dir, f.name), &terms) }, f)).collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| crate::columns::collate(&a.1.name, &b.1.name)));
    let paths: Vec<String> = ranked.iter().take(limit).map(|(_, f)| f.path.clone()).collect();
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.path = ?1");
    let mut files = Vec::with_capacity(paths.len());
    if let Ok(mut statement) = conn.prepare(&sql) {
        for path in &paths {
            if let Ok(mut track) = statement.query_row(params![path], track_of) {
                // As searched: the detected tempo and key folded in, as the window's rows have them.
                if track.bpm.is_none() {
                    track.bpm = notes.detected_bpm.get(path).and_then(Value::as_f64);
                }
                if track.musical_key.is_none() {
                    track.musical_key = notes.detected_key.get(path).and_then(Value::as_str).map(str::to_string);
                }
                files.push(track);
            }
        }
    }
    let meta = meta_for(&files, &notes);
    json_reply(&json!({ "files": files, "matched": found.total, "truncated": found.total > limit, "meta": meta, "generation": generation }), 200)
}

fn random(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Reply {
    let Some(library) = library_of(ctx, params) else { return bare(404) };
    let Some(within) = folder_param(param(params, "within")) else { return bare(400) };
    let Some(conn) = connect(ctx) else { return bare(500) };
    let [a, b, c] = scope_args(&db_path(library, &within));
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.playable AND t.kind = 'audio' AND {} ORDER BY random() LIMIT 1", scope_clause(1));
    match rows(&conn, &sql, &[&a, &b, &c]).into_iter().next() {
        Some(track) => json_reply(&track, 200),
        None => bare(404),
    }
}

fn stat(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Reply {
    let Some(library) = library_of(ctx, params) else { return bare(404) };
    let Some(conn) = connect(ctx) else { return bare(500) };
    let mut files = Map::new();
    let Ok(mut statement) = conn.prepare("SELECT size, mtime FROM tracks WHERE path = ?1") else { return bare(500) };
    for rel in params.get("rel").map(|v| v.as_slice()).unwrap_or(&[]).iter().take(200) {
        let Some(clean) = folder_param(Some(rel)).filter(|c| !c.is_empty()) else { continue };
        // Label-free first; a row's own `rel`, label and all, is the obvious thing to echo back.
        let mut candidates = vec![clean.clone()];
        if let Some(rest) = clean.strip_prefix(&format!("{}/", library.label)) {
            candidates.push(rest.to_string());
        }
        for candidate in candidates {
            let absolute = format!("{}\\{}", library.path, candidate.replace('/', "\\"));
            if let Ok((size, mtime)) = statement.query_row(params![absolute], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))) {
                files.insert(rel.clone(), json!({ "size": size, "mtimeMs": mtime }));
                break;
            }
        }
    }
    json_reply(&json!({ "files": files }), 200)
}

/// Bytes, honouring Range, never gzipped: audio is compressed already, and an encoded body
/// cannot be range-requested - which would cost seeking, the one thing auditioning needs.
fn send_file(request: &tiny_http::Request, file: &Path) -> Reply {
    let Ok(meta) = std::fs::metadata(file) else { return bare(404) };
    if !meta.is_file() {
        return bare(404);
    }
    let size = meta.len();
    let header = request.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    let range = match parse_range(header.as_deref(), size) {
        Ok(range) => range,
        Err(()) => return Reply { status: 416, headers: vec![("Content-Range", format!("bytes */{size}"))], body: Body::Empty },
    };
    let Ok(mut handle) = std::fs::File::open(file) else { return bare(404) };
    let octets = ("Content-Type", "application/octet-stream".to_string());
    let ranges = ("Accept-Ranges", "bytes".to_string());
    match range {
        None => Reply { status: 200, headers: vec![octets, ranges], body: Body::Reader(Box::new(std::io::BufReader::with_capacity(256 * 1024, handle)), Some(size as usize)) },
        Some((start, end)) => {
            if handle.seek(SeekFrom::Start(start)).is_err() {
                return bare(500);
            }
            let length = end - start + 1;
            Reply {
                status: 206,
                headers: vec![octets, ranges, ("Content-Range", format!("bytes {start}-{end}/{size}"))],
                body: Body::Reader(Box::new(std::io::BufReader::with_capacity(256 * 1024, handle).take(length)), Some(length as usize)),
            }
        }
    }
}

/// SHA-256, for the other end to check a file it fetched as parallel ranges against.
fn hash(file: &Path) -> Reply {
    use sha2::{Digest, Sha256};
    let Ok(handle) = std::fs::File::open(file) else { return bare(404) };
    let size = handle.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = std::io::BufReader::with_capacity(1 << 20, handle);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return bare(500),
        }
    }
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    json_reply(&json!({ "algo": "sha256", "hex": hex, "size": size }), 200)
}

/// The settings a settings export carries (`LOCAL_ONLY` off), less the ones that are paths on
/// this machine (`MACHINE_PATH_SETTINGS`): how somebody likes to work, nothing that says which
/// computer this is.
const NOT_SHARED: [&str; 21] = [
    "roots", "recentRoots", "lastDir", "windowBounds", "windowMaximized", "visualizerOnly", "keyCommand", "lalalKey", "bundleExportDir", "outputDevice", "developerMode", "resetOnLaunch", "deviceId",
    "shareLibrary", "runInBackground", "stemOutputDir", "remoteDownloadDir", "flUserData", "youtubeDir", "quickMove", "nativeOutputDevice",
];

fn read_data(ctx: &Ctx) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(ctx.data_dir.join("umakbang-data.json")).ok()?).ok()
}

fn settings(ctx: &Ctx) -> Reply {
    let Some(doc) = read_data(ctx) else { return bare(500) };
    let mut settings = doc.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
    for key in NOT_SHARED {
        settings.remove(key);
    }
    json_reply(&Value::Object(settings), 200)
}

/// The tags, ratings and notes, in the shape a settings import takes - with `settings` empty,
/// since preferences have their own route.
fn metadata(ctx: &Ctx) -> Reply {
    let Some(doc) = read_data(ctx) else { return bare(500) };
    // This machine's own folders only: a root mounted from elsewhere is a third machine's.
    let roots: Vec<Value> = doc.pointer("/settings/roots").and_then(Value::as_array).map(|r| r.iter().filter(|root| root.get("remote").is_none_or(Value::is_null)).cloned().collect()).unwrap_or_default();
    let field = |key: &str| doc.get(key).cloned().unwrap_or_else(|| json!({}));
    let exported = crate::localtime::iso_utc(now_ms());
    json_reply(
        &json!({
            "kind": "umakbang-settings",
            "version": 2,
            "exportedAt": exported,
            "exportedRoot": roots.first().and_then(|r| r.get("path")).cloned().unwrap_or(Value::Null),
            "exportedRoots": roots,
            "settings": {},
            "tags": field("tags"),
            "ratings": field("ratings"),
            "notes": field("notes"),
            "detectedBpm": field("detectedBpm"),
            "detectedKey": field("detectedKey"),
        }),
        200,
    )
}

/// A file's waveform as the Electron app cached it. A 404 is the ordinary answer for a file
/// nobody has looked at yet; the asking machine draws a flat line.
fn peaks(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Reply {
    let (Some(library), Some(rel)) = (library_of(ctx, params), param(params, "rel")) else { return bare(404) };
    let Some(file) = resolve_in_library(library, rel) else { return bare(404) };
    let cache = ctx.data_dir.join("umakbang-peaks-cache.json");
    let Ok(stamp) = std::fs::metadata(&cache).and_then(|m| m.modified()) else { return bare(404) };
    let doc = {
        let mut held = ctx.peaks.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = held.as_ref().is_some_and(|(at, _)| *at == stamp);
        if !fresh {
            if let Some(parsed) = std::fs::read_to_string(&cache).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) {
                *held = Some((stamp, Arc::new(parsed)));
            }
        }
        held.as_ref().map(|(_, v)| v.clone())
    };
    let key = file.to_string_lossy().into_owned();
    match doc.as_ref().and_then(|d| d.get(&key)).and_then(|e| e.get("data")).and_then(Value::as_str) {
        Some(data) => json_reply(&json!({ "data": data }), 200),
        None => bare(404),
    }
}

/// `readPluginInventory`: what FL has found, from its own plugin database (`.fst` files), which
/// is what decides whether a project opens - stricter than what is installed on disk.
pub fn plugin_inventory(user_data: &Path) -> Value {
    let candidates = [user_data.join("Presets").join("Plugin database"), user_data.join("Plugin database"), user_data.to_path_buf()];
    let Some(database) = candidates.iter().find(|c| c.join("Generators").exists()) else {
        return json!({ "names": [], "from": user_data.join("Presets").join("Plugin database").to_string_lossy(), "missing": true });
    };
    fn collect(dir: &Path, into: &mut std::collections::BTreeSet<String>, depth: usize) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                collect(&entry.path(), into, depth + 1);
            } else if name.to_lowercase().ends_with(".fst") {
                into.insert(name[..name.len() - 4].to_string());
            }
        }
    }
    let mut names = std::collections::BTreeSet::new();
    collect(database, &mut names, 0);
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort_by_key(|n| n.to_lowercase());
    json!({ "names": names, "from": database.to_string_lossy() })
}

/// What a project needs, listed rather than bundled: the asking machine fetches each file
/// through the same ranged, hashed path as any other copy, and this library stays read-only.
fn pack(ctx: &Ctx, params: &HashMap<String, Vec<String>>) -> Reply {
    let (Some(library), Some(rel)) = (library_of(ctx, params), param(params, "rel")) else { return bare(404) };
    let Some(file) = resolve_in_library(library, rel) else { return bare(404) };
    let Ok(data) = std::fs::read(&file) else { return bare(404) };
    let contents = flp_contents(&data);
    if !contents.clean {
        // A walk that lost the stream stops finding samples without saying so.
        return json_reply(&json!({ "error": "This project could not be read all the way through." }), 200);
    }
    let fl_root = ctx.fl_user_data.to_string_lossy().into_owned();
    let mut samples = Vec::new();
    let mut elsewhere = Vec::new();
    for recorded in &contents.samples {
        // `%FLStudioUserData%` is FL's own variable: consolidated audio the project needs.
        if let Some(fl) = fl_relative(recorded) {
            if let Some(size) = resolve_under(&fl_root, &fl).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()) {
                samples.push(json!({ "rel": fl, "name": fl.rsplit('/').next().unwrap_or(&fl), "size": size, "scope": "fl" }));
            } else {
                elsewhere.push(recorded.clone());
            }
            continue;
        }
        let within = relative_to_library(library, recorded);
        match within.as_deref().filter(|w| !w.is_empty()).and_then(|w| resolve_in_library(library, w).map(|p| (w.to_string(), p))) {
            Some((within, resolved)) => match std::fs::metadata(&resolved) {
                Ok(meta) => samples.push(json!({ "rel": within, "name": within.rsplit('/').next().unwrap_or(&within), "size": meta.len() })),
                Err(_) => elsewhere.push(recorded.clone()),
            },
            None => elsewhere.push(recorded.clone()),
        }
    }
    json_reply(&json!({ "flp": { "rel": rel, "name": rel.rsplit('/').next().unwrap_or(rel), "size": data.len() }, "samples": samples, "elsewhere": elsewhere, "plugins": contents.plugins }), 200)
}

fn fl_relative(recorded: &str) -> Option<String> {
    let lower = recorded.to_lowercase();
    let rest = lower.strip_prefix("%flstudiouserdata%")?;
    let at = recorded.len() - rest.len();
    Some(recorded[at..].trim_start_matches(['\\', '/']).replace('\\', "/"))
}

pub struct FlpContents {
    pub samples: Vec<String>,
    pub plugins: Vec<String>,
    pub clean: bool,
}

/// `collectFlpContents`: the sample paths and plugin names a project names, from its event
/// stream; `clean` only when the walk reached the end exactly.
pub fn flp_contents(data: &[u8]) -> FlpContents {
    const EVENT_SAMPLE_PATH: u8 = 196;
    const EVENT_PLUGIN_STATE: u8 = 213;
    let mut out = FlpContents { samples: Vec::new(), plugins: Vec::new(), clean: false };
    if data.len() < 12 || &data[..4] != b"FLhd" {
        return out;
    }
    let u32_at = |at: usize| u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as usize;
    let mut pos = 8 + u32_at(4);
    if pos + 8 > data.len() || &data[pos..pos + 4] != b"FLdt" {
        return out;
    }
    let end = (pos + 8 + u32_at(pos + 4)).min(data.len());
    pos += 8;
    let mut seen = std::collections::HashSet::new();
    let mut plugins_seen = std::collections::HashSet::new();
    while pos < end {
        let before = pos;
        let id = data[pos];
        pos += 1;
        if id < 64 {
            pos += 1;
        } else if id < 128 {
            pos += 2;
        } else if id < 192 {
            pos += match id {
                169 => 8,
                172 => 5,
                _ => 4,
            };
        } else {
            let (mut size, mut scale) = (0usize, 1usize);
            loop {
                let Some(&byte) = data.get(pos) else { return out };
                pos += 1;
                size += (byte & 0x7f) as usize * scale;
                if byte & 0x80 == 0 {
                    break;
                }
                scale *= 128;
                if scale > 0x1000_0000 {
                    return out;
                }
            }
            if pos + size > data.len() {
                return out;
            }
            let body = &data[pos..pos + size];
            if id == EVENT_SAMPLE_PATH && size > 0 {
                let units: Vec<u16> = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                let path = String::from_utf16_lossy(&units).trim_end_matches('\0').to_string();
                if !path.is_empty() && seen.insert(path.clone()) {
                    out.samples.push(path);
                }
            } else if id == EVENT_PLUGIN_STATE && size > 4 {
                // Latin-1: the bytes as characters, one each.
                let blob: String = body.iter().map(|&b| b as char).collect();
                for found in plugin_paths(&blob) {
                    let name = plugin_name(&found);
                    if !name.is_empty() && plugins_seen.insert(name.to_lowercase()) {
                        out.plugins.push(name);
                    }
                }
            }
            pos += size;
        }
        if pos <= before {
            return out;
        }
    }
    out.clean = pos == end;
    out
}

/// `/(?:[A-Za-z]:\\|\/)[^\0\r\n]{3,160}?\.(?:dll|vst3|vst|component)/gi`, by hand: a drive or a
/// slash, then the shortest run of 3 to 160 ordinary characters ending in a plugin extension.
fn plugin_paths(blob: &str) -> Vec<String> {
    let chars: Vec<char> = blob.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let start_len = if i + 2 < chars.len() && chars[i].is_ascii_alphabetic() && chars[i + 1] == ':' && chars[i + 2] == '\\' {
            3
        } else if chars[i] == '/' {
            1
        } else {
            i += 1;
            continue;
        };
        let body = i + start_len;
        let mut matched = None;
        let mut j = body;
        while j < chars.len() && j - body <= 160 {
            if matches!(chars[j], '\0' | '\r' | '\n') {
                break;
            }
            if j - body >= 3 {
                for ext in [".dll", ".vst3", ".vst", ".component"] {
                    let e: Vec<char> = ext.chars().collect();
                    if j + e.len() <= lower.len() && lower[j..j + e.len()] == e[..] {
                        matched = Some(j + e.len());
                        break;
                    }
                }
                if matched.is_some() {
                    break;
                }
            }
            j += 1;
        }
        match matched {
            Some(stop) => {
                found.push(chars[i..stop].iter().collect());
                i = stop;
            }
            None => i += 1,
        }
    }
    found
}

fn plugin_name(path: &str) -> String {
    let leaf = path.rsplit(['\\', '/']).next().unwrap_or("");
    let lower = leaf.to_lowercase();
    let mut name = leaf.to_string();
    for ext in [".dll", ".vst3", ".vst", ".component"] {
        if lower.ends_with(ext) {
            name.truncate(leaf.len() - ext.len());
            break;
        }
    }
    let lower = name.to_lowercase();
    for suffix in ["x64", "x86", "win64", "win32", "64bit", "32bit"] {
        if lower.ends_with(suffix) {
            name.truncate(name.len() - suffix.len());
            if name.ends_with(['_', '-']) {
                name.pop();
            }
            break;
        }
    }
    name.trim().to_string()
}

/* ------------------------------------------------------------------ writes */

fn write(ctx: &Ctx, request: &mut tiny_http::Request, path: &str, params: &HashMap<String, Vec<String>>) -> Reply {
    let Some(library) = library_of(ctx, params) else { return bare(404) };
    let outcome = if path == "/rescan" {
        (ctx.forward)(Write::Rescan { path: library.path.clone() })
    } else {
        let mut raw = String::new();
        if request.as_reader().take(MAX_BODY + 1).read_to_string(&mut raw).is_err() {
            return bare(400);
        }
        if raw.len() as u64 > MAX_BODY {
            return bare(413);
        }
        let Ok(body) = serde_json::from_str::<Value>(&raw) else { return bare(400) };
        let rel = body.get("rel").and_then(Value::as_str).unwrap_or("");
        // Checked against the library even though nothing is opened: an annotation keyed to a
        // path outside it is a row nothing here can ever show or clear.
        let Some(file) = resolve_in_library(library, rel) else { return bare(404) };
        let file = file.to_string_lossy().into_owned();
        if path == "/metadata/rating" {
            (ctx.forward)(Write::Rating { path: file, rating: body.get("rating").and_then(Value::as_f64).unwrap_or(0.0) })
        } else {
            let tags = body.get("tags").and_then(Value::as_array).map(|a| a.iter().take(64).map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_string)).collect()).unwrap_or_default();
            (ctx.forward)(Write::Tags { path: file, tags })
        }
    };
    match outcome {
        Ok(()) => json_reply(&json!({ "ok": true }), 200),
        Err(reason) => json_reply(&json!({ "ok": false, "reason": reason }), 500),
    }
}

/* ------------------------------------------------------------------ the supervisor */

pub enum Command {
    /// Serve with this, or stop (None).
    Configure(Option<Base>),
}

/// The server's owner, on a thread of its own: starts it on the tailnet address, and every 30s
/// starts it again if it is not running - Tailscale coming up after login, a sleep that took the
/// address away - so a phone never finds this machine silently gone.
pub struct Supervisor {
    pub tx: Sender<Command>,
    pub state: Arc<Mutex<ServerState>>,
    pub stats: Arc<Mutex<Stats>>,
}

pub fn supervise(version: String, forward: Forward, notify: Notify) -> Supervisor {
    let (tx, rx) = std::sync::mpsc::channel::<Command>();
    let state = Arc::new(Mutex::new(ServerState { listening: false, address: None, port: PORT, reason: Some("Starting…".into()) }));
    let stats = Arc::new(Mutex::new(Stats::default()));
    let (st, sx) = (state.clone(), stats.clone());
    std::thread::Builder::new()
        .name("server-supervisor".into())
        .spawn(move || {
            let mut base: Option<Base> = None;
            let mut running: Option<Running> = None;
            let set = |next: ServerState| {
                if let Ok(mut s) = st.lock() {
                    *s = next;
                }
                notify();
            };
            loop {
                let command = rx.recv_timeout(Duration::from_secs(30));
                match command {
                    Err(RecvTimeoutError::Disconnected) => return,
                    Ok(Command::Configure(next)) => {
                        running = None;
                        base = next;
                        if base.is_none() {
                            set(ServerState { listening: false, address: None, port: PORT, reason: Some("Sharing is turned off.".into()) });
                            continue;
                        }
                    }
                    // The watchdog: only when there should be a server and there is none.
                    Err(RecvTimeoutError::Timeout) if running.is_some() || base.is_none() => continue,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                let Some(current) = base.clone() else { continue };
                // `UMAKBANG_SERVE=host:port` serves somewhere else - for tests on a copy, which
                // must never answer on the tailnet.
                let (address, port, device) = match std::env::var("UMAKBANG_SERVE").ok().and_then(|v| v.rsplit_once(':').and_then(|(h, p)| Some((h.to_string(), p.parse::<u16>().ok()?)))) {
                    Some((host, port)) => (host, port, Device { id: current.device_id.clone(), name: "test".into(), os: "windows".into(), version: version.clone() }),
                    None => {
                        let tailnet = crate::tailscale::read();
                        if tailnet.state != crate::tailscale::State::Running {
                            set(ServerState { listening: false, address: None, port: PORT, reason: Some(tailnet.reason.unwrap_or_else(|| "Tailscale is not running.".into())) });
                            continue;
                        }
                        let Some(this) = tailnet.this.filter(|t| t.ipv4.is_some()) else {
                            set(ServerState { listening: false, address: None, port: PORT, reason: Some("Tailscale is running but has no address on this machine.".into()) });
                            continue;
                        };
                        let os = if this.os.is_empty() { "windows".to_string() } else { this.os.clone() };
                        (this.ipv4.clone().unwrap_or_default(), PORT, Device { id: current.device_id.clone(), name: this.name.clone(), os, version: version.clone() })
                    }
                };
                match start(&address, port, &current, device, forward.clone(), notify.clone(), sx.clone()) {
                    Ok(server) => {
                        running = Some(server);
                        set(ServerState { listening: true, address: Some(address), port, reason: None });
                    }
                    Err(reason) => set(ServerState { listening: false, address: None, port, reason: Some(reason) }),
                }
            }
        })
        .ok();
    Supervisor { tx, state, stats }
}

/* ------------------------------------------------------------------ asking other machines */

/// One machine on the tailnet and whether umakbang answers there (`listRemoteDevices`).
#[derive(Clone, Debug)]
pub struct Peer {
    pub node: crate::tailscale::Node,
    pub serving: bool,
    pub hello: Option<Value>,
    pub reason: Option<String>,
}

fn get_json(host: &str, path: &str, timeout: Duration) -> Result<Value, String> {
    let agent = ureq::Agent::new_with_config(ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build());
    let mut response = agent.get(format!("http://{host}:{PORT}{path}")).call().map_err(|_| "umakbang is not running there.".to_string())?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("Answered {status}."));
    }
    let text = response.body_mut().with_config().limit(128 * 1024 * 1024).read_to_string().map_err(|_| "Answered with something unreadable.".to_string())?;
    serde_json::from_str(&text).map_err(|_| "Answered with something unreadable.".to_string())
}

/// `/hello` on every online peer, at once, 1.5s each at most.
pub fn list_peers() -> (crate::tailscale::Status, Vec<Peer>) {
    let tailnet = crate::tailscale::read();
    let handles: Vec<_> = tailnet
        .peers
        .iter()
        .cloned()
        .map(|node| {
            std::thread::spawn(move || {
                if !node.online {
                    return Peer { node, serving: false, hello: None, reason: None };
                }
                let host = node.ipv4.clone().unwrap_or_else(|| node.name.clone());
                if host.is_empty() {
                    return Peer { node, serving: false, hello: None, reason: Some("No address.".into()) };
                }
                match get_json(&host, "/hello", Duration::from_millis(1500)) {
                    Ok(hello) if hello.get("app").and_then(Value::as_str) == Some("umakbang") => Peer { node, serving: true, hello: Some(hello), reason: None },
                    Ok(_) => Peer { node, serving: false, hello: None, reason: Some("Something else is on that port.".into()) },
                    Err(reason) => Peer { node, serving: false, hello: None, reason: Some(reason) },
                }
            })
        })
        .collect();
    let peers = handles.into_iter().filter_map(|h| h.join().ok()).collect();
    (tailnet, peers)
}

/// Another machine's plugin list, settings or annotations.
pub fn ask(host: &str, path: &str) -> Option<Value> {
    get_json(host, path, Duration::from_secs(if path == "/metadata" { 60 } else { 10 })).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_electron() {
        // `createHash('sha1').update('abc:Z:\\SECRET SAUCE').digest('hex').slice(0, 16)`
        assert_eq!(library_id("abc", r"Z:\SECRET SAUCE").len(), 16);
        assert_eq!(library_id("a", "b"), "dcea6d9ccd3d20ba");
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Ok(Some((0, 99))));
        assert_eq!(parse_range(Some("bytes=900-"), 1000), Ok(Some((900, 999))));
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Ok(Some((900, 999))));
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), Err(()));
        assert_eq!(parse_range(Some("bytes=5-1"), 1000), Err(()));
        assert_eq!(parse_range(None, 1000), Ok(None));
    }

    #[test]
    fn plugin_names() {
        let blob = "xx\0C:\\Program Files\\VSTPlugins\\Serum_x64.dll\0junk /Library/Audio/Plug-Ins/VST3/Pro-Q 3.vst3\0";
        let names: Vec<String> = plugin_paths(blob).iter().map(|p| plugin_name(p)).collect();
        assert_eq!(names, vec!["Serum", "Pro-Q 3"]);
        assert_eq!(fl_relative("%FLStudioUserData%\\Audio\\Rendered\\x.wav").as_deref(), Some("Audio/Rendered/x.wav"));
    }

    #[test]
    fn queries() {
        let q = parse_query("library=abc&rel=a%2Fb%20c.wav&rel=x+y");
        assert_eq!(q["rel"], vec!["a/b c.wav", "x y"]);
        assert_eq!(folder_param(Some("/a/../b")), None);
        assert_eq!(folder_param(Some("\\Stems\\")).as_deref(), Some("Stems"));
    }
}

#[cfg(test)]
mod tree_tests {
    #[test]
    fn one_folder() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE folders (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT, path TEXT, hash TEXT);
             CREATE TABLE tracks (folder INTEGER, name TEXT, size INTEGER, mtime REAL);
             INSERT INTO folders VALUES (1, NULL, 'idk Project', 'x', NULL), (475, 1, 'Backup', 'x/Backup', 'e8b5302a9559da62');
             INSERT INTO tracks VALUES (1, 'idk.als', 156314, 1637993826117.7812);",
        )
        .unwrap();
        assert_eq!(super::js_number(1637993826117.7812), "1637993826117.7812");
        let hash = super::hash_of(&conn, 1);
        let rows: Vec<(String, i64, f64)> = conn.prepare("SELECT name, size, mtime FROM tracks").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().filter_map(Result::ok).collect();
        let kids: Vec<(i64, String, Option<String>)> = conn.prepare("SELECT id, name, hash FROM folders WHERE parent = 1").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().filter_map(Result::ok).collect();
        assert_eq!(hash.as_deref(), Some("fb15f3f7645cac7f"), "{rows:?} {kids:?}");
    }
}
