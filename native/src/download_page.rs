//! The YT2MP3 page (`DownloadPage.tsx`): paste a link, see what it is, download it into the
//! one folder downloads always land in. A page rather than a dialog, so a download can run
//! while you browse.

use crate::screen::{style, Action, SearchBox, State};
use crate::theme::Theme;
use crate::ui::text::TextStyle;
use crate::ui::tree::{col, div, icon, image_sized, input, text, El, Field};
use resvg::tiny_skia::Pixmap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Clone, Debug)]
pub struct Job {
    pub phase: &'static str,
    pub percent: Option<f32>,
    pub title: Option<String>,
}

#[derive(Default)]
pub struct YoutubeState {
    pub link: SearchBox,
    /// None while checking; the version, or why it is not usable (None: not installed).
    pub tool: Option<Result<String, Option<String>>>,
    pub installing: Option<f32>,
    pub info: Option<crate::youtube::Info>,
    pub thumb: Option<Rc<Pixmap>>,
    pub probing: bool,
    pub problem: Option<String>,
    pub job: Option<Job>,
    /// What this sitting pulled down, newest first.
    pub got: Vec<PathBuf>,
    pub generation: u64,
    pub scroll: f32,
    /// The page's paragraphs, wrapped by the app to the width they are drawn at.
    pub wrapped: HashMap<&'static str, Vec<String>>,
}

impl YoutubeState {
    pub fn ready(&self) -> bool {
        matches!(self.tool, Some(Ok(_)))
    }

    pub fn can_download(&self) -> bool {
        self.ready() && self.job.is_none() && self.info.as_ref().is_some_and(|i| !i.playlist)
    }
}

/// The column's width: `max-w-[640px]` inside `px-5`.
pub fn column_width(middle: f32) -> f32 {
    (middle - 40.0).min(640.0)
}

/// The paragraphs the app wraps: key, text, size, width.
pub fn paragraphs(middle: f32) -> Vec<(&'static str, &'static str, f32, f32)> {
    let inner = column_width(middle) - 26.0;
    vec![
        (
            "install",
            "This needs yt-dlp, which umakbang downloads once and then keeps up to date by itself. It lands beside umakbang’s own data, not in your library, so it survives an update and a portable copy carries it.",
            11.5,
            inner,
        ),
        ("lands", "Always the same folder, so a download is never somewhere you have to go looking for. File them out of it from the library.", 11.0, inner),
        (
            "saved",
            "MP3 is what most people mean by this. The original stream is strictly better audio - it is what came down, with no second lossy generation over it - and it arrives as m4a or webm. Video keeps the picture as well, as an MP4 that opens in any editor; nothing in it is re-encoded.",
            11.0,
            inner,
        ),
        ("sitting", "Not a history - the files are in the library, which is the record. This is only so the one you just pulled down is a click away.", 11.0, inner),
    ]
}

fn lines(s: &State, key: &str, size: f32, color: crate::ui::color::Rgba, relaxed: bool) -> El<Action> {
    let mut c = col().min_w(0.0);
    let line_height = if relaxed { size * 1.625 } else { size * 1.5 };
    for line in s.youtube.wrapped.get(key).into_iter().flatten() {
        c = c.child(text(line.clone(), TextStyle { line_height, ..style(size, 400, color) }));
    }
    c
}

fn section(t: &Theme) -> El<Action> {
    col().rounded(6.0).border(t.border, 1.0).bg(t.card.alpha(0.4))
}

fn header(s: &State, t: &Theme, title: &str, key: &str) -> El<Action> {
    col().px(12.0).py(8.0).border_b(t.border).child(text(title.to_string(), style(12.5, 600, t.foreground))).child(lines(s, key, 11.0, t.muted_foreground, false))
}

/// A shadcn button: `variant` is "default", "outline" or "ghost"; `sm` is the small size.
fn button(t: &Theme, variant: &str, sm: bool, enabled: bool, glyph: Option<&'static str>, label: &str, action: Action) -> El<Action> {
    let fg = if variant == "default" { t.primary_foreground } else { t.foreground };
    let mut b = div()
        .h(if sm { 24.0 } else { 28.0 })
        .px(if sm { 8.0 } else { 10.0 })
        .items_center()
        .justify_center()
        .gap(6.0)
        .rounded(6.0)
        .opacity(if enabled { 1.0 } else { 0.4 });
    b = match variant {
        "default" => b.bg(t.primary).maybe(enabled, |el| el.hover_bg(t.primary.alpha(0.9))),
        "outline" => b.border(t.border, 1.0).maybe(enabled, |el| el.hover_bg(t.accent)),
        _ => b.maybe(enabled, |el| el.hover_bg(t.accent)),
    };
    if enabled {
        b = b.on(action);
    }
    if let Some(glyph) = glyph {
        b = b.child(icon(glyph, if sm { 12.0 } else { 14.0 }, fg));
    }
    b.child(text(label.to_string(), style(if sm { 12.0 } else { 12.5 }, 500, fg)))
}

