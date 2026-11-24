//! Audio from a link (`main/youtube.ts`, `lib/youtube.ts`): yt-dlp fetches the stream, the
//! app's own decoder reads it back, and LAME writes the MP3 - the same split the Electron
//! app makes, so neither needs ffmpeg.
//!
//! The extractor lives in `<userData>/tools`, beside the data file both apps share, so one
//! install serves both. It keeps itself current: a build untouched for a week runs `-U`
//! before the next download, with the file's own mtime as the clock.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const STALE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// `CREATE_NO_WINDOW`: without it every call flashes a console over the app.
const NO_WINDOW: u32 = 0x0800_0000;

/// Where the files go: the Electron page's `DOWNLOAD_DIR`, the one folder downloads always
/// land in. `UMAKBANG_DOWNLOAD_DIR` points a test somewhere harmless.
pub fn download_dir() -> PathBuf {
    std::env::var_os("UMAKBANG_DOWNLOAD_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"Z:\SECRET SAUCE\Stems\zmisc"))
}

#[derive(Clone, Debug, Default)]
pub struct Info {
    pub title: String,
    pub uploader: String,
    pub seconds: Option<f64>,
    pub playlist: bool,
    pub count: Option<u64>,
    /// The thumbnail, decoded: width, height, RGBA.
    pub thumbnail: Option<(u32, u32, Vec<u8>)>,
}

#[derive(Clone, Debug)]
pub enum Event {
    /// Whether the extractor is installed, and its version or what is wrong with it.
    Tool(Result<String, Option<String>>),
    InstallProgress(f32),
    /// What a link turned out to be, for the request numbered `.0`.
    Probed(u64, Result<Info, String>),
    Progress { phase: &'static str, percent: Option<f32>, title: Option<String> },
    /// A finished download: where it was written, or why not.
    Done(Result<PathBuf, String>),
    /// Kept as the stream because it would not re-encode.
    Kept(String, String),
}

pub struct Downloader {
    tools: PathBuf,
    scratch: PathBuf,
    active: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

impl Downloader {
    /// `user_data` is the folder holding `umakbang-data.json`.
    pub fn new(user_data: &Path) -> Downloader {
        Downloader { tools: user_data.join("tools"), scratch: user_data.join("youtube-temp"), active: Arc::new(Mutex::new(None)), cancelled: Arc::new(AtomicBool::new(false)) }
    }

    fn tool(&self) -> PathBuf {
        self.tools.join("yt-dlp.exe")
    }

    pub fn status(&self, send: impl Fn(Event) + Send + 'static) {
        let tool = self.tool();
        std::thread::spawn(move || send(Event::Tool(status(&tool))));
    }

    /// Fetches the extractor, written to `.part` and renamed so a half-downloaded file is
    /// never sitting under the name the app looks for.
    pub fn install(&self, send: impl Fn(Event) + Send + 'static) {
        let (dir, tool) = (self.tools.clone(), self.tool());
        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let response = ureq::get(RELEASE_URL).call().map_err(|e| format!("Could not reach the release: {e}"))?;
                let total = response.body().content_length().unwrap_or(0);
                let mut reader = response.into_body().into_reader();
                let part = tool.with_extension("exe.part");
                let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
                let (mut seen, mut buf) = (0u64, vec![0u8; 64 * 1024]);
                loop {
                    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    seen += n as u64;
                    if total > 0 {
                        send(Event::InstallProgress((seen as f32 / total as f32 * 100.0).min(100.0)));
                    }
                }
                drop(out);
                let _ = std::fs::remove_file(&tool);
                std::fs::rename(&part, &tool).map_err(|e| e.to_string())
            })();
            send(Event::Tool(match result {
                Ok(()) => status(&tool),
                Err(e) => Err(Some(e)),
            }));
        });
    }

    /// Reads what a link is before anything is downloaded, with its thumbnail.
    pub fn probe(&self, generation: u64, url: String, send: impl Fn(Event) + Send + 'static) {
        let tool = self.tool();
        std::thread::spawn(move || {
            let result = dump(&tool, &url).map(|json| describe(&json, true));
            send(Event::Probed(generation, result));
        });
    }

    /// The same answers, on this thread: for the shot and the command-line check.
    pub fn status_now(&self) -> Result<String, Option<String>> {
        status(&self.tool())
    }

    pub fn probe_now(&self, url: &str) -> Result<Info, String> {
        dump(&self.tool(), url).map(|json| describe(&json, true))
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self.active.lock().ok().as_mut().and_then(|a| a.as_mut()) {
            let _ = child.kill();
        }
    }

    /// The whole job: keep the tool current, read the link, download the stream, re-encode it
    /// as MP3 when that is what is wanted, and put the result in `dir`.
    pub fn fetch(&self, url: String, format: String, kbps: u32, dir: PathBuf, send: impl Fn(Event) + Send + 'static) {
        let (tool, scratch, active, cancelled) = (self.tool(), self.scratch.clone(), self.active.clone(), self.cancelled.clone());
        cancelled.store(false, Ordering::SeqCst);
        std::thread::spawn(move || {
            let outcome = (|| -> Result<PathBuf, String> {
                if !tool.exists() {
                    return Err("The downloader is not installed yet.".into());
                }
                send(Event::Progress { phase: "tool", percent: None, title: None });
                update_if_stale(&tool);
                send(Event::Progress { phase: "reading", percent: None, title: None });
                let json = dump(&tool, &url)?;
                let info = describe(&json, false);
                if info.playlist {
                    return Err(format!("That link is a playlist{}. Paste a link to a single video.", info.count.map_or(String::new(), |c| format!(" of {c} videos"))));
                }
                if cancelled.load(Ordering::SeqCst) {
                    return Err("Cancelled.".into());
                }
                std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
                let title = Some(info.title.clone());
                send(Event::Progress { phase: "downloading", percent: Some(0.0), title: title.clone() });
                let stem = format!("{:x}-{:x}", SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), std::process::id());
                // m4a first: AAC is what this decoder reads and what the site serves for nearly
                // everything. A video takes the one stream carrying both picture and sound.
                let selector = if format == "video" { "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]" } else { "bestaudio[ext=m4a]/bestaudio/best" };
                let temp = download(&tool, &url, selector, &scratch, &stem, &active, &cancelled, &|p| {
                    send(Event::Progress { phase: "downloading", percent: Some(p), title: title.clone() })
                })?;
                let mut ext = temp.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                let mut bytes = None;
                if format == "mp3" {
                    send(Event::Progress { phase: "converting", percent: Some(0.0), title: title.clone() });
                    match transcode(&temp, kbps, &|f| send(Event::Progress { phase: "converting", percent: Some(f * 100.0), title: title.clone() })) {
                        Ok(encoded) => {
                            bytes = Some(encoded);
                            ext = "mp3".into();
                        }
                        // The stream is kept in whatever it arrived as rather than lost.
                        Err(_) => send(Event::Kept(info.title.clone(), ext.clone())),
                    }
                }
                send(Event::Progress { phase: "writing", percent: None, title: title.clone() });
                let placed = place(&temp, &dir, &info.title, &ext, bytes.as_deref());
                let _ = std::fs::remove_file(&temp);
                placed
            })();
            send(Event::Done(outcome));
        });
    }
}

