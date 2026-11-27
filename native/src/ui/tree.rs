//! The element tree: what a screen is described as, laid out by taffy (CSS flexbox) and painted
//! with tiny-skia.
//!
//! A screen builds a fresh tree for each frame it draws, from its state - the same shape as a
//! React render - and frames are only drawn when something changed. The builder methods are
//! named after the Tailwind classes the Electron components use (`px`, `gap`, `items_center`,
//! `border_b`, `rounded`...), so a component ports by reading its `className`.

use super::color::Rgba;
use super::text::{Text, TextStyle};
use super::Ui;
use resvg::tiny_skia::{
    FillRule, Paint, Path, PathBuilder, Pixmap, PixmapMut, PixmapPaint, Rect as SkRect, Stroke, Transform,
};
use std::rc::Rc;
use taffy::prelude::*;

pub type Painter = Rc<dyn Fn(&mut PixmapMut, [f32; 4], f32)>;

pub enum Kind {
    Box,
    /// One line, cut with an ellipsis when it does not fit - `truncate`.
    Text { text: String, style: TextStyle },
    /// A paragraph, wrapped at spaces to whatever width layout gives it - ordinary text.
    Wrapped { text: String, style: TextStyle },
    Icon { name: &'static str, size: f32, color: Rgba, filled: bool },
    Image(Rc<Pixmap>),
    /// Drawn by the caller into its rectangle: the visualizers, the logo.
    Paint(Painter),
    /// One line of editable text: an `<input>`. Draws its own selection and caret, since only
    /// the renderer can measure where they fall.
    Input(Field),
    /// Lines of editable text that wrap: a `<textarea>`, scrolled by whole pixels.
    Area(Field, f32),
}

/// What an input shows. `caret` and `anchor` are byte offsets into `value`; the selection is
/// between them.
#[derive(Clone)]
pub struct Field {
    pub value: String,
    pub placeholder: String,
    pub caret: usize,
    pub anchor: usize,
    pub focused: bool,
    pub style: TextStyle,
    pub placeholder_color: Rgba,
    pub selection: Rgba,
}

pub struct El<A> {
    pub style: Style,
    pub bg: Option<Rgba>,
    pub hover_bg: Option<Rgba>,
    pub border_color: Option<Rgba>,
    pub radius: f32,
    pub kind: Kind,
    pub children: Vec<El<A>>,
    pub action: Option<A>,
    pub clip: bool,
    pub scroll_y: f32,
    pub opacity: f32,
    /// Drawn after the children, over them: scrollbars.
    pub overlay: Option<Painter>,
    /// A vertical scrollbar in this colour when the children run past the bottom.
    pub scrollbar: Option<Rgba>,
    /// Repainted on its own every animation frame (see `render_live`): a visualizer plot, the
    /// transport's waveform and clock.
    pub live: bool,
    /// A soft drop shadow under the box: `(y offset, blur, opacity)`, as `shadow-lg` casts.
    pub shadow: Option<(f32, f32, f32)>,
    /// A name for a scrolling box, under which its heights are reported (`Ui::extents`).
    pub scroll_key: Option<&'static str>,
    /// Wrapped text set centred, line by line (`text-center`).
    pub text_center: bool,
}

/// `display: flex`, row - the default for every element, as nearly every element in the
/// Electron app is a flex container.
pub fn div<A>() -> El<A> {
    El {
        style: Style::default(),
        bg: None,
        hover_bg: None,
        border_color: None,
        radius: 0.0,
        kind: Kind::Box,
        children: Vec::new(),
        action: None,
        clip: false,
        scroll_y: 0.0,
        opacity: 1.0,
        overlay: None,
        scrollbar: None,
        live: false,
        shadow: None,
        scroll_key: None,
        text_center: false,
    }
}

pub fn col<A>() -> El<A> {
    div().flex_col()
}

pub fn text<A>(text: impl Into<String>, style: TextStyle) -> El<A> {
    let mut el = div();
    el.kind = Kind::Text { text: text.into(), style };
    // Like a `truncate` span in a flex row: allowed to shrink below its text.
    el.style.min_size.width = length(0.0);
    el
}

/// Text that wraps onto as many lines as its width needs.
pub fn para<A>(text: impl Into<String>, style: TextStyle) -> El<A> {
    let mut el = div();
    el.kind = Kind::Wrapped { text: text.into(), style };
    el.style.min_size.width = length(0.0);
    el
}

/// Words onto lines no wider than `width`; a word wider than that has a line to itself.
pub fn wrap_lines(text: &mut Text, words: &str, style: &TextStyle, width: f32) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in words.split_whitespace() {
        let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        if !line.is_empty() && text.width(&candidate, style) > width + 0.01 {
            lines.push(std::mem::replace(&mut line, word.to_string()));
        } else {
            line = candidate;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

pub fn icon<A>(name: &'static str, size: f32, color: Rgba) -> El<A> {
    let mut el = div().size(size, size).shrink0();
    el.kind = Kind::Icon { name, size, color, filled: false };
    el
}

/// An icon with its shape filled as well as stroked - lucide with `fill-current`, as the rating
/// stars are drawn.
pub fn icon_filled<A>(name: &'static str, size: f32, color: Rgba) -> El<A> {
    let mut el = div().size(size, size).shrink0();
    el.kind = Kind::Icon { name, size, color, filled: true };
    el
}

/// An image drawn at its own pixels in a `w` x `h` box: the caller has already scaled it.
pub fn image_sized<A>(pixmap: Rc<Pixmap>, w: f32, h: f32) -> El<A> {
    let mut el = div().size(w, h).shrink0();
    el.kind = Kind::Image(pixmap);
    el
}

pub fn image<A>(pixmap: Rc<Pixmap>, size: f32) -> El<A> {
    let mut el = div().size(size, size).shrink0();
    el.kind = Kind::Image(pixmap);
    el
}

pub fn area<A>(field: Field, scroll: f32) -> El<A> {
    let mut el = div();
    el.kind = Kind::Area(field, scroll);
    el.style.min_size.width = length(0.0);
    el
}

/// Where a textarea's lines break, as byte ranges of `value`: at its newlines, and at the last
/// space that fits `width`, or mid-word when a word is wider than the whole line.
pub fn area_lines(text: &mut Text, value: &str, style: &TextStyle, width: f32) -> Vec<(usize, usize)> {
    let mut lines = Vec::new();
    let mut start = 0;
    for hard in value.split_inclusive('\n') {
        let end_of_hard = start + hard.len();
        let content_end = if hard.ends_with('\n') { end_of_hard - 1 } else { end_of_hard };
        let mut line_start = start;
        loop {
            let rest = &value[line_start..content_end];
            if text.width(rest, style) <= width || rest.is_empty() {
                lines.push((line_start, content_end));
                break;
            }
            // The longest prefix that fits, then back to its last space.
            let mut fit = line_start;
            for (i, ch) in rest.char_indices() {
                let next = line_start + i + ch.len_utf8();
                if text.width(&value[line_start..next], style) > width {
                    break;
                }
                fit = next;
            }
            let fit = fit.max(line_start + rest.chars().next().map_or(1, char::len_utf8));
            let cut = value[line_start..fit].rfind(' ').map(|i| line_start + i + 1).filter(|c| *c > line_start).unwrap_or(fit);
            lines.push((line_start, cut));
            line_start = cut;
        }
        start = end_of_hard;
    }
    if value.is_empty() || value.ends_with('\n') {
        lines.push((value.len(), value.len()));
    }
    lines
}

pub fn input<A>(field: Field) -> El<A> {
    let mut el = div();
    el.kind = Kind::Input(field);
    el.style.min_size.width = length(0.0);
    el
}

pub fn paint<A>(painter: Painter) -> El<A> {
    let mut el = div();
    el.kind = Kind::Paint(painter);
    el
}

#[allow(dead_code)]
impl<A> El<A> {
    pub fn flex_col(mut self) -> Self {
        self.style.flex_direction = FlexDirection::Column;
        self
    }
    pub fn w(mut self, v: f32) -> Self {
        self.style.size.width = length(v);
        self
    }
    pub fn h(mut self, v: f32) -> Self {
        self.style.size.height = length(v);
        self
    }
    pub fn size(self, w: f32, h: f32) -> Self {
        self.w(w).h(h)
    }
    pub fn w_full(mut self) -> Self {
        self.style.size.width = percent(1.0);
        self
    }
    pub fn h_full(mut self) -> Self {
        self.style.size.height = percent(1.0);
        self
    }
    pub fn min_w(mut self, v: f32) -> Self {
        self.style.min_size.width = length(v);
        self
    }
    pub fn max_h(mut self, v: f32) -> Self {
        self.style.max_size.height = length(v);
        self
    }
    pub fn min_h0(mut self) -> Self {
        self.style.min_size.height = length(0.0);
        self
    }
    pub fn grow(mut self) -> Self {
        self.style.flex_grow = 1.0;
        self.style.flex_basis = length(0.0);
        self.style.min_size.width = length(0.0);
        self
    }
    pub fn shrink0(mut self) -> Self {
        self.style.flex_shrink = 0.0;
        self
    }
    pub fn p(self, v: f32) -> Self {
        self.px(v).py(v)
    }
    pub fn px(mut self, v: f32) -> Self {
        self.style.padding.left = length(v);
        self.style.padding.right = length(v);
        self
    }
    pub fn py(mut self, v: f32) -> Self {
        self.style.padding.top = length(v);
        self.style.padding.bottom = length(v);
        self
    }
    pub fn pl(mut self, v: f32) -> Self {
        self.style.padding.left = length(v);
        self
    }
    pub fn pr(mut self, v: f32) -> Self {
        self.style.padding.right = length(v);
        self
    }
    pub fn pt(mut self, v: f32) -> Self {
        self.style.padding.top = length(v);
        self
    }
    pub fn pb(mut self, v: f32) -> Self {
        self.style.padding.bottom = length(v);
        self
    }
    pub fn ml(mut self, v: f32) -> Self {
        self.style.margin.left = length(v);
        self
    }
    pub fn mr(mut self, v: f32) -> Self {
        self.style.margin.right = length(v);
        self
    }
    pub fn mb(mut self, v: f32) -> Self {
        self.style.margin.bottom = length(v);
        self
    }
    pub fn ml_auto(mut self) -> Self {
        self.style.margin.left = auto();
        self
    }
    pub fn mt(mut self, v: f32) -> Self {
        self.style.margin.top = length(v);
        self
    }
    pub fn gap(mut self, v: f32) -> Self {
        self.style.gap = Size { width: length(v), height: length(v) };
        self
    }
    pub fn wrap(mut self) -> Self {
        self.style.flex_wrap = FlexWrap::Wrap;
        self
    }
    /// `text-center`, for wrapped text.
    pub fn centered(mut self) -> Self {
        self.text_center = true;
        self
    }
    /// `self-start`: this child alone, at the start of its parent's cross axis.
    pub fn self_start(mut self) -> Self {
        self.style.align_self = Some(AlignItems::FLEX_START);
        self
    }
    pub fn items_center(mut self) -> Self {
        self.style.align_items = AlignItems::CENTER;
        self
    }
    pub fn items_start(mut self) -> Self {
        self.style.align_items = AlignItems::FLEX_START;
        self
    }
    pub fn justify_center(mut self) -> Self {
        self.style.justify_content = JustifyContent::CENTER;
        self
    }
    pub fn justify_between(mut self) -> Self {
        self.style.justify_content = JustifyContent::SPACE_BETWEEN;
        self
    }
    pub fn justify_end(mut self) -> Self {
        self.style.justify_content = JustifyContent::FLEX_END;
        self
    }
    pub fn bg(mut self, c: Rgba) -> Self {
        self.bg = Some(c);
        self
    }
    pub fn hover_bg(mut self, c: Rgba) -> Self {
        self.hover_bg = Some(c);
        self
    }
    pub fn rounded(mut self, r: f32) -> Self {
        self.radius = r;
        self
    }
    pub fn border(mut self, c: Rgba, w: f32) -> Self {
        self.border_color = Some(c);
        self.style.border = taffy::Rect { left: length(w), right: length(w), top: length(w), bottom: length(w) };
        self
    }
    pub fn border_b(mut self, c: Rgba) -> Self {
        self.border_color = Some(c);
        self.style.border.bottom = length(1.0);
        self
    }
    pub fn border_t(mut self, c: Rgba) -> Self {
        self.border_color = Some(c);
        self.style.border.top = length(1.0);
        self
    }
    pub fn border_r(mut self, c: Rgba) -> Self {
        self.border_color = Some(c);
        self.style.border.right = length(1.0);
        self
    }
    pub fn border_l(mut self, c: Rgba) -> Self {
        self.border_color = Some(c);
        self.style.border.left = length(1.0);
        self
    }
    /// Positioned within its parent, out of the flow - `absolute top-[y] left-[x]`.
    /// Placed by its right edge, `right` in from the parent's.
    pub fn absolute_right(mut self, right: f32, y: f32) -> Self {
        self.style.position = Position::Absolute;
        self.style.inset = taffy::Rect { left: auto(), top: length(y), right: length(right), bottom: auto() };
        self
    }
    pub fn absolute(mut self, x: f32, y: f32) -> Self {
        self.style.position = Position::Absolute;
        self.style.inset = taffy::Rect { left: length(x), top: length(y), right: auto(), bottom: auto() };
        self
    }
    pub fn clip(mut self) -> Self {
        self.clip = true;
        self.style.overflow = taffy::Point { x: taffy::Overflow::Hidden, y: taffy::Overflow::Hidden };
        self
    }
    /// A clipped area whose content is drawn `offset` pixels scrolled up.
    pub fn scroll(mut self, offset: f32) -> Self {
        self.scroll_y = offset;
        self.clip()
    }
    /// Scrolls, and reports its heights under `key` so the app can clamp the offset.
    pub fn scroll_named(mut self, key: &'static str, offset: f32) -> Self {
        self.scroll_key = Some(key);
        self.scroll(offset)
    }
    /// Scrolls, with Chromium's thin scrollbar drawn when the content is taller than the box.
    pub fn scrollbar(mut self, color: Rgba) -> Self {
        self.scrollbar = Some(color);
        self
    }
    pub fn live(mut self) -> Self {
        self.live = true;
        self
    }
    /// `shadow-lg` is (4, 12, 0.25); `shadow-2xl` (16, 40, 0.35) - near enough to the
    /// layered box-shadows Tailwind writes, on this dark ground.
    pub fn shadow(mut self, y: f32, blur: f32, opacity: f32) -> Self {
        self.shadow = Some((y, blur, opacity));
        self
    }
    pub fn overlay(mut self, painter: Painter) -> Self {
        self.overlay = Some(painter);
        self
    }
    pub fn opacity(mut self, v: f32) -> Self {
        self.opacity = v;
        self
    }
    pub fn on(mut self, action: A) -> Self {
        self.action = Some(action);
        self
    }
    pub fn child(mut self, el: El<A>) -> Self {
        self.children.push(el);
        self
    }
    pub fn children(mut self, els: impl IntoIterator<Item = El<A>>) -> Self {
        self.children.extend(els);
        self
    }
    /// Hands the element to `f`: a step that is a function rather than a method.
    pub fn pipe(self, f: impl FnOnce(Self) -> Self) -> Self {
        f(self)
    }
    pub fn maybe(self, condition: bool, f: impl FnOnce(Self) -> Self) -> Self {
        if condition { f(self) } else { self }
    }
}

/// A clickable region, in device pixels, in paint order.
pub struct Hit<A> {
    pub rect: [f32; 4],
    /// Where the element's content box starts, in device pixels, before any clip: what a
    /// chart scrolled half out of view measures a pointer from.
    pub origin: [f32; 2],
    pub action: A,
}

/// The pixels under a live element as the last full frame left them, so the element can be
/// repainted on its own: restore these, then paint it again over them.
pub struct Backdrop {
    /// Device pixels: left, top, right, bottom.
    pub rect: [u32; 4],
    pixels: Pixmap,
}

/// Lays out and paints `root` into `target`, returning where every action can be clicked.
pub fn render<A: Clone + PartialEq>(ui: &mut Ui, root: &El<A>, target: &mut Pixmap, scale: f32, hovered: Option<&A>) -> Vec<Hit<A>> {
    let (width, height) = (target.width() as f32 / scale, target.height() as f32 / scale);
    let (tree, root_id) = layout(ui, root, width, height);
    ui.backdrops.clear();
    ui.spinning = false;
    let mut hits = Vec::new();
    let mut pm = target.as_mut();
    let clip = [0.0, 0.0, width, height];
    paint_node(ui, &tree, root_id, root, (0.0, 0.0), clip, scale, 1.0, false, hovered, &mut pm, &mut hits, true);
    hits
}

/// Repaints only the live elements of `root`, each over the backdrop the last `render`
/// recorded under it, and leaves the rectangles it touched in `ui.damage`. This is an
/// animation frame: a playing track moves six plots, a waveform and a clock, and redrawing
/// the thousand-odd other elements around them sixty times a second is most of a core.
///
/// False when the frame no longer lines up with that render - a live element moved, resized
/// or appeared - and the caller has to draw a full frame instead.
pub fn render_live<A: Clone + PartialEq>(ui: &mut Ui, root: &El<A>, target: &mut Pixmap, scale: f32, hovered: Option<&A>) -> bool {
    let (width, height) = (target.width() as f32 / scale, target.height() as f32 / scale);
    let (tree, root_id) = layout(ui, root, width, height);
    ui.damage.clear();
    let mut pm = target.as_mut();
    let clip = [0.0, 0.0, width, height];
    let mut index = 0;
    let mut ok = true;
    seek_live(ui, &tree, root_id, root, (0.0, 0.0), clip, scale, 1.0, hovered, &mut pm, &mut index, &mut ok);
    ok && index == ui.backdrops.len()
}

fn layout<A>(ui: &mut Ui, root: &El<A>, width: f32, height: f32) -> (TaffyTree<usize>, NodeId) {
    let mut tree: TaffyTree<usize> = TaffyTree::new();
    // Layout stays fractional, as Blink's does: text is positioned at the fraction (to a quarter
    // pixel) and only boxes are snapped to whole pixels when they are filled. Taffy's own rounding
    // moved every label up to half a pixel, which ClearType turns into a different set of
    // coloured fringes - the trail in the pane bar differed on exactly the crumbs that sit at
    // fractional x in Chromium.
    tree.disable_rounding();
    let mut leaves: Vec<*const El<A>> = Vec::new();
    let root_id = build(&mut tree, root, &mut leaves);
    let text_engine = &mut ui.text;
    tree.compute_layout_with_measure(
        root_id,
        Size { width: AvailableSpace::Definite(width), height: AvailableSpace::Definite(height) },
        |input, _node, context, node_style| {
            // In taffy 0.15 this closure lays out the whole leaf, not just its content: its own
            // size, padding and border are applied by `compute_leaf_layout`, which asks only for
            // the content's size. Returning a size directly ignored all of it - every icon and
            // canvas came out 0x0 and nothing but text and backgrounds was drawn.
            let content = context.copied().map(|index| {
                // SAFETY: the pointers are into `root`, which outlives this call and is not mutated.
                unsafe { &*leaves[index] }
            });
            taffy::compute_leaf_layout(input, node_style, |_, _| 0.0, |known, _available| {
                match content.map(|el| &el.kind) {
                    Some(Kind::Text { text, style }) => Size {
                        width: known.width.unwrap_or_else(|| text_engine.width(text, style)),
                        height: known.height.unwrap_or(style.line_height),
                    },
                    Some(Kind::Wrapped { text, style }) => {
                        let limit = match (known.width, _available.width) {
                            (Some(w), _) => w,
                            (None, AvailableSpace::Definite(w)) => w,
                            (None, AvailableSpace::MinContent) => text.split_whitespace().map(|w| text_engine.width(w, style)).fold(0.0, f32::max),
                            (None, AvailableSpace::MaxContent) => f32::INFINITY,
                        };
                        let lines = wrap_lines(text_engine, text, style, limit);
                        let widest = lines.iter().map(|l| text_engine.width(l, style)).fold(0.0, f32::max);
                        Size { width: known.width.unwrap_or(widest), height: known.height.unwrap_or(lines.len().max(1) as f32 * style.line_height) }
                    }
                    _ => Size { width: known.width.unwrap_or(0.0), height: known.height.unwrap_or(0.0) },
                }
            })
        },
    )
    .expect("layout");
    (tree, root_id)
}

/// The whole device pixels a CSS rectangle touches, inside the target.
fn device_rect(r: [f32; 4], scale: f32, pm: &PixmapMut) -> [u32; 4] {
    let clamp = |v: f32, max: u32| (v.max(0.0) as u32).min(max);
    [
        clamp((r[0] * scale).floor(), pm.width()),
        clamp((r[1] * scale).floor(), pm.height()),
        clamp((r[2] * scale).ceil(), pm.width()),
        clamp((r[3] * scale).ceil(), pm.height()),
    ]
}

fn copy_rows(from: &[u8], from_width: u32, from_at: (u32, u32), to: &mut [u8], to_width: u32, to_at: (u32, u32), size: (u32, u32)) {
    let row = (size.0 * 4) as usize;
    for line in 0..size.1 {
        let a = (((from_at.1 + line) * from_width + from_at.0) * 4) as usize;
        let b = (((to_at.1 + line) * to_width + to_at.0) * 4) as usize;
        to[b..b + row].copy_from_slice(&from[a..a + row]);
    }
}

fn snapshot(ui: &mut Ui, pm: &mut PixmapMut, rect: [u32; 4]) {
    let (w, h) = (rect[2] - rect[0], rect[3] - rect[1]);
    let Some(mut pixels) = Pixmap::new(w.max(1), h.max(1)) else { return };
    if w > 0 && h > 0 {
        let width = pm.width();
        copy_rows(pm.data_mut(), width, (rect[0], rect[1]), pixels.data_mut(), w, (0, 0), (w, h));
    }
    ui.backdrops.push(Backdrop { rect, pixels });
}

#[allow(clippy::too_many_arguments)]
fn seek_live<A: Clone + PartialEq>(
    ui: &mut Ui,
    tree: &TaffyTree<usize>,
    node: NodeId,
    el: &El<A>,
    origin: (f32, f32),
    clip: [f32; 4],
    scale: f32,
    inherited: f32,
    hovered: Option<&A>,
    pm: &mut PixmapMut,
    index: &mut usize,
    ok: &mut bool,
) {
    let layout = tree.layout(node).expect("layout");
    let (x, y) = (origin.0 + layout.location.x, origin.1 + layout.location.y);
    let (w, h) = (layout.size.width, layout.size.height);
    let visible = intersect([x, y, x + w, y + h], clip);
    if visible[2] <= visible[0] || visible[3] <= visible[1] {
        return;
    }
    if el.live {
        let rect = device_rect(visible, scale, pm);
        let Some(backdrop) = ui.backdrops.get(*index).filter(|b| b.rect == rect) else {
            *ok = false;
            return;
        };
        *index += 1;
        let (bw, bh) = (rect[2] - rect[0], rect[3] - rect[1]);
        if bw > 0 && bh > 0 {
            let width = pm.width();
            copy_rows(backdrop.pixels.data(), bw, (0, 0), pm.data_mut(), width, (rect[0], rect[1]), (bw, bh));
        }
        // Nothing may land outside what was just restored, or it would pile up frame on frame.
        let bounds = [rect[0] as f32 / scale, rect[1] as f32 / scale, rect[2] as f32 / scale, rect[3] as f32 / scale];
        let mut hits = Vec::new();
        paint_node(ui, tree, node, el, origin, intersect(clip, bounds), scale, inherited, false, hovered, pm, &mut hits, false);
        ui.damage.push(rect);
        return;
    }
    let content = [
        x + layout.padding.left + layout.border.left,
        y + layout.padding.top + layout.border.top,
        x + w - layout.padding.right - layout.border.right,
        y + h - layout.padding.bottom - layout.border.bottom,
    ];
    let child_clip = if el.clip { intersect(clip, content) } else { clip };
    let child_origin = (x, y - el.scroll_y);
    let ids = tree.children(node).expect("children");
    for (child, child_el) in ids.iter().copied().zip(el.children.iter()) {
        seek_live(ui, tree, child, child_el, child_origin, child_clip, scale, inherited * el.opacity, hovered, pm, index, ok);
    }
}

/// How tall a scrolling box's content is: the lowest edge anything inside reaches, down
/// through every box that lets its content spill out. Its children alone are not enough - a
/// child stretched to the box's own height, as a row's are, holds content taller than itself.
fn scroll_extent(tree: &TaffyTree<usize>, node: NodeId) -> f32 {
    let padding = tree.layout(node).map_or(0.0, |l| l.padding.bottom);
    tree.children(node).unwrap_or_default().into_iter().filter_map(|child| reach(tree, child)).fold(0.0, f32::max) + padding
}

/// The bottom of `node` and whatever spills out of it, from its parent's top; `None` for a box
/// positioned out of the flow, which a scroll does not follow.
fn reach(tree: &TaffyTree<usize>, node: NodeId) -> Option<f32> {
    let style = tree.style(node).ok()?;
    if style.position == Position::Absolute {
        return None;
    }
    let layout = tree.layout(node).ok()?;
    let mut bottom = layout.size.height;
    if style.overflow.y == taffy::Overflow::Visible {
        for child in tree.children(node).unwrap_or_default() {
            if let Some(inner) = reach(tree, child) {
                bottom = bottom.max(inner);
            }
        }
    }
    Some(layout.location.y + bottom)
}

fn build<A>(tree: &mut TaffyTree<usize>, el: &El<A>, leaves: &mut Vec<*const El<A>>) -> NodeId {
    if let Kind::Text { .. } | Kind::Wrapped { .. } = el.kind {
        leaves.push(el as *const El<A>);
        return tree.new_leaf_with_context(el.style.clone(), leaves.len() - 1).expect("leaf");
    }
    let children: Vec<NodeId> = el.children.iter().map(|c| build(tree, c, leaves)).collect();
    tree.new_with_children(el.style.clone(), &children).expect("node")
}

#[allow(clippy::too_many_arguments)]
fn paint_node<A: Clone + PartialEq>(
    ui: &mut Ui,
    tree: &TaffyTree<usize>,
    node: NodeId,
    el: &El<A>,
    origin: (f32, f32),
    clip: [f32; 4],
    scale: f32,
    inherited: f32,
    flatten: bool,
    hovered: Option<&A>,
    pm: &mut PixmapMut,
    hits: &mut Vec<Hit<A>>,
    record: bool,
) {
    // Opacity multiplies down the tree, as CSS `opacity` does: a disabled button fades its icon too.
    let opacity = if flatten { inherited } else { inherited * el.opacity };
    let layout = tree.layout(node).expect("layout");
    let x = origin.0 + layout.location.x;
    let y = origin.1 + layout.location.y;
    let (w, h) = (layout.size.width, layout.size.height);
    let rect = [x, y, x + w, y + h];
    let visible = intersect(rect, clip);
    if visible[2] <= visible[0] || visible[3] <= visible[1] {
        return;
    }
    if el.live && record {
        let rect = device_rect(visible, scale, pm);
        snapshot(ui, pm, rect);
    }

    // CSS fades an element and everything in it as one picture: the play button's glyph
    // replaces the circle under it, then the whole button is faded. Fading each piece on its
    // own lets the circle show through the glyph. A box with a fill and children is therefore
    // drawn into its own layer first. Only those: for a bare icon in a button the two are the
    // same picture, and text would lose its ClearType in a transparent layer (as it does in
    // Chromium).
    if !flatten && el.opacity < 1.0 && !el.children.is_empty() && (el.bg.is_some() || el.border_color.is_some()) {
        let [lx, ly, rx, ry] = snap(visible, scale);
        let Some(mut layer) = Pixmap::new((rx - lx).max(1.0) as u32, (ry - ly).max(1.0) as u32) else { return };
        let shift = (lx / scale, ly / scale);
        let mut inner = Vec::new();
        paint_node(
            ui,
            tree,
            node,
            el,
            (origin.0 - shift.0, origin.1 - shift.1),
            [clip[0] - shift.0, clip[1] - shift.1, clip[2] - shift.0, clip[3] - shift.1],
            scale,
            1.0,
            true,
            hovered,
            &mut layer.as_mut(),
            &mut inner,
            false,
        );
        for mut hit in inner {
            hit.rect = [hit.rect[0] + lx, hit.rect[1] + ly, hit.rect[2] + lx, hit.rect[3] + ly];
            hits.push(hit);
        }
        let paint = PixmapPaint { opacity: inherited * el.opacity, ..PixmapPaint::default() };
        pm.draw_pixmap(lx as i32, ly as i32, layer.as_ref(), &paint, Transform::identity(), None);
        return;
    }
    let is_hovered = el.action.is_some() && el.action.as_ref() == hovered;

    if let Some((dy, blur, strength)) = el.shadow {
        // Stacked rings, each a little larger and fainter: a blur without a blur pass.
        const STEPS: usize = 8;
        for i in (0..STEPS).rev() {
            let grow = blur * (i as f32 + 1.0) / STEPS as f32 / 2.0;
            let ring = [rect[0] - grow, rect[1] - grow + dy, rect[2] + grow, rect[3] + grow + dy];
            fill_rect(pm, ring, clip, el.radius + grow, Rgba::rgb8(0, 0, 0).alpha(strength * opacity / STEPS as f32), scale);
        }
    }
    let fill = if is_hovered { el.hover_bg.or(el.bg) } else { el.bg };
    if let Some(color) = fill {
        fill_rect(pm, rect, clip, el.radius, color.alpha(opacity), scale);
    }
    if let Some(color) = el.border_color {
        let b = layout.border;
        let color = color.alpha(opacity);
        if el.radius > 0.0 && b.top > 0.0 && b.top == b.bottom && b.left == b.top && b.right == b.top {
            stroke_rounded(pm, rect, clip, el.radius, b.top, color, scale);
        } else {
            if b.top > 0.0 { fill_rect(pm, [x, y, x + w, y + b.top], clip, 0.0, color, scale) }
            if b.bottom > 0.0 { fill_rect(pm, [x, y + h - b.bottom, x + w, y + h], clip, 0.0, color, scale) }
            if b.left > 0.0 { fill_rect(pm, [x, y, x + b.left, y + h], clip, 0.0, color, scale) }
            if b.right > 0.0 { fill_rect(pm, [x + w - b.right, y, x + w, y + h], clip, 0.0, color, scale) }
        }
    }

    let content = [
        x + layout.padding.left + layout.border.left,
        y + layout.padding.top + layout.border.top,
        x + w - layout.padding.right - layout.border.right,
        y + h - layout.padding.bottom - layout.border.bottom,
    ];
    match &el.kind {
        Kind::Box => {}
        Kind::Text { text, style } => {
            let mut scaled = style.clone();
            scaled.size *= scale;
            scaled.line_height *= scale;
            scaled.color = style.color.alpha(opacity);
            let available = (content[2] - content[0]) * scale;
            let shown = ui.text.fit(text, &scaled, available);
            let device_clip = intersect(content, clip).map(|v| v * scale);
            ui.text.draw(pm, &shown, &scaled, content[0] * scale, content[1] * scale, device_clip);
        }
        Kind::Wrapped { text, style } => {
            let mut scaled = style.clone();
            scaled.size *= scale;
            scaled.line_height *= scale;
            scaled.color = style.color.alpha(opacity);
            let lines = wrap_lines(&mut ui.text, text, style, content[2] - content[0]);
            let device_clip = intersect(content, clip).map(|v| v * scale);
            let width = content[2] - content[0];
            for (i, line) in lines.iter().enumerate() {
                let inset = if el.text_center { ((width - ui.text.width(line, style)) / 2.0).max(0.0) } else { 0.0 };
                ui.text.draw(pm, line, &scaled, (content[0] + inset) * scale, (content[1] + i as f32 * style.line_height) * scale, device_clip);
            }
        }
        Kind::Icon { name, size, color, filled } => {
            let px = (size * scale).round() as u32;
            // `loader2` is only ever drawn spinning (`animate-spin`).
            let spin = if *name == "loader2" { ui.spin } else { 0.0 };
            if let Some(pixmap) = ui.icons.get(name, px, color.alpha(opacity), *filled) {
                if spin != 0.0 {
                    let device_clip = clip.map(|v| v * scale);
                    let (x, y) = ((content[0] * scale).round(), (content[1] * scale).round());
                    let (w, h) = (pixmap.width() as f32, pixmap.height() as f32);
                    if x >= device_clip[0] && y >= device_clip[1] && x + w <= device_clip[2] && y + h <= device_clip[3] {
                        let transform = Transform::from_rotate_at(spin, x + w / 2.0, y + h / 2.0).pre_translate(x, y);
                        let paint = PixmapPaint { quality: resvg::tiny_skia::FilterQuality::Bilinear, ..PixmapPaint::default() };
                        pm.draw_pixmap(0, 0, pixmap.as_ref(), &paint, transform, None);
                    }
                } else {
                    draw_pixmap(pm, pixmap, content[0] * scale, content[1] * scale, clip.map(|v| v * scale));
                }
            }
            if *name == "loader2" {
                ui.spinning = true;
            }
        }
        Kind::Image(pixmap) => {
            draw_pixmap(pm, pixmap, content[0] * scale, content[1] * scale, clip.map(|v| v * scale));
        }
        Kind::Paint(painter) => paint_clipped(pm, painter, content, clip, scale),
        Kind::Input(field) => paint_input(ui, pm, field, content, clip, scale, opacity),
        Kind::Area(field, scroll) => paint_area(ui, pm, field, *scroll, content, clip, scale, opacity),
    }

    if let Some(action) = &el.action {
        hits.push(Hit { rect: visible.map(|v| v * scale), origin: [content[0] * scale, content[1] * scale], action: action.clone() });
    }

    let child_clip = if el.clip { intersect(clip, content) } else { clip };
    let child_origin = (x, y - el.scroll_y);
    let ids = tree.children(node).expect("children");
    if let Some(key) = el.scroll_key {
        let extent = scroll_extent(tree, node);
        let viewport = content[3] - content[1] + layout.padding.top + layout.padding.bottom;
        ui.extents.insert(key, (viewport, extent));
        ui.scroll_rects.insert(key, visible);
    }
    if let Some(color) = el.scrollbar {
        let extent = scroll_extent(tree, node);
        let viewport = content[3] - content[1] + layout.padding.top + layout.padding.bottom;
        if extent > viewport + 0.5 {
            let track = [x, y, x + w, y + h].map(|v| v * scale);
            scrollbar_v(pm, track, extent, viewport, el.scroll_y, color, scale);
        }
    }
    for (child, child_el) in ids.iter().copied().zip(el.children.iter()) {
        paint_node(ui, tree, child, child_el, child_origin, child_clip, scale, opacity, false, hovered, pm, hits, record);
    }
    if let Some(painter) = &el.overlay {
        painter(pm, content.map(|v| v * scale), scale);
    }
}

fn intersect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])]
}

