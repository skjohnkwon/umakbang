//! Lucide icons, drawn from the same SVG data the React app renders, at the size and colour asked
//! for. Rendered once per (name, size, colour) and kept: a screen uses a few dozen combinations.

use super::color::Rgba;
use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg;
use std::collections::HashMap;

#[path = "icon_sources.rs"]
mod sources;

#[derive(Default)]
pub struct Icons {
    rendered: HashMap<(String, u32, [u8; 4], bool), Option<Pixmap>>,
}

impl Icons {
    /// `size` in device pixels. The stroke is the SVG's own 2-in-24, scaled with it, as lucide's is.
    ///
    /// Drawn on whole pixels, as Chromium snaps an inline SVG's position (the title bar's sit at
    /// y 11.5 in layout). Placing them at the fraction was tried and doubled the difference.
    pub fn get(&mut self, name: &str, size: u32, color: Rgba, filled: bool) -> Option<&Pixmap> {
        let key = (name.to_string(), size, color.to_u8(), filled);
        self.rendered
            .entry(key)
            .or_insert_with(|| render(name, size, color, filled))
            .as_ref()
    }
}

/// The umakbang mark, `components/Logo.tsx`.
const LOGO: &str = include_str!("../../assets/logo.svg");

fn render(name: &str, size: u32, color: Rgba, filled: bool) -> Option<Pixmap> {
    let source = if name == "logo" { Some(LOGO) } else { sources::source(name) };
    let mut source = source?.replace("currentColor", &color.hex());
    if filled {
        source = source.replacen(r#"fill="none""#, &format!(r#"fill="{}""#, color.hex()), 1);
    }
    let tree = usvg::Tree::from_str(&source, &usvg::Options::default()).ok()?;
    let mut pixmap = Pixmap::new(size, size)?;
    // By the SVG's own size: lucide's are 24 units square, the logo is 916.
    let scale = size as f32 / tree.size().width();
    resvg::render(&tree, Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    if color.a < 1.0 {
        // The SVG carries the colour but not the opacity; apply it to the coverage.
        for px in pixmap.data_mut().chunks_exact_mut(4) {
            for v in px.iter_mut() {
                *v = (*v as f32 * color.a) as u8;
            }
        }
    }
    Some(pixmap)
}
