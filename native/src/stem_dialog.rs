//! The gate in front of a split (`StemDialog.tsx`): which files, how many minutes of audio,
//! how many the account has left, where the stems will land - then nothing happens until
//! "Upload and split" is pressed. An action with a price should not be one click from a menu.

use crate::screen::{style, tnum, Action, State};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::tree::{col, div, icon, para, text, El};

/// The Stems settings as the dialog and the Settings page read them.
#[derive(Clone, Debug, Default)]
pub struct StemSettings {
    pub key: String,
    pub output_dir: String,
    pub format: String,
    pub splitter: String,
    /// What Check last heard from the account, and whether it is asking now.
    pub minutes: Option<Option<f64>>,
    pub checking: bool,
}

pub struct StemDialog {
    pub paths: Vec<String>,
    pub names: Vec<String>,
    pub durations: Vec<Option<f64>>,
    /// None while asking the account; then what it said, or None if it would not.
    pub minutes: Option<Option<f64>>,
}

#[derive(Clone, Debug)]
pub struct StemJob {
    pub path: String,
    pub phase: &'static str,
    pub percent: Option<f64>,
    pub done: usize,
    pub total: usize,
}

fn line(t: &Theme, label: &str, value: El<Action>) -> El<Action> {
    div().items_center().justify_between().gap(12.0).child(text(label.to_string(), style(12.0, 400, t.muted_foreground)).shrink0()).child(value.min_w(0.0))
}

fn button(t: &Theme, variant: &str, enabled: bool, glyph: Option<&'static str>, label: &str, action: Action) -> El<Action> {
    let (bg, fg) = match variant {
        "default" => (Some(t.primary), t.primary_foreground),
        "secondary" => (Some(t.secondary), t.secondary_foreground),
        _ => (None, t.foreground),
    };
    let mut b = div().h(24.0).px(8.0).items_center().gap(6.0).rounded(6.0).opacity(if enabled { 1.0 } else { 0.4 });
    if let Some(bg) = bg {
        b = b.bg(bg);
    }
    if enabled {
        b = b.hover_bg(if variant == "ghost" { t.accent } else { bg.unwrap_or(t.accent).alpha(0.9) }).on(action);
    }
    if let Some(glyph) = glyph {
        b = b.child(icon(glyph, 14.0, fg));
    }
    b.child(text(label.to_string(), style(12.0, 500, fg)))
}

fn base_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