/// A native `<select>`: the chosen option and the arrow; a press opens the options.
fn select(t: &Theme, width: f32, label: &str, action: Action) -> El<Action> {
    div()
        .w(width)
        .h(28.0)
        .items_center()
        .px(8.0)
        .rounded(6.0)
        .border(t.border, 1.0)
        .bg(t.background)
        .hover_bg(t.accent)
        .on(action)
        .child(text(label.to_string(), style(12.0, 400, t.foreground)).grow())
        .child(icon("chevron-down", 14.0, t.foreground))
}

pub fn page(s: &State, t: &Theme, middle: f32) -> El<Action> {
    let y = &s.youtube;
    let width = column_width(middle);
    let bar = div()
        .h(37.0)
        .shrink0()
        .items_center()
        .gap(8.0)
        .px(12.0)
        .border_b(t.border)
        .child(icon("cloud-download", 14.0, t.muted_foreground))
        .child(text("YT2MP3", style(12.5, 500, t.foreground)))
        .child(div().ml_auto().size(24.0, 24.0).items_center().justify_center().rounded(6.0).hover_bg(t.accent).on(Action::Yt("close")).child(icon("x", 14.0, t.foreground)));

    let mut column = col().w(width).gap(12.0);
    match &y.tool {
        None => column = column.child(text("Checking…", style(12.0, 400, t.muted_foreground))),
        Some(Err(problem)) => {
            let label = match y.installing {
                Some(p) if p > 0.0 => format!("Downloading… {}%", p.round()),
                Some(_) => "Downloading…".into(),
                None => "Install the downloader".into(),
            };
            let mut box_ = section(t)
                .px(12.0)
                .py(12.0)
                .gap(8.0)
                .child(text("One thing to fetch first", style(12.5, 600, t.foreground)))
                .child(lines(s, "install", 11.5, t.muted_foreground, true));
            if let Some(problem) = problem {
                box_ = box_.child(text(problem.clone(), style(11.0, 400, t.destructive)));
            }
            column = column.child(box_.child(div().child(button(t, "default", true, y.installing.is_none(), y.installing.map(|_| "loader2"), &label, Action::Yt("install")))));
        }
        Some(Ok(version)) => {
            // The link, what it is, and the button.
            let field = Field {
                value: y.link.value.clone(),
                placeholder: "https://…".into(),
                caret: y.link.caret,
                anchor: y.link.anchor,
                focused: y.link.focused,
                style: TextStyle { line_height: 16.0, ..style(12.5, 400, t.foreground) },
                placeholder_color: t.muted_foreground.alpha(0.7),
                selection: t.selection,
            };
            let ring = if y.link.focused { t.ring } else { t.input };
            let mut first = section(t)
                .px(12.0)
                .py(12.0)
                .gap(10.0)
                .child(
                    col()
                        .child(text("Link", style(10.5, 400, t.muted_foreground.alpha(0.8))).mb(4.0))
                        .child(div().h(32.0).items_center().px(8.0).rounded(6.0).border(ring, 1.0).bg(t.background).maybe(y.link.focused, |el| el.shadow(0.0, 0.0, 0.0)).on(Action::Yt("link")).child(input(field).grow().h_full())),
                );
            if y.probing {
                first = first.child(div().items_center().gap(6.0).child(icon("loader2", 12.0, t.muted_foreground)).child(text("Reading the link…", style(11.5, 400, t.muted_foreground))));
            }
            let warning = |message: String| div().rounded(4.0).border(t.destructive.alpha(0.4), 1.0).bg(t.destructive.alpha(0.1)).px(8.0).py(6.0).child(text(message, style(11.0, 400, t.destructive)));
            if let Some(problem) = &y.problem {
                first = first.child(warning(problem.clone()));
            }
            if let Some(info) = &y.info {
                if info.playlist {
                    first = first.child(warning(format!("That link is a playlist{}. Paste a link to a single video.", info.count.map_or(String::new(), |c| format!(" of {c} videos")))));
                } else {
                    let sub: Vec<String> = [Some(info.uploader.clone()).filter(|u| !u.is_empty()), Some(info.seconds.map_or("live".into(), crate::columns::duration))].into_iter().flatten().collect();
                    first = first.child(
                        div()
                            .gap(10.0)
                            .rounded(4.0)
                            .border(t.border, 1.0)
                            .bg(t.background.alpha(0.4))
                            .p(8.0)
                            .maybe(y.thumb.is_some(), |el| el.child(image_sized(y.thumb.clone().expect("thumb"), 96.0, 54.0)))
                            .child(col().min_w(0.0).grow().child(text(info.title.clone(), style(12.5, 500, t.foreground))).child(text(sub.join(" · "), style(11.0, 400, t.muted_foreground)))),
                    );
                }
            }
            first = first.child(
                div().w_full().child(
                    button(t, "default", false, y.can_download(), Some(if y.job.is_some() { "loader2" } else { "download" }), "Download", Action::Yt("download")).grow(),
                ),
            );
            if let Some(job) = &y.job {
                let phase = match job.phase {
                    "converting" => "encoding",
                    "merging" => "joining picture and sound",
                    other => other,
                };
                first = first.child(
                    col()
                        .gap(4.0)
                        .rounded(4.0)
                        .border(t.border, 1.0)
                        .bg(t.background.alpha(0.4))
                        .px(8.0)
                        .py(8.0)
                        .child(
                            div()
                                .items_center()
                                .gap(6.0)
                                .child(icon("loader2", 12.0, t.foreground))
                                .child(text(job.title.clone().unwrap_or_else(|| "Working…".into()), style(11.5, 400, t.foreground)).grow())
                                .child(button(t, "ghost", true, true, None, "Stop", Action::Yt("stop")).h(20.0)),
                        )
                        .child(text(format!("{phase}{}", job.percent.map_or(String::new(), |p| format!(" · {}%", p.round()))), style(10.5, 400, t.muted_foreground.alpha(0.7)))),
                );
            }
            column = column.child(first);

            // Where it lands.
            let dir = crate::youtube::download_dir();
            column = column.child(
                section(t).child(header(s, t, "Where it lands", "lands")).child(
                    div()
                        .items_center()
                        .gap(8.0)
                        .px(12.0)
                        .py(10.0)
                        .child(text(dir.display().to_string(), TextStyle { font: crate::ui::text::Font::Mono, ..style(11.5, 400, t.foreground) }).grow())
                        .child(button(t, "outline", true, true, Some("folder-open"), "Show", Action::YtShow(None))),
                ),
            );

            // Saved as.
            let s_ = &s.youtube_settings;
            let format_label = match s_.0.as_str() {
                "source" => "The original stream",
                "video" => "Video (MP4)",
                _ => "MP3",
            };
            column = column.child(
                section(t).child(header(s, t, "Saved as", "saved")).child(
                    div()
                        .wrap()
                        .items_center()
                        .gap(8.0)
                        .px(12.0)
                        .py(10.0)
                        .child(select(t, 140.0, format_label, Action::Yt("format")))
                        .maybe(s_.0 == "mp3", |el| el.child(select(t, 85.0, &format!("{} kbps", s_.1), Action::Yt("bitrate"))))
                        .child(text(format!("yt-dlp {version}"), style(11.0, 400, t.muted_foreground))),
                ),
            );

            if !y.got.is_empty() {
                let mut list = col();
                for (i, path) in y.got.iter().enumerate() {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    list = list.child(
                        div()
                            .items_center()
                            .gap(8.0)
                            .px(12.0)
                            .py(6.0)
                            .maybe(i + 1 < y.got.len(), |el| el.border_b(t.border))
                            .child(text(name, style(12.0, 400, t.foreground)).grow())
                            .child(button(t, "ghost", true, true, Some("folder-open"), "Show", Action::YtShow(Some(i)))),
                    );
                }
                column = column.child(section(t).child(header(s, t, "This sitting", "sitting")).child(list));
            }
        }
    }

    col().grow().min_w(0.0).min_h0().child(bar).child(
        div()
            .grow()
            .min_w(0.0)
            .min_h0()
            .scroll_named("youtube", y.scroll)
            .scrollbar(t.border)
            .items_start()
            .child(div().grow().min_w(0.0).justify_center().px(20.0).py(16.0).child(column)),
    )
}

