//! Contracts (`ContractsPage.tsx`, `ContractDialog.tsx`): what has been generated, saved
//! purchasers, your own terms and the template, and the dialog a track's menu opens to draft
//! one - with the contract itself beside the form, laid out by the same code as the PDF.

use crate::contracts::{Data, Item, PageLayout, LINE_TOP};
use crate::form::{field, text_area};
use crate::screen::{style, Action, State};
use crate::theme::Theme;
use crate::ui::color::Rgba;
use crate::ui::text::{Font, TextStyle};
use crate::ui::tree::{col, div, icon, paint, para, text, El};
use resvg::tiny_skia::{FillRule, Paint, PathBuilder, PixmapMut, Stroke, Transform};
use std::rc::Rc;

pub const SECTIONS: [&str; 4] = ["Contracts", "Purchasers", "Your terms", "Template"];

/// The draft dialog's own state; its fields live in the form.
pub struct Draft {
    pub remember: bool,
    pub busy: bool,
    /// The contract as the preview pane shows it, and how far that pane is scrolled.
    pub preview: Rc<PageLayout>,
    pub preview_scroll: f32,
}

#[derive(Default)]
pub struct ContractsUi {
    pub section: usize,
    pub scroll: f32,
    pub data: Option<Rc<Data>>,
    pub draft: Option<Draft>,
}

/// The preview's frame: the dialog's right pane less its padding. The iframe's own scrollbar
/// and the body's 8px either side come off it before the text wraps.
pub const PREVIEW_WIDTH: f32 = 487.0;
pub const PREVIEW_SCROLLBAR: f32 = 17.0;
const PX: f32 = 4.0 / 3.0;

pub const TEMPLATE_STYLE_SIZE: f32 = 11.5;

pub fn template_style(t: &Theme) -> TextStyle {
    TextStyle { line_height: TEMPLATE_STYLE_SIZE * 1.625, font: Font::Mono, ..style(TEMPLATE_STYLE_SIZE, 400, t.foreground) }
}

pub fn titles_style(t: &Theme) -> TextStyle {
    TextStyle { line_height: 12.5 * 1.5, ..style(12.5, 400, t.foreground) }
}

fn section(t: &Theme, title: &str, hint: Option<String>, body: El<Action>) -> El<Action> {
    let mut header = col().px(12.0).py(8.0).border_b(t.border).child(text(title.to_string(), style(12.5, 600, t.foreground)));
    if let Some(hint) = hint {
        header = header.child(para(hint, style(11.0, 400, t.muted_foreground)));
    }
    col().rounded(6.0).border(t.border, 1.0).bg(t.card.alpha(0.4)).child(header).child(body.px(12.0).py(10.0).gap(10.0))
}

fn button(t: &Theme, variant: &str, enabled: bool, glyph: Option<&'static str>, label: &str, action: Action) -> El<Action> {
    let (bg, fg) = match variant {
        "default" => (Some(t.primary), t.primary_foreground),
        "secondary" => (Some(t.secondary), t.secondary_foreground),
        _ => (None, t.foreground),
    };
    let mut b = div().h(24.0).px(8.0).items_center().justify_center().gap(6.0).rounded(6.0).opacity(if enabled { 1.0 } else { 0.4 });
    if let Some(bg) = bg {
        b = b.bg(bg);
    }
    if enabled {
        b = b.hover_bg(match variant {
            "default" => t.primary.alpha(0.9),
            "secondary" => t.secondary.alpha(0.8),
            _ => t.accent,
        });
        b = b.on(action);
    }
    if let Some(glyph) = glyph {
        b = b.child(icon(glyph, 14.0, fg));
    }
    b.child(text(label.to_string(), style(12.0, 500, fg)))
}

fn icon_button(t: &Theme, glyph: &'static str, enabled: bool, action: Action) -> El<Action> {
    let b = div().size(24.0, 24.0).items_center().justify_center().rounded(6.0).opacity(if enabled { 1.0 } else { 0.4 }).child(icon(glyph, 14.0, t.foreground));
    if enabled { b.hover_bg(t.accent).on(action) } else { b }
}

