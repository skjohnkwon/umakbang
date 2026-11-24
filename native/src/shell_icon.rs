//! The icon Windows shows for a file type - FL Studio's logo for `.flp`, the default player's for
//! `.wav` - as the Electron app gets it from `app.getFileIcon`. Asked once per extension; the
//! table draws hundreds of rows and a handful of types.

use resvg::tiny_skia::Pixmap;
use std::collections::HashMap;

#[derive(Default)]
pub struct ShellIcons {
    by_ext: HashMap<String, Option<Pixmap>>,
}

impl ShellIcons {
    pub fn get(&mut self, ext: &str) -> Option<&Pixmap> {
        self.by_ext.entry(ext.to_lowercase()).or_insert_with(|| load(ext)).as_ref()
    }
}

#[cfg(windows)]
fn load(ext: &str) -> Option<Pixmap> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows_sys::Win32::UI::Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES, SHGetFileInfoW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    // By extension alone (`USEFILEATTRIBUTES`): no file is touched, so this costs a registry
    // lookup rather than a disk read per row.
    let name: Vec<u16> = format!("x.{ext}").encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mut info: SHFILEINFOW = zeroed();
        let ok = SHGetFileInfoW(
            name.as_ptr(),
            FILE_ATTRIBUTE_NORMAL,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
        );
        if ok == 0 || info.hIcon.is_null() {
            return None;
        }
        let mut icon: ICONINFO = zeroed();
        if GetIconInfo(info.hIcon, &mut icon) == 0 {
            DestroyIcon(info.hIcon);
            return None;
        }
        // The 32px icon, as `app.getFileIcon(path, { size: 'normal' })` asks for: for some types
        // (.mp3 here) the 16px icon is a different drawing, not just a smaller one.
        let size = 32i32;
        let mut header: BITMAPINFO = zeroed();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..zeroed()
        };
        let mut bgra = vec![0u8; (size * size * 4) as usize];
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        let lines = GetDIBits(dc, icon.hbmColor, 0, size as u32, bgra.as_mut_ptr().cast(), &mut header, DIB_RGB_COLORS);
        // The AND mask, expanded to 32 bits: white where the icon is transparent.
        let mut mask = vec![0u8; (size * size * 4) as usize];
        let masked = GetDIBits(dc, icon.hbmMask, 0, size as u32, mask.as_mut_ptr().cast(), &mut header, DIB_RGB_COLORS) != 0;
        DeleteDC(dc);
        DeleteObject(icon.hbmColor);
        DeleteObject(icon.hbmMask);
        DestroyIcon(info.hIcon);
        if lines == 0 {
            return None;
        }
        // Icons without an alpha channel carry their transparency in the mask instead; reading
        // them as opaque drew their black background as a dark ring round FL Studio's logo.
        let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
        let mut pixmap = Pixmap::new(size as u32, size as u32)?;
        for ((dst, src), m) in pixmap.data_mut().chunks_exact_mut(4).zip(bgra.chunks_exact(4)).zip(mask.chunks_exact(4)) {
            let a = if has_alpha { src[3] as u32 } else if masked && m[0] > 127 { 0 } else { 255 };
            // GDI hands back straight alpha; tiny-skia wants premultiplied.
            dst[0] = (src[2] as u32 * a / 255) as u8;
            dst[1] = (src[1] as u32 * a / 255) as u8;
            dst[2] = (src[0] as u32 * a / 255) as u8;
            dst[3] = a as u8;
        }
        Some(pixmap)
    }
}

/// The icon at `size` px, shrunk the way Chromium shrinks an `<img>`: from the smallest mipmap
/// level still at least as large (each level a 2x2 box average of the one above), then bilinear
/// to the final size. Straight bicubic from 32 to 14 drew visibly harder edges than the
/// Electron table does.
pub fn resized(source: &Pixmap, size: u32) -> Option<Pixmap> {
    let mut level = source.clone();
    while level.width() / 2 >= size && level.height() / 2 >= size {
        let (w, h) = (level.width() / 2, level.height() / 2);
        let mut half = Pixmap::new(w, h)?;
        let src = level.data();
        let stride = level.width() as usize * 4;
        for y in 0..h as usize {
            for x in 0..w as usize {
                for c in 0..4 {
                    let at = (y * 2) * stride + (x * 2) * 4 + c;
                    let sum = src[at] as u32 + src[at + 4] as u32 + src[at + stride] as u32 + src[at + stride + 4] as u32;
                    half.data_mut()[(y * w as usize + x) * 4 + c] = ((sum + 2) / 4) as u8;
                }
            }
        }
        level = half;
    }
    let mut out = Pixmap::new(size, size)?;
    let (lw, lh) = (level.width() as f32, level.height() as f32);
    let src = level.data();
    let stride = level.width() as usize * 4;
    for y in 0..size {
        for x in 0..size {
            // Pixel centres mapped onto the level, clamped at its edges.
            let sx = ((x as f32 + 0.5) * lw / size as f32 - 0.5).clamp(0.0, lw - 1.0);
            let sy = ((y as f32 + 0.5) * lh / size as f32 - 0.5).clamp(0.0, lh - 1.0);
            let (x0, y0) = (sx.floor() as usize, sy.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(level.width() as usize - 1), (y0 + 1).min(level.height() as usize - 1));
            let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
            for c in 0..4 {
                let p = |xx: usize, yy: usize| src[yy * stride + xx * 4 + c] as f32;
                let top = p(x0, y0) * (1.0 - fx) + p(x1, y0) * fx;
                let bottom = p(x0, y1) * (1.0 - fx) + p(x1, y1) * fx;
                out.data_mut()[((y * size + x) * 4) as usize + c] = (top * (1.0 - fy) + bottom * fy).round() as u8;
            }
        }
    }
    Some(out)
}

#[cfg(not(windows))]
fn load(_ext: &str) -> Option<Pixmap> {
    None
}
