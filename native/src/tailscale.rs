//! `tailscale.ts`: what Tailscale says about this machine and the others on the tailnet, read
//! from `tailscale status --json`. The server binds the address this reports and nothing else.

use serde_json::Value;
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default)]
pub struct Node {
    pub id: String,
    /// The MagicDNS name, without its trailing dot.
    pub name: String,
    pub host_name: String,
    pub os: String,
    pub online: bool,
    pub ipv4: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Running,
    Stopped,
    Missing,
    Error,
}

#[derive(Clone, Debug)]
pub struct Status {
    pub state: State,
    pub reason: Option<String>,
    pub this: Option<Node>,
    pub peers: Vec<Node>,
}

#[cfg(windows)]
const CANDIDATES: [&str; 2] = [r"C:\Program Files\Tailscale\tailscale.exe", r"C:\Program Files (x86)\Tailscale\tailscale.exe"];
#[cfg(windows)]
const ON_PATH: &str = "tailscale.exe";
/// The App Store and standalone apps both carry the CLI inside the bundle; Homebrew's
/// `tailscale` formula puts it on the PATH instead.
#[cfg(not(windows))]
const CANDIDATES: [&str; 3] = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
#[cfg(not(windows))]
const ON_PATH: &str = "tailscale";

fn binary() -> String {
    CANDIDATES.iter().find(|c| std::path::Path::new(c).exists()).map_or_else(|| ON_PATH.to_string(), |c| c.to_string())
}

fn node(id: &str, raw: &Value) -> Node {
    let text = |key: &str| raw.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    Node {
        id: id.to_string(),
        name: text("DNSName").trim_end_matches('.').to_string(),
        host_name: text("HostName"),
        os: text("OS"),
        online: raw.get("Online").and_then(Value::as_bool).unwrap_or(false),
        ipv4: raw.get("TailscaleIPs").and_then(Value::as_array).and_then(|ips| ips.iter().filter_map(Value::as_str).find(|ip| ip.contains('.')).map(str::to_string)),
    }
}

fn failed(state: State, reason: &str) -> Status {
    Status { state, reason: Some(reason.into()), this: None, peers: Vec::new() }
}

/// Five seconds at most: a wedged daemon is a reason to say so, not to hang.
pub fn read() -> Status {
    let child = crate::process::quiet(&mut Command::new(binary()))
        .args(["status", "--json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return failed(State::Missing, "Tailscale is not installed."),
        Err(_) => return failed(State::Error, "Tailscale did not respond."),
    };
    // Read on another thread so the deadline can be kept.
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = std::io::Read::read_to_string(pipe, &mut out);
        }
        out
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                return failed(State::Error, "Tailscale did not respond.");
            }
        }
    }
    let out = reader.join().unwrap_or_default();
    // A non-zero exit still prints the status when the daemon is merely stopped.
    let Ok(raw) = serde_json::from_str::<Value>(&out) else {
        return if out.trim().is_empty() { failed(State::Error, "Tailscale did not respond.") } else { failed(State::Error, "Tailscale returned something unreadable.") };
    };
    let backend = raw.get("BackendState").and_then(Value::as_str).unwrap_or("");
    let this = raw.get("Self").map(|s| node("self", s));
    let mut peers: Vec<Node> = raw.get("Peer").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| node(k, v)).collect()).unwrap_or_default();
    peers.sort_by(|a, b| {
        let (x, y) = (if a.host_name.is_empty() { &a.name } else { &a.host_name }, if b.host_name.is_empty() { &b.name } else { &b.host_name });
        x.to_lowercase().cmp(&y.to_lowercase())
    });
    if backend != "Running" {
        let reason = if backend == "NeedsLogin" { "Tailscale is installed but not signed in." } else { "Tailscale is not running." };
        return Status { state: State::Stopped, reason: Some(reason.into()), this, peers };
    }
    Status { state: State::Running, reason: None, this, peers }
}
