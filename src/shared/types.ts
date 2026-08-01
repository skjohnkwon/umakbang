/** Types shared between the main process, the preload bridge and the renderer. */

/** What sort of file this is. Not what it's for - that's what tags are for. */
export type TrackKind = 'audio' | 'midi' | 'project'

/** One file in the library. Metadata fields are filled in by the background probe pass. */
export interface Track {
  /**
   * Absolute path on disk, exactly as the filesystem gave it. Doubles as the stable identity
   * of a row.
   *
   * Never Unicode-normalized, and that is measured rather than assumed: **NTFS is
   * normalization-sensitive.** A file created with a decomposed (NFD) name opens only via its
   * decomposed path - the composed one returns ENOENT - and `readdir` hands the decomposed
   * form back. Composing this would make such a file list in the explorer and then refuse to
   * open, play, move or trash, which is a far worse failure than the one composing was meant
   * to fix. `pathKey` below is where the composed spelling lives instead.
   */
  path: string
  /**
   * The composed (NFC) spelling of `path`, for looking this file up in the path-keyed maps -
   * tags, ratings, notes, detected tempo and key, the waveform cache.
   *
   * **Absent whenever it would equal `path`,** which is every all-ASCII name and so ~99% of a
   * library. That is the whole design of the field: `src/shared/path-key.ts` returns the
   * argument unchanged for an ASCII string, so the common row carries no second string and no
   * extra property, and the 280.1MB → 187.1MB the index interning bought back is not quietly
   * spent again on a copy of every path. Read it as `track.pathKey ?? track.path`.
   */
  pathKey?: string
  /** Path relative to the library root, using forward slashes. */
  rel: string
  /** Absolute path of the containing directory. */
  dir: string
  /** Directory relative to the library root, forward slashes, '' for the root itself. */
  relDir: string
  /** File name including extension. */
  name: string
  /** Lower-case extension without the dot. */
  ext: string
  size: number
  mtimeMs: number
  kind: TrackKind
  /** Whether the built-in player can play this file. */
  playable: boolean

  /** True once the metadata probe has run for this file (even if it found nothing). */
  probed?: boolean
  /** Seconds. */
  duration?: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  /** Bits per second, for compressed formats. */
  bitrate?: number
  bpm?: number
  musicalKey?: string

  /** DAW project files only - from FL Studio's built-in time tracking. */
  projectCreatedMs?: number
  /** Cumulative seconds the project has been open in its DAW. */
  projectSeconds?: number
}

/** The subset of Track that the metadata probe produces. */
export type TrackMetadata = Pick<
  Track,
  | 'duration'
  | 'sampleRate'
  | 'bitDepth'
  | 'channels'
  | 'bitrate'
  | 'bpm'
  | 'musicalKey'
  | 'projectCreatedMs'
  | 'projectSeconds'
>

export interface ScanProgress {
  phase: 'walking' | 'probing' | 'done'
  /** Files discovered so far. */
  found: number
  /** Files probed so far, during the 'probing' phase. */
  probed: number
  total: number
  /**
   * The library was restored from the saved index and this pass is only checking for
   * changes - worth saying, because it isn't the wait a first scan is.
   */
  revalidating?: boolean
}

/** Incremental metadata updates streamed to the renderer during the probe pass. */
export interface MetadataPatch {
  path: string
  meta: TrackMetadata
}

export type SortKey =
  | 'name'
  | 'kind'
  | 'duration'
  | 'size'
  | 'mtimeMs'
  | 'bpm'
  | 'musicalKey'
  | 'sampleRate'
  | 'rating'

export type ColumnId =
  | 'name'
  | 'rating'
  | 'type'
  | 'bpm'
  | 'key'
  | 'time'
  | 'format'
  | 'size'
  | 'modified'
  | 'notes'
  | 'waveform'

/** Persisted per-column layout. Array order is the on-screen order. */
export interface ColumnState {
  id: ColumnId
  width: number
  visible: boolean
}

/**
 * One folder the library is built from. See `src/shared/roots.ts` for why the label is
 * stored rather than derived.
 */
export interface LibraryRoot {
  /** Absolute path of the folder on disk. */
  path: string
  /** First segment of every relative path underneath it. Assigned once, never changed. */
  label: string
}

