//! Updates and installing (`updater.ts`, plus what electron-builder's NSIS installer did).
//!
//! **One binary does all of it.** The release asset is the app itself,
//! `umakbang-native-<version>-win-x64.exe`, with a `.sha256` beside it. Run under a name
//! containing "setup", or with `--install`, it installs itself per user; installed, it checks
//! the same GitHub releases the Electron app did and stages a newer build; "Restart to update"
//! hands over to the staged copy, which waits for this one to exit, copies itself over it and
//! starts it again. No installer framework, nothing to keep in step with one.
//!
//! **Which repository is checked is `electron-builder.yml`'s `publish` block**, read at build
//! time, so there is still exactly one place that decides it and a fork that edits it checks
//! the fork. Releases are public: no credential is compiled in, and none ever should be.
//!
//! **A development build never updates itself.** Anything run from a cargo `target` folder is
//! one, and replacing it would be the updater overwriting the build it is being developed in.
//! A portable copy does update: what it replaces is the executable in its own folder, which is
//! exactly what updating a folder means (the reason Electron's portable copies could not - its
//! installer installed to the host - does not apply).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const FEED: &str = include_str!("../../electron-builder.yml");

#[derive(Clone, Debug, Default)]
pub enum Status {
    #[default]
    Idle,
    Disabled(String),
    Checking,
    UpToDate,
    /// A newer version, with no native Windows build attached to it.
    NoBuild(String),
    Downloading(String, f32),
    /// Downloaded and verified: the version, waiting for a restart.
    Ready(String),
    Failed(String),
}

static STATUS: Mutex<Status> = Mutex::new(Status::Idle);
static STAGED: Mutex<Option<(String, PathBuf)>> = Mutex::new(None);

pub fn status() -> Status {
    STATUS.lock().map(|s| s.clone()).unwrap_or_default()
}

fn set(status: Status) {
    if let Ok(mut s) = STATUS.lock() {
        *s = status;
    }
}

/// The version waiting for a restart, for the tray's menu.
pub fn staged_version() -> Option<String> {
    STAGED.lock().ok().and_then(|s| s.as_ref().map(|(v, _)| v.clone()))
}

/// `publish.owner` and `publish.repo`.
fn feed() -> Option<(String, String)> {
    let mut in_publish = false;
    let (mut owner, mut repo) = (None, None);
    for line in FEED.lines() {
        if !line.starts_with(' ') && !line.trim().is_empty() && !line.trim_start().starts_with('#') {
            in_publish = line.trim_end() == "publish:";
            continue;
        }
        if in_publish {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("owner:") {
                owner = Some(v.trim().to_string());
            } else if let Some(v) = line.strip_prefix("repo:") {
                repo = Some(v.trim().to_string());
            }
        }
    }
    Some((owner?, repo?))
}

/// Why this copy will not update itself, if it will not.
pub fn disabled_reason() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let lower = exe.to_string_lossy().to_lowercase();
    if lower.contains("\\target\\release\\") || lower.contains("\\target\\debug\\") {
        return Some("Updates are off: this is a development build. Install umakbang to get them.".into());
    }
    // `UMAKBANG_UPDATE_FEED=<base url>` stands in for api.github.com in a test, and is the
    // one way a test copy is allowed to update.
    if (exe.starts_with(std::env::temp_dir()) || std::env::var("UMAKBANG_SERVE").is_ok()) && std::env::var("UMAKBANG_UPDATE_FEED").is_err() {
        return Some("Updates are off for a test copy.".into());
    }
    if feed().is_none() {
        return Some("Updates are off: this build names no release feed.".into());
    }
    None
}

/// `1.2.3` as numbers, ignoring a leading `v` and anything after a `-`.
fn version(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split('-').next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build())
}

/// Starts the checks: 30 seconds after launch, then every twelve hours, as Electron did.
pub fn start(updates_dir: PathBuf, changed: impl Fn() + Send + 'static) {
    if let Some(reason) = disabled_reason() {
        set(Status::Disabled(reason));
        return;
    }
    clear_old(&updates_dir);
    std::thread::Builder::new()
        .name("updater".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(if std::env::var("UMAKBANG_UPDATE_FEED").is_ok() { 2 } else { 30 }));
            check(&updates_dir, &changed);
            std::thread::sleep(Duration::from_secs(12 * 3600 - 30));
        })
        .ok();
}

/// Asks now, on a thread (Settings' "Check now").
pub fn check_now(updates_dir: PathBuf, changed: impl Fn() + Send + 'static) {
    if disabled_reason().is_some() || matches!(status(), Status::Checking | Status::Downloading(..)) {
        return;
    }
    std::thread::spawn(move || check(&updates_dir, &changed));
}

