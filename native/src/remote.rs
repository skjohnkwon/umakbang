//! Other machines' libraries, read in place (`remote-download.ts`, the remote half of
//! `protocol.ts`, and the client of `remote-browse.ts`): a folder is listed when it is opened,
//! bytes are fetched by range as they are played, and anything that would change a file is
//! refused - another machine's library is only ever copied from.
//!
//! A file over there is named `umakbang-device://<device id>/<library id>/<path within it>`,
//! never by its path on that machine. Two machines can keep their library at the same path (two
//! PCs with `Z:\SECRET SAUCE`), and a bare path would make a file here look like one over there:
//! played over the network, refused a delete.

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

const PORT: u16 = crate::server::PORT;

#[derive(Clone, Debug)]
pub struct RemoteRoot {
    pub label: String,
    /// The library's path on the machine it lives on.
    pub path: String,
    pub host: String,
    pub library_id: String,
    pub device_id: String,
    pub device_name: String,
}

/// What every file and folder on another machine is named by.
pub const SCHEME: &str = "umakbang-device://";

impl RemoteRoot {
    /// The name of `within` (forward slashes, `""` for the library folder) in this library.
    pub fn path_of(&self, within: &str) -> String {
        let within = within.trim_matches('/');
        if within.is_empty() { format!("{SCHEME}{}/{}", self.device_id, self.library_id) } else { format!("{SCHEME}{}/{}/{within}", self.device_id, self.library_id) }
    }

    /// `host:port` for the server; a host that names its own port keeps it (tests on one
    /// machine serve on another port, never the tailnet's).
    fn base(&self) -> String {
        if self.host.contains(':') { format!("http://{}", self.host) } else { format!("http://{}:{PORT}", self.host) }
    }

    fn url(&self, route: &str, rel: &str, scope: Option<&str>) -> String {
        let mut url = format!("{}{route}?library={}&rel={}", self.base(), encode(&self.library_id), encode(rel));
        if let Some(scope) = scope {
            url.push_str(&format!("&scope={scope}"));
        }
        url
    }
}

pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Every library on another machine seen this session, for the threads that open files to look
/// up: a file's name says which device and library, this says where they answer now.
static ROOTS: RwLock<Vec<RemoteRoot>> = RwLock::new(Vec::new());

/// `root` as where its device and library answer, replacing what was known of them.
pub fn register(root: RemoteRoot) {
    if let Ok(mut held) = ROOTS.write() {
        match held.iter_mut().find(|r| r.device_id == root.device_id && r.library_id == root.library_id) {
            Some(known) => *known = root,
            None => held.push(root),
        }
    }
}

/// The library a file or folder on another machine is in, and the path within it.
pub fn root_of(path: &str) -> Option<(RemoteRoot, String)> {
    let rest = path.strip_prefix(SCHEME)?;
    let (device, rest) = rest.split_once('/')?;
    let (library, within) = rest.split_once('/').unwrap_or((rest, ""));
    let held = ROOTS.read().ok()?;
    let root = held.iter().find(|r| r.device_id == device && r.library_id == library)?;
    Some((root.clone(), within.to_string()))
}

/// Whether a path names something on another machine. Known or not: a name in this scheme is
/// never a file here, so nothing may treat it as one.
pub fn is_remote(path: &str) -> bool {
    path.starts_with(SCHEME)
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build())
}

/* ------------------------------------------------------------------ reading bytes */

pub trait ReadSeek: Read + Seek + Send + Sync {}
impl<T: Read + Seek + Send + Sync> ReadSeek for T {}

/// A file on another machine as a seekable stream: fetched in 512KB ranges as it is read, so
/// starting a track or jumping across it costs one request, not the whole file.
pub struct RemoteReader {
    url: String,
    len: u64,
    pos: u64,
    block_at: u64,
    block: Vec<u8>,
    agent: ureq::Agent,
}

const BLOCK: u64 = 512 * 1024;

