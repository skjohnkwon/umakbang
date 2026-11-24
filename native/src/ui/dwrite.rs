//! Glyphs rasterised by DirectWrite, as Chromium rasterises them on Windows.
//!
//! cosmic-text still shapes (which glyph, where); this only turns a glyph id at a size into
//! coverage. The reason is the look: Chromium draws text on Windows through DirectWrite with
//! ClearType, three coverage values per pixel, one per subpixel stripe. The same glyphs through
//! swash came out grayscale and visibly thinner beside the Electron app - the one difference
//! the eye catches first, because a screen of a file browser is mostly text.

use std::collections::HashMap;
use std::path::PathBuf;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::DirectWrite::*;
use windows::core::HSTRING;

/// A glyph's coverage: `rgb` is three bytes per pixel, the red, green and blue stripes, with the
/// box placed relative to the pen position on the baseline.
pub struct Glyph {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub rgb: Vec<u8>,
}

#[derive(Hash, PartialEq, Eq)]
struct Key {
    face: usize,
    glyph: u16,
    size: u32,
    /// The pen's fractional x position, in quarters of a pixel.
    phase: u8,
    grayscale: bool,
}

pub struct Raster {
    factory: IDWriteFactory2,
    faces: HashMap<(PathBuf, u32), usize>,
    loaded: Vec<IDWriteFontFace>,
    glyphs: HashMap<Key, Option<Glyph>>,
}

/// How far between whole pixels a glyph may land. Chromium positions glyphs at fractions of a
/// pixel on Windows; four steps is where Skia quantises them.
pub const PHASES: f32 = 4.0;

impl Raster {
    pub fn new() -> Option<Raster> {
        let factory: IDWriteFactory2 = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }.ok()?;
        Some(Raster { factory, faces: HashMap::new(), loaded: Vec::new(), glyphs: HashMap::new() })
    }

    fn face(&mut self, path: &PathBuf, index: u32) -> Option<usize> {
        if let Some(&at) = self.faces.get(&(path.clone(), index)) {
            return Some(at);
        }
        let face = unsafe {
            let file = self.factory.CreateFontFileReference(&HSTRING::from(path.as_os_str()), None).ok()?;
            self.factory.CreateFontFace(DWRITE_FONT_FACE_TYPE_TRUETYPE, &[Some(file)], index, DWRITE_FONT_SIMULATIONS_NONE).ok()?
        };
        self.loaded.push(face);
        let at = self.loaded.len() - 1;
        self.faces.insert((path.clone(), index), at);
        Some(at)
    }

    /// The glyph at `size` px with the pen `phase` quarters of a pixel past a whole pixel.
    pub fn glyph(&mut self, path: &PathBuf, index: u32, glyph: u16, size: f32, phase: u8, grayscale: bool) -> Option<&Glyph> {
        let face = self.face(path, index)?;
        let key = Key { face, glyph, size: size.to_bits(), phase, grayscale };
        if !self.glyphs.contains_key(&key) {
            if self.glyphs.len() > 8192 {
                self.glyphs.clear();
            }
            let rendered = self.render(face, glyph, size, phase as f32 / PHASES, grayscale);
            self.glyphs.insert(Key { face, glyph, size: size.to_bits(), phase, grayscale }, rendered);
        }
        self.glyphs.get(&key).and_then(|g| g.as_ref())
    }

    fn render(&self, face: usize, glyph: u16, size: f32, x: f32, grayscale: bool) -> Option<Glyph> {
        let (mode, texture) = if grayscale {
            (DWRITE_TEXT_ANTIALIAS_MODE_GRAYSCALE, DWRITE_TEXTURE_ALIASED_1x1)
        } else {
            (DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE, DWRITE_TEXTURE_CLEARTYPE_3x1)
        };
        let indices = [glyph];
        let advances = [0.0f32];
        let offsets = [DWRITE_GLYPH_OFFSET::default()];
        let run = DWRITE_GLYPH_RUN {
            fontFace: std::mem::ManuallyDrop::new(Some(self.loaded[face].clone())),
            fontEmSize: size,
            glyphCount: 1,
            glyphIndices: indices.as_ptr(),
            glyphAdvances: advances.as_ptr(),
            glyphOffsets: offsets.as_ptr(),
            isSideways: false.into(),
            bidiLevel: 0,
        };
        let result = unsafe {
            self.factory
                .CreateGlyphRunAnalysis(
                    &run,
                    None,
                    if grayscale { DWRITE_RENDERING_MODE_GDI_CLASSIC } else { DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC },
                    DWRITE_MEASURING_MODE_NATURAL,
                    DWRITE_GRID_FIT_MODE_DEFAULT,
                    mode,
                    x,
                    0.0,
                )
                .and_then(|analysis| {
                    let bounds: RECT = analysis.GetAlphaTextureBounds(texture)?;
                    let (w, h) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
                    let pixels = (w.max(0) * h.max(0)) as usize;
                    let mut rgb = vec![0u8; pixels * 3];
                    if w > 0 && h > 0 {
                        if grayscale {
                            // One coverage per pixel, spread over the three stripes so both
                            // kinds blend through the same code.
                            let mut gray = vec![0u8; pixels];
                            analysis.CreateAlphaTexture(texture, &bounds, &mut gray)?;
                            for (i, v) in gray.into_iter().enumerate() {
                                rgb[i * 3..i * 3 + 3].fill(v);
                            }
                        } else {
                            analysis.CreateAlphaTexture(texture, &bounds, &mut rgb)?;
                        }
                    }
                    Ok(Glyph { left: bounds.left, top: bounds.top, width: w, height: h, rgb })
                })
        };
        // The run holds a counted reference to the face; give it back.
        let mut run = run;
        unsafe { std::mem::ManuallyDrop::drop(&mut run.fontFace) };
        result.ok()
    }
}
