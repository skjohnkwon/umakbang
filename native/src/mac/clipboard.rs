//! Files on the Mac pasteboard, as Finder puts them there: file URLs, which Finder, a browser
//! or Discord reads a paste from, plus the paths as text in the same write so one copy is
//! both. Same signatures as the Windows `clipboard.rs`.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
use objc2::ClassType;
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString, NSPasteboardURLReadingFileURLsOnlyKey, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
use std::path::PathBuf;

/// Puts `paths` on the pasteboard as files and as their paths in text.
pub fn write_files(paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let urls: Vec<Retained<NSURL>> = paths.iter().filter_map(|p| NSURL::from_file_path(p)).collect();
    if urls.is_empty() {
        return false;
    }
    let text: String = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join("\n");
    let board = NSPasteboard::generalPasteboard();
    board.clearContents();
    let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = urls.into_iter().map(ProtocolObject::from_retained).collect();
    let ok = board.writeObjects(&NSArray::from_retained_slice(&objects));
    // SAFETY: a constant AppKit owns.
    unsafe { board.setString_forType(&NSString::from_str(&text), NSPasteboardTypeString) };
    ok
}

/// Files on the pasteboard, if something put files there - Finder's Copy, or ours.
pub fn read_files() -> Vec<PathBuf> {
    let board = NSPasteboard::generalPasteboard();
    let class: &AnyClass = NSURL::class();
    let classes = NSArray::from_slice(&[class]);
    // SAFETY: a constant AppKit owns, as a key in a dictionary that lives for the call.
    let key: &NSString = unsafe { NSPasteboardURLReadingFileURLsOnlyKey };
    let yes = NSNumber::new_bool(true);
    let options: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[key], &[&*yes as &AnyObject]);
    // SAFETY: asking only for NSURL, so every object that comes back is one.
    let Some(objects) = (unsafe { board.readObjectsForClasses_options(&classes, Some(&options)) }) else { return Vec::new() };
    let mut out = Vec::new();
    for object in objects.iter() {
        if let Ok(url) = object.downcast::<NSURL>() {
            if let Some(path) = url.to_file_path() {
                out.push(path);
            }
        }
    }
    out
}
