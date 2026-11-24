# umakbang, native - scoping a rewrite in Rust

Status: **the native app is umakbang.** This is the official port, not a second edition beside
the Electron app: the Electron app is the reference it was measured against and is retired once
the cutover is done. Both read the same data files, so the switch is not a migration.

**The cutover is done.** The native app installs itself per user (`umakbang-native.exe --install`, or
any copy whose file name says setup) into `%LOCALAPPDATA%\Programs\umakbang`, starts at login as
`umakbang`, serves the tailnet in Electron's place, and updates itself from the GitHub releases
`electron-builder.yml` names: a release carries `umakbang-native-<version>-win-x64.exe` and its
`.sha256`, and an update without a checksum is never installed. With no paths on its command line
it uses the Electron app's profile and its own database, or a `data` folder beside the exe
(portable). A crash leaves `crash.log` or a minidump beside the database and is reported on the
next launch. Windows only for now: a macOS build needs the platform layer split out and a Mac (or
a CI runner) to build, sign and test on.

**Videos is dropped.** The reel composer is not what umakbang is for, and it is not being ported -
not deferred, not planned. The native app has no Videos page, no recorder and no exporter, and
nothing below budgets for one.

**Key detection is Essentia's, ported** (`native/src/essentia_key.rs`): KeyExtractor's C++ stage by
stage with the parameters `lib/key-essentia.ts` passes, in single precision, falling back to the
built-in detector under three seconds as the Electron worker does. Against Electron's stored keys
on 58 files with the user's `edma` profile: 45 identical, 6 the relative pair, 7 different. Where
both stored a strength it mostly agrees to three places, so the pipeline matches; why the other 13
differ (the decoder and resampler in front of it are the first suspects) is not yet measured.

**The server speaks protocol 4** (`v0.6-tree-hashes.md`): every folder row in `library.db` carries
a tree hash, cleared by triggers when anything at or below it changes (the clear climbs by a
trigger firing itself, so every writing connection needs `recursive_triggers`), and worked out on
request. `/hello` carries `tree` and `metaRevision`, `/list` carries hashes and an ETag answered
with 304, and `/wait` long-polls. The whole library is watched all the time (`watch.rs`
`LibraryWatch`, 5s settle), so a bounce anywhere reaches a peer in about six seconds. File times
are hashed as JavaScript's `String()` writes them, via ryu: Rust's `Display` picks the other of
two equally short digit strings for about one folder in a hundred.

## Why

Measured on the real library (328,705 files) with the window open and nothing happening:

| | Today (0.4.1) | With the idle-scanner fix (built, not shipped) |
|---|---|---|
| Window (renderer) | 473MB | ~400MB |
| Scanner, idle | 372MB | 0 (stopped when idle) |
| GPU process | 160MB | 157MB |
| Main | 97MB | ~120MB |
| Server, other helpers | ~56MB | ~35MB |
| **Total private** | **1,159MB** | **~700MB** |

Two things make up most of it, and only one of them is the framework:

- **The data layout.** The index is held as 328k JavaScript objects - ~187MB in the window,
  ~690MB of heap while the scanner parses it - and was held in up to three processes at once.
  Measured: the same rows in SQLite, answering folder listings and searches, cost a Node process
  **~100MB RSS in total** (0.2-3ms per folder). Nothing has to hold the library in memory.
- **Chromium.** A GPU process, a renderer and helpers is ~250-300MB before the app does anything.

The target is **under 100MB** at rest with the window open, and under 40MB in the tray.

## Phase 0, measured

The prototype in `native/` (an egui window over the real library imported into SQLite: folder
tree, virtualised table, playback through rodio) answered the question it was built for, and
not the way the plan above it assumed.

| | Private | Working set |
|---|---|---|
| egui, wgpu (default), any folder open, playing or not | 366-393MB | 160-210MB |
| egui, wgpu forced to DX12 / Vulkan | 337-339MB | 137MB |
| egui, OpenGL (glow) | 138MB | 138MB |
| **winit + softbuffer + tiny-skia, CPU-drawn, redrawing every frame** | **11MB** | **24MB** |

- **The library costs almost nothing.** Memory was the same with the 11-folder root open,
  938 subfolders open, or a 709-file folder playing an MP3. Imported: 328,705 files and 19,936
  folders in 5.0s; database 128MB on disk (the NDJSON index is 235MB). Executable: 18MB.
- **The GPU driver is the budget.** Any GPU renderer loads the graphics driver into the process,
  ~100MB before a single widget. Drawing the interface on the CPU into a shared buffer costs
  11MB. A 1360x860 window is a 4.6MB pixel buffer; redrawing only what changed keeps it cheap.

## The interface: our own, drawn on the CPU, built to look 1:1

It has to look like the current app, as close to identical as possible. egui cannot - it has
its own look, and restyling it widget by widget would still not be the same layout engine. So
umakbang gets its own small UI library, built from parts that already exist:

| Piece | Crate | Why it gives 1:1 |
|---|---|---|
| Layout | **taffy** | CSS flexbox and grid - the same layout model the Tailwind UI is written in, so a component's classes translate almost one for one |
| Text | **cosmic-text** (+ swash) | Real shaping and font fallback, rendering the same system font the app uses (`--font-sans`: Segoe UI on Windows, SF on macOS), tabular figures for the `.tnum` columns |
| Painting | **tiny-skia** | Anti-aliased paths, rounded corners, gradients, strokes - what the Tailwind classes draw |
| Window and pixels | **winit + softbuffer** | No GPU driver in the process |
| Colours | port of `lib/theme.ts` | The OKLCH tokens in `index.css` converted exactly, user accent and ramp included |

What is ours: a retained node tree with style structs shaped like the Tailwind classes in use
(padding, gap, radius, border, background, text size and weight, hover and active states),
hit-testing and focus, damage tracking so only changed rectangles repaint, a virtualised list,
and the component set the app actually uses (button with the random hover tint, popover,
context menu, the tag combobox, switch, slider, tabs, dialog). The visualizers draw straight
into their own rectangles of the same buffer.

The check is visual: each screen is compared against a screenshot of the Electron app at the
same window size, side by side, until they match.

## Shape

One process, not five. Threads where Electron had processes:

```
 ┌───────────────────────────────── umakbang.exe ─────────────────────────────────┐
 │  UI thread        own UI library: taffy layout, cosmic-text, tiny-skia, drawn   │
 │                   on the CPU into a softbuffer window                           │
 │  library          rusqlite index + tree; jwalk scanner pool; notify watcher     │
 │  audio            symphonia decode -> rubato (varispeed) -> cpal output;        │
 │                   analysis taps feed the visualizers lock-free                  │
 │  analysis pool    rayon: peaks, tempo, key, on every core                       │
 │  server           tokio + axum: protocol 3 routes over the same SQLite file     │
 └──────────────────────────────────────┬─────────────────────────────────────────┘
                                        │ child processes, only while working
                        yt-dlp
```

No IPC layer, no preload, no second copy of anything: the window and the server read the same
database, and a scan writes it while both keep reading (SQLite WAL).

## What already exists

Every row is a maintained crate or library; the right-hand column is what umakbang has to write
itself.

| umakbang today | Native | Still ours |
|---|---|---|
| Electron window, React, Tailwind, Radix | Own UI library on **taffy + cosmic-text + tiny-skia + winit/softbuffer** (see above) | The component set and the styles, matched to the current app |
| NDJSON index + journal + `.dirs` + `.folders` + metadata cache | **rusqlite** (bundled SQLite, **FTS5 trigram** for substring search) | Schema; one DB per machine with a `root` column |
| `scanner.ts` walk + revalidation skip | **jwalk** (parallel walk), `std::fs` metadata | The folder-mtime skip, `touched` |
| `probe.ts` WAV/AIFF/FLAC/MP3/MP4/Ogg headers, ID3 | **lofty** (tags and properties for all of these) | ACID chunk, filename tempo/key hints |
| `flp.ts` FL Studio projects | - | Port as is (it is a byte parser) |
| folder watch, library watch | **notify** (recursive on Windows/macOS) | Debounce, `touched` |
| `<audio>` playback, AIFF rewrap | **symphonia** decode + **cpal** output; ffmpeg for anything symphonia lacks (Opus, WMA, APE) | Queue, loop region, gapless |
| varispeed (`preservesPitch = false`) | **rubato** resampling - varispeed *is* a resample ratio | - |
| WebAudio analysers, six visualizers | **realfft**, drawn with tiny-skia into their own rectangles | The visualizers (port the maths, it is all ours already) |
| `peaks.worker.ts`, `tempo.ts`, `key.ts` | **rayon** for parallelism | Port; peaks and tempo are self-contained |
| Essentia (WASM) key detection | **libKeyFinder** (C++, GPL, what Mixxx uses) via `cxx`, or Essentia native | Choose by measuring with `tools/keyeval` |
| LAME (trim to MP3, YT2MP3) | **ffmpeg** (or `mp3lame-encoder`) | - |
| Search query language (`shared/search.ts`) | - | Port: parse to SQL `WHERE` + FTS5 `MATCH`; keep the same syntax and results |
| tailnet server (`remote-process.ts`) | **tokio + axum** | Routes over SQLite instead of a second in-memory copy |
| tray, start at login, single instance | **tray-icon**, **auto-launch**, **single-instance** | - |
| electron-updater + NSIS | **Velopack** (installer + delta updates, Windows and macOS) | Feed on GitHub releases |
| Ctrl+C files to Discord (PowerShell `Set-Clipboard`) | **clipboard-win** writes `CF_HDROP` directly; `objc2` NSPasteboard on mac | - |
| Alt-drag a file into a DAW (`startDrag`) | **drag** crate (CrabNebula: OS drag-out of files on Windows/macOS) | Wiring into our pointer events |
| trash, file ops, undo | **trash** crate, `std::fs` | `fs-ops.ts` semantics, journal, undo |
| `.umak` bundles, settings import wizard | **flate2**, **serde_json** | Port; same format |
| contracts (Markdown -> PDF via Chromium) | **typst** as a library (Markdown-ish to PDF, no browser) | Template conversion |
| LALAL stems, YouTube | **reqwest**; yt-dlp unchanged | - |
| ~~Video editor, recorder, export~~ | Dropped with Videos | - |
| YouTube video join (1080p picture + its sound) | ffmpeg (`-c copy`), if it is ever wanted; until then YT2MP3's Video format takes the single combined stream | - |

