# Porting native umakbang to macOS

## Status (November 2026)

**The native app builds, tests and runs on macOS** (`cargo build --release` on a Mac; 45 of 45
tests pass, the protocol 4 tree hashes among them). Every row of the table below has a Mac side
now. The Windows build still type-checks from a Mac (see "Checking the Windows build" below).

How it is arranged: modules that were Windows from top to bottom have a Mac twin in
`native/src/mac/` (`clipboard.rs`, `dialogs.rs`, `tray.rs`, `dwrite.rs`), chosen in `main.rs` and
`ui/mod.rs` with `#[cfg_attr(target_os = "macos", path = ...)]`, so nothing that calls them
changes. Files with only a line or two of Windows in them carry a `cfg` at that spot.
`process::quiet` replaces each `creation_flags(CREATE_NO_WINDOW)`.

What else changed for the Mac, beyond the table:

- **The window keeps the system's frame**: a transparent title bar over our own (Electron's
  `titleBarStyle: 'hidden'`), so the traffic lights, rounded corners, shadow and resize edges
  are the system's. `screen::TRAFFIC_LIGHTS` leaves room for them; the drawn Windows caption
  buttons and the hand-rolled resize edges are off on a Mac.
- **Shortcuts use ⌘** where Windows uses Ctrl (`App::command_key`), and Cmd-click multi-selects.
  Ctrl-click is a right click. In text fields Option moves by word and ⌘ to the ends of the line,
  and Option types characters rather than being swallowed as a shortcut.
- **Cmd+Q saves**: AppKit ends the process itself, which winit reports only as `exiting`, so
  the app flushes its document there.
- **Fonts**: SF Pro, SF Mono and Arial, with Apple Symbols for the stars; family names are read
  from the files. Glyphs come from swash (grayscale), which is how macOS draws text anyway.
- **Profile**: `~/Library/Application Support/umakbang/umakbang-data.json`, where Electron kept
  it, and the database in `~/Library/Application Support/umakbang-native/library.db`. A `data`
  folder beside `umakbang.app` makes a copy portable.
- **Menu bar item** (`tray-icon`), a LaunchAgent for the login item
  (`~/Library/LaunchAgents/dev.umakbang.native.plist`), one copy per profile through a socket
  in `$TMPDIR`, and the Dock's reopen event brings a hidden window back.
- **Updates**: `umakbang-native-<version>-mac-arm64.zip` / `-mac-x64.zip`, checksum required as
  on Windows; the bundle inside must be signed by the same team as the running copy; "Restart
  to update" swaps the `.app` and reopens it, putting the old one back if the copy fails.
- **Packaging**: `native/tools/bundle-mac.sh` makes the `.app` (bundle id `dev.umakbang.app`,
  hardened runtime), the zip, its `.sha256` and a dmg. `.github/workflows/release.yml` has a
  `mac` job that builds both architectures after the Windows job and uploads into the same
  release. It signs when `MAC_CERT_P12` / `MAC_CERT_PASSWORD` are set and notarises when
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set too.

Not done yet:

- **`shell_icon.rs`** has no Mac source of file-type icons, so rows draw the app's own glyphs.
  `NSWorkspace.iconForContentType` is the call.
- **Moving the Electron Mac users across automatically will not work as described below.** The
  0.3.3 and 0.4.1 Mac releases are not Developer ID signed: they carry Electron's ad-hoc
  signature (`Identifier=Electron`, `TeamIdentifier=not set`), so their designated requirement
  is a hash of the Electron binary itself, and Squirrel.Mac will refuse any other bundle,
  signed or not. Those users need to download the dmg once.
- Not yet tried on Intel hardware, or against a real library.

### Checking the Windows build from a Mac

`cargo check --target x86_64-pc-windows-msvc` type-checks the Windows side, but three crates
compile C in their build scripts and there are no Windows headers on a Mac. For a check (not a
build) those objects are never linked, so a stand-in compiler that writes empty files is
enough: point `CC_x86_64_pc_windows_msvc` and `AR_x86_64_pc_windows_msvc` at two short scripts
that create whatever `-o` / `-out:` names.


For whoever builds the Mac version of the native app. Everything needed is in this repository;
nothing has been deleted to make room for the native app.

## Where things stand

- **The native app (`native/`) is umakbang from 0.5.0**, and it is Windows only. It is Rust:
  winit, softbuffer, taffy, cosmic-text, tiny-skia, rodio, rusqlite, tiny_http, ureq.
  `docs/native-rewrite.md` is the full design record.
- **The Electron app (`src/`) is the reference implementation and still builds for macOS.**
  `npm ci && npm run build && npx electron-builder --mac` works as it did for 0.4.1, and
  `.github/workflows/release-electron.yml` is the CI recipe, now run by hand only. Its mac job
  imports the signing certificate from the `MAC_CERT_P12` / `MAC_CERT_PASSWORD` secrets; read the
  comments in it and in `electron-builder.yml`'s `mac:` block before signing anything (an
  `Apple Development` identity has the right team and the wrong lineage, and installed copies
  refuse an update signed with it).
- **Mac users are on Electron 0.4.1.** The 0.5.0 release carries 0.4.1's `latest-mac.yml`, so
  their updater reports no update rather than an error. Uploading a new `latest-mac.yml` into
  a release is what offers them one.

## What already works on a Mac

