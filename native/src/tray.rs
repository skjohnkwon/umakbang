//! Running in the background (`background.ts`): the tray icon and its menu, the login item, and
//! the one-copy-at-a-time rule that lets a second launch bring the first back instead.
//!
//! The tray is the only thing on screen saying a process is serving, and its menu the only way to
//! quit, so it lives on a thread of its own with its own window and message loop: it answers
//! while the main window is hidden, and while the main window is busy.

// The window procedure is a Win32 callback end to end; every line of it is a system call.
#![allow(unsafe_op_in_unsafe_fn)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, Debug)]
pub enum Event {
    Open,
    BackgroundOff,
    Quit,
    /// "Restart to update": an app resident from boot to boot may not quit for weeks, so a
    /// staged update is offered here rather than waiting for one.
    RestartToUpdate,
}

const CALLBACK: u32 = WM_APP + 1;
const REFRESH: u32 = WM_APP + 2;
const BALLOON: u32 = WM_APP + 3;
const CLOSE: u32 = WM_APP + 4;
const TIMER: usize = 1;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn copy_into(dst: &mut [u16], s: &str) {
    let units: Vec<u16> = s.encode_utf16().take(dst.len() - 1).collect();
    dst[..units.len()].copy_from_slice(&units);
    dst[units.len()] = 0;
}

/// The app icon at `size` pixels, from `build/icon.ico`'s own bitmap of that size.
pub fn icon(size: i32) -> HICON {
    let data: &[u8] = include_bytes!("../assets/icon.ico");
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    let mut best: Option<(i32, usize, usize)> = None;
    for i in 0..count {
        let entry = &data[6 + 16 * i..22 + 16 * i];
        let w = if entry[0] == 0 { 256 } else { entry[0] as i32 };
        let len = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
        let off = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
        // The smallest that is not smaller than asked for.
        if w >= size && best.is_none_or(|(bw, _, _)| w < bw) {
            best = Some((w, off, len));
        }
    }
    let Some((_, off, len)) = best else { return std::ptr::null_mut() };
    unsafe { CreateIconFromResourceEx(data[off..off + len].as_ptr(), len as u32, 1, 0x0003_0000, size, size, LR_DEFAULTCOLOR) }
}

/// Gives a window the app's icon, in the title bar and on the taskbar.
pub fn set_window_icon(hwnd: isize) {
    unsafe {
        let (small, big) = (GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CXICON));
        SendMessageW(hwnd as HWND, WM_SETICON, ICON_SMALL as WPARAM, icon(small) as LPARAM);
        SendMessageW(hwnd as HWND, WM_SETICON, ICON_BIG as WPARAM, icon(big) as LPARAM);
    }
}

struct Shared {
    on: Box<dyn Fn(Event) + Send>,
    /// The line the menu and the tooltip say about the server.
    status: Arc<Mutex<String>>,
    window_open: Arc<AtomicBool>,
    taskbar_created: u32,
}