pub fn page(s: &State, t: &Theme, middle: f32) -> El<Action> {
    let c = &s.contracts;
    let mut nav = col()
        .w(168.0)
        .shrink0()
        .border_r(t.border)
        .bg(t.card.alpha(0.3))
        .py(8.0)
        .child(
            div()
                .items_center()
                .gap(4.0)
                .px(12.0)
                .pb(4.0)
                .child(text("Contracts", style(10.0, 600, t.muted_foreground.alpha(0.7))))
                .child(div().ml_auto().size(16.0, 16.0).items_center().justify_center().rounded(2.0).hover_bg(t.accent).on(Action::Contracts("close")).child(icon("x", 12.0, t.muted_foreground.alpha(0.7)))),
        );
    for (i, label) in SECTIONS.iter().enumerate() {
        let on = c.section == i;
        nav = nav.child(
            div()
                .px(12.0)
                .py(6.0)
                .items_center()
                .maybe(on, |el| el.bg(t.accent))
                .maybe(!on, |el| el.hover_bg(t.accent.alpha(0.5)))
                .on(Action::ContractsSection(i))
                .child(text(label.to_string(), style(12.5, if on { 500 } else { 400 }, if on { t.foreground } else { t.muted_foreground }))),
        );
    }
    let available = middle - 168.0 - 1.0 - 40.0;
    let width = available.min(match c.section {
        0 => 640.0,
        3 => 760.0,
        _ => 560.0,
    });
    let body = match &c.data {
        None => col().child(text("Loading…", style(12.0, 400, t.muted_foreground))),
        Some(data) => match c.section {
            0 => history(s, t, data),
            1 => presets(s, t, data),
            2 => terms(s, t),
            _ => template(s, t, data),
        },
    };
    div().grow().min_w(0.0).min_h0().child(nav).child(
        div()
            .grow()
            .min_w(0.0)
            .min_h0()
            .scroll_named("contracts", c.scroll)
            .scrollbar(t.border)
            .items_start()
            .child(div().grow().min_w(0.0).justify_center().px(20.0).py(16.0).child(body.w(width).gap(12.0))),
    )
}

fn history(_s: &State, t: &Theme, data: &Data) -> El<Action> {
    let dir = if data.output_dir.is_empty() { "Not set".to_string() } else { data.output_dir.clone() };
    let mut generated = col();
    let count = data.history.len();
    for (i, record) in data.history.iter().enumerate() {
        let mut sub = format!(
            "{}{} · ${} · {}",
            record.input.customer,
            if record.input.alias.is_empty() { String::new() } else { format!(" ({})", record.input.alias) },
            record.input.price,
            record.when.replace('T', " ")
        );
        if record.pdf_error.is_some() {
            sub.push_str(" · PDF failed");
        }
        generated = generated.child(
            div()
                .items_center()
                .gap(8.0)
                .maybe(i + 1 < count, |el| el.border_b(t.border).pb(8.0).mb(8.0))
                .child(
                    col()
                        .min_w(0.0)
                        .grow()
                        .child(text(record.input.titles.join(" & "), style(12.5, 500, t.foreground)))
                        .child(text(sub, style(11.0, 400, if record.pdf_error.is_some() { t.destructive } else { t.muted_foreground }))),
                )
                .child(icon_button(t, "file-text", record.pdf_path.is_some(), Action::ContractRecord(i, 0)))
                .child(icon_button(t, "folder-open", true, Action::ContractRecord(i, 1)))
                .child(icon_button(t, "trash2", true, Action::ContractRecord(i, 2))),
        );
    }
    if count == 0 {
        generated = generated.child(text("Nothing generated yet.", style(12.0, 400, t.muted_foreground.alpha(0.7))));
    }
    col()
        .child(section(
            t,
            "Where they go",
            Some("Both the Markdown and the PDF land here.".into()),
            div().items_center().gap(8.0).child(text(dir, style(12.0, 400, t.foreground)).grow()).child(button(t, "secondary", true, None, "Change", Action::Contracts("change-dir"))),
        ))
        .child(section(
            t,
            "Generated",
            Some(if count == 0 { "Right-click a track in the library and choose Generate contract.".into() } else { format!("{count} kept, newest first.") }),
            generated,
        ))
}

