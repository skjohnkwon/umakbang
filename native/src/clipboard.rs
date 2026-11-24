//! Files on the system clipboard, as Explorer puts them there: `CF_HDROP`, which is what
//! Discord, a browser or a folder reads a paste from (`clipboard-files.ts`). The paths go on
//! as text in the same open/close, so one copy is both - two separate writes race, and
//! whichever lands last owns the clipboard.
//!
//! Only a copy is mirrored, never a cut: Windows tells the two apart with a drop-effect flag,
//! and a cut that pasted as a copy would leave the original where it was.

use std::path::PathBuf;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData};
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows_sys::Win32::UI::Shell::{DROPFILES, DragQueryFileW, HDROP};

const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;

fn global(bytes: &[u8]) -> Option<HANDLE> {
    // SAFETY: a fresh movable block, filled while locked and handed to the clipboard, which
    // then owns it.
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if handle.is_null() {
            return None;
        }
        let at = GlobalLock(handle) as *mut u8;
        if at.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), at, bytes.len());
        GlobalUnlock(handle);
        Some(handle)
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Puts `paths` on the clipboard as files and as their paths in text.
pub fn write_files(paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    // DROPFILES, then each path NUL-terminated, then one more NUL.
    let mut list: Vec<u16> = Vec::new();
    for path in paths {
        list.extend(wide(&path.to_string_lossy()));
    }
    list.push(0);
    let header = DROPFILES { pFiles: std::mem::size_of::<DROPFILES>() as u32, pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 }, fNC: 0, fWide: 1 };
    let mut drop_bytes = Vec::with_capacity(std::mem::size_of::<DROPFILES>() + list.len() * 2);
    // SAFETY: DROPFILES is plain data; its bytes are copied as they are laid out.
    drop_bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, std::mem::size_of::<DROPFILES>()) });
    for unit in &list {
        drop_bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let text: String = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join("\r\n");
    let text_bytes: Vec<u8> = wide(&text).iter().flat_map(|u| u.to_le_bytes()).collect();
    // SAFETY: the clipboard is opened, filled and closed on this thread.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }
        EmptyClipboard();
        let mut ok = false;
        if let Some(handle) = global(&drop_bytes) {
            ok = !SetClipboardData(CF_HDROP, handle).is_null();
        }
        if let Some(handle) = global(&text_bytes) {
            SetClipboardData(CF_UNICODETEXT, handle);
        }
        CloseClipboard();
        ok
    }
}

/// Files on the clipboard, if something put files there - Explorer's Copy, or ours.
pub fn read_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // SAFETY: read-only use of the clipboard's HDROP, while it is open.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 || OpenClipboard(std::ptr::null_mut()) == 0 {
            return out;
        }
        let handle = GetClipboardData(CF_HDROP) as HDROP;
        if !handle.is_null() {
            let count = DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0);
            for i in 0..count {
                let len = DragQueryFileW(handle, i, std::ptr::null_mut(), 0) as usize;
                let mut buffer = vec![0u16; len + 1];
                DragQueryFileW(handle, i, buffer.as_mut_ptr(), buffer.len() as u32);
                out.push(PathBuf::from(String::from_utf16_lossy(&buffer[..len])));
            }
        }
        CloseClipboard();
    }
    out
}