export interface Settings {
  /**
   * Every folder the library is built from, in the order they were added. Empty until the
   * user picks one.
   */
  roots: LibraryRoot[]
  /** Recently opened roots, most recent first. */
  recentRoots: string[]
  /** Where the player draws its up-next list from. */
  queueSource: 'folder' | 'view'
  /** The sort used by folders you haven't sorted yourself, and by the saved views. */
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  /**
   * Sort remembered per folder, keyed by root-relative path. Stems want to be in name
   * order and a bounces folder wants newest first, and having to re-sort every time you
   * step between them is the sort of thing you stop noticing and start resenting.
   */
  folderSort: Record<string, { key: SortKey; dir: 'asc' | 'desc' }>
  /** Continue to the next track automatically when one finishes. */
  autoAdvance: boolean
  /**
   * Whether stepping through the list with the arrow keys plays each file as it is
   * reached.
   *
   * Off by default. It is how a sample browser behaves and it is genuinely useful when
   * you are auditioning takes, but it also means every keypress interrupts whatever is
   * playing - so it is opted into rather than out of.
   */
  auditionOnArrow: boolean
  /**
   * Whether selecting an audio file with the mouse starts it playing.
   *
   * Off by default - see DEFAULT_SETTINGS: clicking a file to see what it is should not
   * commit you to hearing it. Folders and files the player can't decode are unaffected
   * either way - there is nothing to hear.
   */
  playOnSelect: boolean
  /** Column order, widths and visibility. Empty means "use the defaults". */
  columns: ColumnState[]
  /** Where browsing was when the app last closed, so it reopens in place. */
  lastDir: string
  lastViewMode: 'folder' | 'rated' | 'stats' | 'settings' | 'contracts' | 'videos'

  /** Last window position and size, restored on launch. */
  windowBounds: { x: number; y: number; width: number; height: number } | null
  windowMaximized: boolean
  /**
   * Rebound keys, by action id. Anything absent uses its default.
   *
   * Only the keys umakbang invented are in here - see `src/shared/shortcuts.ts` for why the
   * traditional chords are deliberately not offered.
   */
  shortcuts: Record<string, string>