pub fn dialog(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let Some(d) = &s.stem_dialog else { return Vec::new() };
    let settings = &s.stem_settings;
    let configured = !settings.key.trim().is_empty() && !settings.output_dir.trim().is_empty();
    let running = s.stem_job.is_some();
    let seconds: f64 = d.durations.iter().flatten().sum();
    let unknown = d.durations.iter().filter(|x| x.is_none()).count();
    let minutes = seconds / 60.0;
    let short = matches!(d.minutes, Some(Some(left)) if left < minutes);
    let width = 440f32.min(viewport.0 - 32.0);

    let mut body = col().gap(10.0).px(16.0).py(12.0);
    if !configured {
        body = body.child(para("Set your LALAL.AI key and an output folder in Settings first.", style(12.0, 400, t.muted_foreground)));
    } else {
        let mut audio = div().items_center().child(text(if minutes < 1.0 { "<1 minute".to_string() } else { format!("{minutes:.1} minutes") }, style(12.0, 400, t.foreground)));
        if unknown > 0 {
            audio = audio.child(text(format!(" (+{unknown} of unknown length)"), style(12.0, 400, t.muted_foreground.alpha(0.6))));
        }
        let left = match d.minutes {
            None => "checking…".to_string(),
            Some(None) => "could not be read".to_string(),
            Some(Some(m)) => format!("{m:.1}"),
        };
        let folder = base_name(&settings.output_dir);
        let tail = if d.names.len() == 1 { format!(" / {}", d.names[0]) } else { " / one folder each".to_string() };
        body = body
            .child(line(t, "Audio to process", audio))
            .child(line(t, "Minutes on account", text(left, style(12.0, 400, t.foreground))))
            .child(line(t, "Stems written to", div().min_w(0.0).child(text(folder, style(12.0, 400, t.foreground)).shrink0()).child(text(tail, style(12.0, 400, t.muted_foreground.alpha(0.6))))))
            .child(line(t, "Format", text(settings.format.to_uppercase(), style(12.0, 400, t.foreground))));
        if short {
            body = body.child(
                div()
                    .rounded(4.0)
                    .border(t.destructive.alpha(0.4), 1.0)
                    .bg(t.destructive.alpha(0.1))
                    .px(8.0)
                    .py(6.0)
                    .child(para("That is more audio than the account has minutes for. The service will refuse whatever it can't cover.", style(11.0, 400, t.destructive))),
            );
        }
        if d.names.len() > 1 {
            let mut list = col().rounded(4.0).border(t.border, 1.0).bg(t.card.alpha(0.4)).px(8.0).py(6.0).max_h(110.0).clip();
            for (name, seconds) in d.names.iter().zip(&d.durations) {
                list = list.child(
                    div()
                        .justify_between()
                        .gap(8.0)
                        .child(text(name.clone(), style(11.0, 400, t.muted_foreground)).grow())
                        .child(text(seconds.map_or(String::new(), crate::columns::duration), tnum(11.0, 400, t.muted_foreground)).shrink0()),
                );
            }
            body = body.child(list);
        }
    }
    if let Some(job) = &s.stem_job {
        body = body.child(
            col()
                .gap(4.0)
                .rounded(4.0)
                .border(t.border, 1.0)
                .bg(t.card.alpha(0.4))
                .px(8.0)
                .py(8.0)
                .child(
                    div()
                        .items_center()
                        .gap(6.0)
                        .child(icon("loader2", 12.0, t.foreground))
                        .child(text(base_name(&job.path), style(11.5, 400, t.foreground)).grow())
                        .child(text(format!("{}/{}", job.done, job.total), style(11.5, 400, t.muted_foreground)).shrink0()),
                )
                .child(text(format!("{}{}", job.phase, job.percent.map_or(String::new(), |p| format!(" · {}%", p.round()))), style(10.5, 400, t.muted_foreground.alpha(0.7)))),
        );
    }
    let description = if d.names.len() == 1 { d.names[0].clone() } else { format!("{} files", d.names.len()) };
    let mut footer = div().items_center().justify_end().gap(6.0).px(16.0).py(10.0).border_t(t.border);
    if !configured {
        footer = footer.child(button(t, "secondary", true, None, "Open settings", Action::Stems("settings")));
    }
    footer = footer
        .child(button(t, "ghost", true, None, if running { "Close" } else { "Cancel" }, Action::Stems("cancel")))
        .child(button(t, "default", configured && !running, Some(if running { "loader2" } else { "upload" }), "Upload and split", Action::Stems("split")));
    let panel = col()
        .w(width)
        .rounded(8.0)
        .border(t.border, 1.0)
        .bg(t.popover)
        .shadow(16.0, 40.0, 0.35)
        .child(
            col()
                .px(16.0)
                .py(12.0)
                .border_b(t.border)
                .child(text("Split vocals", style(13.0, 500, t.popover_foreground)))
                .child(para(format!("{description} will be uploaded to LALAL.AI."), style(11.5, 400, t.muted_foreground))),
        )
        .child(body)
        .child(footer)
        .child(div().absolute(width - 34.0, 10.0).size(22.0, 22.0).items_center().justify_center().rounded(4.0).hover_bg(t.accent).on(Action::Stems("cancel")).child(icon("x", 14.0, t.muted_foreground)));
    // Centred on an estimate of its height; a few pixels either way do not show.
    let rows = if configured { 4 + usize::from(short) + usize::from(d.names.len() > 1) * 3 } else { 1 };
    let height = 62.0 + 24.0 + rows as f32 * 28.0 + if s.stem_job.is_some() { 52.0 } else { 0.0 } + 45.0;
    vec![
        div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).bg(Rgba::rgb8(0, 0, 0).alpha(0.5)).on(Action::Stems("cancel")),
        panel.absolute(((viewport.0 - width) / 2.0).round(), ((viewport.1 - height) / 2.0).max(8.0).round()),
    ]
}
