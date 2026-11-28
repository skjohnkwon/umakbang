//! umakbang, native. See docs/native-rewrite.md.
//!
//! `umakbang-native import <index.ndjson> <library.db>` converts the Electron app's saved index
//! into the SQLite schema this app is built on.
//! `umakbang-native <library.db> <umakbang-data.json>` opens the explorer.
//! `... --shot <out.png>` draws one 1360x860 frame to a PNG and exits - what the screen is
//! compared against the Electron app with.
//! `UMAKBANG_OPEN=<folder path>` opens on that folder; `UMAKBANG_SELECT=<n>` selects a file.
//! `UMAKBANG_PLAY=<n>` plays file n (with `--shot`, for two seconds of animation frames first;
//! `UMAKBANG_MUTE=1` keeps it silent).

// A release build is launched from a shortcut, where a console subsystem opens a terminal
// window beside the app for as long as it runs. Debug builds keep the console for their logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analyser;
mod analysis;
#[cfg_attr(target_os = "macos", path = "mac/clipboard.rs")]
mod clipboard;
mod columns;
mod docstore;
mod files;
mod fsops;
mod app;
mod import;
mod keys;
mod layout;
mod library;
mod localtime;
mod overlay;
mod probe;
mod player;
#[cfg_attr(target_os = "macos", path = "mac/present.rs")]
mod present;
mod screen;
mod scan;
mod search;
mod settings_page;
mod stats;
mod youtube;
mod download_page;
#[cfg_attr(target_os = "macos", path = "mac/dialogs.rs")]
mod dialogs;
mod contracts;
mod contracts_page;
mod form;
mod stems;
mod undo;
mod compact;
mod trim;
mod color_picker;
mod server;
mod tailscale;
#[cfg_attr(target_os = "macos", path = "mac/tray.rs")]
mod tray;
mod fl_plugins;
mod remote;
mod devices;
mod backup;
mod import_wizard;
mod tour;
mod crash;
mod portable;
mod process;
mod updater;
mod essentia_key;
mod stem_dialog;
mod stats_page;
mod table;
mod shell_icon;
mod theme;
mod ui;
mod userdata;
mod visualizers;
mod watch;
mod waveform;