fn presets(s: &State, t: &Theme, data: &Data) -> El<Action> {
    let mut body = col();
    for (i, p) in data.presets.iter().enumerate() {
        let sub = format!("{}{}", p.name, if p.email.is_empty() { String::new() } else { format!(" · {}", p.email) });
        body = body.child(
            div()
                .items_center()
                .gap(8.0)
                .child(col().min_w(0.0).grow().child(text(if p.alias.is_empty() { p.name.clone() } else { p.alias.clone() }, style(12.5, 400, t.foreground))).child(text(sub, style(11.0, 400, t.muted_foreground))))
                .child(icon_button(t, "trash2", true, Action::ContractPreset(i))),
        );
    }
    body = body.child(
        div()
            .items_center()
            .gap(6.0)
            .border_t(t.border)
            .pt(10.0)
            .child(field(s, t, "p.name", "Full name", 28.0).grow().w(0.0))
            .child(field(s, t, "p.alias", "Alias", 28.0).grow().w(0.0))
            .child(field(s, t, "p.email", "Email", 28.0).grow().w(0.0))
            .child(button(t, "default", true, None, "Add", Action::Contracts("add-preset"))),
    );
    col().child(section(t, "Purchasers", Some("Saved buyers, offered as one-click fills when a contract is drafted.".into()), body))
}

fn terms(s: &State, t: &Theme) -> El<Action> {
    let row = |label: &str, key: &'static str| {
        div().items_center().gap(12.0).child(text(label.to_string(), style(12.0, 400, t.muted_foreground)).w(130.0).shrink0()).child(field(s, t, key, "", 28.0).grow())
    };
    col().child(section(
        t,
        "Your terms",
        Some("Who you are and what governs the deal.".into()),
        col()
            .child(row("Full legal name", "t.fullName"))
            .child(row("Alias (p.k.a.)", "t.alias"))
            .child(row("Email", "t.email"))
            .child(row("Governing state", "t.governingState"))
            .child(row("Delivered as", "t.fileType")),
    ))
}

fn template(s: &State, t: &Theme, data: &Data) -> El<Action> {
    let changed = s.form.fields.get("tpl").is_some_and(|f| f.value != data.template);
    col().child(section(
        t,
        "Template",
        Some("The contract itself. {TOKENS} are filled in when one is generated; anything unknown is left alone.".into()),
        col()
            .child(text_area(s, t, "tpl", template_style(t), 420.0))
            .child(div().items_center().justify_end().gap(6.0).child(button(t, "ghost", changed, None, "Revert", Action::Contracts("revert"))).child(button(t, "default", changed, None, "Save template", Action::Contracts("save-template")))),
    ))
}

/* ------------------------------------------------------------------ the draft dialog */

pub fn titles_list(s: &State) -> Vec<String> {
    s.form.value("c.titles").lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

pub fn draft_ready(s: &State) -> bool {
    let price = s.form.value("c.price").trim();
    let numeric = !price.is_empty() && price.split_once('.').map_or(price.chars().all(|c| c.is_ascii_digit()), |(a, b)| !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()));
    !titles_list(s).is_empty() && !s.form.value("c.customer").trim().is_empty() && numeric
}

fn label(t: &Theme, words: &str, hint: Option<&str>) -> El<Action> {
    let mut row = div().items_center().gap(4.0).child(text(words.to_string(), style(11.0, 500, t.muted_foreground)));
    if let Some(hint) = hint {
        row = row.child(text(hint.to_string(), style(11.0, 400, t.muted_foreground.alpha(0.6))));
    }
    row
}