impl RemoteReader {
    pub fn open(root: &RemoteRoot, within: &str, scope: Option<&str>) -> std::io::Result<RemoteReader> {
        let url = root.url("/file", within, scope);
        let agent = agent(Duration::from_secs(30));
        let mut reader = RemoteReader { url, len: 0, pos: 0, block_at: 0, block: Vec::new(), agent };
        reader.fetch(0)?;
        Ok(reader)
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    fn fetch(&mut self, at: u64) -> std::io::Result<()> {
        let end = if self.len > 0 { (at + BLOCK).min(self.len) - 1 } else { at + BLOCK - 1 };
        let response = self.agent.get(&self.url).header("Range", &format!("bytes={at}-{end}")).call().map_err(std::io::Error::other)?;
        let status = response.status().as_u16();
        if status != 206 && status != 200 {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("answered {status}")));
        }
        if let Some(total) = response.headers().get("content-range").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).and_then(|n| n.parse::<u64>().ok()) {
            self.len = total;
        }
        let mut body = Vec::with_capacity(BLOCK as usize);
        response.into_body().into_reader().read_to_end(&mut body)?;
        if status == 200 {
            // A server that ignored the range sent the whole file.
            self.len = body.len() as u64;
            self.block_at = 0;
        } else {
            self.block_at = at;
        }
        self.block = body;
        Ok(())
    }
}

