//! Puts a drawn frame on a Mac window.
//!
//! softbuffer's Mac backend allocates a whole-window buffer every frame, wraps it in a CGImage
//! and hands that to Core Animation, which copies it again on its way to the screen: on a
//! Retina window that is about 19MB moved two or three times per frame, whatever changed, and
//! the visualizers stutter. Here the frame goes into IOSurfaces instead, memory the window
//! server reads directly, and only the rectangles that changed are written. There are a few of
//! them, so the one being written is never the one on screen.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr;
use std::rc::Rc;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::msg_send;
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint};
use objc2_io_surface::{
    IOSurfaceLockOptions, IOSurfaceRef, kIOSurfaceBytesPerElement, kIOSurfaceColorSpace, kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceWidth,
};
use objc2_quartz_core::{CALayer, CATransaction, kCAGravityTopLeft};
use resvg::tiny_skia::Pixmap;
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

/// Enough that one is always free while the window server holds the others.
const MOST: usize = 3;
/// Frames of damage remembered, for bringing a buffer that missed some up to date.
const HISTORY: usize = 8;

struct Buffer {
    surface: CFRetained<IOSurfaceRef>,
    /// The frame it last held; 0 is none yet.
    frame: u64,
}

pub struct Screen {
    window: Rc<Window>,
    layer: Option<Retained<CALayer>>,
    root: Option<Retained<CALayer>>,
    buffers: Vec<Buffer>,
    /// The buffer on screen.
    front: Option<usize>,
    size: (u32, u32),
    /// The last frame shown.
    count: u64,
    /// What each recent frame changed; `None` is everything.
    history: VecDeque<(u64, Option<Vec<[u32; 4]>>)>,
}

impl Screen {
    pub fn new(window: Rc<Window>) -> Screen {
        let mut screen =
            Screen { window, layer: None, root: None, buffers: Vec::new(), front: None, size: (0, 0), count: 0, history: VecDeque::new() };
        screen.attach();
        screen
    }

    /// A layer of our own over the view's, as softbuffer does: setting the contents of a layer
    /// AppKit manages is brittle.
    fn attach(&mut self) {
        let Ok(handle) = self.window.window_handle() else { return };
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else { return };
        let view: &AnyObject = unsafe { handle.ns_view.cast().as_ref() };
        let _: () = unsafe { msg_send![view, setWantsLayer: Bool::YES] };
        let root: Option<Retained<CALayer>> = unsafe { msg_send![view, layer] };
        let Some(root) = root else { return };
        let layer = CALayer::new();
        layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
        layer.setGeometryFlipped(true);
        layer.setContentsGravity(unsafe { kCAGravityTopLeft });
        layer.setOpaque(true);
        root.addSublayer(&layer);
        self.layer = Some(layer);
        self.root = Some(root);
    }

    fn surface(w: u32, h: u32) -> Option<CFRetained<IOSurfaceRef>> {
        let number = |n: i32| CFNumber::new_i32(n);
        let (width, height, bpe, format) = (number(w as i32), number(h as i32), number(4), number(i32::from_be_bytes(*b"BGRA")));
        let keys: [&CFString; 4] = unsafe { [kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat] };
        let values: [&CFNumber; 4] = [&width, &height, &bpe, &format];
        let properties = CFDictionary::<CFString, CFNumber>::from_slices(&keys, &values);
        let surface = unsafe { IOSurfaceRef::new(properties.as_opaque()) }?;
        // Tagged sRGB, which is what the pixels are drawn in; untagged, the window server
        // takes them for something else and shifts every colour slightly.
        unsafe extern "C" {
            static kCGColorSpaceSRGB: &'static CFString;
            fn CGColorSpaceCreateWithName(name: &CFString) -> *const c_void;
            fn CGColorSpaceCopyPropertyList(space: *const c_void) -> *const CFType;
            fn CFRelease(object: *const c_void);
        }
        unsafe {
            let space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            if !space.is_null() {
                let list = CGColorSpaceCopyPropertyList(space);
                if !list.is_null() {
                    surface.set_value(kIOSurfaceColorSpace, &*list);
                    CFRelease(list.cast());
                }
                CFRelease(space);
            }
        }
        Some(surface)
    }