  /** Width of the folder sidebar on the left, in pixels. */
  sidebarWidth: number
  /**
   * Where the sidebar splits, in pixels: how much room the tag chips get before the folder
   * tree starts.
   *
   * It was a fixed 92px cap, chosen so the strip could never grow enough to squeeze the
   * transport off the bottom. That reasoning holds for a *default* and not for a limit - how
   * many tags somebody has is their business, and a producer who tags heavily was scrolling a
   * three-line window while the tree below had the whole pane. Dragging it is also how you
   * temporarily give the tree everything, which is the other half of the same complaint.
   */
  tagsHeight: number
  /** Width of the now-playing / visualizer panel on the right, in pixels. */
  panelWidth: number
  /**
   * Height of the transport strip along the bottom of the explorer, in pixels. Taller
   * means a taller waveform, which is the only thing in there worth more room.
   */
  playerHeight: number
  /**
   * Width given to the controls half of the transport strip, in pixels. The waveform takes
   * whatever is left, so this is the boundary between the two.
   */
  playerSplit: number
  /**
   * Which metadata fields the transport strip lists under the track name, in order.
   * Empty means the built-in default rather than a blank line.
   */
  playerDetails: string[]
  /** Whether that panel is showing at all. */
  panelOpen: boolean
  /** Ids of the enabled visualizers, in display order. */
  visualizers: string[]
  /** Full-window visualizers, with the library hidden. */
  visualizerOnly: boolean
  /** Keep the window above other applications. */
  alwaysOnTop: boolean
  /**
   * Playback volume, 0 to 1. Separate from mute, which is its own state: unmuting has to
   * return to the level that was set rather than to full, and a slider dragged up from zero
   * while muted lifts the mute rather than leaving you dragging something inaudible.
   */
  volume: number
  /**
   * Where playback comes out. Null is the system default, which is what follows the OS.
   *
   * The label is stored beside the id, and it is not decoration. A device id is only
   * meaningful while the device is there, so once an interface is unplugged the id names
   * nothing at all - and a picker that fell silently back to the default would be the exact
   * failure this setting exists to make legible. The saved name is what lets the app say
   * *"Scarlett 2i2 isn't connected"* rather than showing "System default" as though the user
   * had chosen it.
   */
  outputDevice: { id: string; label: string } | null
  /** User accent / background overrides; null means "use the stylesheet default". */
  themePrimary: string | null
  themeBackground: string | null
  /**
   * Visualizer tint as a low → high pair: quiet material takes the low colour, loud takes
   * the high one, everything between is a gradient. Null falls back to theme tokens.
   */
  /**
   * The visualizer ramp, quiet → loud, as hex colours in order.
   *
   * A list rather than named ends, because how many points a gradient wants is a matter of
   * taste and two was not enough. Empty means `DEFAULT_VISUALIZER_STOPS`.
   */
  visualizerStops: string[]
  /** Empty space above the visualizers' established 0dB point, in decibels. */
  visualizerHeadroomDb: number
  /**
   * How the waveforms are coloured.
   *
   * 'spectrum' tints each column by where its energy sits - a kick draws at the quiet end
   * of the ramp, a hi-hat at the loud end - which says something the outline alone can't.
   * 'accent' is the plain single-colour shape.
   */
  waveformTint: 'accent' | 'spectrum'
  /** Type filters survive restarts - "audio only" is a mode, not a momentary action. */
  typeFilter: { kinds: TrackKind[]; exts: string[] }
  /**
   * Whether a track's renders are folded into one row in the explorer.
   *
   * `REFLECT_Master.wav`, `REFLECT.mp3` and `REFLECT_notag.wav` are one piece of music
   * occupying three rows, and in a folder of finished work that is the dominant pattern:
   * 40 songs read as 120 files. The fold is the stats page's `workOf` - the folder plus
   * the file name with the render words off - so the explorer and the panels can never
   * disagree about what counts as one track.
   *
   * Off by default. It changes what the library looks like rather than how it behaves, and
   * a row count that silently differs from the file count on disk is not something to hand
   * somebody without their asking for it.
   */
  collapseRenders: boolean
  /**
   * The folders you keep coming back to.
   *
   * One list doing both jobs: they are listed under "Move to" in the row menu, and drawn
   * as Quick access in the sidebar. A folder you file things into and a folder you go to
   * are the same handful of folders, and keeping two lists meant adding each one twice.
   */
  quickMove: QuickMoveTarget[]
  /** The OS Downloads staging view starts as a removable Quick access pin. */
  downloadsQuickAccess: boolean
  /**
   * Folders that hold music the user did not write, as root-relative paths. A folder
   * excludes everything beneath it too. Sample packs and one-shot libraries outnumber
   * finished beats by a wide margin, and without this the dice lands on a kick sample
   * nine times out of ten. Root-relative rather than absolute so it survives moving the
   * library, and travels with an exported settings file.
   *
   * Named for the random button because that is what it was first for, and kept under that
   * name because renaming a persisted key costs a migration this app deliberately doesn't
   * have. The stats page's key and tempo panels read it for the same reason the dice does:
   * 93% of this library's keyed audio is somebody else's loop pack, so without it "keys you
   * write in" describes the packs rather than the user.
   */
  randomExcludeDirs: string[]
  /**
   * Whether the random button leans towards beats you have not rated yet.
   *
   * A lean, not a filter. Excluding rated files outright has a cliff in it: once most of the
   * library is rated the dice would circle the same few leftovers, and at 100% there would be
   * nothing to draw at all. Weighting the unrated ones higher (`UNRATED_WEIGHT` in
   * `player.ts`) keeps the whole library in play and degrades to a plain uniform draw when
   * everything has stars on it.
   */
  randomFavourUnrated: boolean
  /**
   * The folder tag that nominates which parts of the library get their tempo and key
   * analysed. Null means everything, which is what an install that has never tagged a
   * folder should do.
   *
   * Analysis costs a full decode per file, and a library that is mostly sample packs
   * spends nearly all of it on one-shots that have no tempo and no key worth the name.
   * Tagging the folders that hold finished music points the work at them instead.
   */
  analysisTag: string | null
  /**
   * Whether musical key is estimated from the audio.
   *
   * Tempo detection is accurate and stays on regardless. Key is not: measured against
   * files with known keys it lands on the right one about a third of the time, and the
   * misses are not near-misses that a threshold would catch. Keys that came off a tag, an
   * ACID chunk or a file name are unaffected by this - those are read, not guessed.
   */
  detectKeyFromAudio: boolean
  /**
   * Which detector estimates the key.
   *
   * `builtin` is `key.ts`: one FFT chroma correlated against Krumhansl-Kessler, no
   * dependencies. `essentia` is Essentia's `KeyExtractor` through its WebAssembly build -
   * the same engine behind the web tools that do this well, and a genuine HPCP front end
   * with tuning correction and harmonic weighting rather than raw bin folding.
   *
   * A setting rather than a replacement, for two unrelated reasons. Measured, Essentia is
   * better on this material but not uniformly, and a detector that is wrong differently is
   * worth being able to switch back from. And `essentia.js` is AGPL-3.0: using it here is
   * free, but an umakbang that shipped it to anybody else would have to be AGPL-3.0 too, so
   * the built-in detector has to remain a complete answer on its own.
   *
   * It reads the same 11025 Hz mono signal the built-in one does - measured, that costs it
   * nothing against feeding it 44100, which is what makes this a swap of one function and
   * not a second signal down the pipeline.
   */
  keyEngine: 'builtin' | 'essentia'
  /**
   * Which of Essentia's key profiles to score against, when it is the detector.
   *
   * `bgate` and `edma` were both derived from electronic dance music rather than from
   * probe-tone experiments on classical tonality, which is what this library is. `temperley`
   * and `krumhansl` are the classical ones, kept because a library is not all one thing.
   */
  keyProfile: 'bgate' | 'edma' | 'temperley' | 'krumhansl'
  /**
   * A command that works out a file's key better than the built-in detector does.
   *
   * `{file}` is replaced with the absolute path; whatever the command prints is read as
   * the key. Empty means "use the built-in detector", which is what an install with no
   * such tool should do.
   *
   * Deliberately a command rather than support for one particular product: the plugin that
   * started this - Antares Auto-Key - turned out to publish nothing a host can read, and
   * anything that did would be a different integration again. A command works with whatever
   * you have.
   *
   * Machine-specific, so it is left out of a settings export along with the library root:
   * a settings file is something people pass around, and it should not be able to carry a
   * command that then runs here.
   */
  keyCommand: string
  /**
   * How many files are analysed at once, 1..10.
   *
   * The detectors run in a worker now, so several at a time is genuinely parallel - but
   * each one holds a decoded buffer, and decoding still costs the renderer thread. Higher
   * gets through a folder faster; too high on a large library is a lot of memory at once.
   */
  analysisConcurrency: number

