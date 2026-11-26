//! Puts a drawn frame on the window, through softbuffer. A Mac has its own (`mac/present.rs`):
//! softbuffer there re-uploads the whole window on every frame.

use std::num::NonZeroU32;
use std::rc::Rc;

use resvg::tiny_skia::Pixmap;
use winit::window::Window;

pub struct Screen {
    surface: softbuffer::Surface<Rc<Window>, Rc<Window>>,
    size: (u32, u32),
}

impl Screen {
    pub fn new(window: Rc<Window>) -> Screen {
        let context = softbuffer::Context::new(window.clone()).expect("softbuffer context");
        let surface = softbuffer::Surface::new(&context, window).expect("surface");
        Screen { surface, size: (0, 0) }
    }

    /// Shows `frame`. `damage` lists what changed since the last frame, in device pixels;
    /// `None` is all of it.
    pub fn present(&mut self, frame: &Pixmap, damage: Option<&[[u32; 4]]>) {
        let (w, h) = (frame.width(), frame.height());
        let resized = self.size != (w, h);
        if resized {
            if self.surface.resize(NonZeroU32::new(w).unwrap(), NonZeroU32::new(h).unwrap()).is_err() {
                return;
            }
            self.size = (w, h);
        }
        let Ok(mut buffer) = self.surface.buffer_mut() else { return };
        let pixels = frame.data();
        // The window's background is opaque, so premultiplied is the colour itself.
        let copy = |buffer: &mut [u32], rect: [u32; 4]| {
            for y in rect[1]..rect[3] {
                let (from, to) = ((y * w + rect[0]) as usize, (y * w + rect[2]) as usize);
                for (dst, px) in buffer[from..to].iter_mut().zip(pixels[from * 4..to * 4].chunks_exact(4)) {
                    *dst = (px[0] as u32) << 16 | (px[1] as u32) << 8 | px[2] as u32;
                }
            }
        };
        match damage {
            Some(damage) if !resized && buffer.age() == 1 => {
                let rects: Vec<softbuffer::Rect> = damage
                    .iter()
                    .filter(|r| r[2] > r[0] && r[3] > r[1])
                    .map(|&r| {
                        copy(&mut buffer, r);
                        softbuffer::Rect {
                            x: r[0],
                            y: r[1],
                            width: NonZeroU32::new(r[2] - r[0]).unwrap(),
                            height: NonZeroU32::new(r[3] - r[1]).unwrap(),
                        }
                    })
                    .collect();
                if !rects.is_empty() {
                    let _ = buffer.present_with_damage(&rects);
                }
            }
            _ => {
                copy(&mut buffer, [0, 0, w, h]);
                let _ = buffer.present();
            }
        }
    }
}