fn command(tool: &Path) -> Command {
    let mut c = Command::new(tool);
    c.creation_flags(NO_WINDOW).stdin(Stdio::null());
    c
}

fn status(tool: &Path) -> Result<String, Option<String>> {
    if !tool.exists() {
        return Err(None);
    }
    let out = command(tool).arg("--version").output().map_err(|e| Some(e.to_string()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(Some(if err.is_empty() { "The downloader would not run.".into() } else { err }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `-U` once a week, non-fatal in every direction: an update is an optimisation, never a
/// precondition.
fn update_if_stale(tool: &Path) {
    let stale = std::fs::metadata(tool).and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age > STALE);
    if !stale {
        return;
    }
    let _ = command(tool).arg("-U").stdout(Stdio::null()).stderr(Stdio::null()).status();
    if let Ok(file) = std::fs::File::options().write(true).open(tool) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// The tail of whatever the tool complained about, as one sentence.
fn complaint(err: &str, fallback: &str) -> String {
    let Some(line) = err.lines().map(str::trim).filter(|l| l.starts_with("ERROR:")).last() else { return fallback.to_string() };
    let line = line.trim_start_matches("ERROR:").trim();
    // "[youtube] abc: Video unavailable" reads as "Video unavailable".
    match line.strip_prefix('[').and_then(|rest| rest.split_once(']')).and_then(|(_, rest)| rest.split_once(':')) {
        Some((_, said)) => said.trim().to_string(),
        None => line.to_string(),
    }
}

fn dump(tool: &Path, url: &str) -> Result<serde_json::Value, String> {
    if !tool.exists() {
        return Err("The downloader is not installed yet.".into());
    }
    // `--no-playlist` turns a `watch?v=…&list=…` into the one video it was about.
    let mut child = command(tool)
        .args(["--dump-single-json", "--no-playlist", "--no-warnings", "--flat-playlist", url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    // A link the site is slow to answer for must not leave a process running forever.
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > Duration::from_secs(60) => {
                let _ = child.kill();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break None,
        }
    };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if !status.is_some_and(|s| s.success()) {
        return Err(complaint(&String::from_utf8_lossy(&stderr), "That link could not be read."));
    }
    let out = std::process::Output { status: status.unwrap_or_default(), stdout, stderr };
    serde_json::from_slice(&out.stdout).map_err(|_| "That link could not be read.".to_string())
}

fn describe(json: &serde_json::Value, with_thumbnail: bool) -> Info {
    let s = |key: &str| json.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let uploader = s("uploader").or_else(|| s("channel")).unwrap_or_default();
    if json.get("_type").and_then(|v| v.as_str()) == Some("playlist") {
        return Info {
            title: s("title").unwrap_or_else(|| "Playlist".into()),
            uploader,
            playlist: true,
            count: json.get("playlist_count").and_then(|v| v.as_u64()).or_else(|| json.get("entries").and_then(|e| e.as_array()).map(|a| a.len() as u64)),
            ..Default::default()
        };
    }
    let mut info = Info { title: s("title").unwrap_or_else(|| "Untitled".into()), uploader, seconds: json.get("duration").and_then(|v| v.as_f64()), ..Default::default() };
    if with_thumbnail {
        info.thumbnail = thumbnail(json);
    }
    info
}

/// The thumbnail, fetched and decoded here. Non-fatal in every direction: a thumbnail that
/// will not load is a card without a picture, never a link that cannot be read.
fn thumbnail(json: &serde_json::Value) -> Option<(u32, u32, Vec<u8>)> {
    // A JPEG this decoder reads: the listed one when it is one, else YouTube's own `hqdefault`.
    let listed = json.get("thumbnail").and_then(|v| v.as_str()).unwrap_or("");
    let url = if listed.contains(".jpg") {
        listed.to_string()
    } else {
        let id = json.get("id").and_then(|v| v.as_str())?;
        format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")
    };
    let agent = ureq::Agent::new_with_config(ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(8))).build());
    let mut response = agent.get(&url).call().ok()?;
    let bytes = response.body_mut().read_to_vec().ok()?;
    let options = zune_jpeg::zune_core::options::DecoderOptions::default().jpeg_set_out_colorspace(zune_jpeg::zune_core::colorspace::ColorSpace::RGBA);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(std::io::Cursor::new(bytes), options);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    Some((info.width as u32, info.height as u32, pixels))
}

/// One format to `<stem>.<ext>` in the scratch folder. `--no-mtime`, because Modified means
/// when a file arrived here, not when somebody uploaded it.
#[allow(clippy::too_many_arguments)]
fn download(tool: &Path, url: &str, format: &str, scratch: &Path, stem: &str, active: &Mutex<Option<Child>>, cancelled: &AtomicBool, on_percent: &dyn Fn(f32)) -> Result<PathBuf, String> {
    let template = scratch.join(format!("{stem}.%(ext)s"));
    let mut child = command(tool)
        .args(["-f", format, "--no-playlist", "--newline", "--no-warnings", "--no-mtime", "-o"])
        .arg(&template)
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    if let Ok(mut slot) = active.lock() {
        *slot = Some(child);
    }
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            // "[download]  42.0% of ..."
            if let Some(rest) = line.trim_start().strip_prefix("[download]") {
                if let Some(percent) = rest.trim_start().split('%').next().and_then(|n| n.trim().parse::<f32>().ok()) {
                    on_percent(percent);
                }
            }
        }
    }
    let status = active.lock().ok().and_then(|mut a| a.take()).and_then(|mut c| c.wait().ok());
    let err = err_reader.join().unwrap_or_default();
    if cancelled.load(Ordering::SeqCst) {
        return Err("Cancelled.".into());
    }
    if !status.is_some_and(|s| s.success()) {
        return Err(complaint(&err, "The download failed."));
    }
    std::fs::read_dir(scratch)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&format!("{stem}.")) && !n.ends_with(".part")))
        .ok_or_else(|| "The download finished but left no file.".to_string())
}

