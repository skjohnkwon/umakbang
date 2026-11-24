//! Stem separation through LALAL.AI (`main/stems.ts`): the only place umakbang sends audio
//! anywhere. Upload, queue the split, poll every 3s (their limit is 30 a minute), download
//! each stem. Always an explicit per-file action behind a dialog that names the price.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const BASE: &str = "https://www.lalal.ai/api/v1";
const POLL: Duration = Duration::from_secs(3);
const GIVE_UP: Duration = Duration::from_secs(20 * 60);

/// The models the split endpoint accepts (`STEM_SPLITTERS`), newest first.
pub const SPLITTERS: [&str; 4] = ["andromeda", "perseus", "orion", "phoenix"];

#[derive(Clone, Debug)]
pub struct Options {
    pub key: String,
    pub output_dir: PathBuf,
    pub splitter: String,
    pub format: String,
    pub stem: String,
}

#[derive(Clone, Debug)]
pub struct Outcome {
    #[allow(dead_code)]
    pub path: String,
    pub written: Vec<PathBuf>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Event {
    Minutes(Option<f64>),
    Progress { path: String, phase: &'static str, percent: Option<f64> },
    Finished(Vec<Outcome>),
}

/// Every non-2xx answer comes back as a response, so what the service said can be read.
fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(600))).build())
}

/// What a refused request said, always with its status: "invalid license key" and
/// "unsupported model" read alike until one is visibly a 403 and the other a 422.
fn describe(status: u16, text: &str) -> String {
    let said = match serde_json::from_str::<Value>(text) {
        Ok(body) => flatten(body.get("error").or_else(|| body.get("detail")).or_else(|| body.get("message")).unwrap_or(&Value::Null)),
        Err(_) => text.trim().chars().take(300).collect(),
    };
    let status = format!("{status} {}", reason(status));
    if said.is_empty() { status } else { format!("{said} ({status})") }
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// A validation report, `{"detail": [{"msg": …}]}`, flattened rather than printed as
/// `[object Object]` - which is how a bad model name hid for as long as it did.
fn flatten(detail: &Value) -> String {
    match detail {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(flatten).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("; "),
        Value::Object(map) => match map.get("msg").or_else(|| map.get("message")).or_else(|| map.get("detail")) {
            Some(Value::String(s)) => s.trim_start_matches("Value error, ").to_string(),
            _ => detail.to_string().chars().take(300).collect(),
        },
        _ => String::new(),
    }
}

fn post(path: &str, key: &str, body: Option<&Value>) -> Result<Value, (u16, String)> {
    let request = agent().post(format!("{BASE}{path}")).header("X-License-Key", key);
    let response = match body {
        Some(body) => request.header("Content-Type", "application/json").send(body.to_string()),
        None => request.send_empty(),
    };
    let mut response = response.map_err(|e| (0, e.to_string()))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err((status, text));
    }
    serde_json::from_str(&text).map_err(|_| (status, text))
}

/// How much audio the account can still process, or None if the service would not say.
pub fn minutes_left(key: &str) -> Option<f64> {
    post("/limits/minutes_left/", key, None).ok()?.get("minutes_left")?.as_f64()
}

/// `filename*` for anything past ASCII, as RFC 6266 spells it.
fn content_disposition(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if (' '..='~').contains(&c) && c != '"' && c != '\\' { c } else { '_' }).collect();
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