    /// Shows `frame`. `damage` lists what changed since the last frame, in device pixels;
    /// `None` is all of it.
    pub fn present(&mut self, frame: &Pixmap, damage: Option<&[[u32; 4]]>) {
        let (Some(layer), Some(root)) = (self.layer.clone(), self.root.clone()) else { return };
        let (w, h) = (frame.width(), frame.height());
        let damage: Option<Vec<[u32; 4]>> = damage.map(|d| {
            d.iter().map(|r| [r[0].min(w), r[1].min(h), r[2].min(w), r[3].min(h)]).filter(|r| r[2] > r[0] && r[3] > r[1]).collect()
        });
        if self.size != (w, h) {
            self.buffers.clear();
            self.front = None;
            self.history.clear();
            self.size = (w, h);
        }
        if damage.as_ref().is_some_and(|d| d.is_empty()) && self.front.is_some() {
            return;
        }
        let count = self.count + 1;
        self.history.push_back((count, damage));
        while self.history.len() > HISTORY {
            self.history.pop_front();
        }

        // A buffer the window server has let go of, the most up to date one, so the least
        // copying; a new one while there are fewer than `MOST`.
        let free = (0..self.buffers.len())
            .filter(|&i| Some(i) != self.front && !self.buffers[i].surface.is_in_use())
            .max_by_key(|&i| self.buffers[i].frame);
        let index = match free {
            Some(i) => i,
            None if self.buffers.len() < MOST => {
                let Some(surface) = Self::surface(w, h) else { return };
                self.buffers.push(Buffer { surface, frame: 0 });
                self.buffers.len() - 1
            }
            // All held: the oldest that isn't on screen, at the risk of a torn frame.
            None => match (0..self.buffers.len()).filter(|&i| Some(i) != self.front).min_by_key(|&i| self.buffers[i].frame) {
                Some(i) => i,
                None => return,
            },
        };

        // What changed since this buffer's frame: every frame after it, if all are remembered.
        let since = self.buffers[index].frame;
        let oldest = self.history.front().map_or(u64::MAX, |(n, _)| *n);
        let mut rects: Option<Vec<[u32; 4]>> = None;
        if since > 0 && since + 1 >= oldest {
            let mut all = Vec::new();
            let mut whole = false;
            for (_, d) in self.history.iter().filter(|(n, _)| *n > since) {
                match d {
                    Some(d) => all.extend_from_slice(d),
                    None => whole = true,
                }
            }
            if !whole {
                rects = Some(all);
            }
        }
        let rects = rects.unwrap_or_else(|| vec![[0, 0, w, h]]);

        let surface = self.buffers[index].surface.clone();
        if unsafe { surface.lock(IOSurfaceLockOptions::empty(), ptr::null_mut()) } != 0 {
            return;
        }
        let base = surface.base_address().as_ptr() as *mut u8;
        let stride = surface.bytes_per_row();
        let pixels = frame.data();
        for r in rects {
            for y in r[1]..r[3] {
                let from = ((y * w + r[0]) * 4) as usize;
                let len = ((r[2] - r[0]) * 4) as usize;
                let src = &pixels[from..from + len];
                // SAFETY: the surface is locked, `w` by `h`, and `r` lies inside it.
                let dst = unsafe { std::slice::from_raw_parts_mut(base.add(y as usize * stride + r[0] as usize * 4), len) };
                // RGBA premultiplied over an opaque background is the colour itself; the
                // surface is BGRA.
                for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    d[0] = s[2];
                    d[1] = s[1];
                    d[2] = s[0];
                    d[3] = 255;
                }
            }
        }
        unsafe { surface.unlock(IOSurfaceLockOptions::empty(), ptr::null_mut()) };
        self.buffers[index].frame = count;
        self.count = count;
        self.front = Some(index);

        CATransaction::begin();
        CATransaction::setDisableActions(true);
        layer.setFrame(root.bounds());
        layer.setContentsScale(self.window.scale_factor());
        // SAFETY: an IOSurface is one of the things a layer's contents may be.
        let contents: &AnyObject = unsafe { &*(&*surface as *const IOSurfaceRef as *const AnyObject) };
        unsafe { layer.setContents(Some(contents)) };
        CATransaction::commit();
    }
}