fn rounded_path(r: [f32; 4], radius: f32) -> Option<Path> {
    let (x, y, w, h) = (r[0], r[1], r[2] - r[0], r[3] - r[1]);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let radius = radius.min(w / 2.0).min(h / 2.0);
    if radius <= 0.0 {
        return SkRect::from_xywh(x, y, w, h).map(PathBuilder::from_rect);
    }
    // Quarter circles as cubics, the usual 0.5523 handle length.
    let k = radius * 0.552_284_8;
    let mut pb = PathBuilder::new();
    pb.move_to(x + radius, y);
    pb.line_to(x + w - radius, y);
    pb.cubic_to(x + w - radius + k, y, x + w, y + radius - k, x + w, y + radius);
    pb.line_to(x + w, y + h - radius);
    pb.cubic_to(x + w, y + h - radius + k, x + w - radius + k, y + h, x + w - radius, y + h);
    pb.line_to(x + radius, y + h);
    pb.cubic_to(x + radius - k, y + h, x, y + h - radius + k, x, y + h - radius);
    pb.line_to(x, y + radius);
    pb.cubic_to(x, y + radius - k, x + radius - k, y, x + radius, y);
    pb.close();
    pb.finish()
}

/// Fills a (possibly rounded) rectangle given in logical pixels, cut to `clip`.
pub fn fill_rect(pm: &mut PixmapMut, r: [f32; 4], clip: [f32; 4], radius: f32, color: Rgba, scale: f32) {
    if color.a <= 0.0 {
        return;
    }
    let inside = r[0] >= clip[0] && r[1] >= clip[1] && r[2] <= clip[2] && r[3] <= clip[3];
    let mut paint = Paint::default();
    paint.set_color(color.skia());
    paint.anti_alias = radius > 0.0;
    if inside || radius <= 0.0 {
        // A square box cut by the clip is still a square box: the cut is the shape.
        let shape = if inside { r } else { intersect(r, clip) };
        let Some(path) = rounded_path(snap(shape, scale), if inside { radius * scale } else { 0.0 }) else { return };
        pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
        return;
    }
    // A rounded one keeps its corners where they are in view: the whole shape, trimmed.
    let Some(path) = rounded_path(snap(r, scale), radius * scale) else { return };
    cut(pm, clip, scale, |target, shift| target.fill_path(&path, &paint, FillRule::Winding, shift, None));
}