fn upload(path: &Path, o: &Options) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Upload failed: {e}"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut response = agent()
        .post(format!("{BASE}/upload/"))
        .header("X-License-Key", &o.key)
        .header("Content-Disposition", content_disposition(&name))
        .header("Content-Type", "application/octet-stream")
        .send(&bytes[..])
        .map_err(|e| format!("Upload failed: {e}"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!("Upload failed: {}", describe(status, &text)));
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    body.get("id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("Upload failed: {}", body.get("error").and_then(Value::as_str).unwrap_or("no id returned")))
}

fn queue(source: &str, o: &Options) -> Result<String, String> {
    let body = json!({
        "source_id": source,
        "presets": { "stem": o.stem, "splitter": o.splitter, "extraction_level": "deep_extraction", "dereverb_enabled": false, "encoder_format": o.format }
    });
    let answer = post("/split/stem_separator/", &o.key, Some(&body)).map_err(|(s, t)| format!("Could not start the split: {}", describe(s, &t)))?;
    answer.get("task_id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "Could not start the split: no task id returned".to_string())
}

fn wait(task: &str, o: &Options, report: &dyn Fn(&'static str, Option<f64>)) -> Result<Vec<Value>, String> {
    let deadline = Instant::now() + GIVE_UP;
    while Instant::now() < deadline {
        std::thread::sleep(POLL);
        let answer = post("/check/", &o.key, Some(&json!({ "task_ids": [task] }))).map_err(|(s, t)| format!("Lost track of the job: {}", describe(s, &t)))?;
        let Some(entry) = answer.get("result").and_then(|r| r.get(task)) else { continue };
        match entry.get("status").and_then(Value::as_str) {
            Some("success") => {
                let tracks = entry.get("result").and_then(|r| r.get("tracks")).and_then(Value::as_array).cloned().unwrap_or_default();
                if tracks.is_empty() {
                    return Err("The service reported success but sent no stems".into());
                }
                return Ok(tracks);
            }
            Some("error") | Some("server_error") => return Err(entry.get("error").and_then(|e| e.get("detail")).and_then(Value::as_str).unwrap_or("The service reported an error").to_string()),
            Some("cancelled") => return Err("The job was cancelled".into()),
            _ => report("separating", entry.get("progress").and_then(Value::as_f64)),
        }
    }
    Err("Gave up waiting for the service".into())
}

fn label_for(track: &Value, stem: &str) -> String {
    let label = track.get("label").and_then(Value::as_str).unwrap_or("").to_lowercase();
    if !label.is_empty() {
        return label.replace('_', " ");
    }
    if track.get("type").and_then(Value::as_str) == Some("back") { format!("no {stem}") } else { stem.to_string() }
}

/// The source's name without its extension, made safe as a folder.
pub fn folder_name_for(path: &Path) -> String {
    let base = path.file_stem().map(|s| s.to_string_lossy().trim().to_string()).unwrap_or_default();
    let cleaned: String = base.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() { "stems".into() } else { cleaned }
}

fn free_name(dir: &Path, base: &str, ext: &str) -> PathBuf {
    (0..100)
        .map(|n| dir.join(if n == 0 { format!("{base}{ext}") } else { format!("{base} {}{ext}", n + 1) }))
        .find(|p| !p.exists())
        .unwrap_or_else(|| dir.join(format!("{base} {}{ext}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))))
}

fn split_one(path: &Path, o: &Options, report: &dyn Fn(&'static str, Option<f64>)) -> Result<Vec<PathBuf>, String> {
    let destination = o.output_dir.join(folder_name_for(path));
    std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    report("uploading", None);
    let source = upload(path, o)?;
    report("queued", None);
    let task = queue(&source, o)?;
    let tracks = wait(&task, o, report)?;
    report("downloading", None);
    let ext = format!(".{}", o.format);
    let mut written = Vec::new();
    for track in tracks {
        let Some(url) = track.get("url").and_then(Value::as_str) else { continue };
        let target = free_name(&destination, &label_for(&track, &o.stem), &ext);
        let response = agent().get(url).call().map_err(|e| format!("Could not download a stem: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Could not download a stem: {}", response.status()));
        }
        let mut reader = response.into_body().into_reader();
        let mut file = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut file).map_err(|e| format!("Could not download a stem: {e}"))?;
        written.push(target);
    }
    if written.is_empty() {
        return Err("The service returned no downloadable stems".into());
    }
    report("done", None);
    Ok(written)
}

/// Every file in turn on a thread of its own, each failure reported per file so a batch
/// keeps the ones that worked.
pub fn split_all(paths: Vec<String>, options: Options, send: impl Fn(Event) + Send + 'static) {
    std::thread::spawn(move || {
        let mut outcomes = Vec::new();
        for path in paths {
            let report = |phase: &'static str, percent: Option<f64>| send(Event::Progress { path: path.clone(), phase, percent });
            match split_one(Path::new(&path), &options, &report) {
                Ok(written) => outcomes.push(Outcome { path, written, error: None }),
                Err(error) => {
                    report("failed", None);
                    outcomes.push(Outcome { path, written: Vec::new(), error: Some(error) });
                }
            }
        }
        send(Event::Finished(outcomes));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_what_was_refused() {
        assert_eq!(describe(403, r#"{"detail": "Invalid license key"}"#), "Invalid license key (403 Forbidden)");
        assert_eq!(describe(422, r#"{"detail": [{"loc": ["body"], "msg": "Value error, Lynx does not support this stem"}]}"#), "Lynx does not support this stem (422 Unprocessable Entity)");
        assert_eq!(describe(500, ""), "500 Internal Server Error");
    }

    #[test]
    fn names_things() {
        assert_eq!(folder_name_for(&Path::new("a").join("beat: one.wav")), "beat_ one");
        assert!(content_disposition("ü.wav").contains("filename*=UTF-8''%C3%BC.wav"));
    }
}
