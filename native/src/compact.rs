//! The two shrunken windows (`MiniPlayer.tsx`, `VisualizerOnlyView.tsx`): the mini player, a
//! 300px square kept on top with the transport and nothing else; and the stage, a short wide
//! window that is only visualizers, side by side like a meter bridge, with the controls in an
//! overlay that fades in while the pointer is over it.

use crate::screen::{style, tnum, Action, State};
use crate::theme::Theme;
use crate::ui::tree::{col, div, icon, icon_filled, paint, text, El};

fn ghost(t: &Theme, glyph: &'static str, size: f32, box_: f32, enabled: bool, action: Action) -> El<Action> {
    let b = div().size(box_, box_).items_center().justify_center().rounded(6.0).opacity(if enabled { 1.0 } else { 0.4 }).child(icon(glyph, size, t.foreground));
    if enabled { b.hover_bg(t.accent).on(action) } else { b }
}

fn play_button(t: &Theme, playing: bool, enabled: bool, size: f32, glyph: f32) -> El<Action> {
    div()
        .size(size, size)
        .shrink0()
        .items_center()
        .justify_center()
        .rounded(size / 2.0)
        .bg(t.primary)
        .opacity(if enabled { 1.0 } else { 0.4 })
        .maybe(enabled, |el| el.hover_bg(t.primary.alpha(0.9)).on(Action::Play))
        .child(icon_filled(if playing { "pause" } else { "play" }, glyph, t.primary_foreground))
}

pub fn mini(s: &State, t: &Theme, viewport: (f32, f32)) -> El<Action> {
    let now = s.now.as_ref();
    let loaded = now.is_some();
    // Only the way back on the left: the caption buttons own the right of a 300px strip.
    let bar = div()
        .h(38.0)
        .shrink0()
        .items_center()
        .gap(6.0)
        .pl(6.0)
        .bg(t.background)
        .child(div().size(24.0, 24.0).items_center().justify_center().rounded(6.0).hover_bg(t.accent).on(Action::Tool("mini-exit")).child(icon("maximize2", 14.0, t.foreground)))
        .child(div().grow().h_full().on(Action::Drag).items_center().child(crate::screen::logo(t.primary.alpha(0.6), 14.0)))
        .child(crate::screen::caption_buttons_pub(s, t));
    let name = now.map_or("Nothing playing".to_string(), |n| n.file.name.clone());
    let place = now.map_or("Pick a track in the library".to_string(), |n| crate::table::parent_label_pub(&n.file.dir));
    let wave = match now {
        Some(now) => paint(crate::waveform::painter(now.wave.clone(), s.visuals.borrow().palette.clone(), s.visuals.borrow().ramp, t.primary, t.muted_foreground, t.background)).grow().w_full().live().on(Action::Seek),
        None => div().grow(),
    };
    let (time, total) = now.map_or((0.0, 0.0), |n| (n.time, n.duration));
    let body = col()
        .grow()
        .min_h0()
        .px(12.0)
        .pb(12.0)
        .pt(4.0)
        .justify_between()
        .on(Action::Drag)
        .child(col().min_w(0.0).child(text(name, style(13.0, 500, t.foreground))).child(text(place, style(11.0, 400, t.muted_foreground))))
        .child(div().grow().min_h0().py(8.0).child(wave))
        .child(div().justify_between().child(text(crate::screen::format_time_pub(time), tnum(10.5, 400, t.muted_foreground))).child(text(crate::screen::format_time_pub(total), tnum(10.5, 400, t.muted_foreground))))
        .child(
            div()
                .mt(6.0)
                .items_center()
                .justify_center()
                .gap(6.0)
                .child(ghost(t, "skip-back", 16.0, 36.0, loaded, Action::Previous))
                .child(play_button(t, now.is_some_and(|n| n.playing), loaded, 40.0, 16.0))
                .child(ghost(t, "skip-forward", 16.0, 36.0, loaded, Action::Next))
                .child(
                    div()
                        .ml(4.0)
                        .size(36.0, 36.0)
                        .items_center()
                        .justify_center()
                        .rounded(6.0)
                        .hover_bg(t.accent)
                        .on(Action::Volume)
                        .child(icon(if s.transport.muted { "volume-x" } else { "volume2" }, 14.0, if s.transport.muted { t.primary } else { t.foreground })),
                ),
        );
    col().w(viewport.0).h(viewport.1).bg(t.background).child(bar).child(body)
}

pub fn stage(s: &State, t: &Theme, viewport: (f32, f32)) -> El<Action> {
    let now = s.now.as_ref();
    let loaded = now.is_some();
    let chrome = 30.0;
    let mut root = col().w(viewport.0).h(viewport.1).bg(t.background).pt(chrome).child(crate::visualizers::stack(t, &s.visuals, true).p(4.0));
    // No title bar: this strip is what moves the window, left of the caption buttons.
    root = root.child(div().absolute(0.0, 0.0).w(viewport.0 - 138.0).h(chrome).on(Action::Drag));
    root = root.child(div().absolute(viewport.0 - 138.0, 0.0).h(chrome).child(crate::screen::caption_buttons_sized(s, t, chrome)));
    if s.stage_hover {
        let time = now.map_or(String::new(), |n| format!("{} / {}", crate::screen::format_time_pub(n.time), crate::screen::format_time_pub(n.duration)));
        let overlay = div()
            .absolute(0.0, viewport.1 - 52.0)
            .w(viewport.0)
            .h(52.0)
            .items_center()
            .gap(12.0)
            .px(16.0)
            .py(10.0)
            .bg(t.background.alpha(0.85))
            .child(crate::screen::logo(t.primary.alpha(0.7), 16.0))
            .child(
                div()
                    .items_center()
                    .gap(4.0)
                    .child(ghost(t, "skip-back", 14.0, 36.0, loaded, Action::Previous))
                    .child(play_button(t, now.is_some_and(|n| n.playing), loaded, 32.0, 14.0))
                    .child(ghost(t, "skip-forward", 14.0, 36.0, loaded, Action::Next)),
            )
            .child(text(now.map_or("Nothing playing".to_string(), |n| n.file.name.clone()), style(12.5, 500, t.foreground)).grow())
            .maybe(loaded, |el| el.child(text(time, tnum(11.0, 400, t.muted_foreground)).shrink0()))
            .child(
                div()
                    .items_center()
                    .gap(2.0)
                    .shrink0()
                    .child(ghost(t, "audio-lines", 14.0, 24.0, true, Action::Tool("stage")).bg(t.primary.alpha(0.15)))
                    .child(ghost(t, if s.always_on_top { "pin" } else { "pin-off" }, 14.0, 24.0, true, Action::Tool("pin"))),
            );
        root = root.child(overlay);
    }
    root
}