/// The stream decoded and written out as an MP3 at `kbps` - a second lossy generation, the
/// honest cost of asking for an MP3 at all.
pub fn transcode(path: &Path, kbps: u32, progress: &dyn Fn(f32)) -> Result<Vec<u8>, String> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, InterleavedPcm, Quality};
    use rodio::Source;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let decoder = rodio::Decoder::try_from(file).map_err(|e| e.to_string())?;
    let channels = decoder.channels().get().min(2) as u8;
    let source_channels = decoder.channels().get() as usize;
    let rate = decoder.sample_rate().get();
    let total = decoder.total_duration().map(|d| d.as_secs_f64() * rate as f64 * source_channels as f64);
    let bitrate = match kbps {
        0..=143 => Bitrate::Kbps128,
        144..=175 => Bitrate::Kbps160,
        176..=223 => Bitrate::Kbps192,
        224..=287 => Bitrate::Kbps256,
        _ => Bitrate::Kbps320,
    };
    let mut builder = Builder::new().ok_or("The encoder would not start.")?;
    builder.set_num_channels(channels).map_err(|e| format!("{e:?}"))?;
    builder.set_sample_rate(rate).map_err(|e| format!("{e:?}"))?;
    builder.set_brate(bitrate).map_err(|e| format!("{e:?}"))?;
    builder.set_quality(Quality::Good).map_err(|e| format!("{e:?}"))?;
    let mut encoder = builder.build().map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::new();
    let mut chunk: Vec<i16> = Vec::with_capacity(1152 * 2 * 64);
    let (mut frame, mut seen) = (Vec::with_capacity(source_channels), 0usize);
    let mut flush = |chunk: &mut Vec<i16>, out: &mut Vec<u8>| -> Result<(), String> {
        if chunk.is_empty() {
            return Ok(());
        }
        out.reserve(mp3lame_encoder::max_required_buffer_size(chunk.len()));
        if channels == 1 {
            encoder.encode_to_vec(mp3lame_encoder::MonoPcm(chunk.as_slice()), out).map_err(|e| format!("{e:?}"))?;
        } else {
            encoder.encode_to_vec(InterleavedPcm(chunk.as_slice()), out).map_err(|e| format!("{e:?}"))?;
        }
        chunk.clear();
        Ok(())
    };
    for sample in decoder {
        frame.push(sample);
        seen += 1;
        if frame.len() < source_channels {
            continue;
        }
        // Anything past stereo is folded into the first two channels' average.
        let pick = |c: usize| (frame[c.min(frame.len() - 1)].clamp(-1.0, 1.0) * 32767.0) as i16;
        chunk.push(pick(0));
        if channels == 2 {
            chunk.push(pick(1));
        }
        frame.clear();
        if chunk.len() >= 1152 * 2 * 64 {
            flush(&mut chunk, &mut out)?;
            if let Some(total) = total {
                progress((seen as f64 / total).min(1.0) as f32);
            }
        }
    }
    flush(&mut chunk, &mut out)?;
    out.reserve(7200);
    encoder.flush_to_vec::<FlushNoGap>(&mut out).map_err(|e| format!("{e:?}"))?;
    if out.is_empty() {
        return Err("Nothing came out of the encoder.".into());
    }
    Ok(out)
}