pub struct Tray {
    hwnd: isize,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Tray {
    /// The tooltip and menu read the status again.
    pub fn refresh(&self) {
        unsafe { PostMessageW(self.hwnd as HWND, REFRESH, 0, 0) };
    }

    /// Once a session, on the first close: the window went, the app did not.
    pub fn balloon(&self) {
        unsafe { PostMessageW(self.hwnd as HWND, BALLOON, 0, 0) };
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        unsafe { PostMessageW(self.hwnd as HWND, CLOSE, 0, 0) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn notify_data(hwnd: HWND) -> NOTIFYICONDATAW {
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd;
    data.uID = 1;
    data
}

fn add(hwnd: HWND, status: &str) {
    let mut data = notify_data(hwnd);
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    data.uCallbackMessage = CALLBACK;
    data.hIcon = icon(unsafe { GetSystemMetrics(SM_CXSMICON) });
    copy_into(&mut data.szTip, &format!("umakbang - {status}"));
    unsafe { Shell_NotifyIconW(NIM_ADD, &data) };
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let shared = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Shared;
    if shared.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let shared = &*shared;
    let status = || shared.status.lock().map(|s| s.clone()).unwrap_or_default();
    match msg {
        CALLBACK => match (lparam as u32) & 0xFFFF {
            WM_LBUTTONUP => (shared.on)(Event::Open),
            WM_RBUTTONUP | WM_CONTEXTMENU => {
                let menu = CreatePopupMenu();
                let open = wide(if shared.window_open.load(Ordering::Relaxed) { "Show umakbang" } else { "Open umakbang" });
                let line = wide(&status());
                let background = wide("Run in the background (starts with Windows)");
                let quit = wide("Quit umakbang");
                AppendMenuW(menu, MF_STRING, 1, open.as_ptr());
                AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
                AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, line.as_ptr());
                AppendMenuW(menu, MF_STRING | MF_CHECKED, 2, background.as_ptr());
                let update = crate::updater::staged_version().map(|v| wide(&format!("Restart to update to {v}")));
                if let Some(update) = &update {
                    AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
                    AppendMenuW(menu, MF_STRING, 4, update.as_ptr());
                }
                AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
                AppendMenuW(menu, MF_STRING, 3, quit.as_ptr());
                let mut at = POINT { x: 0, y: 0 };
                GetCursorPos(&mut at);
                // Without this the menu never closes when clicked away from.
                SetForegroundWindow(hwnd);
                let chosen = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, at.x, at.y, 0, hwnd, std::ptr::null());
                PostMessageW(hwnd, WM_NULL, 0, 0);
                DestroyMenu(menu);
                match chosen {
                    1 => (shared.on)(Event::Open),
                    2 => (shared.on)(Event::BackgroundOff),
                    3 => (shared.on)(Event::Quit),
                    4 => (shared.on)(Event::RestartToUpdate),
                    _ => {}
                }
            }
            _ => {}
        },
        REFRESH | WM_TIMER => {
            let mut data = notify_data(hwnd);
            data.uFlags = NIF_TIP;
            copy_into(&mut data.szTip, &format!("umakbang - {}", status()));
            Shell_NotifyIconW(NIM_MODIFY, &data);
        }
        BALLOON => {
            let mut data = notify_data(hwnd);
            data.uFlags = NIF_INFO;
            data.dwInfoFlags = NIIF_INFO;
            copy_into(&mut data.szInfoTitle, "umakbang is still running");
            copy_into(&mut data.szInfo, "It keeps serving your library from here. Right-click the icon to quit.");
            Shell_NotifyIconW(NIM_MODIFY, &data);
        }
        CLOSE => {
            let data = notify_data(hwnd);
            Shell_NotifyIconW(NIM_DELETE, &data);
            DestroyWindow(hwnd);
        }
        WM_DESTROY => PostQuitMessage(0),
        // Explorer restarted and took every tray icon with it.
        m if m == shared.taskbar_created => add(hwnd, &status()),
        _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
    }
    0
}

pub fn show(status: Arc<Mutex<String>>, window_open: Arc<AtomicBool>, on: impl Fn(Event) + Send + 'static) -> Option<Tray> {
    let (tx, rx) = std::sync::mpsc::channel::<isize>();
    let thread = std::thread::Builder::new()
        .name("tray".into())
        .spawn(move || unsafe {
            let class = wide("umakbang-native-tray");
            let instance = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(proc);
            wc.hInstance = instance;
            wc.lpszClassName = class.as_ptr();
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null());
            if hwnd.is_null() {
                let _ = tx.send(0);
                return;
            }
            let first = status.lock().map(|s| s.clone()).unwrap_or_default();
            let shared = Box::new(Shared { on: Box::new(on), status, window_open, taskbar_created: RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()) });
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(shared) as isize);
            add(hwnd, &first);
            SetTimer(hwnd, TIMER, 15_000, None);
            let _ = tx.send(hwnd as isize);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let held = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Shared;
            if !held.is_null() {
                drop(Box::from_raw(held));
            }
        })
        .ok()?;
    let hwnd = rx.recv().ok().filter(|&h| h != 0)?;
    Some(Tray { hwnd, thread: Some(thread) })
}

/* ------------------------------------------------------------------ the login item */

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// The official app's entry. Never the Electron app's (`electron.app.umakbang`), which the
/// cutover removes by hand; and the name the port used while it ran beside Electron is taken
/// down whenever this one is written, so the two cannot both start the app.
const LOGIN_NAME: &str = "umakbang";
const PORT_LOGIN_NAME: &str = "umakbang (native)";

pub fn login_item_present() -> bool {
    use windows_sys::Win32::System::Registry::*;
    let key = wide(RUN_KEY);
    [LOGIN_NAME, PORT_LOGIN_NAME].iter().any(|n| {
        let name = wide(n);
        let mut size = 0u32;
        unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) == 0 }
    })
}

/// Starts with Windows, windowless (`--background`), or no longer does. It names the exe's own
/// path, so it is written again from wherever this copy runs.
pub fn set_login_item(on: bool, args: &[String]) {
    use windows_sys::Win32::System::Registry::*;
    let (key, name) = (wide(RUN_KEY), wide(LOGIN_NAME));
    unsafe {
        RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), wide(PORT_LOGIN_NAME).as_ptr());
        if !on {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr());
            return;
        }
        let Ok(exe) = std::env::current_exe() else { return };
        let mut command = format!("\"{}\"", exe.display());
        for arg in args {
            command.push_str(&format!(" \"{arg}\""));
        }
        command.push_str(" --background");
        let value = wide(&command);
        let mut handle: HKEY = std::ptr::null_mut();
        if RegCreateKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut handle, std::ptr::null_mut()) == 0 {
            RegSetValueExW(handle, name.as_ptr(), 0, REG_SZ, value.as_ptr() as *const u8, (value.len() * 2) as u32);
            RegCloseKey(handle);
        }
    }
}

/* ------------------------------------------------------------------ one copy at a time */

/// Whether this is the only copy running on this profile. When it is not, the first copy is
/// asked to show its window and this one should leave. Keyed by the profile's path, so a test
/// copy on a scratch profile never finds - or wakes - the real one.
pub fn single_instance(profile: &std::path::Path, show: impl Fn() + Send + 'static) -> bool {
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject, INFINITE};
    use sha1::{Digest, Sha1};
    let key: String = Sha1::digest(profile.to_string_lossy().to_lowercase().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let name = wide(&format!("Local\\umakbang-native-{key}"));
    unsafe {
        let event = CreateEventW(std::ptr::null(), 0, 0, name.as_ptr());
        if event.is_null() {
            return true;
        }
        if windows_sys::Win32::Foundation::GetLastError() == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS {
            SetEvent(event);
            return false;
        }
        let handle = event as isize;
        std::thread::Builder::new()
            .name("instance".into())
            .spawn(move || loop {
                if WaitForSingleObject(handle as _, INFINITE) != 0 {
                    return;
                }
                show();
            })
            .ok();
        true
    }
}
