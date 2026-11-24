//! When the app dies, something is left to say why (`crashReporter.start`). The release build
//! has no console, so a panic used to vanish with the window and leave nothing at all.
//!
//! Two kinds of death, two records, both beside the library database:
//!
//! - a Rust panic appends its message, thread, location and backtrace to `crash.log`;
//! - a native fault - an access violation in a driver, a stack overflow - is caught by the
//!   unhandled-exception filter and written as `crash.dmp`, a minidump Visual Studio or WinDbg
//!   opens, as Electron's crash reporter leaves in `crashDumps`.
//!
//! Either one leaves `crashed` behind, and the next launch says so and files the dump under a
//! dated name, keeping the newest few. A dump nobody is told about is one nobody sends.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();
/// The dump's path, wide and NUL-terminated, made before anything can go wrong: the filter
/// runs on a broken process and should not have to allocate to name a file.
#[cfg_attr(not(windows), allow(dead_code))]
static DUMP: OnceLock<Vec<u16>> = OnceLock::new();

const KEEP: usize = 5;

/// Installs both, writing into `dir`.
pub fn install(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let _ = DIR.set(dir.to_path_buf());
    let mut wide: Vec<u16> = dir.join("crash.dmp").as_os_str().to_string_lossy().encode_utf16().collect();
    wide.push(0);
    let _ = DUMP.set(wide);

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = DIR.get() {
            let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "(no message)".into());
            let at = info.location().map_or_else(String::new, |l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
            let trace = std::backtrace::Backtrace::force_capture();
            if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
                let _ = writeln!(log, "--- {} umakbang {} ---\npanic on thread '{thread}' at {at}:\n{message}\n{trace}\n", crate::localtime::iso_utc(crate::localtime::now()), env!("CARGO_PKG_VERSION"));
            }
            // Only a panic that takes the process down is a crash. One on a worker thread is
            // recorded above but costs that thread, which the app is built to survive.
            if thread == "main" {
                let _ = std::fs::write(dir.join("crashed"), b"panic");
            }
        }
        previous(info);
    }));

    // On a Mac a native fault is written up by the system itself, in
    // ~/Library/Logs/DiagnosticReports; only the panic hook above is ours.
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter(Some(on_fault));
    }
}

#[cfg(windows)]
unsafe extern "system" fn on_fault(pointers: *const windows_sys::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS) -> i32 {
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL};
    use windows_sys::Win32::System::Diagnostics::Debug::{MiniDumpNormal, MiniDumpWithThreadInfo, MiniDumpWriteDump, MINIDUMP_EXCEPTION_INFORMATION};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId};
    if let Some(path) = DUMP.get() {
        unsafe {
            let file = CreateFileW(path.as_ptr(), GENERIC_WRITE, 0, std::ptr::null(), CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut());
            if file != INVALID_HANDLE_VALUE {
                let exception = MINIDUMP_EXCEPTION_INFORMATION { ThreadId: GetCurrentThreadId(), ExceptionPointers: pointers as *mut _, ClientPointers: 0 };
                MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file, MiniDumpNormal | MiniDumpWithThreadInfo, &exception, std::ptr::null(), std::ptr::null());
                CloseHandle(file);
            }
        }
    }
    // EXCEPTION_CONTINUE_SEARCH: Windows carries on as it would have, reporting and ending it.
    0
}

/// What the last run left, once: a sentence for the notice, with the dump filed under a dated
/// name and only the newest `KEEP` kept. None when the last run ended normally.
pub fn last_run(dir: &Path) -> Option<String> {
    let marker = dir.join("crashed");
    let dump = dir.join("crash.dmp");
    let crashed = marker.exists() || dump.exists();
    if !crashed {
        return None;
    }
    let _ = std::fs::remove_file(&marker);
    if dump.exists() {
        let stamp = std::fs::metadata(&dump)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        let _ = std::fs::rename(&dump, dir.join(format!("crash-{stamp}.dmp")));
        let mut dumps: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|entries| entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("crash-") && n.ends_with(".dmp"))).collect())
            .unwrap_or_default();
        // Dated names sort in time order; the oldest go first.
        dumps.sort();
        while dumps.len() > KEEP {
            let _ = std::fs::remove_file(dumps.remove(0));
        }
    }
    Some(format!("umakbang closed unexpectedly last time. What happened was saved in {}.", dir.display()))
}
