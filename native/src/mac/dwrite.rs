//! No DirectWrite on a Mac. `Raster::new` answers None, and `ui::text` draws every glyph
//! through cosmic-text's own rasteriser (swash) instead - grayscale coverage, which is what
//! macOS itself has drawn text with since it dropped subpixel antialiasing in Mojave.

use std::path::PathBuf;

#[allow(dead_code)]
pub struct Glyph {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub rgb: Vec<u8>,
}

pub struct Raster;

pub const PHASES: f32 = 4.0;

impl Raster {
    pub fn new() -> Option<Raster> {
        None
    }

    pub fn glyph(&mut self, _path: &PathBuf, _index: u32, _glyph: u16, _size: f32, _phase: u8, _grayscale: bool) -> Option<&Glyph> {
        None
    }
}
