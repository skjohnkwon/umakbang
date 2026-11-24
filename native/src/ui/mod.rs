//! umakbang's own UI library: an element tree laid out by taffy, text by cosmic-text, icons by
//! resvg, all painted by tiny-skia on the CPU into a softbuffer window. See
//! docs/native-rewrite.md for why it is CPU-drawn and why it is ours.

pub mod color;
pub mod dwrite;
pub mod icons;
pub mod text;
pub mod tree;

pub struct Ui {
    pub text: text::Text,
    pub icons: icons::Icons,
    /// What the last full frame left under each live element, in paint order.
    pub backdrops: Vec<tree::Backdrop>,
    /// The device rectangles the last live frame repainted.
    pub damage: Vec<[u32; 4]>,
    /// For each scrolling box that names itself, its viewport and content heights as last
    /// laid out - what the app clamps that box's scroll by.
    pub extents: std::collections::HashMap<&'static str, (f32, f32)>,
    /// And where each of them is on screen, in logical pixels: what the wheel is over.
    pub scroll_rects: std::collections::HashMap<&'static str, [f32; 4]>,
    /// The spinners' angle in degrees (`animate-spin`: one turn a second), and whether the
    /// last full frame drew one - which is what keeps frames coming while it does.
    pub spin: f32,
    pub spinning: bool,
}

impl Ui {
    pub fn new() -> Ui {
        Ui { text: text::Text::new(), icons: icons::Icons::default(), backdrops: Vec::new(), damage: Vec::new(), extents: std::collections::HashMap::new(), scroll_rects: std::collections::HashMap::new(), spin: 0.0, spinning: false }
    }
}
