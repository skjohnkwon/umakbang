//! Where umakbang keeps what it remembers, when it is not told (`portable.ts`).
//!
//! The shortcut used to pass both paths, which no installed app should need. Without them:
//!
//! - a folder called `data` beside the executable makes the copy **portable** - the library
//!   database and the profile both live in it, so a copy on a stick carries its library with
//!   it and leaves nothing on the machine it ran on;
//! - otherwise the profile is the one the Electron app kept (`%APPDATA%\umakbang`), since both
//!   read it, and the database sits in `%LOCALAPPDATA%\umakbang-native` where it always has.
//!
//! The `data` folder is made by the user, never shipped: an installer and a zip are the same
//! bytes, and a marker packed into the build would make an installed copy portable too.
//! One that cannot be written to falls back and says so - writing elsewhere in silence is the
//! exact confusion portable mode exists to end, and it looks identical to having worked.

use std::path::{Path, PathBuf};

pub struct Paths {
    pub db: PathBuf,
    pub profile: PathBuf,
    /// Why a `data` folder beside the executable was not used, for a notice.
    pub refused: Option<String>,
}

/// The `data` folder beside the running executable, if there is one. On a Mac the executable
/// is inside `umakbang.app/Contents/MacOS`, so "beside it" means beside the bundle - what the
/// user sees in Finder.
fn marker() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let beside = exe.parent()?;
    #[cfg(target_os = "macos")]
    let beside = if beside.ends_with("Contents/MacOS") { beside.parent().and_then(Path::parent).and_then(Path::parent).unwrap_or(beside) } else { beside };
    let dir = beside.join("data");
    dir.is_dir().then_some(dir)
}

/// The user's home folder.
pub fn home() -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from).unwrap_or_default()
}

/// Proven by writing a real file: Windows' access check on a folder means nothing.
fn writable(dir: &Path) -> bool {
    let probe = dir.join(".umakbang-write-test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

pub fn resolve() -> Paths {
    let mut refused = None;
    if let Some(dir) = marker() {
        if writable(&dir) {
            return Paths { db: dir.join("library.db"), profile: dir.join("umakbang-data.json"), refused: None };
        }
        refused = Some(format!("The data folder beside umakbang ({}) can't be written to, so this copy is keeping its library on this computer instead.", dir.display()));
    }
    #[cfg(windows)]
    let (roaming, local) = {
        let roaming = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| roaming.clone());
        (roaming, local)
    };
    // Electron's `userData` on a Mac is `~/Library/Application Support/umakbang`, so reading the
    // profile there carries every tag and rating over from the Electron app.
    #[cfg(not(windows))]
    let (roaming, local) = {
        let support = home().join("Library").join("Application Support");
        (support.clone(), support)
    };
    Paths { db: local.join("umakbang-native").join("library.db"), profile: roaming.join("umakbang").join("umakbang-data.json"), refused }
}

/// Whether this run keeps its data beside the executable: such a copy never registers to
/// start with Windows, since it would try to start from a stick that has gone home.
pub fn is_portable() -> bool {
    marker().is_some_and(|dir| writable(&dir))
}