pub fn dialog(s: &State, t: &Theme, viewport: (f32, f32)) -> Vec<El<Action>> {
    let Some(draft) = &s.contracts.draft else { return Vec::new() };
    let data = s.contracts.data.clone();
    let titles = titles_list(s);
    let width = 980f32.min(viewport.0 - 32.0);
    let rows = titles.len().saturating_add(1).clamp(2, 5);
    let ready = draft_ready(s);
    let description = if titles.len() == 1 { format!("An exclusive sale of \"{}\".", titles[0]) } else { format!("An exclusive sale covering {} tracks as combined Masters.", titles.len()) };

    let mut form = col().w(460.0).shrink0().gap(12.0).px(16.0).py(12.0).border_r(t.border).child(
        col().gap(4.0).child(label(t, "Track titles", Some("One per line. Each becomes a named Master."))).child(text_area(s, t, "c.titles", titles_style(t), rows as f32 * 18.75 + 14.0)),
    );
    let presets = data.as_ref().map(|d| d.presets.clone()).unwrap_or_default();
    if !presets.is_empty() {
        let customer = s.form.value("c.customer");
        let mut chips = div().wrap().gap(4.0);
        for (i, p) in presets.iter().enumerate() {
            let on = customer == p.name;
            chips = chips.child(
                div()
                    .px(8.0)
                    .py(2.0)
                    .rounded(4.0)
                    .border(if on { t.primary } else { t.border.alpha(0.7) }, 1.0)
                    .maybe(on, |el| el.bg(t.primary.alpha(0.15)))
                    .maybe(!on, |el| el.hover_bg(t.accent))
                    .on(Action::ContractChip(i))
                    .child(text(if p.alias.is_empty() { p.name.clone() } else { p.alias.clone() }, style(11.5, 400, if on { t.foreground } else { t.muted_foreground }))),
            );
        }
        form = form.child(chips);
    }
    form = form
        .child(
            div()
                .gap(8.0)
                .child(col().gap(4.0).grow().w(0.0).child(label(t, "Purchaser", None)).child(field(s, t, "c.customer", "Full legal name", 28.0)))
                .child(col().gap(4.0).grow().w(0.0).child(label(t, "Alias", None)).child(field(s, t, "c.alias", "p.k.a.", 28.0))),
        )
        .child(
            div()
                .gap(8.0)
                .child(col().gap(4.0).grow().w(0.0).child(label(t, "Email", None)).child(field(s, t, "c.email", "where the files go", 28.0)))
                .child(col().gap(4.0).child(label(t, "Price (USD)", None)).child(field(s, t, "c.price", "", 28.0).w(92.0)))
                .child(
                    col().gap(4.0).child(label(t, "Your shares", Some("Writer / publisher, %"))).child(
                        div().items_center().gap(4.0).child(field(s, t, "c.writer", "", 28.0).w(52.0)).child(text("/", style(12.5, 400, t.muted_foreground))).child(field(s, t, "c.publisher", "", 28.0).w(52.0)),
                    ),
                ),
        )
        .child(
            div()
                .items_center()
                .gap(6.0)
                .on(Action::Contracts("remember"))
                .child(
                    div()
                        .size(13.0, 13.0)
                        .rounded(2.0)
                        .border(if draft.remember { t.primary } else { t.muted_foreground }, 1.0)
                        .maybe(draft.remember, |el| el.bg(t.primary).items_center().justify_center().child(icon("check", 10.0, t.primary_foreground))),
                )
                .child(icon("star", 12.0, t.muted_foreground))
                .child(text("Remember this purchaser", style(12.0, 400, t.muted_foreground))),
        )
        .child(para(
            format!("Written to {} as Markdown and PDF.", data.as_ref().map(|d| d.output_dir.clone()).filter(|d| !d.is_empty()).unwrap_or_else(|| "nowhere yet. Set a folder in Contracts".into())),
            style(11.0, 400, t.muted_foreground.alpha(0.7)),
        ));

    let preview_box = preview(t, &draft.preview, draft.preview_scroll);
    let body_height = 620.0 + 32.0;
    let panel = col()
        .w(width)
        .rounded(8.0)
        .border(t.border, 1.0)
        .bg(t.popover)
        .shadow(16.0, 40.0, 0.35)
        .clip()
        .child(
            col()
                .px(16.0)
                .py(12.0)
                .border_b(t.border)
                .child(text("Generate contract", style(13.0, 500, t.popover_foreground)))
                .child(text(description, style(11.5, 400, t.muted_foreground))),
        )
        .child(div().h(body_height).min_h0().child(form).child(div().grow().min_w(0.0).bg(t.muted.alpha(0.3)).p(16.0).justify_center().child(preview_box)))
        .child(
            div()
                .items_center()
                .justify_end()
                .gap(6.0)
                .px(16.0)
                .py(10.0)
                .border_t(t.border)
                .child(button(t, "ghost", !draft.busy, None, "Cancel", Action::Contracts("cancel")))
                .child(button(t, "default", ready && !draft.busy, Some(if draft.busy { "loader2" } else { "file-pen-line" }), "Generate", Action::Contracts("generate"))),
        )
        .child(div().absolute(width - 34.0, 10.0).size(22.0, 22.0).items_center().justify_center().rounded(4.0).hover_bg(t.accent).on(Action::Contracts("cancel")).child(icon("x", 14.0, t.muted_foreground)));
    let height = 12.0 * 2.0 + 19.5 + 17.25 + 1.0 + body_height + 20.0 + 24.0 + 1.0 + 2.0;
    vec![
        div().absolute(0.0, 0.0).w(viewport.0).h(viewport.1).bg(Rgba::rgb8(0, 0, 0).alpha(0.5)).on(Action::Contracts("backdrop")),
        panel.absolute(((viewport.0 - width) / 2.0).round(), ((viewport.1 - height) / 2.0).max(8.0).round()),
    ]
}

