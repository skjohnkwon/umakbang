//! DirectWrite's glyphs at each pen phase. Windows only.
#[cfg(windows)]
#[path = "../src/ui/dwrite.rs"]
mod dwrite;

#[cfg(not(windows))]
fn main() {
    eprintln!("dwprobe reads DirectWrite, which is Windows only.");
}

#[cfg(windows)]
fn main() {
    let mut r = dwrite::Raster::new().expect("factory");
    let path = std::path::PathBuf::from(r"C:\Windows\Fonts\segoeui.ttf");
    for phase in 0..4 {
        match r.glyph(&path, 0, 44, 12.5, phase, true) {
            Some(g) => println!("phase {phase}: {}x{} at {},{} lit {}", g.width, g.height, g.left, g.top, g.rgb.iter().filter(|v| **v > 0).count()),
            None => println!("phase {phase}: none"),
        }
    }
}