### ffmpeg

**Not bundled.** Its reasons were the video exporter, the screen recorder and `mp4-remux.ts`, and
all three went with Videos. What was left is done without it: decoding is symphonia, MP3 (trims,
YT2MP3) is LAME through `mp3lame-encoder`, and YT2MP3's Video format takes the single stream that
already carries picture and sound. Should a 1080p YouTube join ever be wanted, an ffmpeg fetched
on demand the way yt-dlp is - never at rest, never in the installer - is the shape for it.

## Memory budget

| | Budget |
|---|---|
| Executable + window + CPU frame buffers (measured floor: 11MB private) | 15-25MB |
| Fonts (the one system UI font, shaped glyph cache) | ~5-10MB |
| SQLite page cache | 16MB (fixed by `cache_size`) |
| One open folder's rows, the tree's visible nodes | < 5MB |
| Audio: decoder + output buffers + analysis taps | ~10MB |
| Waveforms on screen | ~5MB (fetched per visible row, LRU) |
| **Window open, idle** | **~50-70MB** |
| **Tray, window closed** (no window, no frame buffers) | **~15-30MB** |

The rule that makes it hold: **nothing holds the library.** Every view is a query - a folder,
a page of search results, a stats aggregate - and nothing grows with the size of the library
except the database file.

## Phases, each with a gate

Each phase ends with a number measured on the real library. A phase that misses its gate is
fixed before the next starts.

0. **Prototype.** Done - see "Phase 0, measured". The library in SQLite passed; the egui window
   did not, which is what moved the interface to the CPU.
0b. **The UI library.** Window, taffy layout, cosmic-text, tiny-skia, damage tracking,
   hit-testing; then the explorer screen alone - title bar, sidebar, table, transport - built
   to match a screenshot of the Electron app at the same size.
   *Gate: side by side with the Electron screenshot, no visible difference at a glance; under
   60MB private browsing the 328k library; scrolling a 5,000-file folder at display refresh
   using under one core.*
1. **The library.** Scanner, revalidation skip, watcher, tree, table with columns and sorting,
   the search language, tags, ratings, notes, annotations following moved files, file
   operations, undo, clipboard, drag-out.
   *Gate: launch to first rows under 300ms warm; full revalidation within 10% of today's 2.9s.*
2. **The player.** Transport, queue, loop region and trim, varispeed, waveforms, the six
   visualizers. *Gate: visualizers at display refresh using under 5% of one core.*
3. **Background and network.** Tray, start at login, protocol 3 server (and `/index` for older
   peers), settings sync, remote roots. *Gate: under 35MB in the tray.*
4. **Analysis and stats.** Peaks, tempo, key (libKeyFinder vs Essentia, measured with
   `tools/keyeval`), the stats page as SQL aggregates.
5. **The rest.** YT2MP3 (now with ffmpeg), stems, contracts (typst), bundles and the import
   wizard, Velopack installer and updates, settings page, first-run tour.
6. ~~**Videos.**~~ Dropped: not part of umakbang.

## Risks

- **The interface is the bulk of the work**, more so now it is our own library: every Radix
  component (menus, popovers, the tag combobox, dialogs), text input with selection and IME,
  scrolling with momentum, and the hover and focus states all become ours.
- **CPU drawing has to stay cheap.** It holds only if redraws are limited to what changed. A
  full-window repaint every frame used a whole core in the floor test; the visualizers are the
  one part that repaints continuously, and they are small rectangles.
- **Drag-out into DAWs** is native on each OS and has broken before (see the CLAUDE.md note on
  nested `DoDragDrop`). The `drag` crate exists for this; verify it with FL Studio in phase 1.
- **Accessibility** has to be built: a browser gives screen readers the whole tree for free. AccessKit is the existing library for exposing it.
- **macOS** needs its own signing, notarisation, ScreenCaptureKit permissions and an ffmpeg
  build per architecture.
- **Two apps at once** until the cutover. Shared data files make that safe, not cheap; after it,
  the Electron app is only a reference.