/// The page on white, as the iframe shows it: Arial at 16px, the strokes and discs painted.
fn preview(_t: &Theme, page: &Rc<PageLayout>, scroll: f32) -> El<Action> {
    let mut sheet = div().w(PREVIEW_WIDTH).h(620.0).rounded(4.0).bg(Rgba::rgb8(255, 255, 255)).clip().shadow(8.0, 24.0, 0.3).on(Action::ContractPreview);
    let black = Rgba::rgb8(0, 0, 0);
    for item in &page.items {
        if let Item::Text { x, baseline, face, text: words } = item {
            let top = (baseline - LINE_TOP) * PX - scroll;
            if !(-30.0..650.0).contains(&top) {
                continue;
            }
            let style = TextStyle { line_height: 24.0, font: Font::Arial, italic: *face >= 2, ..style(16.0, if face % 2 == 1 { 700 } else { 400 }, black) };
            sheet = sheet.child(div().absolute(x * PX, top).child(text(words.trim_end().to_string(), style)));
        }
    }
    let strokes: Vec<Item> = page.items.iter().filter(|i| !matches!(i, Item::Text { .. })).cloned().collect();
    let painter = Rc::new(move |pm: &mut PixmapMut, r: [f32; 4], scale: f32| {
        let k = PX * scale;
        for item in &strokes {
            match item {
                Item::Line { x1, x2, y, width, grey } => {
                    let mut pb = PathBuilder::new();
                    let yy = r[1] + y * k - scroll * scale;
                    pb.move_to(r[0] + x1 * k, yy);
                    pb.line_to(r[0] + x2 * k, yy);
                    if let Some(path) = pb.finish() {
                        let mut paint = Paint::default();
                        let g = (grey * 255.0) as u8;
                        paint.set_color(Rgba::rgb8(g, g, g).skia());
                        paint.anti_alias = true;
                        pm.stroke_path(&path, &paint, &Stroke { width: (width * k).max(scale), ..Stroke::default() }, Transform::identity(), None);
                    }
                }
                Item::Disc { x, y, r: radius } => {
                    if let Some(path) = PathBuilder::from_circle(r[0] + x * k, r[1] + y * k - scroll * scale, radius * k) {
                        let mut paint = Paint::default();
                        paint.set_color(Rgba::rgb8(0, 0, 0).skia());
                        paint.anti_alias = true;
                        pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
                    }
                }
                Item::Text { .. } => {}
            }
        }
    });
    // The frame's classic scrollbar: a light track, its thumb sized to how much is in view.
    let content = preview_height(page).max(620.0);
    let track = 620.0 - 2.0 * PREVIEW_SCROLLBAR;
    let thumb = (track * 620.0 / content).max(18.0);
    let thumb_top = PREVIEW_SCROLLBAR + (track - thumb) * (scroll / (content - 620.0).max(1.0));
    sheet
        .child(paint(painter).absolute(0.0, 0.0).size(PREVIEW_WIDTH, 620.0))
        .child(div().absolute(PREVIEW_WIDTH - PREVIEW_SCROLLBAR, 0.0).size(PREVIEW_SCROLLBAR, 620.0).bg(Rgba::rgb8(241, 241, 241)))
        .child(div().absolute(PREVIEW_WIDTH - PREVIEW_SCROLLBAR + 3.0, thumb_top).size(PREVIEW_SCROLLBAR - 6.0, thumb).rounded(4.0).bg(Rgba::rgb8(193, 193, 193)))
}

/// How tall the preview's content is, for clamping its scroll.
pub fn preview_height(page: &PageLayout) -> f32 {
    page.items
        .iter()
        .map(|i| match i {
            Item::Text { baseline, .. } => baseline + 6.0,
            Item::Line { y, .. } => *y,
            Item::Disc { y, .. } => *y,
        })
        .fold(0.0, f32::max)
        * PX
        + 8.0
}