fn stroke_rounded(pm: &mut PixmapMut, r: [f32; 4], clip: [f32; 4], radius: f32, width: f32, color: Rgba, scale: f32) {
    if r[2] <= clip[0] || r[0] >= clip[2] || r[3] <= clip[1] || r[1] >= clip[3] {
        return;
    }
    let inside = r[0] >= clip[0] && r[1] >= clip[1] && r[2] <= clip[2] && r[3] <= clip[3];
    // The border sits inside the box, as `box-sizing: border-box` draws it.
    let half = width * scale / 2.0;
    let [x0, y0, x1, y1] = snap(r, scale);
    let inset = [x0 + half, y0 + half, x1 - half, y1 - half];
    let Some(path) = rounded_path(inset, (radius - half).max(0.0) * scale) else { return };
    let mut paint = Paint::default();
    paint.set_color(color.skia());
    paint.anti_alias = true;
    let stroke = Stroke { width: width * scale, ..Stroke::default() };
    if inside {
        pm.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    } else {
        // Half scrolled out of view, the part still in view keeps its border.
        cut(pm, clip, scale, |target, shift| target.stroke_path(&path, &paint, &stroke, shift, None));
    }
}

/// Draws into a pixmap the size of the visible part of `clip` and copies that in: whatever
/// `draw` puts outside the clip falls off the pixmap's edges. `draw` is handed the offset to
/// draw at.
fn cut(pm: &mut PixmapMut, clip: [f32; 4], scale: f32, draw: impl FnOnce(&mut PixmapMut, Transform)) {
    let c = clip.map(|v| v * scale);
    let left = c[0].ceil().max(0.0);
    let top = c[1].ceil().max(0.0);
    let right = c[2].floor().min(pm.width() as f32);
    let bottom = c[3].floor().min(pm.height() as f32);
    if right <= left || bottom <= top {
        return;
    }
    let Some(mut own) = Pixmap::new((right - left) as u32, (bottom - top) as u32) else { return };
    draw(&mut own.as_mut(), Transform::from_translate(-left, -top));
    pm.draw_pixmap(left as i32, top as i32, own.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
}

/// Runs a painter inside the clip. Painters draw wherever their rectangle says, so one that a
/// scrolling box has half hidden is drawn into a pixmap of its own and only the part still in
/// view is copied out - otherwise a chart scrolled up would paint over the title bar.
fn paint_clipped(pm: &mut PixmapMut, painter: &Painter, content: [f32; 4], clip: [f32; 4], scale: f32) {
    let r = content.map(|v| v * scale);
    let c = clip.map(|v| v * scale);
    if r[2] <= c[0] || r[0] >= c[2] || r[3] <= c[1] || r[1] >= c[3] {
        return;
    }
    if r[0] >= c[0] - 0.5 && r[1] >= c[1] - 0.5 && r[2] <= c[2] + 0.5 && r[3] <= c[3] + 0.5 {
        painter(pm, r, scale);
        return;
    }
    let (x, y) = (r[0].round(), r[1].round());
    let (w, h) = ((r[2] - r[0]).ceil().max(1.0) as u32, (r[3] - r[1]).ceil().max(1.0) as u32);
    let Some(mut own) = Pixmap::new(w, h) else { return };
    painter(&mut own.as_mut(), [0.0, 0.0, r[2] - r[0], r[3] - r[1]], scale);
    let left = (c[0].ceil() - x).max(0.0) as i32;
    let top = (c[1].ceil() - y).max(0.0) as i32;
    let right = ((c[2].floor() - x).min(w as f32)) as i32;
    let bottom = ((c[3].floor() - y).min(h as f32)) as i32;
    let Some(rect) = resvg::tiny_skia::IntRect::from_xywh(left, top, (right - left).max(0) as u32, (bottom - top).max(0) as u32) else { return };
    if let Some(part) = own.clone_rect(rect) {
        pm.draw_pixmap(x as i32 + left, y as i32 + top, part.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
    }
}

/// A box in device pixels with each edge on the nearest whole pixel: Chromium's pixel-snapped
/// rect, which keeps a box's width from wobbling with where it happens to start.
fn snap(r: [f32; 4], scale: f32) -> [f32; 4] {
    r.map(|v| (v * scale).round())
}

fn draw_pixmap(pm: &mut PixmapMut, pixmap: &Pixmap, x: f32, y: f32, clip: [f32; 4]) {
    let (px, py) = (x.round(), y.round());
    let (pw, ph) = (pixmap.width() as f32, pixmap.height() as f32);
    // Whole or nothing: icons are small, and one half-scrolled out of view is not worth a mask.
    if px + pw <= clip[0] || py + ph <= clip[1] || px >= clip[2] || py >= clip[3] {
        return;
    }
    if py < clip[1] || py + ph > clip[3] {
        return;
    }
    pm.draw_pixmap(px as i32, py as i32, pixmap.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
}

#[allow(dead_code)]
pub fn measure(text: &mut Text, s: &str, style: &TextStyle) -> f32 {
    text.width(s, style)
}

/// Chromium's thin native scrollbar, vertical, along the right edge of `track` (device pixels):
/// a small arrow at each end and a rounded thumb between them, sized by how much of the content
/// is in view.
pub fn scrollbar_v(pm: &mut PixmapMut, track: [f32; 4], content: f32, viewport: f32, offset: f32, color: Rgba, scale: f32) {
    let x = track[2] - 9.0 * scale;
    let width = 7.0 * scale;
    let arrow = 12.0 * scale;
    let (top, bottom) = (track[1] + arrow, track[3] - arrow);
    if bottom <= top || content <= viewport {
        return;
    }
    let length = ((bottom - top) * viewport / content).max(16.0 * scale);
    let at = top + (bottom - top - length) * (offset / (content - viewport)).clamp(0.0, 1.0);
    fill_device(pm, [x, at, x + width, at + length], 3.5 * scale, color);
    arrow_mark(pm, x + width / 2.0, track[1] + arrow / 2.0, 0, color, scale);
    arrow_mark(pm, x + width / 2.0, track[3] - arrow / 2.0, 1, color, scale);
}

/// The horizontal one, along the bottom edge.
pub fn scrollbar_h(pm: &mut PixmapMut, track: [f32; 4], content: f32, viewport: f32, offset: f32, color: Rgba, scale: f32) {
    let y = track[3] - 9.0 * scale;
    let height = 7.0 * scale;
    let arrow = 12.0 * scale;
    let (left, right) = (track[0] + arrow, track[2] - arrow);
    if right <= left || content <= viewport {
        return;
    }
    let length = ((right - left) * viewport / content).max(16.0 * scale);
    let at = left + (right - left - length) * (offset / (content - viewport)).clamp(0.0, 1.0);
    fill_device(pm, [at, y, at + length, y + height], 3.5 * scale, color);
    arrow_mark(pm, track[0] + arrow / 2.0, y + height / 2.0, 2, color, scale);
    arrow_mark(pm, track[2] - arrow / 2.0, y + height / 2.0, 3, color, scale);
}

fn fill_device(pm: &mut PixmapMut, r: [f32; 4], radius: f32, color: Rgba) {
    if let Some(path) = rounded_path(r, radius) {
        let mut paint = Paint::default();
        paint.set_color(color.skia());
        paint.anti_alias = true;
        pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

/// A small solid triangle: 0 up, 1 down, 2 left, 3 right.
fn arrow_mark(pm: &mut PixmapMut, cx: f32, cy: f32, direction: u8, color: Rgba, scale: f32) {
    let (a, b) = (3.5 * scale, 2.0 * scale);
    let mut pb = PathBuilder::new();
    match direction {
        0 => { pb.move_to(cx - a, cy + b); pb.line_to(cx + a, cy + b); pb.line_to(cx, cy - b); }
        1 => { pb.move_to(cx - a, cy - b); pb.line_to(cx + a, cy - b); pb.line_to(cx, cy + b); }
        2 => { pb.move_to(cx + b, cy - a); pb.line_to(cx + b, cy + a); pb.line_to(cx - b, cy); }
        _ => { pb.move_to(cx - b, cy - a); pb.line_to(cx - b, cy + a); pb.line_to(cx + b, cy); }
    }
    pb.close();
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(color.skia());
        paint.anti_alias = true;
        pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

/// An `<input>`'s line: the selection behind the text, the text scrolled so the caret stays in
/// view, and a 1px caret - or the placeholder when there is nothing typed.
#[allow(clippy::too_many_arguments)]
fn paint_area(ui: &mut Ui, pm: &mut PixmapMut, field: &Field, scroll: f32, content: [f32; 4], clip: [f32; 4], scale: f32, opacity: f32) {
    let clip = intersect(content, clip);
    let device_clip = clip.map(|v| v * scale);
    let mut style = field.style.clone();
    style.size *= scale;
    style.line_height *= scale;
    style.color = style.color.alpha(opacity);
    let lh = field.style.line_height;
    if field.value.is_empty() {
        let mut placeholder = style.clone();
        placeholder.color = field.placeholder_color.alpha(opacity);
        ui.text.draw(pm, &field.placeholder, &placeholder, content[0] * scale, content[1] * scale, device_clip);
    }
    let lines = area_lines(&mut ui.text, &field.value, &field.style, content[2] - content[0]);
    let (lo, hi) = (field.caret.min(field.anchor), field.caret.max(field.anchor));
    for (i, (from, to)) in lines.iter().copied().enumerate() {
        let top = content[1] + i as f32 * lh - scroll;
        if top + lh < clip[1] || top > clip[3] {
            continue;
        }
        let x_of = |ui: &mut Ui, at: usize| ui.text.width(&field.value[from..at.clamp(from, to)], &field.style);
        if field.focused && lo != hi && hi >= from && lo <= to {
            let (a, b) = (x_of(ui, lo.max(from)), x_of(ui, hi.min(to)) + if hi > to { 4.0 } else { 0.0 });
            fill_rect(pm, [content[0] + a, top, content[0] + b, top + lh], clip, 0.0, field.selection.alpha(opacity), scale);
        }
        ui.text.draw(pm, &field.value[from..to], &style, content[0] * scale, (top * scale).round(), device_clip);
        // The caret belongs to the line it starts, except at the very end of a soft-wrapped one.
        let next_from = lines.get(i + 1).map(|l| l.0);
        let here = field.caret >= from && field.caret <= to && !(field.caret == to && next_from == Some(to) && to > from);
        if field.focused && here {
            let x = ((content[0] + x_of(ui, field.caret)) * scale).round() / scale;
            fill_rect(pm, [x, top, x + 1.0 / scale, top + lh], clip, 0.0, field.style.color.alpha(opacity), scale);
        }
    }
}

fn paint_input(ui: &mut Ui, pm: &mut PixmapMut, field: &Field, content: [f32; 4], clip: [f32; 4], scale: f32, opacity: f32) {
    let mut style = field.style.clone();
    style.size *= scale;
    style.line_height *= scale;
    style.color = style.color.alpha(opacity);
    let left = content[0] * scale;
    let available = (content[2] - content[0]) * scale;
    let top = (((content[1] + content[3]) / 2.0) * scale - style.line_height / 2.0).round();
    let device_clip = intersect(content, clip).map(|v| v * scale);
    if field.value.is_empty() {
        let mut placeholder = style.clone();
        placeholder.color = field.placeholder_color.alpha(opacity);
        let shown = ui.text.fit(&field.placeholder, &placeholder, available);
        ui.text.draw(pm, &shown, &placeholder, left, top, device_clip);
    } else {
        let at = |ui: &mut Ui, offset: usize| {
            let offset = offset.min(field.value.len());
            if field.value.is_char_boundary(offset) { ui.text.width(&field.value[..offset], &style) } else { 0.0 }
        };
        let caret = at(ui, field.caret);
        let anchor = at(ui, field.anchor);
        // Scrolled just far enough to keep the caret inside the box, as a browser does.
        let shift = (caret - available + scale).max(0.0);
        if field.focused && field.caret != field.anchor {
            let (from, to) = (caret.min(anchor) - shift, caret.max(anchor) - shift);
            fill_rect(pm, [(left + from) / scale, top / scale, (left + to) / scale, (top + style.line_height) / scale], clip, 0.0, field.selection.alpha(opacity), scale);
        }
        ui.text.draw(pm, &field.value, &style, left - shift, top, device_clip);
        if field.focused {
            let x = (left + caret - shift).round() / scale;
            fill_rect(pm, [x, top / scale, x + 1.0 / scale, (top + style.line_height) / scale], clip, 0.0, field.style.color.alpha(opacity), scale);
        }
        return;
    }
    if field.focused {
        let x = left.round() / scale;
        fill_rect(pm, [x, top / scale, x + 1.0 / scale, (top + style.line_height) / scale], clip, 0.0, field.style.color.alpha(opacity), scale);
    }
}