use std::path::PathBuf;
use winit::event_loop::{ControlFlow, EventLoop};

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    // The update hand-over, the uninstaller and setup: none of them is the app.
    if args.len() >= 4 && args[1] == "--apply-update" {
        updater::apply(&PathBuf::from(&args[2]), args[3].parse().unwrap_or(0), &args[4..]);
        return;
    }
    if args.iter().any(|a| a == "--uninstall") {
        updater::uninstall();
        return;
    }
    if updater::is_setup(&args) {
        updater::run_setup();
        return;
    }
    if args.len() == 4 && args[1] == "import" {
        if let Err(error) = import::run(&PathBuf::from(&args[2]), &PathBuf::from(&args[3])) {
            eprintln!("import failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    // `backfill <index.ndjson> <library.db>`: what the prober reads, from the Electron app's
    // index, for rows imported before the database kept it.
    if args.len() == 4 && args[1] == "backfill" {
        let library = library::Library::open(&PathBuf::from(&args[3])).expect("open library");
        let started = std::time::Instant::now();
        let filled = library.backfill(&PathBuf::from(&args[2]));
        println!("backfilled {filled} rows in {:.1}s", started.elapsed().as_secs_f64());
        return;
    }
    // `analysischeck <umakbang-data.json> <count>`: the native detectors against the readings the
    // Electron app stored, on that many of its analysed files.
    if args.len() == 4 && args[1] == "analysischeck" {
        let data = userdata::UserData::load(&PathBuf::from(&args[2]));
        let count: usize = args[3].parse().unwrap_or(40);
        let (mut tempo_same, mut tempo_double, mut tempo_n, mut key_same, mut key_pair, mut key_n) = (0, 0, 0, 0, 0, 0);
        let mut paths: Vec<&String> = data.detected_bpm.keys().filter(|p| std::path::Path::new(p).exists()).collect();
        paths.sort();
        let step = (paths.len() / count.max(1)).max(1);
        let started = std::time::Instant::now();
        for path in paths.iter().step_by(step).take(count) {
            let Some((signal, rate)) = analysis::decode(std::path::Path::new(path)) else { continue };
            if let (Some(theirs), Some((ours, conf))) = (data.detected_bpm.get(*path), analysis::detect_tempo(&signal, rate)) {
                if conf >= analysis::MIN_TEMPO_CONFIDENCE {
                    tempo_n += 1;
                    if (theirs - ours).abs() <= 1.0 { tempo_same += 1 } else if (theirs * 2.0 - ours).abs() <= 1.5 || (theirs / 2.0 - ours).abs() <= 1.0 { tempo_double += 1 } else { println!("  tempo {theirs} vs {ours} {path}") }
                }
            }
            if let (Some(theirs), Some((ours, fit))) = (data.detected_key.get(*path), { let profile = data.settings.key_profile.clone().unwrap_or_else(|| "krumhansl".into()); if data.settings.key_engine.as_deref().unwrap_or("essentia") == "essentia" { essentia_key::detect(&signal, rate as f32, &profile).or_else(|| analysis::detect_key(&signal, rate)) } else { analysis::detect_key(&signal, rate) } }) {
                if fit >= analysis::MIN_KEY_FIT {
                    key_n += 1;
                    let stored = data.detected_key_fit.get(*path).copied();
                    if std::env::var("UMAKBANG_KEYS").is_ok() {
                        println!("  {:>5} {:<4} vs {:<4} fit ours {:.3} theirs {}", if keys::same_key(theirs, &ours) { "same" } else { "DIFF" }, theirs, ours, fit, stored.map_or("-".to_string(), |f| format!("{f:.3}")));
                    }
                    if keys::same_key(theirs, &ours) { key_same += 1 } else if keys::relative_pair(theirs) == keys::relative_pair(&ours) { key_pair += 1 }
                }
            }
        }
        println!("tempo: {tempo_same}/{tempo_n} within 1 BPM, {tempo_double} an octave off");
        println!("key: {key_same}/{key_n} the same, {key_pair} the relative major/minor (Essentia, as Electron detected them)");
        println!("{:.1}s", started.elapsed().as_secs_f64());
        return;
    }
    // `ytcheck <userData> <url> <mp3|source|video>`: one download, start to finish, into
    // `UMAKBANG_DOWNLOAD_DIR`, printing what the page would be told.
    if args.len() == 5 && args[1] == "ytcheck" {
        let downloader = youtube::Downloader::new(std::path::Path::new(&args[2]));
        println!("tool: {:?}", downloader.status_now());
        let (tx, rx) = std::sync::mpsc::channel();
        let started = std::time::Instant::now();
        downloader.fetch(args[3].clone(), args[4].clone(), 192, youtube::download_dir(None), move |e| {
            let _ = tx.send(e);
        });
        let mut last = String::new();
        for event in rx {
            let line = match &event {
                youtube::Event::Progress { phase, percent, .. } => format!("{phase} {}", percent.map_or(String::new(), |p| format!("{:.0}", (p / 10.0).floor() * 10.0))),
                other => format!("{other:?}"),
            };
            if line != last {
                println!("{:6.1}s {line}", started.elapsed().as_secs_f64());
                last = line;
            }
            if matches!(event, youtube::Event::Done(_)) {
                break;
            }
        }
        return;
    }
    // `contractcheck <userData> <out.pdf> <input.json>`: one contract laid out and written, for
    // comparing against Chromium's print of the same document.
    if args.len() == 5 && args[1] == "contractcheck" {
        let store = contracts::Store::load(std::path::Path::new(&args[2]));
        let input: contracts::Input = serde_json::from_str(&args[4]).expect("input json");
        let fonts = contracts::Fonts::load().expect("Arial");
        let started = std::time::Instant::now();
        let pages = store.preview(&input, &fonts);
        let bytes = contracts::pdf(&pages, &fonts).expect("pdf");
        std::fs::write(&args[3], &bytes).expect("write");
        println!("{} pages, {} bytes, {:.0}ms", pages.len(), bytes.len(), started.elapsed().as_secs_f64() * 1000.0);
        return;
    }
    // `trimcheck <source> <from> <to> <out>`: a region written as the Save button writes it.
    if args.len() == 6 && args[1] == "trimcheck" {
        let source = std::path::Path::new(&args[2]);
        let ext = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        match trim::trim(source, &ext, Some(320), args[3].parse().unwrap_or(0.0), args[4].parse().unwrap_or(1.0)) {
            Ok(bytes) => {
                std::fs::write(&args[5], &bytes).expect("write");
                println!("{} bytes as {}", bytes.len(), trim::output_ext(&ext));
            }
            Err(e) => println!("refused: {e}"),
        }
        return;
    }
    // `probecheck <index.ndjson> <every-nth>`: probes files the Electron index describes and
    // counts where the two disagree - the port's parity check against real files.
    if args.len() == 4 && args[1] == "probecheck" {
        probe_check(&args[2], args[3].parse().unwrap_or(500));
        return;
    }
    // No paths given - an installed app, a portable copy, a login launch with only
    // `--background` - and it works out its own, as the Electron app always did.
    let mut refused_portable = None;
    if args.len() < 3 || args[1].starts_with("--") {
        let paths = portable::resolve();
        if let Some(dir) = paths.profile.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        refused_portable = paths.refused;
        args.splice(1..1, [paths.db.to_string_lossy().into_owned(), paths.profile.to_string_lossy().into_owned()]);
    }
    if args.len() >= 3 && args[1] == "measure" {
        // measure <size> <weight> <tnum 0|1> <text>... : widths as this app shapes them.
        let mut text = ui::text::Text::new();
        let size: f32 = args[2].parse().unwrap();
        let weight: u16 = args[3].parse().unwrap();
        let tabular = args[4] == "1";
        for t in &args[5..] {
            let style = ui::text::TextStyle { size, line_height: size * 1.5, weight, color: ui::color::Rgba::rgb8(255, 255, 255), tabular, tracking: 0.0, grayscale: false, italic: false, font: crate::ui::text::Font::Sans };
            println!("{t:?} {:.2}", text.width(t, &style));
        }
        return;
    }
    // `bundlecheck <library.db> <umakbang-data.json> <out.umak> <empty.db>`: writes a bundle from a
    // profile, then restores its indexes into another database - on copies, never the real ones.
    if args.get(1).map(String::as_str) == Some("bundlecheck") && args.len() >= 6 {
        let started = std::time::Instant::now();
        match backup::write_bundle(&PathBuf::from(&args[4]), &PathBuf::from(&args[3]), &PathBuf::from(&args[2])) {
            Ok(()) => println!("wrote {} bytes in {:.1}s", std::fs::metadata(&args[4]).map(|m| m.len()).unwrap_or(0), started.elapsed().as_secs_f64()),
            Err(e) => {
                println!("write failed: {e}");
                return;
            }
        }
        let header = backup::read_header(&PathBuf::from(&args[4]));
        println!("header: {}", header.as_ref().map(|h| h["counts"].to_string()).unwrap_or_else(|| "unreadable".into()));
        let started = std::time::Instant::now();
        match backup::restore(&PathBuf::from(&args[4]), &PathBuf::from(&args[5]), true) {
            Ok(r) => println!("restored {:?}, skipped {:?}, settings {} in {:.1}s", r.restored, r.skipped, r.backup.is_some(), started.elapsed().as_secs_f64()),
            Err(e) => println!("restore failed: {e}"),
        }
        return;
    }
    // `remotecheck <host:port> <library id> <rel> <out dir> [<flp rel>]`: copies a file from a
    // server the way "Copy to" does, decodes a second of it the way the player streams it, and
    // packs a project - against a test server, never a real machine's.
    // `devicecheck <host[:port]> <library id> <library path> [dir] [query]`: one folder of another
    // machine's library as the Devices section lists it, or a search at or below it.
    if args.get(1).map(String::as_str) == Some("devicecheck") && args.len() >= 5 {
        let root = remote::RemoteRoot { label: "test".into(), path: args[4].clone(), host: args[2].clone(), library_id: args[3].clone(), device_id: "test".into(), device_name: "test".into() };
        let dir = args.get(5).cloned().unwrap_or_default();
        let started = std::time::Instant::now();
        let outcome = match args.get(6) {
            Some(query) => remote::search(&root, &dir, query),
            None => remote::list(&root, &dir),
        };
        match outcome {
            Ok(listing) => {
                println!("{} folders, {} files ({} matched), {} rated, {} tagged, in {:.0}ms", listing.folders.len(), listing.files.len(), listing.matched, listing.ratings.len(), listing.tags.len(), started.elapsed().as_secs_f64() * 1000.0);
                for (name, files) in listing.folders.iter().take(5) {
                    println!("  folder {name} ({files})");
                }
                for file in listing.files.iter().take(5) {
                    println!("  file {} | {} | in {}", file.name, file.path, file.dir);
                }
            }
            Err(e) => println!("failed: {e}"),
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("remotecheck") && args.len() >= 6 {
        let root = remote::RemoteRoot { label: "test".into(), path: "/".into(), host: args[2].clone(), library_id: args[3].clone(), device_id: "test".into(), device_name: "test".into() };
        let out = PathBuf::from(&args[5]);
        let _ = std::fs::create_dir_all(&out);
        let name = args[4].rsplit('/').next().unwrap_or("file").to_string();
        let started = std::time::Instant::now();
        let target = remote::free_name(&out, &name);
        match remote::copy_one(&root, &args[4], None, &target, &|_| {}) {
            Ok(()) => println!("copied {} bytes in {:.2}s to {}", std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0), started.elapsed().as_secs_f64(), target.display()),
            Err(e) => println!("copy failed: {e}"),
        }
        match remote::RemoteReader::open(&root, &args[4], None) {
            Ok(reader) => {
                let len = reader.len();
                let mut builder = rodio::Decoder::builder().with_data(Box::new(std::io::BufReader::new(reader)) as Box<dyn remote::ReadSeek>).with_byte_len(len).with_seekable(true);
                if let Some(ext) = std::path::Path::new(&name).extension().and_then(|e| e.to_str()) {
                    builder = builder.with_hint(&ext.to_lowercase());
                }
                match builder.build() {
                    Ok(mut decoder) => {
                        use rodio::Source;
                        let rate = decoder.sample_rate().get() as usize * decoder.channels().get() as usize;
                        let first = decoder.by_ref().take(rate).count();
                        let seek = decoder.try_seek(std::time::Duration::from_secs(20)).is_ok();
                        let after = decoder.take(rate).count();
                        println!("streamed: {first} samples, seek to 0:20 {}, then {after} samples", if seek { "ok" } else { "failed" });
                    }
                    Err(e) => println!("decode failed: {e}"),
                }
            }
            Err(e) => println!("open failed: {e}"),
        }
        // A project, by its absolute path on the serving machine, packed into the out folder.
        // The project is given within the library, as `rel` is above.
        if let Some(within) = args.get(6) {
            remote::register(root.clone());
            let flp = root.path_of(within);
            println!("preview: {:?}", remote::preview(&flp, &[]));
            match remote::pack(&flp, &out, &|_| {}) {
                Ok(zip) => println!("packed into {} ({} bytes)", zip.display(), std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0)),
                Err(e) => println!("pack failed: {e}"),
            }
        }
        return;
    }
    // First, so that opening the library can already fail somewhere visible.
    let crash_dir = PathBuf::from(&args[1]).parent().map(PathBuf::from).unwrap_or_default();
    crash::install(&crash_dir);
    let library = library::Library::open(&PathBuf::from(&args[1])).expect("open library");
    userdata::UserData::prepare(&PathBuf::from(&args[2]));
    let data = userdata::UserData::load(&PathBuf::from(&args[2]));
    let mut app = app::App::new(library, data, PathBuf::from(&args[1]));
    app.user_data = PathBuf::from(&args[2]).parent().map(PathBuf::from).unwrap_or_default();
    if let Ok(path) = std::env::var("UMAKBANG_OPEN") {
        if let Some(folder) = app.library.folder_at(&path) {
            app.open(folder.id, true);
        }
    }
    // `UMAKBANG_DEVICE=<host:port>`: the server there in the Devices section as another machine,
    // unfolded; `UMAKBANG_DEVICE_OPEN=<dir>` opens that folder of it (empty for its library).
    if let Ok(host) = std::env::var("UMAKBANG_DEVICE") {
        app.test_device(&host, std::env::var("UMAKBANG_DEVICE_OPEN").ok().as_deref());
    }
    // `UMAKBANG_SPLIT=<folder>`: the explorer split, that folder in the second half.
    if let Some(folder) = std::env::var("UMAKBANG_SPLIT").ok().and_then(|rel| app.library.folder_at(&rel)) {
        app.open_in_other_pane(folder.id);
    }
    // `UMAKBANG_IMPORT=<backup file>`: the import wizard open on that backup.
    if let Some(backup) = std::env::var("UMAKBANG_IMPORT").ok().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|raw| serde_json::from_str(&raw).ok()) {
        let started = std::time::Instant::now();
        app.state.importing = Some(import_wizard::Wizard::new(backup));
        if std::env::var("UMAKBANG_TIMING").is_ok() {
            eprintln!("import wizard opened in {:.0}ms", started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    // `UMAKBANG_VIEW=rated|downloads|<n>`: a saved view instead of the folder.
    match std::env::var("UMAKBANG_VIEW").as_deref() {
        Ok("rated") => app.show_view(screen::View::Rated(1, 5)),
        Ok("downloads") => app.show_view(screen::View::Downloads),
        // `youtube`, with `UMAKBANG_LINK` read as the page would read it.
        Ok("youtube") => {
            app.show_view(screen::View::Downloading);
            let downloader = youtube::Downloader::new(PathBuf::from(&args[2]).parent().unwrap_or(std::path::Path::new(".")));
            app.state.youtube.tool = Some(downloader.status_now());
            if let Ok(link) = std::env::var("UMAKBANG_LINK") {
                app.state.youtube.link.value = link.clone();
                app.state.youtube.link.caret = link.len();
                app.state.youtube.link.anchor = link.len();
                match downloader.probe_now(&link) {
                    Ok(mut info) => {
                        app.state.youtube.thumb = info.thumbnail.take().and_then(|(w, h, rgba)| download_page::thumb_pixmap(w, h, rgba, 1.0)).map(std::rc::Rc::new);
                        app.state.youtube.info = Some(info);
                    }
                    Err(problem) => app.state.youtube.problem = Some(problem),
                }
            }
        }
        // `contracts<section>`, and `UMAKBANG_CONTRACT=<title>` drafts one over it.
        Ok(page) if page.starts_with("contracts") => {
            app.show_view(screen::View::Contracts);
            app.state.contracts.section = page.trim_start_matches("contracts").parse().unwrap_or(0);
            if let Ok(title) = std::env::var("UMAKBANG_CONTRACT") {
                app.open_contract_draft(vec![title]);
                if let Ok(name) = std::env::var("UMAKBANG_CUSTOMER") {
                    app.state.form.set("c.customer", name);
                }
            }
        }
        // `stems:<path>`: the split dialog for that file, over the folder.
        Ok(page) if page.starts_with("stems:") => app.open_stem_dialog(vec![page["stems:".len()..].to_string()]),
        // `stats` or `stats:<scroll>`.
        Ok(page) if page.starts_with("stats") => {
            app.show_view(screen::View::Stats);
            app.state.stats.scroll = page.trim_start_matches("stats").trim_start_matches(':').parse().unwrap_or(0.0);
        }
        Ok(section) if section.starts_with("settings") => {
            app.show_view(screen::View::Settings);
            app.state.settings_section = section.trim_start_matches("settings").parse().unwrap_or(0);
            app.prepare_section();
        }
        Ok(n) => {
            if let Ok(n) = n.parse::<u8>() {
                app.show_view(screen::View::Rated(n, n));
            }
        }
        Err(_) => {}
    }
    // `UMAKBANG_TAGS=a,b`: those tag chips switched on.
    if let Ok(tags) = std::env::var("UMAKBANG_TAGS") {
        app.filter_tags(tags.split(',').map(str::to_string).collect());
    }
    if std::env::var("UMAKBANG_MENU").as_deref() == Ok("type") {
        app.open_type_menu();
        eprintln!("menu open: {}", app.state.menu.is_some());
    }
    // `UMAKBANG_SEARCH=<query>`: a shot of the search results, answered in place.
    if let Ok(query) = std::env::var("UMAKBANG_SEARCH") {
        app.type_search(&query);
    }
    if let Some(index) = std::env::var("UMAKBANG_SELECT").ok().and_then(|v| v.parse().ok()) {
        app.state.selection = std::collections::BTreeSet::from([index]);
        app.state.focus = Some(index);
    }
    // `UMAKBANG_SCROLL_X=<px>`: the table scrolled sideways, to compare columns past the name.
    if let Some(x) = std::env::var("UMAKBANG_SCROLL_X").ok().and_then(|v| v.parse().ok()) {
        app.state.scroll_x = x;
    }
    // `UMAKBANG_ABOUT=1`: About open, its name typed out.
    if std::env::var("UMAKBANG_ABOUT").is_ok() {
        app.state.about = Some(std::time::Instant::now() - std::time::Duration::from_secs(2));
    }
    let play: Option<usize> = std::env::var("UMAKBANG_PLAY").ok().and_then(|v| v.parse().ok());

    // `--bench <frames>`: scrolls the open folder a few rows per frame and times each full
    // redraw, which is the work a wheel turn costs.
    if let Some(at) = args.iter().position(|a| a == "--bench") {
        let frames: usize = args.get(at + 1).and_then(|v| v.parse().ok()).unwrap_or(300);
        let rows = table::row_count(&app.state) as f32;
        let max = (rows * table::ROW - table::body_height(860.0, app.state.sizes.player)).max(0.0);
        let mut times = Vec::with_capacity(frames);
        for i in 0..frames {
            app.state.scroll = (i as f32 * 3.0 * table::ROW) % (max + 1.0);
            let started = std::time::Instant::now();
            app.draw(1360, 860, 1.0);
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        println!(
            "{} rows, {frames} frames: mean {mean:.2}ms, median {:.2}ms, p95 {:.2}ms, worst {:.2}ms",
            rows,
            times[times.len() / 2],
            times[times.len() * 95 / 100],
            times[times.len() - 1]
        );
        return;
    }

    if let Some(at) = args.iter().position(|a| a == "--shot") {
        let out = args.get(at + 1).expect("--shot needs a path");
        // `UMAKBANG_SCALE=2`: drawn as a Retina screen draws it, at twice the size in pixels.
        let scale: f32 = std::env::var("UMAKBANG_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
        if let Some(index) = play {
            // Two seconds of the shared loop, timed like the real one, with every live frame
            // drawn as the window would draw it.
            app.play(index);
            app.draw((1360.0 * scale) as u32, (860.0 * scale) as u32, scale);
            let mut live = Vec::new();
            for _ in 0..120 {
                std::thread::sleep(std::time::Duration::from_millis(16));
                app.advance(visualizers::Phase::Live);
                let started = std::time::Instant::now();
                if !app.draw_live((1360.0 * scale) as u32, (860.0 * scale) as u32, scale) {
                    eprintln!("live frame fell back to a full one");
                    app.draw((1360.0 * scale) as u32, (860.0 * scale) as u32, scale);
                }
                live.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            live.sort_by(|a, b| a.partial_cmp(b).unwrap());
            eprintln!("live frames: median {:.2}ms, worst {:.2}ms", live[live.len() / 2], live[live.len() - 1]);
        }
        // `UMAKBANG_SIZE=<w>x<h>`: the frame at another size, to match a reference window.
        let (w, h) = std::env::var("UMAKBANG_SIZE")
            .ok()
            .and_then(|v| v.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
            .unwrap_or((1360u32, 860u32));
        let (w, h) = ((w as f32 * scale) as u32, (h as f32 * scale) as u32);
        // Once to measure what overflows, which decides the sidebar's gutters.
        app.draw(w, h, scale);
        if app.state.view == screen::View::Stats && app.state.stats.scroll > 0.0 {
            // Clamped as the wheel would, by what the page lays out to.
            app.draw(w, h, scale);
            let (viewport, content) = app.ui.extents.get("stats").copied().unwrap_or((0.0, 0.0));
            app.state.stats.scroll = app.state.stats.scroll.min((content - viewport).max(0.0));
        }
        // `UMAKBANG_REGION=<from>,<to>`: the scissors on and that loop drawn.
        if let Some((a, b)) = std::env::var("UMAKBANG_REGION").ok().and_then(|v| v.split_once(',').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))) {
            app.draw(w, h, scale);
            app.test_region(a, b);
        }
        // `UMAKBANG_PICK=<kind>,<index>`: that colour picker open.
        if let Some((kind, index)) = std::env::var("UMAKBANG_PICK").ok().and_then(|v| v.split_once(',').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))) {
            app.draw(w, h, scale);
            app.test_pick(kind, index);
        }
        if let Ok(hover) = std::env::var("UMAKBANG_CHART") {
            // `<id>:<index>`: that chart's tooltip, as if the pointer were over it.
            if let Some((id, index)) = hover.split_once(':').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?))) {
                app.draw(w, h, scale);
                app.state.stats.hover = Some((id, index));
            }
        }
        let started = std::time::Instant::now();
        let frame = app.draw(w, h, scale);
        if std::env::var("UMAKBANG_TIMING").is_ok() {
            eprintln!("frame drawn in {:.1}ms", started.elapsed().as_secs_f64() * 1000.0);
        }
        frame.save_png(out).expect("write png");
        // `UMAKBANG_LIVE_SHOT=<png>`: half a second of animation frames over that one, as the
        // window would show them - what is drawn over a visualizer has to stay over it.
        if let Ok(live) = std::env::var("UMAKBANG_LIVE_SHOT") {
            for _ in 0..30 {
                std::thread::sleep(std::time::Duration::from_millis(16));
                app.advance(visualizers::Phase::Live);
                if !app.draw_live(w, h, scale) {
                    eprintln!("live frame fell back to a full one");
                }
            }
            app.frame.as_ref().expect("frame").save_png(live).expect("write png");
        }
        if std::env::var("UMAKBANG_HITS").is_ok() {
            for hit in &app.hits {
                let [x0, y0, x1, y1] = hit.rect;
                println!("{:?} @{x0:.1},{y0:.1} {:.1}x{:.1}", hit.action, x1 - x0, y1 - y0);
            }
            for b in &app.ui.backdrops {
                println!("live {:?} covered={}", b.rect, b.covered());
            }
            for bar in &app.ui.bars {
                println!("bar {} h={} track={:?} content={:.1} viewport={:.1} z={}/{}", bar.key, bar.horizontal, bar.track, bar.content, bar.viewport, bar.z, app.hits.len());
            }
        }
        return;
    }

    let event_loop = EventLoop::<app::Wake>::with_user_event().build().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    app.proxy = Some(event_loop.create_proxy());
    // One copy per profile: a second launch - the shortcut double-clicked while this one sits in
    // the tray - shows the first and leaves.
    let shower = event_loop.create_proxy();
    if !tray::single_instance(&PathBuf::from(&args[2]), move || {
        let _ = shower.send_event(app::Wake::Show);
    }) {
        return;
    }
    // The copy that stays empties the write log, before the search thread and the server open
    // the database and it would have to wait for them.
    app.library.shrink_log();
    // A login launch (`--background`) opens no window; the tray is enough.
    app.start_hidden = args.iter().any(|a| a == "--background");
    app.launch_args = vec![args[1].clone(), args[2].clone()];
    // Read once the second copy has gone, so only the copy that stays says it.
    if let Some(message) = crash::last_run(&crash_dir) {
        app.announce(message);
    }
    if let Some(message) = refused_portable {
        app.announce(message);
    }
    // Only the running app writes the document: a shot or a bench never changes the user's
    // data. Before anything below, which can: the server's first launch makes the device id
    // every library id is derived from, and losing it would hand a peer new ids every launch.
    app.doc = Some(docstore::DocStore::new(&PathBuf::from(&args[2])));
    app.data_path = PathBuf::from(&args[2]);
    app.rescue_backups();
    app.drop_mounts();
    app.start_search(PathBuf::from(&args[1]));
    app.start_analysis();
    app.downloader = Some(youtube::Downloader::new(PathBuf::from(&args[2]).parent().unwrap_or(std::path::Path::new("."))));
    // The index caught up with the disk, as every launch does (`beginScan`).
    if std::env::var("UMAKBANG_NO_SCAN").is_err() {
        app.start_scan(false);
    }
    // The tailnet server, as the Electron app starts it at launch; then whichever machine
    // changed its settings last, adopted; and the daily backup.
    app.start_server();
    app.start_updates();
    app.watch_library();
    app.sync_settings(true);
    // `UMAKBANG_RESTORE=<file>`: that backup or bundle imported at launch, as Import would.
    if let Ok(file) = std::env::var("UMAKBANG_RESTORE") {
        app.import_file(PathBuf::from(file));
    }
    backup::auto_backup(PathBuf::from(&args[2]), PathBuf::from(&args[1]));
    // The pane sizes live beside the library, the native app's own; until the first drag
    // writes them, the Electron app's are where it starts. Shots never read them, so a shot
    // stays a function of the profile it is given.
    let layout_path = PathBuf::from(&args[1]).with_file_name("layout.json");
    if let Some(layout) = layout::Layout::load(&layout_path) {
        app.layout = layout;
    }
    app.layout_path = Some(layout_path);
    if let Some(index) = play {
        app.play(index);
    }
    // `UMAKBANG_CRASH=panic|fault`: dies on purpose a second after launch, to prove a crash
    // leaves its record. Never set outside a test profile.
    if let Ok(kind) = std::env::var("UMAKBANG_CRASH") {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if kind == "fault" {
                unsafe { std::ptr::null_mut::<u8>().write_volatile(1) };
            }
        });
        if std::env::var("UMAKBANG_CRASH").as_deref() == Ok("panic") {
            panic!("UMAKBANG_CRASH asked for a panic");
        }
    }
    event_loop.run_app(&mut app).expect("run");
    app.flush_doc();
}