Most of the app is plain Rust and the crates are cross-platform: the library database and its
schema and triggers (`library.rs`), scanning and probing (`scan.rs`, `probe.rs`, `flp.rs`),
tempo and key analysis (`analysis.rs`, `essentia_key.rs`), playback (rodio over CoreAudio), the
tailnet server and protocol 4 (`server.rs`), the remote client (`remote.rs`), the folder and
library watches (notify uses FSEvents), backups and `.umak` bundles, contracts and PDF output,
the whole UI layer (`ui/`, `table.rs`, `screen.rs`), trash (`trash`), the text clipboard
(`arboard`) and drag out (`drag`, which supports macOS).

`build.rs` already skips its Windows resource step on other targets.

## What is Windows only, file by file

| File | Windows piece | Mac replacement |
| --- | --- | --- |
| `Cargo.toml` | `windows` and `windows-sys` are unconditional | move them under `[target.'cfg(windows)'.dependencies]` |
| `main.rs` | `windows_subsystem` attribute | harmless off Windows (it is ignored) |
| `ui/dwrite.rs` | DirectWrite for system fonts and fallback | cosmic-text's own `fontdb` system font loading |
| `dialogs.rs` | `IFileDialog` folder and file pickers | `rfd` (NSOpenPanel / NSSavePanel) |
| `tray.rs` | `Shell_NotifyIcon` tray and its menu, HKCU Run login item, single instance | `tray-icon` + `muda` for the menu bar item; login item via `SMAppService` or a LaunchAgent (`auto-launch` crate); single instance via a lock file; handle the Dock reopen event |
| `clipboard.rs` | `CF_HDROP` file copy and paste | NSPasteboard file URLs (`objc2-app-kit`) |
| `shell_icon.rs` | `SHGetFileInfoW` file type icons | `NSWorkspace.iconForFile` |
| `localtime.rs` | `SystemTimeToTzSpecificLocalTime` | `libc::localtime_r`, or the `time` crate |
| `files.rs` | Downloads folder via `SHGetKnownFolderPath` | `dirs::download_dir()` |
| `crash.rs` | minidumps via `SetUnhandledExceptionFilter` | keep the panic hook; macOS writes native crash reports to `~/Library/Logs/DiagnosticReports` |
| `portable.rs` | `%APPDATA%\umakbang` profile, `%LOCALAPPDATA%\umakbang-native` database | `~/Library/Application Support/umakbang` is where Electron kept `umakbang-data.json` on a Mac, so reading it there carries every tag and rating over; put the database in `~/Library/Application Support/umakbang-native` |
| `updater.rs` | self-install, Start menu shortcuts, Apps entry, copy-over-exe update | see Releases below |
| `app.rs` | `explorer.exe` to open and reveal | `open` and `open -R` |
| `analysis.rs`, `fl_plugins.rs`, `tailscale.rs`, `youtube.rs` | `CommandExt::creation_flags(CREATE_NO_WINDOW)` | not needed; put it behind `#[cfg(windows)]` |
| `tailscale.rs` | `C:\Program Files\Tailscale\tailscale.exe` | `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, or `tailscale` on the PATH |
| `youtube.rs` | downloads `yt-dlp.exe` | the `yt-dlp_macos` release asset, made executable |
| `fl_plugins.rs` | FL Studio's plugin database location on Windows | check where FL Studio for Mac keeps it before writing anything; test on a copy |

The suggested shape is a `platform` module with `windows.rs` and `macos.rs` behind the same
function signatures, so the rest of the app never says `cfg`. Get `cargo check` passing on a Mac
first, then work through the table.

## Releases

`.github/workflows/release.yml` builds the Windows app from a `v<version>` tag that matches
`native/Cargo.toml`, names it `umakbang-native-<version>-win-x64.exe` with a `.sha256` beside it,
adds a `umakbang-setup-...` copy for first installs, and takes the notes from
`native/assets/changelog.json`. A Mac job belongs beside the `windows` one and should upload
into the same release:

- **Bundle and sign.** A `.app` bundle (`Info.plist`, the `.icns` made from `build/icon.png`),
  signed with the Developer ID Application identity, then notarised and stapled. Shipped as a
  zip (for updates) and a dmg (for first installs).
- **Names the updater can find.** `updater.rs` currently looks for `win-x64.exe`; pick the asset
  by platform, for example `umakbang-native-<version>-mac-arm64.zip` and `-mac-x64.zip` (or one
  universal build), each with a `.sha256`. Nothing unverified may be installed: keep the
  checksum rule.
- **Applying an update** on a Mac means replacing the `.app` bundle: unzip beside it, verify the
  signature, swap the bundle, relaunch.
- **Moving the Electron Mac users across.** Electron's updater on a Mac (Squirrel.Mac) installs a
  zipped `.app` named in `latest-mac.yml`, provided it is signed by the same team and satisfies
  the installed copy's designated requirement. If the native bundle keeps the bundle id
  `dev.umakbang.app` and is signed with the same Developer ID, publishing a `latest-mac.yml`
  that points at its zip should carry those installs over to the native app with no manual
  step. Test this against a copy of 0.4.1 before releasing it.
- **Uploading Mac assets into an existing release** (for example a Mac 0.5.0 after the Windows
  one): run the workflow by hand against the tag; the Windows job re-uploads its assets with
  `--clobber`, which is harmless because the checksums go up with them, but it can be skipped
  with an `if:` if that is unwanted.

## Testing

Test against copies of the data only, never a real profile: launch with explicit paths
(`umakbang-native <library.db> <umakbang-data.json>`) or with a `data` folder beside the binary
(portable). With no paths and no `data` folder the app uses the real profile.
`cargo test` runs the unit tests, including the protocol 4 tree hash tests, which are platform
independent and must pass unchanged, since the phone and other machines compare hashes.
