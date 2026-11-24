//! The first run (`Tutorial.tsx`): seven steps over about twenty seconds, each pointing at the
//! real chrome. It runs itself - a Next button is pressed seven times without anything being
//! read - with Skip on screen throughout and Escape bound to the same. Nothing is blocked: the
//! dim and the ring take no clicks, so a step can be tried as it is described.

use crate::screen::{style, tnum, Action, State};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::tree::{col, div, para, text, El};

pub const STEP_MS: u128 = 3000;

pub struct Step {
    pub target: &'static str,
    pub title: &'static str,
    pub body: &'static str,
}

pub const STEPS: [Step; 7] = [
    Step { target: "sidebar", title: "Your library", body: "Every folder underneath what you opened, plus saved views: rated, downloads, all files." },
    Step { target: "table", title: "Click, then click again", body: "One click selects. Clicking the selected row plays it, or opens a folder. Space pauses." },
    Step { target: "search", title: "Ask, don\u{2019}t scroll", body: "Names, or questions: bpm>140, key:Cm, ext:wav, tag:keeper, stars:4-5." },
    Step { target: "tags", title: "Tag as you go", body: "Press T on a selection to tag it. Click a tag to filter; click a second to narrow." },
    Step { target: "random", title: "Dig", body: "R plays something at random from anywhere in the library and takes you to it." },
    Step { target: "transport", title: "What\u{2019}s playing", body: "Drag across the waveform to loop a section, and save that stretch as its own file." },
    Step { target: "settings", title: "That\u{2019}s the whole app", body: "Colours, shortcuts, key detection, backups and stems are behind the cog." },
];

#[derive(Clone, Debug)]
pub struct Tour {
    pub index: usize,
    /// How far through this step, 0..1, for the bar.
    pub progress: f32,
    /// What it points at, in logical pixels; None draws the dim alone.
    pub target: Option<[f32; 4]>,
}

const CARD_WIDTH: f32 = 300.0;
const CARD_GAP: f32 = 12.0;

pub fn overlay(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let Some(tour) = &s.tour else { return Vec::new() };
    let step = &STEPS[tour.index.min(STEPS.len() - 1)];
    let (w, h) = viewport;
    let dim = Rgba::rgb8(0, 0, 0).alpha(0.55);
    let mut out = Vec::new();
    // The frame clamped to the window: the sidebar starts hard against the left edge, and an
    // unclamped ring there reads as a drawing mistake.
    let spot = tour.target.map(|r| {
        let (top, left) = ((r[1] - 6.0).max(2.0), (r[0] - 6.0).max(2.0));
        [left, top, (r[2] + 6.0).min(w - 2.0), (r[3] + 6.0).min(h - 2.0)]
    });
    match spot {
        Some([l, tp, r, b]) => {
            // The dim as four panels round the hole: none of them takes a click.
            out.push(div().absolute(0.0, 0.0).w(w).h(tp).bg(dim));
            out.push(div().absolute(0.0, b).w(w).h((h - b).max(0.0)).bg(dim));
            out.push(div().absolute(0.0, tp).w(l).h(b - tp).bg(dim));
            out.push(div().absolute(r, tp).w((w - r).max(0.0)).h(b - tp).bg(dim));
            out.push(div().absolute(l, tp).w(r - l).h(b - tp).rounded(8.0).border(t.primary.alpha(0.7), 2.0));
        }
        None => out.push(div().absolute(0.0, 0.0).w(w).h(h).bg(dim)),
    }
    let card_height = 150.0;
    let (top, left) = match spot {
        None => (h / 2.0 - 75.0, w / 2.0 - CARD_WIDTH / 2.0),
        Some([l, tp, r, b]) => {
            let below = b + CARD_GAP + card_height < h;
            let top = if below { b + CARD_GAP } else { (tp - card_height - CARD_GAP).max(CARD_GAP) };
            let left = ((l + r) / 2.0 - CARD_WIDTH / 2.0).max(CARD_GAP).min(w - CARD_WIDTH - CARD_GAP);
            (top, left)
        }
    };
    let bar = div().h(3.0).grow().rounded(1.5).bg(t.secondary).clip().child(div().h(3.0).w((CARD_WIDTH - 24.0 - 44.0) * tour.progress.clamp(0.0, 1.0)).rounded(1.5).bg(t.primary));
    out.push(
        col()
            .absolute(left.round(), top.round())
            .w(CARD_WIDTH)
            .p(12.0)
            .rounded(8.0)
            .border(t.border.alpha(0.8), 1.0)
            .bg(t.card.alpha(0.95))
            .shadow(8.0, 24.0, 0.3)
            .child(div().justify_between().gap(8.0).items_center().child(text(step.title, style(13.0, 500, t.foreground))).child(text(format!("{}/{}", tour.index + 1, STEPS.len()), tnum(10.5, 400, t.muted_foreground.alpha(0.6))).shrink0()))
            .child(para(step.body, crate::ui::text::TextStyle { line_height: 18.7, ..style(11.5, 400, t.muted_foreground) }).mt(4.0))
            .child(
                div()
                    .mt(10.0)
                    .gap(8.0)
                    .items_center()
                    .child(bar)
                    .child(div().px(6.0).py(2.0).rounded(4.0).hover_bg(t.accent).on(Action::TourSkip).child(text("Skip", style(11.0, 400, t.muted_foreground)))),
            ),
    );
    out
}