  /**
   * How many file operations Ctrl+Z can step back through, 1..200.
   *
   * A cap exists at all because a record holds one entry per file it touched, and pasting a
   * large folder is tens of thousands of them - an unbounded history would keep every one of
   * those alive for the life of the process. Where the cap should sit is not something the
   * app can know: 25 covers a normal session of tidying, and somebody moving a library about
   * in long batches wants more. Turning it down also frees whatever the dropped records held.
   */
  undoDepth: number

  /**
   * LALAL.AI licence key, for the "Split vocals" action.
   *
   * A credential, so it is left out of a settings export along with the library root and
   * the key command: a settings file is something people pass around, and it should not
   * carry an account that bills by the minute.
   */
  lalalKey: string

  /**
   * Where the Export button writes bundles, so it does not have to ask every time.
   *
   * Seeded once, when empty, to the same `backups` folder the automatic daily backup uses,
   * and left alone after that so choosing somewhere else sticks. Left out of a settings
   * export: unlike a stem folder this is not a preference but where *this install* keeps its
   * own files, derived from where the executable sits, and an imported value would aim at
   * the exporting machine's install folder and then never be re-seeded.
   */
  bundleExportDir: string

  /** Where separated stems are written. */
  stemOutputDir: string
  /** Which separation model to ask for, and what container to get back. */
  stemSplitter: string
  stemFormat: string