/// The thumbnail at `96x54` device-scaled, cropped to cover and rounded (`object-cover
/// rounded`), ready to be drawn at its own pixels.
pub fn thumb_pixmap(w: u32, h: u32, rgba: Vec<u8>, scale: f32) -> Option<Pixmap> {
    use resvg::tiny_skia::{FillRule, FilterQuality, IntSize, Paint, PathBuilder, Pattern, Rect, SpreadMode, Transform};
    let source = Pixmap::from_vec(rgba, IntSize::from_wh(w, h)?)?;
    let (tw, th) = ((96.0 * scale).round(), (54.0 * scale).round());
    let mut out = Pixmap::new(tw as u32, th as u32)?;
    let k = (tw / w as f32).max(th / h as f32);
    let (dx, dy) = ((tw - w as f32 * k) / 2.0, (th - h as f32 * k) / 2.0);
    let shader = Pattern::new(source.as_ref(), SpreadMode::Pad, FilterQuality::Bicubic, 1.0, Transform::from_row(k, 0.0, 0.0, k, dx, dy));
    let r = 4.0 * scale;
    let mut pb = PathBuilder::new();
    pb.move_to(r, 0.0);
    pb.line_to(tw - r, 0.0);
    pb.quad_to(tw, 0.0, tw, r);
    pb.line_to(tw, th - r);
    pb.quad_to(tw, th, tw - r, th);
    pb.line_to(r, th);
    pb.quad_to(0.0, th, 0.0, th - r);
    pb.line_to(0.0, r);
    pb.quad_to(0.0, 0.0, r, 0.0);
    pb.close();
    let path = pb.finish().or_else(|| Some(PathBuilder::from_rect(Rect::from_xywh(0.0, 0.0, tw, th)?)))?;
    let paint = Paint { shader, anti_alias: true, ..Paint::default() };
    out.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    Some(out)
}