impl Read for RemoteReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let inside = self.pos >= self.block_at && self.pos < self.block_at + self.block.len() as u64;
        if !inside {
            self.fetch(self.pos)?;
        }
        let offset = (self.pos - self.block_at) as usize;
        let n = buf.len().min(self.block.len() - offset);
        buf[..n].copy_from_slice(&self.block[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for RemoteReader {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let next = match to {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.len as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if next < 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

/// A file to decode, wherever it is, and how long it is.
pub fn open(path: &str) -> std::io::Result<(Box<dyn ReadSeek>, u64)> {
    if let Some((root, within)) = root_of(path) {
        let reader = RemoteReader::open(&root, &within, None)?;
        let len = reader.len();
        // Buffered on top, so the decoder's small reads come out of memory.
        return Ok((Box::new(std::io::BufReader::with_capacity(64 * 1024, reader)), len));
    }
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    Ok((Box::new(std::io::BufReader::new(file)), len))
}

/// A decoder over `open`, with the length known and the extension as a hint.
pub fn decoder(path: &str) -> Result<rodio::Decoder<Box<dyn ReadSeek>>, Box<dyn std::error::Error>> {
    decoder_limited(path, u64::MAX)
}

/// The same, refusing anything longer than `max` bytes before a byte of it is decoded.
pub fn decoder_limited(path: &str, max: u64) -> Result<rodio::Decoder<Box<dyn ReadSeek>>, Box<dyn std::error::Error>> {
    let (reader, len) = open(path)?;
    if len > max {
        return Err("too large".into());
    }
    let mut builder = rodio::Decoder::builder().with_data(reader).with_byte_len(len).with_seekable(true);
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        builder = builder.with_hint(&ext.to_lowercase());
    }
    Ok(builder.build()?)
}

/// The waveform the other machine already drew, when it has one: cheaper than fetching the
/// whole file to draw it again here.
pub fn peaks(path: &str) -> Option<Vec<u8>> {
    let (root, within) = root_of(path)?;
    let mut response = agent(Duration::from_secs(10)).get(root.url("/peaks", &within, None)).call().ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let body: Value = serde_json::from_str(&response.body_mut().read_to_string().ok()?).ok()?;
    base64(body.get("data")?.as_str()?)
}

fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = text.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= value(c)? << (18 - 6 * i);
        }
        out.push((acc >> 16) as u8);
        if chunk.len() > 2 {
            out.push((acc >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(acc as u8);
        }
    }
    Some(out)
}

/* ------------------------------------------------------------------ one folder at a time */

/// One `Track` line from another index, as a row here: the struct a restored bundle's rows and a
/// listed folder's files are both read into.
pub struct Row {
    pub rel_dir: String,
    pub file: crate::library::FileRow,
    pub project_created: Option<f64>,
}

/// One folder of another machine's library, as `/list` answers it. Only ever the one folder:
/// the library is asked about where you are standing, never fetched whole.
#[derive(Clone, Debug, Default)]
pub struct Listing {
    /// The subfolders by name, with how many files are at or below each.
    pub folders: Vec<(String, i64)>,
    /// Named in this library's scheme for them, never by their path over there.
    pub files: Vec<crate::library::FileRow>,
    /// That machine's stars and tags on these files.
    pub ratings: std::collections::HashMap<String, u8>,
    pub tags: std::collections::HashMap<String, Vec<String>>,
    /// Every match, for a search; the files are the best of them.
    pub matched: usize,
}

impl Listing {
    /// `files` and their `meta` (keyed by the path over there), as rows here.
    fn absorb(&mut self, root: &RemoteRoot, files: &[Value], meta: &Value) {
        let base = slashed_base(&root.path);
        for track in files {
            let Some(row) = row_from_track(track, &base, &root.label) else { continue };
            let theirs = row.file.path.clone();
            let dir = row.rel_dir.strip_prefix(root.label.as_str()).unwrap_or("").trim_start_matches('/').to_string();
            let within = if dir.is_empty() { row.file.name.clone() } else { format!("{dir}/{}", row.file.name) };
            let mut file = row.file;
            file.path = root.path_of(&within);
            file.dir = root.path_of(&dir);
            if let Some(entry) = meta.get(&theirs) {
                if let Some(stars) = entry.get("rating").and_then(Value::as_f64).filter(|s| *s >= 1.0) {
                    self.ratings.insert(file.path.clone(), stars.min(5.0) as u8);
                }
                let tags: Vec<String> = entry.get("tags").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()).unwrap_or_default();
                if !tags.is_empty() {
                    self.tags.insert(file.path.clone(), tags);
                }
                // A tempo or key that machine worked out, where the file names none.
                if file.bpm.is_none() {
                    file.bpm = entry.get("detectedBpm").and_then(Value::as_f64);
                }
                if file.musical_key.is_none() {
                    file.musical_key = entry.get("detectedKey").and_then(Value::as_str).map(str::to_string);
                }
            }
            self.files.push(file);
        }
    }
}

fn read_json(response: &mut ureq::http::Response<ureq::Body>) -> Result<Value, String> {
    let text = response.body_mut().with_config().limit(256 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The files a page of `/list` asks for at once: the server's own ceiling.
const PAGE: usize = 2000;

/// `dir` (within the library, `""` for its folder) on that machine: its subfolders, and every
/// file in it, a page at a time.
pub fn list(root: &RemoteRoot, dir: &str) -> Result<Listing, String> {
    let agent = agent(Duration::from_secs(30));
    let mut listing = Listing::default();
    let mut offset = 0;
    loop {
        let url = format!("{}/list?library={}&dir={}&offset={offset}&limit={PAGE}", root.base(), encode(&root.library_id), encode(dir));
        let mut response = agent.get(&url).call().map_err(|_| format!("{} is not answering.", root.device_name))?;
        match response.status().as_u16() {
            200 => {}
            404 => return Err(format!("That folder is no longer on {}.", root.device_name)),
            status => return Err(format!("{} answered {status}.", root.device_name)),
        }
        let body = read_json(&mut response)?;
        if offset == 0 {
            listing.folders = body
                .get("folders")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|f| Some((f.get("name")?.as_str()?.to_string(), f.get("files").and_then(Value::as_i64).unwrap_or(0)))).collect())
                .unwrap_or_default();
        }
        let files = body.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
        listing.absorb(root, &files, body.get("meta").unwrap_or(&Value::Null));
        offset += files.len();
        let total = body.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
        if files.is_empty() || offset >= total {
            listing.matched = total;
            return Ok(listing);
        }
    }
}

/// `/search` at or below `dir` on that machine, by the same query language as here.
pub fn search(root: &RemoteRoot, dir: &str, query: &str) -> Result<Listing, String> {
    let url = format!("{}/search?library={}&within={}&q={}&limit=1000", root.base(), encode(&root.library_id), encode(dir), encode(query));
    let mut response = agent(Duration::from_secs(30)).get(&url).call().map_err(|_| format!("{} is not answering.", root.device_name))?;
    match response.status().as_u16() {
        200 => {}
        // A query the server cannot use (nothing but punctuation) finds nothing.
        400 => return Ok(Listing::default()),
        status => return Err(format!("{} answered {status}.", root.device_name)),
    }
    let body = read_json(&mut response)?;
    let mut listing = Listing::default();
    let files = body.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    listing.absorb(root, &files, body.get("meta").unwrap_or(&Value::Null));
    listing.matched = body.get("matched").and_then(Value::as_u64).map_or(listing.files.len(), |n| n as usize);
    Ok(listing)
}

/// `Track` lines from another index, filed under `label`: each path's place below `base` (the
/// library's path where it was indexed) becomes its folder here. Shared by mounted libraries and
/// bundle restores.
pub fn rows_from_tracks(tracks: Vec<Value>, base: &str, label: &str) -> Vec<Row> {
    let base = slashed_base(base);
    tracks.iter().filter_map(|track| row_from_track(track, &base, label)).collect()
}

/// A library's path as `row_from_track` compares it: forward slashes, no trailing one.
fn slashed_base(base: &str) -> String {
    base.replace('\\', "/").trim_end_matches('/').to_string()
}

/// One `Track` line as a row here; None when it has no path or lies outside `base`.
fn row_from_track(track: &Value, base: &str, label: &str) -> Option<Row> {
    {
        let path = track.get("path").and_then(Value::as_str).map(str::to_string)?;
        let slashed = path.replace('\\', "/");
        // Case-blind on Windows paths, where the drive letter's case is anybody's guess.
        let rest = slashed.get(..base.len()).filter(|head| head.eq_ignore_ascii_case(base)).map(|_| slashed[base.len()..].trim_start_matches('/'))?;
        let (dir, name) = rest.rsplit_once('/').unwrap_or(("", rest));
        let rel_dir = if dir.is_empty() { label.to_string() } else { format!("{label}/{dir}") };
        let num = |k: &str| track.get(k).and_then(Value::as_f64);
        let int = |k: &str| track.get(k).and_then(Value::as_i64);
        let file = crate::library::FileRow {
            path: path.clone(),
            name: name.to_string(),
            ext: track.get("ext").and_then(Value::as_str).unwrap_or("").to_string(),
            kind: track.get("kind").and_then(Value::as_str).unwrap_or("other").to_string(),
            size: int("size").unwrap_or(0),
            mtime: num("mtimeMs").unwrap_or(0.0),
            duration: num("duration"),
            bpm: num("bpm"),
            musical_key: track.get("musicalKey").and_then(Value::as_str).map(str::to_string),
            playable: track.get("playable").and_then(Value::as_bool).unwrap_or(false),
            sample_rate: int("sampleRate"),
            bit_depth: int("bitDepth"),
            channels: int("channels"),
            bitrate: int("bitrate"),
            project_seconds: num("projectSeconds"),
            project_created: num("projectCreatedMs"),
            probed: track.get("probed").and_then(Value::as_bool).unwrap_or(false),
            dir: rel_dir.clone(),
        };
        Some(Row { rel_dir, file, project_created: num("projectCreatedMs") })
    }
}

/* ------------------------------------------------------------------ copying here */

const CHUNK: u64 = 2 * 1024 * 1024;
const PARALLEL: usize = 8;

/// What a copy is doing, for the progress line.
#[derive(Clone, Debug)]
pub struct Progress {
    pub name: String,
    pub received: u64,
    pub total: u64,
    pub verifying: bool,
}

fn size_of(root: &RemoteRoot, within: &str, scope: Option<&str>) -> Result<u64, String> {
    let response = agent(Duration::from_secs(30)).get(root.url("/file", within, scope)).header("Range", "bytes=0-0").call().map_err(|e| e.to_string())?;
    let total = response.headers().get("content-range").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).and_then(|n| n.parse::<u64>().ok());
    total.ok_or_else(|| format!("{} answered {}", root.device_name, response.status().as_u16()))
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// `copyOne`: the file into `target` - in parallel 2MB ranges written at their offsets into a
/// preallocated `.part`, checked against the other machine's SHA-256, and only then renamed into
/// place. A range that arrived short would otherwise leave a file of exactly the right size with
/// the wrong bytes in it, which no length check would notice.
pub fn copy_one(root: &RemoteRoot, within: &str, scope: Option<&str>, target: &Path, report: &(dyn Fn(Progress) + Sync)) -> Result<(), String> {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let part = PathBuf::from(format!("{}.part", target.display()));
    let result = (|| -> Result<(), String> {
        let total = size_of(root, within, scope)?;
        let file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        file.set_len(total).map_err(|e| e.to_string())?;
        drop(file);
        let received = std::sync::atomic::AtomicU64::new(0);
        let next = std::sync::atomic::AtomicU64::new(0);
        let failure: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
        let ranges = total.div_ceil(CHUNK);
        std::thread::scope(|scope_| {
            for _ in 0..PARALLEL.min(ranges.max(1) as usize) {
                scope_.spawn(|| {
                    let agent = agent(Duration::from_secs(120));
                    let Ok(mut out) = std::fs::OpenOptions::new().write(true).open(&part) else { return };
                    loop {
                        let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if index >= ranges || failure.lock().map(|f| f.is_some()).unwrap_or(true) {
                            return;
                        }
                        let start = index * CHUNK;
                        let end = (start + CHUNK).min(total) - 1;
                        let outcome = (|| -> Result<(), String> {
                            let response = agent.get(root.url("/file", within, scope)).header("Range", &format!("bytes={start}-{end}")).call().map_err(|e| e.to_string())?;
                            let status = response.status().as_u16();
                            if status != 206 && !(status == 200 && start == 0) {
                                return Err(format!("{} answered {status}", root.device_name));
                            }
                            out.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
                            let mut body = response.into_body().into_reader();
                            let mut buf = vec![0u8; 256 * 1024];
                            loop {
                                let n = body.read(&mut buf).map_err(|e| e.to_string())?;
                                if n == 0 {
                                    break;
                                }
                                out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                                let got = received.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed) + n as u64;
                                report(Progress { name: name.clone(), received: got, total, verifying: false });
                            }
                            Ok(())
                        })();
                        if let Err(e) = outcome {
                            if let Ok(mut f) = failure.lock() {
                                f.get_or_insert(e);
                            }
                            return;
                        }
                    }
                });
            }
        });
        if let Some(e) = failure.into_inner().ok().flatten() {
            return Err(e);
        }
        report(Progress { name: name.clone(), received: total, total, verifying: true });
        let mut hash_url = root.url("/hash", within, scope);
        hash_url = hash_url.replacen("/hash?", "/hash?", 1);
        let expected = agent(Duration::from_secs(600))
            .get(&hash_url)
            .call()
            .ok()
            .filter(|r| r.status().as_u16() == 200)
            .and_then(|mut r| r.body_mut().read_to_string().ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("hex").and_then(Value::as_str).map(str::to_string));
        if let Some(expected) = expected {
            if sha256_of(&part).map_err(|e| e.to_string())? != expected {
                return Err("arrived damaged - the copy did not match the original".into());
            }
        }
        std::fs::rename(&part, target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

/// `freeName`: `name`, or `name (2)`, `(3)`... - never over something already there.
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut candidate = dir.join(name);
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/* ------------------------------------------------------------------ packing a project */

/// What a project on another machine needs (`/pack`), and what this machine lacks of it.
#[derive(Clone, Debug, Default)]
pub struct Preview {
    pub name: String,
    pub sample_count: usize,
    pub total_bytes: u64,
    pub elsewhere: Vec<String>,
    pub missing_plugins: Vec<String>,
    pub error: Option<String>,
}

fn manifest(root: &RemoteRoot, within: &str) -> Result<Value, String> {
    let mut response = agent(Duration::from_secs(60)).get(root.url("/pack", within, None)).call().map_err(|_| format!("{} could not read that project.", root.device_name))?;
    if response.status().as_u16() != 200 {
        return Err(format!("{} could not read that project.", root.device_name));
    }
    let value: Value = serde_json::from_str(&response.body_mut().read_to_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    Ok(value)
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

pub fn preview(flp: &str, local_plugins: &[String]) -> Preview {
    let Some((root, within)) = root_of(flp) else { return Preview { error: Some("That project is not on another machine.".into()), ..Preview::default() } };
    match manifest(&root, &within) {
        Err(error) => Preview { error: Some(error), ..Preview::default() },
        Ok(m) => {
            let flatten = |n: &str| n.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
            let have: std::collections::HashSet<String> = local_plugins.iter().map(|n| flatten(n)).collect();
            let plugins = strings(&m, "plugins");
            let samples = m.get("samples").and_then(Value::as_array).cloned().unwrap_or_default();
            Preview {
                name: m.pointer("/flp/name").and_then(Value::as_str).unwrap_or("").to_string(),
                sample_count: samples.len(),
                total_bytes: m.pointer("/flp/size").and_then(Value::as_u64).unwrap_or(0) + samples.iter().filter_map(|s| s.get("size").and_then(Value::as_u64)).sum::<u64>(),
                elsewhere: strings(&m, "elsewhere"),
                missing_plugins: plugins.iter().filter(|p| !have.contains(&flatten(p))).cloned().collect(),
                error: None,
            }
        }
    }
}

/// `packRemote`: the project and every sample it names, fetched like any copy into a folder of
/// their own, then zipped beside it. A package missing a sound is worse than none, so one
/// failure throws the whole folder away.
pub fn pack(flp: &str, destination: &Path, report: &(dyn Fn(Progress) + Sync)) -> Result<PathBuf, String> {
    let (root, within) = root_of(flp).ok_or("That project is not on another machine.")?;
    let m = manifest(&root, &within)?;
    let name = m.pointer("/flp/name").and_then(Value::as_str).unwrap_or("project.flp").to_string();
    let stem = name.strip_suffix(".flp").or_else(|| name.strip_suffix(".FLP")).unwrap_or(&name).to_string();
    let mut dir = destination.join(format!("{stem}.packing"));
    let mut n = 2;
    while dir.exists() {
        dir = destination.join(format!("{stem}.packing ({n})"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut items: Vec<(String, String, Option<String>)> = vec![(m.pointer("/flp/rel").and_then(Value::as_str).unwrap_or(&within).to_string(), name.clone(), None)];
    for sample in m.get("samples").and_then(Value::as_array).into_iter().flatten() {
        items.push((
            sample.get("rel").and_then(Value::as_str).unwrap_or("").to_string(),
            sample.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            sample.get("scope").and_then(Value::as_str).map(str::to_string),
        ));
    }
    for (rel, item, scope) in &items {
        let target = free_name(&dir, item);
        if let Err(e) = copy_one(&root, rel, scope.as_deref(), &target, report) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("{item}: {e}"));
        }
    }
    let zip = free_name(destination, &format!("{stem}.zip"));
    let zipped = zip_dir(&dir, &zip);
    let _ = std::fs::remove_dir_all(&dir);
    zipped.map(|_| zip)
}

/// A zip of a folder's files, stored rather than deflated: audio barely compresses, and a
/// project's samples are what is in it.
fn zip_dir(dir: &Path, out: &Path) -> Result<(), String> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    entries.sort();
    let mut zip = std::io::BufWriter::new(std::fs::File::create(out).map_err(|e| e.to_string())?);
    let mut central = Vec::new();
    let mut offset: u64 = 0;
    let mut count: u16 = 0;
    for path in &entries {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        if data.len() as u64 >= u32::MAX as u64 || offset >= u32::MAX as u64 {
            return Err(format!("{name} is too large to pack"));
        }
        let mut crc = flate2::Crc::new();
        crc.update(&data);
        let crc = crc.sum();
        let name_bytes = name.as_bytes();
        let mut local = Vec::new();
        local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes()); // version needed
        local.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        local.extend_from_slice(&0u16.to_le_bytes()); // stored
        local.extend_from_slice(&0u32.to_le_bytes()); // time and date
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name_bytes);
        zip.write_all(&local).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 8]); // extra, comment, disk, internal attributes
        central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
        central.extend_from_slice(&(offset as u32).to_le_bytes());
        central.extend_from_slice(name_bytes);
        offset += local.len() as u64 + data.len() as u64;
        count += 1;
    }
    let mut end = Vec::new();
    end.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    end.extend_from_slice(&[0u8; 4]);
    end.extend_from_slice(&count.to_le_bytes());
    end.extend_from_slice(&count.to_le_bytes());
    end.extend_from_slice(&(central.len() as u32).to_le_bytes());
    end.extend_from_slice(&(offset as u32).to_le_bytes());
    end.extend_from_slice(&0u16.to_le_bytes());
    zip.write_all(&central).and_then(|_| zip.write_all(&end)).and_then(|_| zip.flush()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes() {
        assert_eq!(base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64("AAEC").unwrap(), vec![0, 1, 2]);
    }

    #[test]
    fn zips_open() {
        let dir = std::env::temp_dir().join(format!("umakbang-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("in")).unwrap();
        std::fs::write(dir.join("in").join("a.txt"), b"one").unwrap();
        std::fs::write(dir.join("in").join("b.flp"), b"two two").unwrap();
        zip_dir(&dir.join("in"), &dir.join("out.zip")).unwrap();
        let bytes = std::fs::read(dir.join("out.zip")).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert_eq!(&bytes[bytes.len() - 22..bytes.len() - 18], b"PK\x05\x06");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
