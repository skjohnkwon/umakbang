//! Libraries mounted from other machines (`remote-index.ts`, `remote-download.ts`, the remote half
//! of `protocol.ts`): another machine's library as a root of this one, read-only.
//!
//! It is an ordinary root from the window's point of view - the sidebar lists it, the explorer
//! walks into it, the player plays out of it. What knows it is remote is here: the index is
//! downloaded rather than walked, bytes are fetched by range rather than read, and anything that
//! would change a file is refused - another machine's library is only ever copied from.

use serde_json::Value;
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
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
    pub device_name: String,
}

impl RemoteRoot {
    pub fn from_root(root: &crate::userdata::Root) -> Option<RemoteRoot> {
        let remote = root.remote.as_ref().filter(|r| !r.is_null())?;
        let text = |k: &str| remote.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Some(RemoteRoot { label: root.label.clone(), path: root.path.clone(), host: text("host"), library_id: text("libraryId"), device_name: text("deviceName") })
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

/// Every mounted library, for the threads that open files to look up.
static ROOTS: RwLock<Vec<RemoteRoot>> = RwLock::new(Vec::new());

pub fn set_roots(roots: &[crate::userdata::Root]) {
    if let Ok(mut held) = ROOTS.write() {
        *held = roots.iter().filter_map(RemoteRoot::from_root).collect();
    }
}

/// The mounted library a path is in, and the path within it, forward slashes.
pub fn root_of(path: &str) -> Option<(RemoteRoot, String)> {
    let held = ROOTS.read().ok()?;
    let norm = |s: &str| s.replace('\\', "/");
    let path = norm(path);
    for root in held.iter() {
        let base = norm(&root.path);
        let base = base.trim_end_matches('/');
        if let Some(rest) = path.strip_prefix(base) {
            if rest.is_empty() || rest.starts_with('/') {
                return Some((root.clone(), rest.trim_start_matches('/').to_string()));
            }
        }
    }
    None
}

pub fn is_remote(path: &str) -> bool {
    root_of(path).is_some()
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

/* ------------------------------------------------------------------ the index */

/// One row of another machine's index, as this library files it: under the mount's label.
pub struct Row {
    pub rel_dir: String,
    pub file: crate::library::FileRow,
    pub project_created: Option<f64>,
}

/// `/index`, gunzipped as it arrives, with the journal lines folded in: the library as that
/// machine sees it now, relabelled under this mount's name.
pub fn fetch_index(root: &RemoteRoot) -> Result<Vec<Row>, String> {
    let url = format!("{}/index?library={}", root.base(), encode(&root.library_id));
    let response = agent(Duration::from_secs(600)).get(&url).call().map_err(|e| format!("{} is not reachable ({e}).", root.device_name))?;
    let status = response.status().as_u16();
    if status == 204 {
        return Ok(Vec::new());
    }
    if status != 200 {
        return Err(format!("{} answered {status}.", root.device_name));
    }
    let gzipped = response.headers().get("content-encoding").and_then(|v| v.to_str().ok()) == Some("gzip");
    let body = response.into_body().into_reader();
    let reader: Box<dyn Read> = if gzipped { Box::new(flate2::read::GzDecoder::new(body)) } else { Box::new(body) };
    // Each line becomes a row as it arrives. Held as parsed JSON until the end, a big library's
    // index took over a gigabyte for a moment and left half of it behind: hundreds of thousands
    // of small maps, which a Mac's allocator does not hand back.
    let base = slashed_base(&root.path);
    let mut index = Rows::default();
    for line in std::io::BufReader::with_capacity(1 << 20, reader).lines() {
        let line = line.map_err(|e| format!("{}: {e}", root.device_name))?;
        if line.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&line) else { continue };
        // A journal line: what changed since the index was written.
        if parsed.get("added").is_some() || parsed.get("removed").is_some() {
            for path in parsed.get("removed").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                index.remove(path);
            }
            for track in parsed.get("added").and_then(Value::as_array).into_iter().flatten() {
                index.put(row_from_track(track, &base, &root.label));
            }
            continue;
        }
        index.put(row_from_track(&parsed, &base, &root.label));
    }
    Ok(index.rows.into_iter().flatten().collect())
}

/// The rows of an index being read, in the order they first appeared, a later line for the
/// same path replacing an earlier one in place.
#[derive(Default)]
struct Rows {
    rows: Vec<Option<Row>>,
    at: std::collections::HashMap<String, usize>,
}

impl Rows {
    fn put(&mut self, row: Option<Row>) {
        let Some(row) = row else { return };
        match self.at.get(&row.file.path) {
            Some(&i) => self.rows[i] = Some(row),
            None => {
                self.at.insert(row.file.path.clone(), self.rows.len());
                self.rows.push(Some(row));
            }
        }
    }
    fn remove(&mut self, path: &str) {
        if let Some(i) = self.at.remove(path) {
            self.rows[i] = None;
        }
    }
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
