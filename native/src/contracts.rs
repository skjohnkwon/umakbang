//! Exclusive track-sale contracts (`main/contracts.ts`): a template filled from a profile and
//! one deal's figures, written as Markdown and as a PDF.
//!
//! The Electron app prints its HTML through Chromium. There is no Chromium here, so this lays
//! the document out itself - the same CSS as numbers: Arial 12pt on 18pt lines, the `@page`
//! inch of margin plus the body's 8px, paragraphs 0.8em apart, headings 1.2em above and 0.6em
//! below, lists indented 1.4em - and writes the PDF directly, with the fonts subset into it.
//! The preview in the dialog draws the same laid-out pages, so it cannot drift from the PDF.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const DEFAULT_TEMPLATE: &str = include_str!("../assets/contract-template.md");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub full_name: String,
    pub alias: String,
    pub email: String,
    pub governing_state: String,
    pub file_type: String,
}

impl Default for Profile {
    fn default() -> Profile {
        Profile {
            full_name: String::new(),
            alias: String::new(),
            email: String::new(),
            governing_state: "CALIFORNIA".into(),
            file_type: "ZIP FILE OF WAV FILES (STEMS) and MASTER WAV FILE".into(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Preset {
    pub name: String,
    pub alias: String,
    pub email: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub titles: Vec<String>,
    pub customer: String,
    pub alias: String,
    pub email: String,
    pub price: String,
    pub producer_writer: String,
    pub producer_publisher: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    pub id: String,
    pub when: String,
    pub input: Input,
    pub markdown_path: String,
    pub pdf_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub profile: Profile,
    pub presets: Vec<Preset>,
    pub history: Vec<Record>,
    pub template: String,
    pub output_dir: String,
}

impl Default for Data {
    fn default() -> Data {
        Data { profile: Profile::default(), presets: Vec::new(), history: Vec::new(), template: DEFAULT_TEMPLATE.to_string(), output_dir: String::new() }
    }
}

/// `umakbang-contracts.json`, beside the data file, per machine and never exported.
pub struct Store {
    file: PathBuf,
    pub data: Data,
}

impl Store {
    pub fn load(user_data: &Path) -> Store {
        let file = user_data.join("umakbang-contracts.json");
        let mut data: Data = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        // An empty template would generate an empty contract.
        if data.template.trim().is_empty() {
            data.template = DEFAULT_TEMPLATE.to_string();
        }
        if data.output_dir.is_empty() {
            data.output_dir = documents_dir().join("umakbang contracts").to_string_lossy().into_owned();
        }
        Store { file, data }
    }

    /// Written whole, to `.tmp` and renamed, as the Electron app writes it.
    pub fn persist(&self) {
        let Ok(text) = serde_json::to_string_pretty(&self.data) else { return };
        let tmp = self.file.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }

    pub fn save_preset(&mut self, preset: Preset) {
        let clean = Preset { name: preset.name.trim().into(), alias: preset.alias.trim().into(), email: preset.email.trim().into() };
        if clean.name.is_empty() && clean.alias.is_empty() {
            return;
        }
        let key = preset_key(&clean);
        self.data.presets.retain(|p| preset_key(p) != key);
        self.data.presets.push(clean);
        self.data.presets.sort_by_key(|p| (if p.alias.is_empty() { &p.name } else { &p.alias }).to_lowercase());
        self.persist();
    }

    pub fn delete_preset(&mut self, key: &str) {
        let wanted = key.trim().to_lowercase();
        self.data.presets.retain(|p| preset_key(p) != wanted);
        self.persist();
    }

    pub fn delete_record(&mut self, id: &str) {
        self.data.history.retain(|r| r.id != id);
        self.persist();
    }

    /// Writes a contract's Markdown and PDF and records it. The Markdown is written first and
    /// kept whatever happens to the PDF: it is the document.
    pub fn generate(&mut self, input: Input, fonts: &Fonts) -> Result<Record, String> {
        let titles: Vec<String> = input.titles.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        if titles.is_empty() {
            return Err("A contract needs at least one track title.".into());
        }
        if input.customer.trim().is_empty() {
            return Err("The purchaser's legal name is required.".into());
        }
        let price = input.price.trim().trim_start_matches('$');
        let numeric = !price.is_empty() && price.split_once('.').map_or(price.chars().all(|c| c.is_ascii_digit()), |(a, b)| !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()));
        if !numeric {
            return Err("The price must be a number, like 300.".into());
        }
        let input = Input { titles: titles.clone(), ..input };
        let now = crate::localtime::parts(crate::localtime::now()).ok_or("The clock could not be read.")?;
        let markdown = fill(&self.data.template, &values(&self.data.profile, &input, now));
        let stem = format!("{}-CONTRACT-{:04}{:02}{:02}", safe_name(&titles.join(" & ")), now.year, now.month, now.day);
        let target = PathBuf::from(&self.data.output_dir);
        if self.data.output_dir.is_empty() {
            return Err("No output folder is set for contracts.".into());
        }
        let markdown_path = target.join(format!("{stem}.md"));
        let pdf_path = target.join(format!("{stem}.pdf"));
        std::fs::create_dir_all(&target).and_then(|_| std::fs::write(&markdown_path, &markdown)).map_err(|e| format!("Could not write the contract: {e}"))?;
        let pdf_error = pdf(&layout(&markdown, fonts), fonts).and_then(|bytes| std::fs::write(&pdf_path, bytes).map_err(|e| e.to_string())).err();
        let stamp = crate::localtime::now();
        let record = Record {
            id: format!("{}", stamp as i64),
            when: iso_local(stamp),
            input,
            markdown_path: markdown_path.to_string_lossy().into_owned(),
            pdf_path: if pdf_error.is_none() { Some(pdf_path.to_string_lossy().into_owned()) } else { None },
            pdf_error,
        };
        self.data.history.insert(0, record.clone());
        self.data.history.truncate(100);
        self.persist();
        Ok(record)
    }

    /// The contract as the dialog's preview shows it: one column `width` points wide.
    pub fn preview_flow(&self, input: &Input, fonts: &Fonts, width: f32) -> PageLayout {
        let titles: Vec<String> = input.titles.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        let markdown = match crate::localtime::parts(crate::localtime::now()) {
            _ if titles.is_empty() => "*Add a track title to see the contract.*".to_string(),
            Some(now) => fill(&self.data.template, &values(&self.data.profile, &Input { titles, ..input.clone() }, now)),
            None => "*Cannot preview yet.*".to_string(),
        };
        flow(&markdown, fonts, width)
    }

    /// The contract as it would be printed, without printing it: lenient where `generate` is
    /// strict, since it runs on every keystroke.
    pub fn preview(&self, input: &Input, fonts: &Fonts) -> Vec<PageLayout> {
        let titles: Vec<String> = input.titles.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        if titles.is_empty() {
            return layout("*Add a track title to see the contract.*", fonts);
        }
        let now = crate::localtime::parts(crate::localtime::now());
        match now {
            Some(now) => layout(&fill(&self.data.template, &values(&self.data.profile, &Input { titles, ..input.clone() }, now)), fonts),
            None => layout("*Cannot preview yet.*", fonts),
        }
    }
}

fn preset_key(p: &Preset) -> String {
    (if p.alias.is_empty() { &p.name } else { &p.alias }).trim().to_lowercase()
}

fn documents_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Documents")).unwrap_or_else(|| PathBuf::from("."))
}

/// `toISOString().slice(0, 19)`: UTC, to the second.
fn iso_local(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn safe_name(name: &str) -> String {
    let kept: String = name.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && (*c as u32) >= 0x20).collect();
    let kept = kept.trim().trim_end_matches('.').to_string();
    if kept.is_empty() { "contract".into() } else { kept }
}

/* ------------------------------------------------------------------ filling */

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

fn spell(n: u64) -> String {
    match n {
        0..=19 => ONES[n as usize].to_string(),
        20..=99 => format!("{}{}", TENS[(n / 10) as usize], if n % 10 > 0 { format!("-{}", ONES[(n % 10) as usize]) } else { String::new() }),
        100..=999 => format!("{} hundred{}", ONES[(n / 100) as usize], if n % 100 > 0 { format!(" {}", spell(n % 100)) } else { String::new() }),
        1000..=999_999 => format!("{} thousand{}", spell(n / 1000), if n % 1000 > 0 { format!(" {}", spell(n % 1000)) } else { String::new() }),
        _ => format!("{} million{}", spell(n / 1_000_000), if n % 1_000_000 > 0 { format!(" {}", spell(n % 1_000_000)) } else { String::new() }),
    }
}

/// `priceToWords`: cents the way cheques spell them, "three hundred and 50/100".
pub fn price_to_words(value: &str) -> String {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let Ok(numeric) = digits.parse::<f64>() else { return value.to_string() };
    if !numeric.is_finite() || numeric < 0.0 {
        return value.to_string();
    }
    let mut dollars = numeric.floor() as u64;
    let mut cents = ((numeric - dollars as f64) * 100.0).round() as u64;
    if cents == 100 {
        dollars += 1;
        cents = 0;
    }
    let words = spell(dollars) + &if cents > 0 { format!(" and {cents:02}/100") } else { String::new() };
    let mut chars = words.chars();
    chars.next().map_or(String::new(), |f| f.to_uppercase().collect::<String>() + chars.as_str())
}

/// `formatPercent`: 25 -> "25", 12.50 -> "12.5".
fn format_percent(value: &str) -> String {
    match value.replace('%', "").trim().parse::<f64>() {
        Ok(n) if n.is_finite() => {
            let r = (n * 100.0).round() / 100.0;
            if r.fract() == 0.0 { format!("{}", r as i64) } else { format!("{r}") }
        }
        _ => "0".into(),
    }
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// `contractValues`: everything the template can ask for.
pub fn values(profile: &Profile, input: &Input, today: crate::localtime::Parts) -> BTreeMap<&'static str, String> {
    let titles: Vec<String> = input.titles.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).map(|t| format!("\"{t}\"")).collect();
    let price = input.price.trim().trim_start_matches('$').trim().to_string();
    let writer = format_percent(&input.producer_writer);
    let publisher = format_percent(&input.producer_publisher);
    let rest = |p: &str| format_percent(&format!("{}", 100.0 - p.parse::<f64>().unwrap_or(0.0)));
    BTreeMap::from([
        ("PRODUCT_TITLE", titles.join(" & ")),
        ("CONTRACT_DATE", format!("{} {}, {}", MONTHS[today.month as usize - 1], today.day, today.year)),
        ("PRODUCT_OWNER_FULLNAME", profile.full_name.clone()),
        ("PRODUCER_ALIAS", profile.alias.clone()),
        ("CUSTOMER_FULLNAME", input.customer.clone()),
        // A purchaser who trades under their own name is the ordinary case, not a gap.
        ("CUSTOMER_ALIAS", if input.alias.trim().is_empty() { input.customer.clone() } else { input.alias.trim().to_string() }),
        ("PRODUCT_PRICE", format!("${price} USD")),
        ("PRODUCT_PRICE_WORD", price_to_words(&price)),
        ("PURCH_WRITER", rest(&writer)),
        ("PURCH_PUBLISHER", rest(&publisher)),
        ("PROD_WRITER", writer),
        ("PROD_PUBLISHER", publisher),
        ("FILE_TYPE", profile.file_type.clone()),
        ("STATE_PROVINCE_COUNTRY", profile.governing_state.clone()),
    ])
}

/// `fillTemplate`: `{TOKEN}` replaced; unknown tokens left alone rather than blanked.
pub fn fill(template: &str, values: &BTreeMap<&'static str, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after.find(|c: char| !(c.is_ascii_uppercase() || c == '_')).unwrap_or(after.len());
        if name_len > 0 && after[name_len..].starts_with('}') {
            let name = &after[..name_len];
            match values.get(name) {
                Some(v) => out.push_str(v),
                None => out.push_str(&rest[open..open + name_len + 2]),
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/* ------------------------------------------------------------------ Markdown */

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

/// One line of inline Markdown: `**bold**`, `*italic*`, the template's raw `<u>` and `<br>`.
/// Applied per line, as the Electron converter does - a `**` opened on one line and closed on
/// the next prints both pairs of stars, there and here.
fn inline(text: &str) -> Vec<(String, Style)> {
    // Characters with their markup, `<u>` spans resolved first.
    #[derive(Clone, Copy)]
    struct C {
        ch: char,
        u: bool,
        b: bool,
        i: bool,
        br: bool,
        star: bool,
    }
    let mut cs: Vec<C> = Vec::new();
    let mut under = false;
    let mut rest = text;
    while !rest.is_empty() {
        let lower = rest.to_ascii_lowercase();
        if lower.starts_with("<u>") {
            under = true;
            rest = &rest[3..];
            continue;
        }
        if lower.starts_with("</u>") {
            under = false;
            rest = &rest[4..];
            continue;
        }
        if let Some(len) = ["<br>", "<br/>", "<br />"].iter().find(|t| lower.starts_with(**t)).map(|t| t.len()) {
            cs.push(C { ch: '\n', u: false, b: false, i: false, br: true, star: false });
            rest = &rest[len..];
            continue;
        }
        let ch = rest.chars().next().expect("not empty");
        cs.push(C { ch, u: under, b: false, i: false, br: false, star: ch == '*' });
        rest = &rest[ch.len_utf8()..];
    }
    // `\*\*(.+?)\*\*`, left to right.
    let mut i = 0;
    while i + 1 < cs.len() {
        if cs[i].star && cs[i + 1].star {
            let close = (i + 3..cs.len().saturating_sub(1)).find(|&j| cs[j].star && cs[j + 1].star);
            if let Some(j) = close {
                for c in &mut cs[i + 2..j] {
                    c.b = true;
                }
                cs.drain(j..j + 2);
                cs.drain(i..i + 2);
                i = j - 2;
                continue;
            }
        }
        i += 1;
    }
    // `(^|[^*])\*([^*]+)\*`.
    let mut i = 0;
    while i < cs.len() {
        if cs[i].star && (i == 0 || !cs[i - 1].star) {
            if let Some(j) = (i + 1..cs.len()).find(|&j| cs[j].star) {
                if j > i + 1 {
                    for c in &mut cs[i + 1..j] {
                        c.i = true;
                    }
                    cs.remove(j);
                    cs.remove(i);
                    i = j - 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    let mut runs: Vec<(String, Style)> = Vec::new();
    for c in cs {
        let style = Style { bold: c.b, italic: c.i, underline: c.u };
        match runs.last_mut() {
            Some((text, s)) if *s == style && !c.br && !text.ends_with('\n') => text.push(c.ch),
            _ => runs.push((c.ch.to_string(), style)),
        }
    }
    runs
}

#[derive(Debug)]
enum Block {
    Paragraph(Vec<Vec<(String, Style)>>),
    Heading(Vec<(String, Style)>),
    Rule,
    /// Items, and whether the list is numbered.
    List(Vec<Vec<(String, Style)>>, bool),
}

/// `markdownToHtml`'s subset: headings, rules, both list kinds, paragraphs keeping every line
/// break, and inline bold, italic and underline. Anything else passes through as text.
fn blocks(markdown: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut paragraph: Vec<Vec<(String, Style)>> = Vec::new();
    let mut list: Option<(Vec<String>, bool)> = None;
    let close_paragraph = |p: &mut Vec<Vec<(String, Style)>>, out: &mut Vec<Block>| {
        if !p.is_empty() {
            out.push(Block::Paragraph(std::mem::take(p)));
        }
    };
    let close_list = |l: &mut Option<(Vec<String>, bool)>, out: &mut Vec<Block>| {
        if let Some((items, numbered)) = l.take() {
            out.push(Block::List(items.iter().map(|i| inline(i)).collect(), numbered));
        }
    };
    for raw in markdown.replace("\r\n", "\n").split('\n') {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            close_paragraph(&mut paragraph, &mut out);
            close_list(&mut list, &mut out);
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && line[hashes..].starts_with(char::is_whitespace) {
            close_paragraph(&mut paragraph, &mut out);
            close_list(&mut list, &mut out);
            out.push(Block::Heading(inline(line[hashes..].trim())));
            continue;
        }
        let t = line.trim();
        if t.len() >= 3 && t.chars().all(|c| c == '-') {
            close_paragraph(&mut paragraph, &mut out);
            close_list(&mut list, &mut out);
            out.push(Block::Rule);
            continue;
        }
        let lead = line.trim_start();
        let bullet = (lead.starts_with("- ") || lead.starts_with("* ") || lead.starts_with("-\t") || lead.starts_with("*\t")).then(|| lead[1..].trim_start());
        let numbered = {
            let digits = lead.chars().take_while(char::is_ascii_digit).count();
            (digits > 0 && lead[digits..].starts_with('.') && lead[digits + 1..].starts_with(char::is_whitespace)).then(|| lead[digits + 1..].trim_start())
        };
        if let Some(item) = bullet.or(numbered) {
            close_paragraph(&mut paragraph, &mut out);
            let wanted = numbered.is_some() && bullet.is_none();
            if list.as_ref().is_some_and(|(_, n)| *n != wanted) {
                close_list(&mut list, &mut out);
            }
            list.get_or_insert_with(|| (Vec::new(), wanted)).0.push(item.to_string());
            continue;
        }
        // A continuation line inside a list item belongs to that item.
        if let Some((items, _)) = list.as_mut() {
            if raw.starts_with("  ") && !raw.trim_start().is_empty() {
                if let Some(last) = items.last_mut() {
                    last.push(' ');
                    last.push_str(line.trim());
                    continue;
                }
            }
        }
        paragraph.push(inline(line.trim()));
    }
    close_paragraph(&mut paragraph, &mut out);
    close_list(&mut list, &mut out);
    out
}

/* ------------------------------------------------------------------ fonts */

/// Arial in its four faces, as the contract's stylesheet asks for it.
pub struct Fonts {
    pub faces: Vec<(PathBuf, Vec<u8>)>,
}

impl Fonts {
    pub fn load() -> Option<Fonts> {
        let dir = std::env::var("WINDIR").map(|w| PathBuf::from(w).join("Fonts")).unwrap_or_else(|_| PathBuf::from(r"C:\Windows\Fonts"));
        let faces = ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"]
            .iter()
            .map(|f| {
                let path = dir.join(f);
                std::fs::read(&path).ok().map(|bytes| (path, bytes))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Fonts { faces })
    }

    fn face(&self, index: usize) -> Option<ttf_parser::Face<'_>> {
        ttf_parser::Face::parse(&self.faces[index].1, 0).ok()
    }
}

fn face_of(style: Style) -> usize {
    match (style.bold, style.italic) {
        (false, false) => 0,
        (true, false) => 1,
        (false, true) => 2,
        (true, true) => 3,
    }
}

/// A run's width in points at `size`, kerned with the font's own pairs.
fn width(face: &ttf_parser::Face, text: &str, size: f32) -> f32 {
    let scale = size / face.units_per_em() as f32;
    let mut total = 0.0;
    let mut prev: Option<ttf_parser::GlyphId> = None;
    for ch in text.chars() {
        let glyph = face.glyph_index(ch).unwrap_or(ttf_parser::GlyphId(0));
        total += face.glyph_hor_advance(glyph).unwrap_or(0) as f32;
        if let Some(p) = prev {
            total += kern(face, p, glyph) as f32;
        }
        prev = Some(glyph);
    }
    total * scale
}

fn kern(face: &ttf_parser::Face, left: ttf_parser::GlyphId, right: ttf_parser::GlyphId) -> i16 {
    face.tables().kern.and_then(|k| k.subtables.into_iter().filter(|s| s.horizontal && !s.variable).find_map(|s| s.glyphs_kerning(left, right))).unwrap_or(0)
}

/* ------------------------------------------------------------------ layout */

pub const PAGE: (f32, f32) = (612.0, 792.0);
const MARGIN: f32 = 72.0;
const BODY: f32 = 6.0;
const SIZE: f32 = 12.0;
const LINE: f32 = 18.0;
const LEFT: f32 = MARGIN + BODY;
const RIGHT: f32 = PAGE.0 - MARGIN - BODY;
const BOTTOM: f32 = PAGE.1 - MARGIN;

#[derive(Clone, Debug)]
pub enum Item {
    /// A run of text: left edge, baseline, face, and the text.
    Text { x: f32, baseline: f32, face: usize, text: String },
    /// A stroke from (x1, y) to (x2, y), its width and grey (0 black, 1 white).
    Line { x1: f32, x2: f32, y: f32, width: f32, grey: f32 },
    /// A list's disc.
    Disc { x: f32, y: f32, r: f32 },
}

#[derive(Clone, Debug, Default)]
pub struct PageLayout {
    pub items: Vec<Item>,
}

/// Where text may go: the printed page, or the preview's one endless column.
#[derive(Clone, Copy)]
struct Geometry {
    left: f32,
    right: f32,
    /// The top of every page after the first.
    top: f32,
    bottom: f32,
}

struct Flow<'a> {
    fonts: &'a Fonts,
    g: Geometry,
    faces: Vec<ttf_parser::Face<'a>>,
    pages: Vec<PageLayout>,
    y: f32,
    /// The bottom margin still owed by the block above, collapsed with the next one's top.
    pending: f32,
    top_of_page: bool,
}

impl<'a> Flow<'a> {
    fn new_page(&mut self) {
        self.pages.push(PageLayout::default());
        self.y = self.g.top;
        self.pending = 0.0;
        self.top_of_page = true;
    }

    /// A block's top margin, collapsed with what the last one left; dropped at a page's top.
    fn margin(&mut self, top: f32) {
        if !self.top_of_page {
            self.y += self.pending.max(top);
        }
        self.pending = 0.0;
    }

    fn items(&mut self) -> &mut Vec<Item> {
        &mut self.pages.last_mut().expect("a page").items
    }

    /// Words onto lines of `width`, each line a list of placed runs.
    fn wrap(&self, runs: &[(String, Style)], limit: f32) -> Vec<Vec<(f32, String, Style)>> {
        // Pieces end at a break opportunity: after a space, or after a hyphen inside a word.
        let mut pieces: Vec<(String, Style)> = Vec::new();
        for (text, style) in runs {
            let mut piece = String::new();
            let chars: Vec<char> = text.chars().collect();
            for (k, ch) in chars.iter().enumerate() {
                if *ch == '\n' {
                    if !piece.is_empty() {
                        pieces.push((std::mem::take(&mut piece), *style));
                    }
                    pieces.push(("\n".into(), *style));
                    continue;
                }
                piece.push(*ch);
                let hyphen = *ch == '-' && k > 0 && chars[k - 1].is_alphanumeric() && chars.get(k + 1).is_some_and(|n| n.is_alphanumeric());
                if *ch == ' ' || hyphen {
                    pieces.push((std::mem::take(&mut piece), *style));
                }
            }
            if !piece.is_empty() {
                pieces.push((piece, *style));
            }
        }
        let mut lines: Vec<Vec<(f32, String, Style)>> = vec![Vec::new()];
        let mut x = 0.0;
        // A word is one or more pieces with no break between them (a style change mid-word).
        let mut i = 0;
        while i < pieces.len() {
            if pieces[i].0 == "\n" {
                lines.push(Vec::new());
                x = 0.0;
                i += 1;
                continue;
            }
            let mut j = i;
            while j < pieces.len() && pieces[j].0 != "\n" && !(pieces[j].0.ends_with(' ') || pieces[j].0.ends_with('-')) {
                j += 1;
            }
            let end = (j + 1).min(pieces.len());
            let end = if end > i && pieces[end - 1].0 == "\n" { end - 1 } else { end }.max(i + 1);
            let word = &pieces[i..end];
            // Trailing spaces hang: they do not count against the line.
            let measured: f32 = word
                .iter()
                .enumerate()
                .map(|(k, (t, s))| {
                    let t = if k + 1 == word.len() { t.trim_end() } else { t.as_str() };
                    width(&self.faces[face_of(*s)], t, SIZE)
                })
                .sum();
            if x > 0.0 && x + measured > limit + 0.01 {
                lines.push(Vec::new());
                x = 0.0;
            }
            let line = lines.last_mut().expect("a line");
            for (t, s) in word {
                line.push((x, t.clone(), *s));
                x += width(&self.faces[face_of(*s)], t, SIZE);
            }
            i = end;
        }
        lines
    }

    /// Lines of text into the flow at `left`, breaking pages between lines - never leaving one
    /// line of a paragraph alone at either end of a page (`orphans: 2; widows: 2`).
    fn lines(&mut self, lines: Vec<Vec<(f32, String, Style)>>, left: f32, marker: Option<Marker>) {
        let count = lines.len();
        let mut index = 0;
        let mut marker = marker;
        while index < count {
            let room = ((self.g.bottom - self.y) / LINE).floor().max(0.0) as usize;
            let left_over = count - index;
            if room < left_over {
                // Break here: keep two at the bottom and two at the top, or move the lot.
                let mut take = room.min(left_over);
                if left_over - take < 2 && left_over >= 2 {
                    take = take.min(left_over - 2);
                }
                if take < 2 && !(self.top_of_page && take > 0) {
                    take = 0;
                }
                if take == 0 && self.top_of_page {
                    take = room.max(1);
                }
                for _ in 0..take {
                    self.line(&lines[index], left, marker.take());
                    index += 1;
                }
                self.new_page();
                continue;
            }
            self.line(&lines[index], left, marker.take());
            index += 1;
        }
    }

    fn line(&mut self, runs: &[(f32, String, Style)], left: f32, marker: Option<Marker>) {
        let face = &self.faces[0];
        let em = face.units_per_em() as f32;
        // Blink rounds the ascent and descent to whole CSS pixels and floors the half-leading,
        // so the baseline sits on a pixel: 3px of leading over a 14px ascent in a 24px line.
        let px = 0.75;
        let (ascent, descent) = ((face.ascender() as f32 / em * SIZE / px).round(), (-face.descender() as f32 / em * SIZE / px).round());
        let baseline = self.y + (((LINE / px - ascent - descent) / 2.0).floor() + ascent) * px;
        let (u_pos, u_thick) = face.underline_metrics().map_or((-0.106 * SIZE, 0.073 * SIZE), |m| (m.position as f32 / em * SIZE, m.thickness as f32 / em * SIZE));
        let mut out = Vec::new();
        if let Some(marker) = marker {
            match marker {
                Marker::Number(n) => {
                    let text = format!("{n}. ");
                    let w = width(face, &text, SIZE);
                    out.push(Item::Text { x: left - w, baseline, face: 0, text });
                }
                // Blink's disc, measured off its print: 3.2pt across, its centre 11.3pt left of
                // the item's text and 2.6pt above the baseline.
                Marker::Disc => out.push(Item::Disc { x: left - 11.3, y: baseline - 2.6, r: 1.6 }),
            }
        }
        // An underline runs unbroken across the spaces between underlined words, and stops at
        // the last one's ink.
        let mut underline: Option<(f32, f32)> = None;
        let flush = |u: &mut Option<(f32, f32)>, out: &mut Vec<Item>| {
            if let Some((x1, x2)) = u.take() {
                out.push(Item::Line { x1, x2, y: baseline - u_pos, width: u_thick, grey: 0.0 });
            }
        };
        for (x, text, style) in runs {
            if text.trim_end_matches(' ').is_empty() && !style.underline {
                flush(&mut underline, &mut out);
                continue;
            }
            if !text.trim_end_matches(' ').is_empty() {
                out.push(Item::Text { x: left + x, baseline, face: face_of(*style), text: text.clone() });
            }
            if style.underline {
                let ink = width(&self.faces[face_of(*style)], text.trim_end(), SIZE);
                let start = underline.map_or(left + x, |(x1, _)| x1);
                underline = Some((start, left + x + ink));
            } else {
                flush(&mut underline, &mut out);
            }
        }
        flush(&mut underline, &mut out);
        self.items().extend(out);
        self.y += LINE;
        self.top_of_page = false;
    }
}

#[derive(Clone, Copy)]
enum Marker {
    Number(usize),
    Disc,
}

/// The document as pages of placed text and strokes.
pub fn layout(markdown: &str, fonts: &Fonts) -> Vec<PageLayout> {
    layout_in(markdown, fonts, Geometry { left: LEFT, right: RIGHT, top: MARGIN, bottom: BOTTOM })
}

/// The document as the preview shows it: one column `width` points wide inside the body's 8px
/// margin, never broken into pages - the HTML in an iframe, as the Electron dialog draws it.
pub fn flow(markdown: &str, fonts: &Fonts, width: f32) -> PageLayout {
    layout_in(markdown, fonts, Geometry { left: BODY, right: BODY + width, top: 0.0, bottom: f32::INFINITY }).into_iter().next().unwrap_or_default()
}

/// Where the first line's box starts above its baseline, in points: what draws a text element
/// for a run placed by baseline.
pub const LINE_TOP: f32 = 12.75;

fn layout_in(markdown: &str, fonts: &Fonts, g: Geometry) -> Vec<PageLayout> {
    let faces: Vec<ttf_parser::Face> = (0..4).filter_map(|i| fonts.face(i)).collect();
    if faces.len() < 4 {
        return vec![PageLayout::default()];
    }
    let mut flow = Flow { fonts, g, faces, pages: Vec::new(), y: 0.0, pending: 0.0, top_of_page: true };
    flow.new_page();
    // The body's 8px margin, on the first page only.
    flow.y += BODY;
    let width = g.right - g.left;
    for block in blocks(markdown) {
        match block {
            Block::Paragraph(lines) => {
                flow.margin(0.0);
                let mut all = Vec::new();
                for line in &lines {
                    all.extend(flow.wrap(line, width));
                }
                flow.lines(all, g.left, None);
                flow.pending = 0.8 * SIZE;
            }
            Block::Heading(runs) => {
                flow.margin(1.2 * SIZE);
                let bold: Vec<(String, Style)> = runs.into_iter().map(|(t, s)| (t, Style { bold: true, ..s })).collect();
                let lines = flow.wrap(&bold, width);
                flow.lines(lines, g.left, None);
                flow.pending = 0.6 * SIZE;
            }
            Block::Rule => {
                flow.margin(1.2 * SIZE);
                if flow.y + 0.75 > flow.g.bottom {
                    flow.new_page();
                }
                let y = flow.y + 0.375;
                flow.items().push(Item::Line { x1: g.left, x2: g.right, y, width: 0.75, grey: 0.6 });
                flow.y += 0.75;
                flow.top_of_page = false;
                flow.pending = 1.2 * SIZE;
            }
            Block::List(items, numbered) => {
                let indent = g.left + 1.4 * SIZE;
                let count = items.len();
                for (n, item) in items.iter().enumerate() {
                    flow.margin(0.0);
                    let lines = flow.wrap(item, g.right - indent);
                    flow.lines(lines, indent, Some(if numbered { Marker::Number(n + 1) } else { Marker::Disc }));
                    flow.pending = if n + 1 == count { 0.8 * SIZE } else { 0.4 * SIZE };
                }
            }
        }
    }
    let _ = flow.fonts;
    flow.pages
}

/* ------------------------------------------------------------------ PDF */

/// The pages as a PDF, Arial subset into it - only the glyphs the contract uses.
pub fn pdf(pages: &[PageLayout], fonts: &Fonts) -> Result<Vec<u8>, String> {
    use pdf_writer::types::{CidFontType, FontFlags, SystemInfo, UnicodeCmap};
    use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str};

    let mut next = 1;
    let mut id = || {
        let r = Ref::new(next);
        next += 1;
        r
    };
    let (catalog, page_tree) = (id(), id());
    let mut pdf = Pdf::new();

    // Which glyphs each face draws, and the text each stands for.
    let faces: Vec<ttf_parser::Face> = (0..4).filter_map(|i| fonts.face(i)).collect();
    let mut remappers: Vec<subsetter::GlyphRemapper> = (0..4).map(|_| subsetter::GlyphRemapper::new()).collect();
    let mut unicode: Vec<BTreeMap<u16, char>> = vec![BTreeMap::new(); 4];
    let mut used = [false; 4];
    // Encoded runs: per page, per text item, the new glyph ids and their kerned offsets.
    let mut encoded: Vec<Vec<Option<Vec<(u16, f32)>>>> = Vec::new();
    for page in pages {
        let mut items = Vec::new();
        for item in &page.items {
            let Item::Text { face, text, .. } = item else {
                items.push(None);
                continue;
            };
            used[*face] = true;
            let f = &faces[*face];
            let mut glyphs = Vec::new();
            let mut prev = None;
            for ch in text.chars() {
                let g = f.glyph_index(ch).unwrap_or(ttf_parser::GlyphId(0));
                let k = prev.map_or(0, |p| kern(f, p, g)) as f32 / f.units_per_em() as f32 * 1000.0;
                let new = remappers[*face].remap(g.0);
                unicode[*face].insert(new, ch);
                glyphs.push((new, k));
                prev = Some(g);
            }
            items.push(Some(glyphs));
        }
        encoded.push(items);
    }

    // The fonts.
    let names = ["ArialMT", "Arial-BoldMT", "Arial-ItalicMT", "Arial-BoldItalicMT"];
    let mut font_refs = [None; 4];
    for face in 0..4 {
        if !used[face] {
            continue;
        }
        let f = &faces[face];
        let em = f.units_per_em() as f32;
        let to_pdf = |v: f32| v / em * 1000.0;
        let subset = subsetter::subset(&fonts.faces[face].1, 0, &remappers[face]).map_err(|e| format!("The font could not be subset: {e:?}"))?;
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&subset, 6);
        let (type0, cid, descriptor, file, cmap) = (id(), id(), id(), id(), id());
        let base = format!("UMKBNG+{}", names[face]);
        pdf.type0_font(type0).base_font(Name(base.as_bytes())).encoding_predefined(Name(b"Identity-H")).descendant_font(cid).to_unicode(cmap);
        let widths: Vec<f32> = remappers[face].remapped_gids().map(|old| to_pdf(f.glyph_hor_advance(ttf_parser::GlyphId(old)).unwrap_or(0) as f32)).collect();
        let mut font = pdf.cid_font(cid);
        font.subtype(CidFontType::Type2)
            .base_font(Name(base.as_bytes()))
            .system_info(SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"Identity"), supplement: 0 })
            .font_descriptor(descriptor)
            .default_width(0.0)
            .cid_to_gid_map_predefined(Name(b"Identity"));
        font.widths().consecutive(0, widths);
        font.finish();
        let b = f.global_bounding_box();
        let mut flags = FontFlags::NON_SYMBOLIC;
        if face >= 2 {
            flags |= FontFlags::ITALIC;
        }
        pdf.font_descriptor(descriptor)
            .name(Name(base.as_bytes()))
            .flags(flags)
            .bbox(Rect::new(to_pdf(b.x_min as f32), to_pdf(b.y_min as f32), to_pdf(b.x_max as f32), to_pdf(b.y_max as f32)))
            .italic_angle(f.italic_angle())
            .ascent(to_pdf(f.ascender() as f32))
            .descent(to_pdf(f.descender() as f32))
            .cap_height(to_pdf(f.capital_height().unwrap_or(1467) as f32))
            .stem_v(if face == 1 || face == 3 { 140.0 } else { 80.0 })
            .font_file2(file);
        pdf.stream(file, &compressed).filter(Filter::FlateDecode);
        let mut map = UnicodeCmap::new(Name(b"Custom"), SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"UCS"), supplement: 0 });
        for (g, ch) in &unicode[face] {
            map.pair(*g, *ch);
        }
        let map = map.finish();
        pdf.cmap(cmap, &map);
        font_refs[face] = Some(type0);
    }

    // The pages.
    let mut page_refs = Vec::new();
    for (page, glyph_runs) in pages.iter().zip(&encoded) {
        let (page_id, content_id) = (id(), id());
        page_refs.push(page_id);
        let mut c = Content::new();
        for (item, glyphs) in page.items.iter().zip(glyph_runs) {
            match item {
                Item::Text { x, baseline, face, .. } => {
                    let Some(glyphs) = glyphs else { continue };
                    c.begin_text();
                    c.set_font(Name(format!("F{face}").as_bytes()), SIZE);
                    c.set_text_matrix([1.0, 0.0, 0.0, 1.0, *x, PAGE.1 - baseline]);
                    // TJ with the kerning between glyphs: a positive kern moves right, which TJ
                    // spells as a negative adjustment.
                    let mut array = c.show_positioned();
                    let mut items = array.items();
                    for (g, k) in glyphs {
                        if *k != 0.0 {
                            items.adjust(-k);
                        }
                        items.show(Str(&g.to_be_bytes()));
                    }
                    items.finish();
                    array.finish();
                    c.end_text();
                }
                Item::Line { x1, x2, y, width, grey } => {
                    c.set_stroke_gray(*grey);
                    c.set_line_width(*width);
                    c.move_to(*x1, PAGE.1 - y);
                    c.line_to(*x2, PAGE.1 - y);
                    c.stroke();
                }
                Item::Disc { x, y, r } => {
                    // Four Béziers make the circle.
                    let k = 0.552_284_8 * r;
                    let (cx, cy) = (*x, PAGE.1 - y);
                    c.set_fill_gray(0.0);
                    c.move_to(cx + r, cy);
                    c.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
                    c.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
                    c.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
                    c.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
                    c.fill_nonzero();
                }
            }
        }
        let content = miniz_oxide::deflate::compress_to_vec_zlib(&c.finish(), 6);
        pdf.stream(content_id, &content).filter(Filter::FlateDecode);
        let mut p = pdf.page(page_id);
        p.media_box(Rect::new(0.0, 0.0, PAGE.0, PAGE.1)).parent(page_tree).contents(content_id);
        let mut resources = p.resources();
        let mut font_dict = resources.fonts();
        for (face, r) in font_refs.iter().enumerate() {
            if let Some(r) = r {
                font_dict.pair(Name(format!("F{face}").as_bytes()), *r);
            }
        }
        font_dict.finish();
        resources.finish();
        p.finish();
    }
    pdf.pages(page_tree).kids(page_refs.iter().copied()).count(page_refs.len() as i32);
    pdf.catalog(catalog).pages(page_tree);
    Ok(pdf.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spells_prices() {
        assert_eq!(price_to_words("300"), "Three hundred");
        assert_eq!(price_to_words("1250.5"), "One thousand two hundred fifty and 50/100");
        assert_eq!(price_to_words("99.999"), "One hundred");
        assert_eq!(format_percent("12.50"), "12.5");
        assert_eq!(format_percent("25"), "25");
    }

    #[test]
    fn fills_tokens() {
        let v = BTreeMap::from([("A_B", "x".to_string())]);
        assert_eq!(fill("{A_B} {UNKNOWN} {lower} {", &v), "x {UNKNOWN} {lower} {");
    }

    #[test]
    fn reads_inline_markup() {
        let runs = inline("a **b** *c* <u>d</u> **open");
        let shown: Vec<(String, bool, bool, bool)> = runs.iter().map(|(t, s)| (t.clone(), s.bold, s.italic, s.underline)).collect();
        assert_eq!(
            shown,
            vec![
                ("a ".into(), false, false, false),
                ("b".into(), true, false, false),
                (" ".into(), false, false, false),
                ("c".into(), false, true, false),
                (" ".into(), false, false, false),
                ("d".into(), false, false, true),
                (" **open".into(), false, false, false),
            ]
        );
    }
}
