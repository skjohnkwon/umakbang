//! Running in the background on a Mac: the menu bar item and its menu, the login item, and the
//! one-copy-at-a-time rule. Same signatures as the Windows `tray.rs`.
//!
//! AppKit wants its status item made and changed on the main thread, which is where the app
//! calls `show` and `refresh` from (winit's event loop). Menu choices arrive on that thread too
//! and are handed to `on`, which forwards them to the event loop like the Windows tray does.
//!
//! A second launch from Finder or the Dock never starts a second process on a Mac - Launch
//! Services activates the running one - so "bring the window back" is the Dock's reopen event,
//! handled below, as well as the socket a copy started from a terminal knocks on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIcon, TrayIconBuilder};

#[derive(Clone, Copy, Debug)]
pub enum Event {
    Open,
    BackgroundOff,
    Quit,
    /// "Restart to update", offered here as on Windows.
    RestartToUpdate,
}

/// Nothing to do on a Mac: the Dock and the app switcher take their icon from the bundle.
#[allow(dead_code)]
pub fn set_window_icon(_hwnd: isize) {}

/// The app icon as straight RGBA at `size` pixels, from `build/icon.png`.
fn icon_rgba(size: u32) -> Option<(Vec<u8>, u32)> {
    let source = resvg::tiny_skia::Pixmap::decode_png(include_bytes!("../../../build/icon.png")).ok()?;
    let small = crate::shell_icon::resized(&source, size)?;
    let mut rgba = small.data().to_vec();
    // tiny-skia keeps premultiplied alpha; the status item wants it straight.
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    Some((rgba, size))
}

pub struct Tray {
    icon: TrayIcon,
    open: MenuItem,
    status_line: MenuItem,
    update: MenuItem,
    update_separator: PredefinedMenuItem,
    menu: Menu,
    update_shown: bool,
    status: Arc<Mutex<String>>,
    window_open: Arc<AtomicBool>,
}

impl Tray {
    /// The tooltip and menu read the status again.
    pub fn refresh(&self) {
        let status = self.status.lock().map(|s| s.clone()).unwrap_or_default();
        let _ = self.icon.set_tooltip(Some(format!("umakbang - {status}")));
        self.status_line.set_text(&status);
        self.open.set_text(if self.window_open.load(Ordering::Relaxed) { "Show umakbang" } else { "Open umakbang" });
        // `refresh` takes `&self`; the update item is shown by enabling it and naming the
        // version, and hidden by disabling it when there is none.
        match crate::updater::staged_version() {
            Some(v) => {
                self.update.set_text(format!("Restart to update to {v}"));
                self.update.set_enabled(true);
            }
            None => {
                self.update.set_text("No update waiting");
                self.update.set_enabled(false);
            }
        }
        let _ = (&self.menu, &self.update_separator, self.update_shown);
    }

    /// Once a session, on the first close. Nothing to say on a Mac: an app that keeps running
    /// after its window closes is what every Mac app does, and the menu bar item is right there.
    pub fn balloon(&self) {}
}

/// Where menu choices go. The handler muda calls must be `Send + Sync`, and there is one per
/// process, so the current tray's callback lives here.
static ON: OnceLock<Mutex<Option<Box<dyn Fn(Event) + Send>>>> = OnceLock::new();

