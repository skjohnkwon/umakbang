//! The OS's own pickers: `dialog.showOpenDialog` with `openDirectory`, as Electron opens it.

use std::path::{Path, PathBuf};
use windows::core::{HSTRING, Interface};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog, IShellItem, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};

/// A folder chosen in the system dialog, starting in `start` when it exists; None if
/// cancelled. Modal over `owner` (an HWND as an integer) when one is given.
pub fn pick_folder(title: &str, start: Option<&Path>, owner: Option<isize>) -> Option<PathBuf> {
    // SAFETY: COM calls on this thread, with every interface released by its drop.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let options = dialog.GetOptions().ok()?;
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        if let Some(start) = start.filter(|p| p.is_dir()) {
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start.as_os_str()), None) {
                let _ = dialog.SetFolder(&item);
            }
        }
        let hwnd = owner.map(|h| windows::Win32::Foundation::HWND(h as *mut core::ffi::c_void));
        dialog.Show(hwnd).ok()?;
        let item = dialog.GetResult().ok()?;
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(name.0 as *const core::ffi::c_void));
        let _ = dialog.cast::<IFileOpenDialog>();
        path.map(PathBuf::from)
    }
}

/// The file types a dialog offers, as `(name, "*.umak;*.json")`.
fn set_filters(dialog: &IFileDialog, filters: &[(&str, &str)]) {
    let names: Vec<HSTRING> = filters.iter().map(|(n, _)| HSTRING::from(*n)).collect();
    let specs: Vec<HSTRING> = filters.iter().map(|(_, s)| HSTRING::from(*s)).collect();
    let list: Vec<COMDLG_FILTERSPEC> = names.iter().zip(&specs).map(|(n, s)| COMDLG_FILTERSPEC { pszName: windows::core::PCWSTR(n.as_ptr()), pszSpec: windows::core::PCWSTR(s.as_ptr()) }).collect();
    // SAFETY: the strings outlive the call, which copies them.
    unsafe {
        let _ = dialog.SetFileTypes(&list);
    }
}

unsafe fn result_path(item: IShellItem) -> Option<PathBuf> {
    // SAFETY: the name is freed once, after it has been copied out.
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(name.0 as *const core::ffi::c_void));
        path.map(PathBuf::from)
    }
}

/// A file to open, of these types.
pub fn pick_file(title: &str, filters: &[(&str, &str)], start: Option<&Path>, owner: Option<isize>) -> Option<PathBuf> {
    // SAFETY: COM calls on this thread, with every interface released by its drop.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        set_filters(&dialog.cast::<IFileDialog>().ok()?, filters);
        if let Some(start) = start.filter(|p| p.is_dir()) {
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start.as_os_str()), None) {
                let _ = dialog.SetFolder(&item);
            }
        }
        let hwnd = owner.map(|h| windows::Win32::Foundation::HWND(h as *mut core::ffi::c_void));
        dialog.Show(hwnd).ok()?;
        result_path(dialog.GetResult().ok()?)
    }
}

/// Where to save, starting in `dir` with `name` filled in.
pub fn save_file(title: &str, dir: Option<&Path>, name: &str, filters: &[(&str, &str)], extension: &str, owner: Option<isize>) -> Option<PathBuf> {
    // SAFETY: as above.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        set_filters(&dialog.cast::<IFileDialog>().ok()?, filters);
        let _ = dialog.SetDefaultExtension(&HSTRING::from(extension));
        let _ = dialog.SetFileName(&HSTRING::from(name));
        if let Some(dir) = dir.filter(|p| p.is_dir()) {
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(dir.as_os_str()), None) {
                let _ = dialog.SetFolder(&item);
            }
        }
        let hwnd = owner.map(|h| windows::Win32::Foundation::HWND(h as *mut core::ffi::c_void));
        dialog.Show(hwnd).ok()?;
        result_path(dialog.GetResult().ok()?)
    }
}