fn probe_check(index: &str, every: usize) {
    use std::io::BufRead;
    let file = std::fs::File::open(index).expect("index");
    let (mut checked, mut fields, mut differ) = (0usize, 0usize, std::collections::BTreeMap::<&str, usize>::new());
    let mut examples: Vec<String> = Vec::new();
    for (i, line) in std::io::BufReader::new(file).lines().enumerate() {
        if i % every != 0 {
            continue;
        }
        let Ok(line) = line else { continue };
        let Ok(track) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if track.get("probed").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }
        let path = track["path"].as_str().unwrap_or_default().to_string();
        let ext = track["ext"].as_str().unwrap_or_default().to_string();
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        let meta = probe::probe(std::path::Path::new(&path), &ext);
        checked += 1;
        let mut compare = |name: &'static str, theirs: Option<f64>, ours: Option<f64>| {
            fields += 1;
            let same = match (theirs, ours) {
                (None, None) => true,
                (Some(a), Some(b)) => (a - b).abs() < 0.0015,
                _ => false,
            };
            if !same {
                *differ.entry(name).or_default() += 1;
                if examples.len() < 12 {
                    examples.push(format!("{name}: electron {theirs:?} native {ours:?} {path}"));
                }
            }
        };
        let num = |k: &str| track.get(k).and_then(|v| v.as_f64());
        compare("duration", num("duration"), meta.duration);
        compare("sampleRate", num("sampleRate"), meta.sample_rate.map(|v| v as f64));
        compare("bitDepth", num("bitDepth"), meta.bit_depth.map(|v| v as f64));
        compare("channels", num("channels"), meta.channels.map(|v| v as f64));
        compare("bitrate", num("bitrate"), meta.bitrate.map(|v| v as f64));
        compare("projectSeconds", num("projectSeconds"), meta.project_seconds);
        let theirs_key = track.get("musicalKey").and_then(|v| v.as_str()).map(str::to_string);
        fields += 1;
        if theirs_key != meta.key && !(theirs_key.is_some() && meta.key.is_none()) {
            *differ.entry("key").or_default() += 1;
            if examples.len() < 12 {
                examples.push(format!("key: electron {theirs_key:?} native {:?} {path}", meta.key));
            }
        }
    }
    println!("{checked} files, {fields} fields compared");
    for (name, n) in &differ {
        println!("  {name}: {n} differ");
    }
    for e in examples {
        println!("  {e}");
    }
}