pub fn show(status: Arc<Mutex<String>>, window_open: Arc<AtomicBool>, on: impl Fn(Event) + Send + 'static) -> Option<Tray> {
    let first = status.lock().map(|s| s.clone()).unwrap_or_default();
    let open = MenuItem::with_id("open", if window_open.load(Ordering::Relaxed) { "Show umakbang" } else { "Open umakbang" }, true, None);
    let status_line = MenuItem::with_id("status", &first, false, None);
    let background = CheckMenuItem::with_id("background", "Run in the background (opens at login)", true, true, None);
    let update = MenuItem::with_id("update", "No update waiting", false, None);
    let update_separator = PredefinedMenuItem::separator();
    let quit = MenuItem::with_id("quit", "Quit umakbang", true, None);
    let menu = Menu::new();
    menu.append_items(&[&open, &PredefinedMenuItem::separator(), &status_line, &background, &update_separator, &update, &PredefinedMenuItem::separator(), &quit]).ok()?;

    let cell = ON.get_or_init(|| Mutex::new(None));
    if let Ok(mut slot) = cell.lock() {
        *slot = Some(Box::new(on));
    }
    MenuEvent::set_event_handler(Some(|event: MenuEvent| {
        let chosen = match event.id().as_ref() {
            "open" => Event::Open,
            "background" => Event::BackgroundOff,
            "quit" => Event::Quit,
            "update" => Event::RestartToUpdate,
            _ => return,
        };
        if let Some(Ok(slot)) = ON.get().map(|c| c.lock()) {
            if let Some(on) = slot.as_ref() {
                on(chosen);
            }
        }
    }));

    let (rgba, size) = icon_rgba(44)?;
    let icon = TrayIconBuilder::new()
        .with_menu(Box::new(menu.clone()))
        .with_tooltip(format!("umakbang - {first}"))
        .with_icon(tray_icon::Icon::from_rgba(rgba, size, size).ok()?)
        .build()
        .ok()?;
    let tray = Tray { icon, open, status_line, update, update_separator, menu, update_shown: false, status, window_open };
    tray.refresh();
    Some(tray)
}

impl Drop for Tray {
    fn drop(&mut self) {
        if let Some(Ok(mut slot)) = ON.get().map(|c| c.lock()) {
            *slot = None;
        }
    }
}

/* ------------------------------------------------------------------ the login item */

/// A per-user LaunchAgent: launchd starts the app at login, windowless (`--background`). It
/// names the executable's own path, so it is written again from wherever this copy runs.
const AGENT_LABEL: &str = "dev.umakbang.native";

fn agent_path() -> std::path::PathBuf {
    crate::portable::home().join("Library").join("LaunchAgents").join(format!("{AGENT_LABEL}.plist"))
}

pub fn login_item_present() -> bool {
    agent_path().exists()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn set_login_item(on: bool, args: &[String]) {
    let path = agent_path();
    if !on {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let mut program = vec![exe.to_string_lossy().into_owned()];
    program.extend(args.iter().cloned());
    program.push("--background".into());
    let arguments: String = program.iter().map(|a| format!("\t\t<string>{}</string>\n", xml_escape(a))).collect();
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
{arguments}	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
"#
    );
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, plist);
}

/* ------------------------------------------------------------------ one copy at a time */

static SHOW: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Whether this is the only copy running on this profile. When it is not, the first copy is
/// asked to show its window and this one should leave. Keyed by the profile's path, so a test
/// copy on a scratch profile never finds - or wakes - the real one.
pub fn single_instance(profile: &std::path::Path, show: impl Fn() + Send + 'static) -> bool {
    use sha1::{Digest, Sha1};
    use std::io::Write;
    use std::os::unix::net::{UnixListener, UnixStream};
    let key: String = Sha1::digest(profile.to_string_lossy().to_lowercase().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    // $TMPDIR is per user on a Mac, and short enough for a socket path.
    let socket = std::env::temp_dir().join(format!("umakbang-native-{key}.sock"));
    if let Ok(mut stream) = UnixStream::connect(&socket) {
        let _ = stream.write_all(b"show\n");
        return false;
    }
    // Nobody answered: whatever is there was left by a copy that has gone.
    let _ = std::fs::remove_file(&socket);
    let show: Arc<dyn Fn() + Send + Sync> = {
        let show = Mutex::new(show);
        Arc::new(move || {
            if let Ok(show) = show.lock() {
                show();
            }
        })
    };
    if let Ok(listener) = UnixListener::bind(&socket) {
        let knock = show.clone();
        std::thread::Builder::new()
            .name("instance".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    if stream.is_ok() {
                        knock();
                    }
                }
            })
            .ok();
    }
    let _ = SHOW.set(Box::new(move || show()));
    install_reopen_handler();
    true
}