  /**
   * Whether the guided first run has already happened.
   *
   * Set the moment the tour ends, however it ends - finished or skipped - because a tour
   * somebody skipped is a tour they have decided about, and asking again on the next launch
   * is the same intrusion a second time.
   */
  tutorialSeen: boolean
  /**
   * Shows the switches that are for testing umakbang rather than for using it.
   *
   * A gate rather than a hidden key sequence: the thing behind it throws this machine's
   * settings away, and an option that destructive should be one somebody deliberately turned
   * on and can see is on.
   */
  developerMode: boolean
  /**
   * Come up on the next launch as though nothing had ever been set: no library, default
   * settings, the welcome screen.
   *
   * The first run is the hardest state to get back to and the one most worth testing, and
   * the alternative is deleting a file in `%APPDATA%` by hand and hoping it was the right
   * one. The current data file is copied aside before anything is thrown away, and both this
   * and `developerMode` survive the reset - without that the switch would be invisible on the
   * screen you land on and every launch after it would wipe the machine again.
   */
  resetOnLaunch: boolean
}

/** One entry in the "Move to" menu. */
/**
 * The ramp everything is tinted with until the user says otherwise.
 *
 * Five points rather than two: a gradient between two colours spends most of its length in
 * the muddy middle between them, and the whole job of this ramp is to make "louder" and
 * "brighter" legible at a glance.
 */
export const DEFAULT_VISUALIZER_STOPS = [
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#ec4899'
] as const

export interface QuickMoveTarget {
  /** What the menu calls it. Starts as the folder's own name. */
  label: string
  /** Absolute path. May sit outside the library - that's the point of filing. */
  path: string
}

/** How a transfer treats its sources. */
export type TransferMode = 'move' | 'copy'

/** One indexed file that has moved or been copied: where it was, and where it is now. */
export interface TransferItem {
  from: string
  track: Track
}

/**
 * The outcome of a copy, move or rename.
 *
 * `items` is per *file* - a folder expands to everything indexable beneath it - so the
 * renderer can carry ratings, tags and already-probed metadata across without a rescan.
 */
export interface TransferResult {
  error?: string
  /** The top-level entries that made it, in the order they were handled. */
  moves: Array<{ from: string; to: string; directory: boolean }>
  items: TransferItem[]
  /** Paths that are no longer where they were. Empty for a copy. */
  removed: string[]
}

/** The outcome of sending files to the OS trash. */
export interface TrashResult {
  error?: string
  /** The top-level entries that were trashed. */
  trashed: string[]
  /** Indexed files that went with them, folder contents included. */
  removed: string[]
}

/* ------------------------------------------------------------------ undo */

/**
 * Which operation an undo record reverses.
 *
 * Trash is deliberately absent. `shell.trashItem` has no reliable cross-platform way back,
 * and an Undo that sometimes does nothing teaches people that none of them work - so a
 * delete carries no Undo affordance at all rather than a dead one.
 */
export type UndoKind = 'move' | 'copy' | 'rename' | 'newFolder'

/**
 * One file an operation left somewhere, with the stamp it left it with.
 *
 * `size` and `mtimeMs` are the whole of "never reverse something done outside umakbang". A
 * move carries both across untouched, so a file whose stamp still matches is one nothing
 * has written to since umakbang put it there. A mismatch is refused and reported.
 */
export interface UndoEntry {
  /** Where the file is now. */
  at: string
  /** Where it was before. Absent for a copy, which came from nowhere. */
  from?: string
  size: number
  mtimeMs: number
}

/** The last operation, in enough detail to be run backwards. One of these at a time. */
export interface UndoRecord {
  id: string
  kind: UndoKind
  /** The top-level entries the operation handled, exactly as `TransferResult` reported them. */
  moves: Array<{ from: string; to: string; directory: boolean }>
  items: UndoEntry[]
  /** The folder the operation started from, so the undo can say where things went back to. */
  originDir: string
  at: number
}

/**
 * What the menu, the toolbar and the notice all say about the pending undo.
 *
 * The label is built once, in main, precisely so those three cannot word it three different
 * ways - "Undo Move (43 files)" is one sentence about one record, not three renderings of it.
 */
export interface UndoSummary {
  id: string
  kind: UndoKind
  label: string
  fileCount: number
  /**
   * How many operations are on the stack, this one included.
   *
   * Only so the button can say there is more than one press in it. Undo runs the newest and
   * nothing else, so this is never a thing to pick from - a count, not an index.
   */
  depth: number
}