/// Staged copies of versions this one has caught up with are worth nothing.
fn clear_old(dir: &Path) {
    let current = version(env!("CARGO_PKG_VERSION"));
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let staged = name.strip_prefix("umakbang-").and_then(|n| n.strip_suffix(".exe")).map(version);
        if name.ends_with(".part") || staged.is_some_and(|v| v <= current) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn check(dir: &Path, changed: &dyn Fn()) {
    let Some((owner, repo)) = feed() else { return };
    set(Status::Checking);
    changed();
    let outcome = (|| -> Result<Status, String> {
        let mut response = agent(Duration::from_secs(20))
            .get(&format!("{}/repos/{owner}/{repo}/releases/latest", std::env::var("UMAKBANG_UPDATE_FEED").unwrap_or_else(|_| "https://api.github.com".into())))
            .header("User-Agent", "umakbang-updater")
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("Could not reach GitHub: {e}"))?;
        if response.status() != 200 {
            return Err(format!("GitHub answered {}.", response.status()));
        }
        let release: serde_json::Value = serde_json::from_str(&response.body_mut().read_to_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let tag = release["tag_name"].as_str().unwrap_or("").to_string();
        let latest = tag.trim_start_matches('v').to_string();
        if version(&latest) <= version(env!("CARGO_PKG_VERSION")) {
            return Ok(Status::UpToDate);
        }
        if staged_version().as_deref() == Some(latest.as_str()) {
            return Ok(Status::Ready(latest));
        }
        let assets = release["assets"].as_array().cloned().unwrap_or_default();
        let find = |pred: &dyn Fn(&str) -> bool| assets.iter().find(|a| a["name"].as_str().is_some_and(pred)).and_then(|a| a["browser_download_url"].as_str().map(str::to_string));
        let Some(exe_url) = find(&|n: &str| n.starts_with("umakbang-native") && n.ends_with("win-x64.exe")) else { return Ok(Status::NoBuild(latest)) };
        // Never installed unverified: no checksum published, no update.
        let Some(sum_url) = find(&|n: &str| n.starts_with("umakbang-native") && n.ends_with("win-x64.exe.sha256")) else { return Ok(Status::NoBuild(latest)) };
        let mut sum_response = agent(Duration::from_secs(20)).get(&sum_url).header("User-Agent", "umakbang-updater").call().map_err(|e| e.to_string())?;
        let expected = sum_response.body_mut().read_to_string().map_err(|e| e.to_string())?.split_whitespace().next().unwrap_or("").to_lowercase();
        let _ = std::fs::create_dir_all(dir);
        let target = dir.join(format!("umakbang-{latest}.exe"));
        let part = dir.join(format!("umakbang-{latest}.exe.part"));
        let response = agent(Duration::from_secs(1800)).get(&exe_url).header("User-Agent", "umakbang-updater").call().map_err(|e| format!("Download failed: {e}"))?;
        let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        let mut reader = response.into_body().into_reader();
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        let (mut buf, mut got) = (vec![0u8; 1 << 16], 0f64);
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            got += n as f64;
            if total > 0.0 {
                set(Status::Downloading(latest.clone(), (got / total) as f32));
            }
        }
        drop(file);
        let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if actual != expected {
            let _ = std::fs::remove_file(&part);
            return Err("The download did not match its published checksum, so it was thrown away.".into());
        }
        std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
        if let Ok(mut s) = STAGED.lock() {
            *s = Some((latest.clone(), target));
        }
        Ok(Status::Ready(latest))
    })();
    set(outcome.unwrap_or_else(Status::Failed));
    changed();
}

/// "Restart to update": the staged copy started to replace this one; true when it was, and the
/// caller then quits. `args` are what this copy was started with, so the new one opens the same.
pub fn restart_into_update(args: &[String]) -> bool {
    let Some((_, staged)) = STAGED.lock().ok().and_then(|s| s.clone()) else { return false };
    let Ok(current) = std::env::current_exe() else { return false };
    let mut command = std::process::Command::new(&staged);
    command.arg("--apply-update").arg(&current).arg(std::process::id().to_string()).args(args);
    command.spawn().is_ok()
}

/// The staged copy's half: waits for the old process to go, puts itself where it was, and
/// starts it. Retried, because Windows can hold an exe open a moment after its process exits.
pub fn apply(target: &Path, pid: u32, args: &[String]) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            WaitForSingleObject(handle, 30_000);
            CloseHandle(handle);
        }
    }
    let Ok(me) = std::env::current_exe() else { return };
    let mut copied = false;
    for _ in 0..40 {
        if std::fs::copy(&me, target).is_ok() {
            copied = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    // Copied or not, umakbang comes back: the old version is better than none.
    let _ = std::process::Command::new(target).args(args).spawn();
    let _ = copied;
}

/* ------------------------------------------------------------------ installing */

fn programs_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join("Programs").join("umakbang")
}

fn start_menu() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join(r"Microsoft\Windows\Start Menu\Programs\umakbang.lnk")
}

fn desktop() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default().join(r"Desktop\umakbang.lnk")
}

const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\umakbang";

