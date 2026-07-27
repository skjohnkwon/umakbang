/** Types shared between the main process, the preload bridge and the renderer. */

/** What sort of file this is. Not what it's for - that's what tags are for. */
export type TrackKind = 'audio' | 'midi' | 'project'

/** One file in the library. Metadata fields are filled in by the background probe pass. */
export interface Track {
  /** Absolute path on disk. Doubles as the stable identity of a row. */
  path: string
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
   * On by default: picking a sample out of a folder is nearly always a request to hear it,
   * and the alternative is two clicks for the one thing you came to do. Folders and files
   * the player can't decode are unaffected - there is nothing to hear.
   */
  playOnSelect: boolean
  /** Column order, widths and visibility. Empty means "use the defaults". */
  columns: ColumnState[]
  /** Where browsing was when the app last closed, so it reopens in place. */
  lastDir: string
  lastViewMode: 'folder' | 'rated' | 'stats' | 'settings' | 'contracts'

  /** Last window position and size, restored on launch. */
  windowBounds: { x: number; y: number; width: number; height: number } | null
  windowMaximized: boolean
  /** Width of the folder sidebar on the left, in pixels. */
  sidebarWidth: number
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
   * The folders you keep coming back to.
   *
   * One list doing both jobs: they are listed under "Move to" in the row menu, and drawn
   * as Quick access in the sidebar. A folder you file things into and a folder you go to
   * are the same handful of folders, and keeping two lists meant adding each one twice.
   */
  quickMove: QuickMoveTarget[]
  /**
   * Folders the random beat button never draws from, as root-relative paths. A folder
   * excludes everything beneath it too. Sample packs and one-shot libraries outnumber
   * finished beats by a wide margin, and without this the dice lands on a kick sample
   * nine times out of ten. Root-relative rather than absolute so it survives moving the
   * library, and travels with an exported settings file.
   */
  randomExcludeDirs: string[]
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
   * LALAL.AI licence key, for the "Split vocals" action.
   *
   * A credential, so it is left out of a settings export along with the library root and
   * the key command: a settings file is something people pass around, and it should not
   * carry an account that bills by the minute.
   */
  lalalKey: string
  /** Where separated stems are written. */
  stemOutputDir: string
  /** Which separation model to ask for, and what container to get back. */
  stemSplitter: string
  stemFormat: string
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
  detectedKey: Record<string, string>
}

export interface PlatformInfo {
  platform: NodeJS.Platform
  isMac: boolean
  isWindows: boolean
  /** Localised label for the "show this file in the OS file manager" action. */
  revealLabel: string
  homeDir: string
  musicDir: string
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
  sidebarWidth: 345,
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
  waveformTint: 'spectrum',
  typeFilter: { kinds: [], exts: [] },
  quickMove: [],
  randomExcludeDirs: [],
  visualizerOnly: false,
  alwaysOnTop: false,
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
  lalalKey: '',
  stemOutputDir: '',
  stemSplitter: 'lynx',
  stemFormat: 'mp3'
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