/** How far through an undo is, reported per file so a long one can be watched. */
export interface UndoProgress {
  done: number
  total: number
}

/**
 * What an undo managed.
 *
 * Partial failure is reported rather than swallowed: "Restored 39 of 43. 4 changed on disk
 * since." is the sentence this exists to make possible.
 */
export interface UndoOutcome {
  restored: number
  total: number
  failures: Array<{
    path: string
    /**
     * `changed` - the file is not the one umakbang put there. `occupied` - something is at
     * the path it would go back to. `missing` - it is no longer where it was left.
     */
    reason: 'changed' | 'occupied' | 'missing' | 'error'
    message: string
  }>
  /** Where the files went back to, root-relative, when there is somewhere to look. */
  landedRel?: string
  /** True when the user stopped it part way. What had already been put back stays put back. */
  cancelled: boolean
}

export interface UserData {
  settings: Settings
  /** Absolute path -> tags applied to it. */
  tags: Record<string, string[]>
  /** Absolute path -> 1..5 star rating. Absent means unrated. */
  ratings: Record<string, number>
  /**
   * Tempo worked out by analysing the audio, for files whose headers and names don't
   * say. Kept separate from the probe's metadata cache because it is derived from a full
   * decode, which only happens when a file is actually looked at.
   */
  detectedBpm: Record<string, number>
  /**
   * Musical key worked out by analysing the audio, for files whose headers and names
   * don't say. Kept beside the detected tempo and for the same reason: it comes from a
   * full decode, which only happens when a file is actually looked at.
   */
  /**
   * Whatever you want to remember about a file, by absolute path.
   *
   * User-authored and irreplaceable, so it travels in a settings export beside the tags and
   * the ratings, follows a file when it is moved, and is dropped from the map entirely when
   * it is emptied rather than being stored as "".
   */
  notes: Record<string, string>
  detectedKey: Record<string, string>
  /**
   * How well the detector's key fitted, for the keys in `detectedKey`, 0 to 1.
   *
   * Kept so the column can say when a reading is a close call rather than drawing it like a
   * certainty. Deliberately absent from settings exports: it describes this machine's
   * detector run, it is worthless without the key beside it, and a backup that carried it
   * would need `remapBackup` taught about one more path-keyed map for a visual nicety.
   */
  detectedKeyFit: Record<string, number>
}

export interface PlatformInfo {
  platform: NodeJS.Platform
  isMac: boolean
  isWindows: boolean
  /** Localised label for the "show this file in the OS file manager" action. */
  revealLabel: string
  homeDir: string
  musicDir: string
  downloadsDir: string
}

/**
 * Where the updater has got to.
 *
 * `version` is always what is running, so the settings row can name it whatever else is
 * happening. `available` is the newer one, and only exists once there is one. `disabled`
 * carries a reason rather than being silent, because "no updates here" and "updates are
 * broken" look identical from the outside and only one of them is worth acting on.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error' | 'disabled'
  /** The running version. */
  version: string
  /** The version being downloaded or waiting to install. */
  available?: string
  /** Download progress, whole percent. */
  percent?: number
  /** Why it is disabled, or what went wrong. */
  reason?: string
}