/// Whether this run is the installer: `--install`, or a file name that says setup.
pub fn is_setup(args: &[String]) -> bool {
    args.iter().any(|a| a == "--install")
        || std::env::current_exe().ok().and_then(|e| e.file_name().map(|n| n.to_string_lossy().to_lowercase())).is_some_and(|n| n.contains("setup"))
}

fn message(text: &str, flags: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide("umakbang"));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), flags) }
}

/// A shortcut, made by the shell's own scripting object - the paths go through the
/// environment rather than the command line, since a name with an apostrophe in it is normal.
fn shortcut(at: &Path, target: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:UMAK_LNK); $s.TargetPath = $env:UMAK_EXE; $s.WorkingDirectory = (Split-Path $env:UMAK_EXE); $s.IconLocation = $env:UMAK_EXE + ',0'; $s.Save()"])
        .env("UMAK_LNK", at)
        .env("UMAK_EXE", target)
        .creation_flags(0x0800_0000)
        .status()
        .is_ok_and(|s| s.success())
}

fn set_reg(key: windows_sys::Win32::System::Registry::HKEY, name: &str, value: &str) {
    use windows_sys::Win32::System::Registry::{RegSetValueExW, REG_SZ};
    let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let data: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, data.as_ptr() as *const u8, (data.len() * 2) as u32) };
}

fn set_reg_dword(key: windows_sys::Win32::System::Registry::HKEY, name: &str, value: u32) {
    use windows_sys::Win32::System::Registry::{RegSetValueExW, REG_DWORD};
    let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_DWORD, &value as *const u32 as *const u8, 4) };
}

/// Installs this copy for the current user: `%LOCALAPPDATA%\Programs\umakbang\umakbang.exe`,
/// a Start menu and a Desktop shortcut, and an entry under Apps that uninstalls it. Then
/// starts it. Nothing needs administrator rights, the same as electron-builder's per-user NSIS.
pub fn install() -> Result<PathBuf, String> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE};
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = programs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = dir.join("umakbang.exe");
    if me != exe {
        let mut done = false;
        for _ in 0..20 {
            if std::fs::copy(&me, &exe).is_ok() {
                done = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if !done {
            return Err("umakbang is running. Quit it from its tray icon and run setup again.".into());
        }
    }
    shortcut(&start_menu(), &exe);
    shortcut(&desktop(), &exe);
    let key_name: Vec<u16> = UNINSTALL_KEY.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    unsafe {
        if RegCreateKeyExW(HKEY_CURRENT_USER, key_name.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, std::ptr::null(), &mut key, std::ptr::null_mut()) == 0 {
            let path = exe.to_string_lossy();
            set_reg(key, "DisplayName", "umakbang");
            set_reg(key, "DisplayVersion", env!("CARGO_PKG_VERSION"));
            set_reg(key, "Publisher", "umakbang");
            set_reg(key, "DisplayIcon", &format!("{path},0"));
            set_reg(key, "InstallLocation", &dir.to_string_lossy());
            set_reg(key, "UninstallString", &format!("\"{path}\" --uninstall"));
            set_reg_dword(key, "NoModify", 1);
            set_reg_dword(key, "NoRepair", 1);
            let size = std::fs::metadata(&exe).map(|m| (m.len() / 1024) as u32).unwrap_or(0);
            set_reg_dword(key, "EstimatedSize", size);
            RegCloseKey(key);
        }
    }
    Ok(exe)
}

/// `--uninstall`, from Apps: asked first, then the shortcuts, the start-at-login entry and the
/// Apps entry go, and the program folder is removed once this process has let go of it. The
/// library, the tags and the ratings are left exactly where they are.
pub fn uninstall() {
    use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONQUESTION, MB_YESNO};
    if message("Uninstall umakbang?\n\nYour library, tags, ratings and settings stay on this computer.", MB_YESNO | MB_ICONQUESTION) != IDYES {
        return;
    }
    let _ = std::fs::remove_file(start_menu());
    let _ = std::fs::remove_file(desktop());
    crate::tray::set_login_item(false, &[]);
    let key: Vec<u16> = UNINSTALL_KEY.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr()) };
    let dir = programs_dir();
    // Only ever the folder setup made, checked by name before anything is removed.
    if dir.ends_with(r"Programs\umakbang") {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd.exe")
            .args(["/C", "ping 127.0.0.1 -n 3 > nul & rmdir /S /Q"])
            .arg(&dir)
            .creation_flags(0x0800_0000)
            .spawn();
    }
}

/// Setup's whole run: install, say so if it could not, start the installed copy.
pub fn run_setup() {
    use windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR;
    match install() {
        Ok(exe) => {
            let _ = std::process::Command::new(exe).spawn();
        }
        Err(e) => {
            message(&format!("umakbang could not be installed.\n\n{e}"), MB_ICONERROR);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn feed_and_versions() {
        assert_eq!(super::feed(), Some(("skjohnkwon".to_string(), "umakbang".to_string())));
        assert!(super::version("v0.4.10") > super::version("0.4.9"));
        assert!(super::version("0.5.0-beta") > super::version("0.4.1"));
    }
}