/// `fileNameFor`: a title a filesystem accepts.
pub fn file_name_for(title: &str) -> String {
    let cleaned: String = title.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '-' } else { c }).collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    let cut: String = cleaned.chars().take(120).collect();
    let cut = cut.trim().trim_end_matches(['.', ' ']).to_string();
    if cut.is_empty() { "download".into() } else { cut }
}

/// Into `dir` under a name nothing is using, never over a file: `freeName` rather than an
/// error, since a name nobody typed is not worth refusing over.
fn place(temp: &Path, dir: &Path, title: &str, ext: &str, bytes: Option<&[u8]>) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = file_name_for(title);
    let target = (0..100)
        .map(|n| dir.join(if n == 0 { format!("{base}.{ext}") } else { format!("{base} ({}).{ext}", n + 1) }))
        .find(|p| !p.exists())
        .unwrap_or_else(|| dir.join(format!("{base} {}.{ext}", SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))));
    match bytes {
        Some(bytes) => {
            let mut file = std::fs::File::options().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
            file.write_all(bytes).map_err(|e| e.to_string())?;
        }
        // Copied, not renamed: the scratch is under the profile and the library is often on
        // another drive.
        None => {
            std::fs::copy(temp, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_files_from_titles() {
        assert_eq!(file_name_for("A: B / C?"), "A- B - C-");
        assert_eq!(file_name_for("  trailing.. "), "trailing");
        assert_eq!(file_name_for("..."), "download");
    }

    #[test]
    fn reads_complaints() {
        assert_eq!(complaint("WARNING: x\nERROR: [youtube] abc123: Video unavailable\n", "f"), "Video unavailable");
        assert_eq!(complaint("nothing", "fallback"), "fallback");
    }
}