export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  recentRoots: [],
  queueSource: 'folder',
  // Newest first: the thing you were working on last is the thing you want next.
  sortKey: 'mtimeMs',
  sortDir: 'desc',
  folderSort: {},
  // Both off: browsing a sample library is not listening to an album. Clicking a file to
  // see what it is should not commit you to hearing it, and reaching the end of one should
  // not start the next - the next file in a folder is rarely the next thing you wanted.
  autoAdvance: false,
  auditionOnArrow: false,
  playOnSelect: false,
  // The columns worth having on screen, at widths that fit their content. Empty meant
  // `lib/columns.ts` defaults, which showed everything and left the ones you read most -
  // BPM and key - fighting for room with format and size. `normalizeColumns` still clamps
  // each width to its minimum on load, so this is a starting layout, not a constraint.
  columns: [
    { id: 'name', width: 300, visible: true },
    { id: 'rating', width: 97, visible: true },
    { id: 'type', width: 113, visible: true },
    { id: 'bpm', width: 76, visible: true },
    { id: 'key', width: 71, visible: true },
    { id: 'time', width: 111, visible: false },
    { id: 'format', width: 127, visible: false },
    { id: 'size', width: 88, visible: false },
    { id: 'modified', width: 134, visible: true },
    { id: 'waveform', width: 120, visible: false }
  ],
  lastDir: '',
  lastViewMode: 'folder',
  windowBounds: null,
  windowMaximized: false,
  // Sized for the panes that earn the space: a sidebar wide enough for nested folder names
  // without truncating them, and a now-playing panel wide enough for the visualizers to be
  // readable rather than decorative.
  // Empty means every key is where `SHORTCUT_ACTIONS` puts it.
  shortcuts: {},
  sidebarWidth: 345,
  // The cap the tag strip used to be fixed at, kept as the starting point - it is a good
  // default and a bad limit. See `tagsHeight`.
  tagsHeight: 92,
  panelWidth: 576,
  playerHeight: 118,
  playerSplit: 318,
  // Empty means the built-in list in `lib/player-details.ts`. These are the fields that
  // say what a file *is* when you are deciding whether to use it.
  playerDetails: ['bpm', 'key', 'modified', 'extension', 'projectTime', 'size'],
  panelOpen: true,
  visualizers: ['spectrogram', 'spectrum', 'wave', 'scope', 'levels', 'stereo'],
  themePrimary: null,
  themeBackground: null,
  visualizerStops: [],
  visualizerHeadroomDb: 6,
  waveformTint: 'spectrum',
  typeFilter: { kinds: [], exts: [] },
  collapseRenders: false,
  quickMove: [],
  downloadsQuickAccess: true,
  randomExcludeDirs: [],
  randomFavourUnrated: false,
  visualizerOnly: false,
  alwaysOnTop: false,
  volume: 1,
  // Whatever the OS is set to. Anything else would be this machine's guess about hardware
  // it has not looked at yet.
  outputDevice: null,
  analysisTag: null,
  detectKeyFromAudio: true,
  // Essentia by default. It was `builtin` for two reasons and neither holds any more: the
  // licence one is gone, because `essentia.js` is AGPL-3.0 and umakbang now is too, and the
  // measurement one was "not reliably *better*", which is not the same as "no better" - it
  // was one pair's difference over 60 files, so it decided nothing either way.
  //
  // What is not ambiguous is the failure mode. `world seed.mp3` reads Fm on the built-in
  // detector at confidence 0.130 - a hair over the runner-up - where two independent
  // references say Db and Essentia says Db on all four profiles at both 60s and 120s. A
  // detector that is unsure and shows its answer like any other is worse than one that is
  // right, and the built-in one stays available for anyone who wants it.
  keyEngine: 'essentia',
  keyProfile: 'krumhansl',
  keyCommand: '',
  // Analysis is off the main thread in a worker, so the ceiling is cores rather than
  // responsiveness, and 2 left a library crawling through its own backlog.
  analysisConcurrency: 10,
  // Enough for a session's worth of tidying without holding a history nobody will walk back
  // through. See `undoDepth` for why there is a ceiling on it at all.
  undoDepth: 25,
  lalalKey: '',
  bundleExportDir: '',
  stemOutputDir: '',
  stemSplitter: 'lynx',
  stemFormat: 'mp3',
  // False, so a fresh install gets the tour once a folder is open. An install that predates
  // the tour gets it too, which is the right way round: it is twenty seconds and it can be
  // stopped at any point.
  tutorialSeen: false,
  developerMode: false,
  resetOnLaunch: false
}

/* ------------------------------------------------------------------ stems */

export type StemPhase = 'uploading' | 'queued' | 'separating' | 'downloading' | 'done' | 'failed'

export interface StemProgress {
  path: string
  phase: StemPhase
  /** 0..100 within the current phase, when the service reports one. */
  percent?: number
  message?: string
}

export interface StemOptions {
  licenseKey: string
  outputDir: string
  /** Which model does the separation. The service adds new ones and retires old ones. */
  splitter: string
  /** Container the stems come back in. */
  format: string
  stem: string
}

export interface StemOutcome {
  path: string
  written: string[]
  error?: string
}