/// Clicking the Dock icon, or opening the app again from Finder, while the window is hidden:
/// AppKit asks the application delegate `applicationShouldHandleReopen:hasVisibleWindows:`.
/// winit's delegate does not answer it, so the method is added to its class here.
fn install_reopen_handler() {
    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    extern "C-unwind" fn reopen(_this: &AnyObject, _cmd: Sel, _app: &AnyObject, visible: Bool) -> Bool {
        if !visible.as_bool() {
            if let Some(show) = SHOW.get() {
                show();
            }
        }
        Bool::YES
    }

    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else { return };
    let object: &AnyObject = AsRef::<AnyObject>::as_ref(&*delegate);
    let class: &AnyClass = object.class();
    let imp: unsafe extern "C-unwind" fn() = unsafe { std::mem::transmute(reopen as extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, Bool) -> Bool) };
    // SAFETY: the types string matches the function: BOOL return, self, _cmd, an object, a BOOL.
    unsafe {
        objc2::ffi::class_addMethod(class as *const AnyClass as *mut AnyClass, sel!(applicationShouldHandleReopen:hasVisibleWindows:), imp, c"c@:@c".as_ptr());
    }
}

/* ------------------------------------------------------------------ Cmd+Q and the Dock */

static QUIT_KEY: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Cmd+Q, and Quit in the app menu, hand over to `on` instead of ending the process: running
/// in the background they close the window into the menu bar and the server carries on, as the
/// window's X does on Windows. Quitting for good is the menu bar item's Quit.
///
/// Only the menu item is redirected. The Dock's Quit, logging out and shutting down ask the app
/// to terminate by Apple Event, not through the menu, and still end it.
///
/// winit makes the app menu as the app finishes launching, so this is called after that.
pub fn intercept_quit(on: impl Fn() + Send + Sync + 'static) {
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    extern "C-unwind" fn quit_key(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
        if let Some(on) = QUIT_KEY.get() {
            on();
        }
    }

    if QUIT_KEY.set(Box::new(on)).is_err() {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else { return };
    let object: &AnyObject = AsRef::<AnyObject>::as_ref(&*delegate);
    let class: &AnyClass = object.class();
    let imp: unsafe extern "C-unwind" fn() = unsafe { std::mem::transmute(quit_key as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject)) };
    // SAFETY: the types string matches the function: void return, self, _cmd, the sender.
    unsafe {
        objc2::ffi::class_addMethod(class as *const AnyClass as *mut AnyClass, sel!(umakbangQuitKey:), imp, c"v@:@".as_ptr());
    }
    let Some(menu) = app.mainMenu() else { return };
    for i in 0..menu.numberOfItems() {
        let Some(submenu) = menu.itemAtIndex(i).and_then(|item| item.submenu()) else { continue };
        for j in 0..submenu.numberOfItems() {
            let Some(entry) = submenu.itemAtIndex(j) else { continue };
            if entry.action() == Some(sel!(terminate:)) {
                // SAFETY: the delegate outlives the menu (it lives as long as the app), and it
                // answers the selector, added above.
                unsafe {
                    entry.setTarget(Some(object));
                    entry.setAction(Some(sel!(umakbangQuitKey:)));
                }
            }
        }
    }
}

/// In the Dock and the app switcher, or only in the menu bar. With its window closed into the
/// background the app is the menu bar item and nothing else, as the Electron app was; showing
/// the window again brings the Dock icon back and the app to the front.
pub fn set_in_dock(on: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(if on { NSApplicationActivationPolicy::Regular } else { NSApplicationActivationPolicy::Accessory });
    if on {
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    }
}
