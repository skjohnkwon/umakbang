import { create } from 'zustand'
import type {
  LibraryRoot,
  MetadataPatch,
  PlatformInfo,
  ScanProgress,
  Settings,
  SortKey,
  Track,
  TrackKind,
  TransferMode,
  TransferResult,
  UserData
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { setInternalDropHandler } from '@/lib/drag'
import { forgetPeaks, setDecodeObserver } from '@/lib/peaks'
import type { BackupSummary, FolderMapping, SettingsBackup } from '@shared/backup'
import {
  analyseDecoded,
  configureAnalysis,
  forgetAnalysis,
  requestAnalysis,
  setAnalysisConcurrency,
  reprocessAll,
  setKeyCommand,
  setKeyDetectionEnabled,
  setKeyEngine,
  resetAnalysis
} from '@/lib/analysis'
import { inAnalysisScope } from '@/lib/analysis-scope'
import { plausibleBpm } from '@shared/tempo'
import { absolutePath, baseName, parentPath, relativePath, samePath } from '@/lib/paths'

export type ViewMode =
  | { mode: 'folder'; dir: string }
  | { mode: 'all' }
  /** Files whose star rating falls inside an inclusive range. */
  | { mode: 'rated'; min: number; max: number }
  | { mode: 'stats' }
  | { mode: 'settings' }
  /** Contracts: what has been generated, who for, and on what terms. */
  | { mode: 'contracts' }
  /** The OS Downloads folder - a staging area, listed on demand. */
  | { mode: 'downloads' }

/**
 * Whether two views are the same place.
 *
 * History needs this or every re-navigation to the folder you are already standing in
 * stacks another entry, and Back walks through a run of identical rows doing nothing
 * visible. Clicking the current folder in the sidebar does exactly that.
 */
function sameView(a: ViewMode | undefined, b: ViewMode): boolean {
  if (!a || a.mode !== b.mode) return false
  if (a.mode === 'folder' && b.mode === 'folder') return a.dir === b.dir
  if (a.mode === 'rated' && b.mode === 'rated') return a.min === b.min && a.max === b.max
  return true
}

/**
 * How many places back you can go.
 *
 * Bounded because this is kept for the life of the session and a folder tree is easy to
 * walk a long way through. Fifty is far more than anybody retraces by hand.
 */
const HISTORY_LIMIT = 50

/**
 * One place in the history: a view, and the file that was revealed to reach it.
 *
 * The selection is here rather than in `ViewMode` deliberately. `ViewMode` is also the
 * store's `view`, the persisted `lastViewMode` and what `sameView` compares, so a field
 * added to it for the benefit of Back would have to be reasoned about everywhere those are.
 *
 * Only reveals record one. Going back into a folder you were merely browsing restores the
 * folder and no selection, because the entry for it was pushed on arrival - before you had
 * selected anything - and keeping it current would mean writing to the history stack on
 * every click.
 */
interface HistoryEntry {
  view: ViewMode
  /** The revealed file, if this entry came from `revealTrack`. */
  selected?: string
}

/**
 * An entry added to the stack, with anything ahead of it discarded. Null when it is the
 * place we are already standing.
 *
 * Shared by `setView` and `revealTrack` rather than living inside `setView`, because a
 * reveal moves the explorer and so is somewhere you can want to come back from, but it
 * cannot go through `setView`: it carries a pile of its own state - the cleared query, the
 * selected row, the filters it had to drop to show that row at all - which has to land in
 * the same commit as the view or the table renders once against the new folder with the old
 * selection still in it.
 *
 * The selected file is part of what makes an entry distinct, not just the view. Two random
 * beats out of the same folder are two places you have been, and comparing the folder alone
 * collapsed them into one - so Back walked out of the folder rather than to the beat before.
 */
function pushed(
  history: HistoryEntry[],
  historyIndex: number,
  entry: HistoryEntry
): { history: HistoryEntry[]; historyIndex: number } | null {
  const current = history[historyIndex]
  if (current && sameView(current.view, entry.view) && current.selected === entry.selected) {
    return null
  }
  const trimmed = [...history.slice(0, historyIndex + 1), entry].slice(-HISTORY_LIMIT)
  return { history: trimmed, historyIndex: trimmed.length - 1 }
}

interface LibraryState {
  ready: boolean
  platform: PlatformInfo | null
  settings: Settings
  /** Every folder the library is built from. Empty until one is chosen. */
  roots: LibraryRoot[]

  /**
   * The full index. This array keeps a stable identity and its Track objects are
   * mutated in place when metadata arrives - copying a 30k-element array a few hundred
   * times during a scan is pure waste. `revision` is what components actually depend
   * on to know something changed.
   */
  tracks: Track[]
  byPath: Map<string, Track>
  /** Bumped whenever any track data changes. */
  revision: number
  /**
   * Bumped only when tracks are added or removed. The folder tree depends on this rather
   * than `revision`, so the long metadata pass doesn't rebuild it for nothing.
   */
  structureRevision: number

  scanning: boolean
  progress: ScanProgress | null

  tags: Record<string, string[]>
  /** Absolute path -> 1..5 stars. */
  ratings: Record<string, number>
  /** Tempo recovered by analysing audio, for files whose headers don't carry one. */
  detectedBpm: Record<string, number>
  /** Whatever the user wrote about a file, by absolute path. */
  notes: Record<string, string>
  /** Musical key recovered the same way. */
  detectedKey: Record<string, string>
  /** How well each of those keys fitted, 0 to 1. Absent for a key nothing measured. */
  detectedKeyFit: Record<string, number>
  /** Contents of the Downloads folder, refreshed on demand rather than indexed. */
  downloads: Track[]

  view: ViewMode
  query: string
  /**
   * Identifies the focused row, and the anchor a shift-click extends from. A file row
   * uses its absolute path; a folder row uses `dir:<relative path>`. Absolute paths can't
   * collide with that prefix.
   */
  selectedPath: string | null
  /**
   * Every selected row, by the same ids. Ordinary clicking keeps this at one entry;
   * ctrl-click and shift-click grow it. `selectedPath` is always in here when it's set.
   */
  selection: Set<string>
  /** Entries waiting to be pasted, and whether pasting moves them or copies them. */
  clipboard: { paths: string[]; mode: TransferMode } | null
  /**
   * Folders that exist on disk but hold no indexed file yet - newly created ones, and
   * pasted ones whose contents the library doesn't index. The tree is derived from files,
   * so without this a folder you just made wouldn't appear until you put something in it.
   */
  extraDirs: Set<string>
  /** The outcome of the last file operation, shown briefly and then dismissed. */
  notice: { message: string; tone: 'info' | 'error'; nonce: number } | null
  /**
   * The window is shrunk to the mini player. Not persisted: it's a "get out of the way"
   * mode you turn on for a session, and launching into a 300px square with no library in
   * sight would read as the app having broken.
   */
  miniPlayer: boolean
  /** Folder view shows every descendant rather than just direct children. */
  recursive: boolean
  /**
   * Quick filters from the Type menu. Empty arrays mean "everything"; within a list the
   * entries are ORed, and the two lists are ANDed with each other.
   */
  typeFilter: { kinds: TrackKind[]; exts: string[] }
  /**
   * Tags to narrow the view to, ORed together. Deliberately *not* persisted: the type
   * filter is a mode you leave switched on, but a tag filter is a question you asked
   * once, and finding the library apparently empty after a restart is no way to answer it.
   */
  tagFilter: string[]

  hydrate: () => Promise<void>
  resetLibrary: (roots: LibraryRoot[]) => void
  /** A folder was added: take the new list, keep everything already indexed. */
  adoptRoots: (roots: LibraryRoot[]) => void
  addTracks: (incoming: Track[]) => void
  /** A folder was re-read: fold in what it holds now. `dir` is absolute. */
  applyFolder: (dir: string, incoming: Track[]) => void
  removeTracks: (paths: string[]) => void
  applyMetadata: (patches: MetadataPatch[]) => void
  setProgress: (progress: ScanProgress) => void

  setView: (view: ViewMode) => void
  /**
   * Where you have been this session, and where you are in it.
   *
   * A file explorer's Back is not "up a folder": it retraces the path you actually took,
   * including sideways moves between saved views and Stats. Navigating anywhere new
   * discards whatever was ahead, the way a browser does.
   */
  history: HistoryEntry[]
  historyIndex: number
  goBack: () => void
  goForward: () => void
  /**
   * Shows a view without recording it. Back and Forward use this; nothing else should.
   *
   * `selected` restores the row the entry was made on, so stepping back into a folder you
   * reached by pressing random lands on the beat rather than on a list of names you never
   * read. It selects and scrolls to it; it does not play it.
   */
  showView: (view: ViewMode, selected?: string) => void
  setQuery: (query: string) => void
  /** Selects exactly one row, and makes it the anchor for a later shift-click. */
  setSelected: (path: string | null) => void
  /** Replaces the whole selection. The anchor is left alone unless one is given. */
  setSelection: (ids: string[], anchor?: string | null) => void
  /** Adds or removes one row, the way ctrl-click does. */
  toggleSelection: (id: string) => void
  clearSelection: () => void
  setRecursive: (recursive: boolean) => void
  /**
   * Navigates to a file's folder and selects it. Bumped nonce tells the table to scroll
   * the row into view once the new folder's rows exist.
   */
  revealNonce: number
  revealTrack: (track: Track) => void
  /** The folder browsing was last in, so returning to the explorer is seamless. */
  lastFolderDir: string
  toggleKindFilter: (kind: TrackKind) => void
  toggleExtFilter: (ext: string) => void
  clearTypeFilter: () => void
  setTypeFilter: (filter: { kinds: TrackKind[]; exts: string[] }) => void
  toggleTagFilter: (tag: string) => void
  clearTagFilter: () => void
  /** Drops the search, the type filters and the tag filter in one go. */
  clearAllFilters: () => void
  /** Applies a set of tags to every given file, leaving the ones they already have. */
  addTags: (paths: string[], tags: string[]) => void
  /** Removes a tag from every given file. */
  removeTag: (paths: string[], tag: string) => void
  /**
   * Renames a tag everywhere it appears, merging into the destination if that already
   * exists. Returns an error message, or null when it worked.
   */
  renameTag: (from: string, to: string) => string | null
  setSort: (key: SortKey) => void
  patchSettings: (patch: Partial<Settings>) => void

  updateTags: (path: string, tags: string[]) => void
  setRating: (path: string, rating: number) => void
  /** Writes a note against a file. An empty one removes it. */
  setNote: (path: string, note: string) => void
  refreshDownloads: () => Promise<void>
  applyDetectedBpm: (path: string, bpm: number) => void
  /** Folds an analysed tempo and/or key into the index and the cache. */
  applyAnalysis: (path: string, analysis: { bpm?: number; musicalKey?: string; keyFit?: number }) => void
  /** Throws away analysed tempo and key for these files and works them out again. */
  recalculateAnalysis: (tracks: Track[]) => void
  /**
   * Re-runs every file that already carries an analysed tempo or key, in the background.
   *
   * What it is for is a detector change: switching engine, profile or key command means
   * everything measured so far was measured by something else. Values read from tags, ACID
   * chunks or file names are never touched, because those were read rather than guessed.
   */
  reprocessCached: () => void
  /** Which file stem separation is working on, and how far along. Null when idle. */
  stemJob: { path: string; phase: string; percent?: number; done: number; total: number } | null
  /** Sends files to LALAL.AI and writes the stems back to the configured folder. */
  splitStems: (tracks: Track[]) => Promise<void>

  /* --- file operations --- */

  /** Holds entries for a paste. 'cut' moves them, 'copy' leaves the originals. */
  setClipboard: (paths: string[], mode: TransferMode) => void
  clearClipboard: () => void
  /** Copies or moves entries into an absolute destination folder. */
  transferPaths: (paths: string[], destination: string, mode: TransferMode) => Promise<void>
  /** Moves entries into a library folder, given that folder's root-relative path. */
  moveIntoFolder: (paths: string[], relDir: string) => Promise<void>
  /** Empties the clipboard into a library folder. */
  pasteInto: (relDir: string) => Promise<void>
  /** Copies each entry alongside itself, as "name (2)". */
  duplicatePaths: (paths: string[]) => Promise<void>
  /** Sends entries to the OS trash. */
  trashPaths: (paths: string[]) => Promise<void>
  /** Creates a folder inside a library folder. Resolves to an error message, or null. */
  createFolder: (relDir: string, name: string) => Promise<string | null>
  /** Renames a file or folder. Resolves to an error message, or null. */
  renameEntry: (path: string, newName: string, directory: boolean) => Promise<string | null>

  notify: (message: string, tone?: 'info' | 'error') => void
  dismissNotice: () => void
  setMiniPlayer: (mini: boolean) => void

  /**
   * Writes the whole profile - preferences, tags, ratings, and every cache - to one `.umak`
   * file.
   *
   * There used to be a second, settings-only `.json` export beside this. It went because
   * two export buttons made the user answer a question they had no way to weigh: both carry
   * everything that cannot be reproduced, and the only difference is whether the receiving
   * machine spends a minute rebuilding caches. A bundle is bigger and always the better
   * answer. `.json` files are still read on import, so nothing already written is orphaned.
   */
  /**
   * `pick` opens the save dialog; without it the bundle goes straight to the folder set in
   * Settings. Exporting is something done repeatedly to the same place, and asking for a
   * name every time was a dialog whose answer never changed.
   */
  exportBundle: (pick?: boolean) => Promise<void>
  /** True while a bundle is being written or unpacked, since both take a moment. */
  bundleBusy: boolean
  /** A backup that has been read but not yet applied, driving the import wizard. */
  importing: {
    backup: SettingsBackup
    summary: BackupSummary
    here: 'windows' | 'posix'
  } | null
  beginImport: () => Promise<void>
  cancelImport: () => void
  applyBackup: (backup: SettingsBackup, mapping: FolderMapping) => Promise<void>
  /**
   * Takes the store's own copy of everything main just wrote, keeping the settings that
   * describe this window rather than this library. Shared by both kinds of import.
   */
  adoptUserData: (data: UserData) => void
}

/**
 * One string object per distinct directory, extension and kind across the whole index.
 *
 * The scanner already interns these when it reads the saved index, and **that does the
 * renderer no good at all**: measured, structured clone does not preserve the sharing.
 * Simulating the real 326,487-track library through the same batched serialise/deserialise
 * the scanner posts across, the received rows plus their `byPath` map cost 280.1MB whether
 * or not the sending side interned, and 187.1MB when the receiving side does it too. Both
 * sides intern for that reason, not by duplication: one keeps the scanner process small
 * while it holds the index for the whole scan, the other is where the library actually
 * lives.
 *
 * There are 15,684 distinct `dir` values, as many `relDir`, 16 extensions and 3 kinds among
 * those 326,487 tracks. `path`, `rel` and `name` are left alone - they are distinct per
 * track, so pooling them is a Map that can never return a hit.
 */
const stringPool = new Map<string, string>()

function interned(value: string): string {
  const hit = stringPool.get(value)
  if (hit !== undefined) return hit
  stringPool.set(value, value)
  return value
}

function shareStrings(track: Track): void {
  if (typeof track.dir === 'string') track.dir = interned(track.dir)
  if (typeof track.relDir === 'string') track.relDir = interned(track.relDir)
  if (typeof track.ext === 'string') track.ext = interned(track.ext)
  if (typeof track.kind === 'string') track.kind = interned(track.kind) as TrackKind
}

export const useLibrary = create<LibraryState>((set, get) => ({
  ready: false,
  platform: null,
  settings: { ...DEFAULT_SETTINGS },
  roots: [],

  tracks: [],
  byPath: new Map(),
  revision: 0,
  structureRevision: 0,

  scanning: false,
  progress: null,

  tags: {},
  ratings: {},
  notes: {},
  detectedBpm: {},
  detectedKey: {},
  detectedKeyFit: {},
  downloads: [],

  view: { mode: 'folder', dir: '' },
  query: '',
  selectedPath: null,
  selection: new Set(),
  clipboard: null,
  extraDirs: new Set(),
  notice: null,
  miniPlayer: false,
  // Off by default: browsing shows subfolders as rows and drills down, like a file
  // manager. The toolbar toggle flattens the whole subtree when you'd rather see every
  // file at once.
  recursive: false,
  typeFilter: { kinds: [], exts: [] },
  tagFilter: [],
  importing: null,
  revealNonce: 0,
  lastFolderDir: '',

  hydrate: async () => {
    const [platform, userData] = await Promise.all([
      window.umakbang.getPlatform(),
      window.umakbang.getUserData()
    ])

    // Reopen where the last session left off.
    const { lastDir, lastViewMode } = userData.settings
    const view: ViewMode =
      lastViewMode === 'stats'
        ? { mode: 'stats' }
        : lastViewMode === 'settings'
          ? { mode: 'settings' }
        : lastViewMode === 'rated'
          ? { mode: 'rated', min: 1, max: 5 }
          : { mode: 'folder', dir: lastDir }

    set({
      ready: true,
      platform,
      settings: userData.settings,
      roots: userData.settings.roots,
      tags: userData.tags,
      ratings: userData.ratings ?? {},
      notes: userData.notes ?? {},
      detectedBpm: userData.detectedBpm ?? {},
      detectedKey: userData.detectedKey ?? {},
      detectedKeyFit: userData.detectedKeyFit ?? {},
      typeFilter: userData.settings.typeFilter ?? { kinds: [], exts: [] },
      view,
      // The place the session opens in is the first thing Back can return to.
      history: [{ view }],
      historyIndex: 0,
      lastFolderDir: lastDir
    })

    // Now that the real settings exist, hand the analysis module the ones it caches.
    applyAnalysisSettings(userData.settings)
  },

  adoptRoots: (roots) => set({ roots, scanning: true }),

  resetLibrary: (roots) => {
    resetAnalysis()
    // The index this pooled strings for is about to be thrown away. Kept across a reset it
    // would grow by every folder any library ever opened had, and hold them alive for the
    // life of the window.
    stringPool.clear()
    // Rescanning the same folders shouldn't throw away where the user is standing; only a
    // change to which folders are open starts over at the top.
    const before = get().roots.map((root) => root.label).join('|')
    const sameRoot = before === roots.map((root) => root.label).join('|')
    set({
      roots,
      tracks: [],
      byPath: new Map(),
      revision: 0,
      structureRevision: 0,
      scanning: true,
      progress: null,
      view: sameRoot ? get().view : { mode: 'folder', dir: '' },
      lastFolderDir: sameRoot ? get().lastFolderDir : '',
      selectedPath: null,
      selection: new Set(),
      // A fresh walk of the disk supersedes anything we were remembering about it.
      extraDirs: sameRoot ? get().extraDirs : new Set()
    })
  },

  addTracks: (incoming) => {
    const { tracks, byPath, detectedBpm, detectedKey } = get()
    let added = 0
    for (const track of incoming) {
      if (byPath.has(track.path)) continue
      added++
      shareStrings(track)
      // The saved index holds tempos probed before `plausibleBpm` existed - a hi-hat at
      // 346 BPM off its own loop chunk. Dropped here rather than waiting for a rescan to
      // rewrite the index, and dropped before the fold below so a detected tempo can take
      // its place.
      if (track.bpm !== undefined && !plausibleBpm(track.bpm)) track.bpm = undefined
      // Fold in any previously analysed tempo and key so sorting and `bpm>` / `key:`
      // filters see them too, not just the displayed value.
      if (track.bpm === undefined && detectedBpm[track.path] !== undefined) {
        track.bpm = detectedBpm[track.path]
      }
      if (track.musicalKey === undefined && detectedKey[track.path] !== undefined) {
        track.musicalKey = detectedKey[track.path]
      }
      byPath.set(track.path, track)
      tracks.push(track)
    }
    // Nothing arrived, so nothing has to be recomputed. This is the whole of a revalidation
    // pass: the walk re-sends every row the index replay already put here, and a *structural*
    // bump per batch is what makes `buildTree` fold in a tail and `useVisibleRows` re-derive
    // - 1,300 times over, for a library that has not changed. The batch still costs an IPC
    // hop and a Map lookup per row; only the scanner can stop that, which is what `onFresh`
    // in scanner.ts is for.
    if (added > 0) bumpRevision(true)
  },

  /**
   * Folds a freshly-read folder back into the index.
   *
   * What the watcher sends after something in the folder you're looking at changed - a
   * bounce re-exported over itself, a file dropped in from outside. New files are added,
   * files that have gone are dropped, and a file whose size or timestamp moved is updated
   * in place *and* has everything derived from its contents thrown away: the waveform, the
   * tempo and the key all described the take before this one.
   */
  applyFolder: (dir, incoming) => {
    const { byPath, tracks } = get()
    const stale: string[] = []
    const arrived: Track[] = []
    let touched = false

    for (const track of incoming) {
      const known = byPath.get(track.path)
      if (!known) {
        arrived.push(track)
        continue
      }
      if (known.size === track.size && known.mtimeMs === track.mtimeMs) continue
      // Mutated in place, like every other update to the index.
      known.size = track.size
      known.mtimeMs = track.mtimeMs
      known.probed = false
      known.duration = undefined
      known.sampleRate = undefined
      known.bitDepth = undefined
      known.channels = undefined
      known.bitrate = undefined
      known.bpm = undefined
      known.musicalKey = undefined
      stale.push(track.path)
      touched = true
    }

    // Anything the folder used to hold and no longer does.
    const present = new Set(incoming.map((track) => track.path))
    const gone = tracks
      .filter((track) => track.dir === dir && !present.has(track.path))
      .map((track) => track.path)

    if (stale.length > 0) {
      forgetPeaks(stale)
      forgetAnalysis(stale)
      void window.umakbang.clearDetected(stale)
      set((state) => {
        const detectedBpm = { ...state.detectedBpm }
        const detectedKey = { ...state.detectedKey }
        const detectedKeyFit = { ...state.detectedKeyFit }
        for (const path of stale) {
          delete detectedBpm[path]
          delete detectedKey[path]
          delete detectedKeyFit[path]
        }
        return { detectedBpm, detectedKey, detectedKeyFit }
      })
    }
    if (arrived.length > 0) get().addTracks(arrived)
    if (gone.length > 0) get().removeTracks(gone)
    if (touched) bumpRevision(false)

    // Whatever is new or has moved gets its headers read straight away. Without this a
    // re-exported file sits there with no duration and no format until the next full scan,
    // which is worse than the stale numbers it replaced.
    const unread = [...arrived.map((track) => track.path), ...stale]
    if (unread.length > 0) {
      void window.umakbang.probeFiles(unread).then((patches) => {
        if (patches.length > 0) get().applyMetadata(patches)
      })
    }
  },

  removeTracks: (paths) => {
    if (paths.length === 0) return
    const doomed = new Set(paths)
    const { byPath } = get()
    for (const path of paths) byPath.delete(path)
    // A new array identity is what invalidates the incrementally-built folder tree.
    set({ tracks: get().tracks.filter((track) => !doomed.has(track.path)) })
    flushRevision()
  },

  applyMetadata: (patches) => {
    const { byPath } = get()
    let touched = 0
    for (const patch of patches) {
      const track = byPath.get(patch.path)
      if (!track) continue
      touched++
      Object.assign(track, patch.meta)
      // Same as `addTracks`: the metadata cache is append-only and keyed by path, so an
      // entry written by the old bounds is handed back verbatim until the file changes.
      if (track.bpm !== undefined && !plausibleBpm(track.bpm)) track.bpm = undefined
      track.probed = true
    }
    // A batch that named nothing this window holds - the tail of a superseded scan, most
    // often - changed no row and is no reason to re-derive the visible ones.
    if (touched > 0) bumpRevision()
  },

  setProgress: (progress) => {
    set({ progress, scanning: progress.phase !== 'done' })
    // Make sure the last coalesced batch lands as soon as the scan finishes.
    if (progress.phase === 'done') flushRevision()
  },

  setView: (view) => {
    // Somewhere new: anything that was ahead is discarded, the way a browser does.
    const { history, historyIndex } = get()
    const next = pushed(history, historyIndex, { view })
    if (next) set(next)
    get().showView(view)
  },

  history: [],
  historyIndex: -1,

  goBack: () => {
    const { history, historyIndex } = get()
    if (historyIndex <= 0) return
    const index = historyIndex - 1
    set({ historyIndex: index })
    get().showView(history[index].view, history[index].selected)
  },

  goForward: () => {
    const { history, historyIndex } = get()
    if (historyIndex >= history.length - 1) return
    const index = historyIndex + 1
    set({ historyIndex: index })
    get().showView(history[index].view, history[index].selected)
  },

  /**
   * Puts a view on screen without touching history.
   *
   * Split out from `setView` precisely so Back and Forward can reuse every side effect of
   * arriving somewhere - the cleared selection, the remembered folder, the persisted
   * location - without pushing the place they just moved to onto the stack, which would
   * make Back its own Forward and trap you between two entries.
   */
  showView: (view, selected) => {
    // Remember where browsing left off so returning from Stats or a saved view drops
    // you back exactly where you were.
    const lastFolderDir = view.mode === 'folder' ? view.dir : get().lastFolderDir
    set({
      view,
      selectedPath: selected ?? null,
      selection: selected ? new Set([selected]) : new Set(),
      lastFolderDir,
      // The same nonce a reveal uses, so the table scrolls the row into view once the new
      // folder's rows exist. Selecting a row 4,000 down a folder and leaving it off screen
      // answers the question no better than not selecting it at all.
      //
      // Nothing here plays it: both audition paths are event handlers in `FileTable`, not
      // subscriptions, so arriving at a selection is silent. Back should tell you which
      // beat it was, not start it again.
      ...(selected ? { revealNonce: get().revealNonce + 1 } : {})
    })

    // Persisted too, so closing and reopening lands in the same place. Writes are
    // debounced in the main process, so navigating quickly costs nothing.
    if (
      view.mode === 'folder' ||
      view.mode === 'rated' ||
      view.mode === 'stats' ||
      view.mode === 'settings'
    ) {
      get().patchSettings({ lastDir: lastFolderDir, lastViewMode: view.mode })
    }
  },
  setQuery: (query) => set({ query }),

  setSelected: (selectedPath) =>
    set({ selectedPath, selection: selectedPath ? new Set([selectedPath]) : new Set() }),

  setSelection: (ids, anchor) =>
    set({
      selection: new Set(ids),
      ...(anchor === undefined ? {} : { selectedPath: anchor })
    }),

  toggleSelection: (id) => {
    const selection = new Set(get().selection)
    if (selection.has(id)) selection.delete(id)
    else selection.add(id)
    // Ctrl-clicking makes that row the anchor, so a shift-click afterwards runs from it.
    set({ selection, selectedPath: selection.has(id) ? id : get().selectedPath })
  },

  clearSelection: () => set({ selection: new Set(), selectedPath: null }),

  setRecursive: (recursive) => set({ recursive }),

  revealTrack: (track) => {
    const { typeFilter, tagFilter, tags, history, historyIndex } = get()
    // Clear a filter that would hide the very row we're trying to show.
    const passesType =
      (typeFilter.kinds.length === 0 || typeFilter.kinds.includes(track.kind)) &&
      (typeFilter.exts.length === 0 || typeFilter.exts.includes(track.ext))
    const passesTags =
      tagFilter.length === 0 || tagFilter.some((tag) => tags[track.path]?.includes(tag))

    const view: ViewMode = { mode: 'folder', dir: track.relDir }

    set({
      view,
      // A reveal is a place you arrived at, so Back has to be able to leave it. Without
      // this the random button moved the explorer while history still named the folder you
      // pressed it from, so Back skipped every beat it had drawn and went to whatever page
      // came before - which reads as Back being wired to the wrong thing entirely.
      // The revealed file rides along in the entry, so Back lands on the beat and not just
      // on the folder it happened to live in.
      ...(pushed(history, historyIndex, { view, selected: track.path }) ?? {}),
      // And this is where browsing is now, so leaving Settings or Stats returns here rather
      // than to the folder the random button took you out of.
      lastFolderDir: track.relDir,
      query: '',
      recursive: false,
      selectedPath: track.path,
      selection: new Set([track.path]),
      typeFilter: passesType ? typeFilter : { kinds: [], exts: [] },
      tagFilter: passesTags ? tagFilter : [],
      revealNonce: get().revealNonce + 1
    })

    // Persisted for the same reason `showView` does it: a restart should open where you
    // were left, and a revealed folder is where you were left.
    get().patchSettings({ lastDir: track.relDir, lastViewMode: 'folder' })
  },

  toggleKindFilter: (kind) => {
    const { kinds, exts } = get().typeFilter
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]
    get().setTypeFilter({ kinds: next, exts })
  },

  toggleExtFilter: (ext) => {
    const { kinds, exts } = get().typeFilter
    const next = exts.includes(ext) ? exts.filter((e) => e !== ext) : [...exts, ext]
    get().setTypeFilter({ kinds, exts: next })
  },

  clearTypeFilter: () => get().setTypeFilter({ kinds: [], exts: [] }),

  setTypeFilter: (typeFilter) => {
    // Persisted: "audio only" is a mode you leave switched on, not a one-off action.
    set({ typeFilter })
    get().patchSettings({ typeFilter })
  },

  toggleTagFilter: (tag) => {
    const current = get().tagFilter
    set({
      tagFilter: current.includes(tag)
        ? current.filter((entry) => entry !== tag)
        : [...current, tag]
    })
  },

  clearTagFilter: () => set({ tagFilter: [] }),

  clearAllFilters: () => {
    set({ query: '', tagFilter: [] })
    get().setTypeFilter({ kinds: [], exts: [] })
  },

  addTags: (paths, tags) => {
    const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    if (cleaned.length === 0 || paths.length === 0) return
    const next = { ...get().tags }
    for (const path of paths) {
      const merged = [...new Set([...(next[path] ?? []), ...cleaned])]
      next[path] = merged
      void window.umakbang.setTags(path, merged)
    }
    set({ tags: next })
  },

  renameTag: (from, to) => {
    const next = to.trim()
    if (!next) return 'A tag needs a name.'
    if (next === from) return null

    const tags = { ...get().tags }
    let touched = 0
    for (const [path, list] of Object.entries(tags)) {
      if (!list.includes(from)) continue
      // Deduped, because a file that already carries the destination tag must not end up
      // with it twice - which is what makes this a merge as well as a rename.
      const merged = [...new Set(list.map((tag) => (tag === from ? next : tag)))]
      tags[path] = merged
      void window.umakbang.setTags(path, merged)
      touched++
    }
    if (touched === 0) return null

    const state = get()
    set({
      tags,
      // A filter naming the old tag would empty the library the moment the rename lands.
      tagFilter: state.tagFilter.map((tag) => (tag === from ? next : tag))
    })
    // `Settings.analysisTag` names a folder tag, so renaming that one without following it
    // here would silently take every folder out of the analysis scope.
    if (state.settings.analysisTag === from) get().patchSettings({ analysisTag: next })
    return null
  },

  removeTag: (paths, tag) => {
    const next = { ...get().tags }
    for (const path of paths) {
      const remaining = (next[path] ?? []).filter((entry) => entry !== tag)
      if (remaining.length === 0) delete next[path]
      else next[path] = remaining
      void window.umakbang.setTags(path, remaining)
    }
    set({ tags: next })
  },

  setSort: (key) => {
    const { settings, view } = get()
    const current = effectiveSort(settings, view)

    // Clicking the active column flips direction; a new column starts ascending,
    // except for columns where "most" is the interesting end.
    const isSame = current.key === key
    const dir: 'asc' | 'desc' = isSame
      ? current.dir === 'asc'
        ? 'desc'
        : 'asc'
      : key === 'mtimeMs' || key === 'size'
        ? 'desc'
        : 'asc'

    // Sorting inside a folder is remembered for that folder alone. The saved views -
    // Rated, Downloads - share the one global sort, since they aren't places.
    if (view.mode === 'folder') {
      get().patchSettings({ folderSort: { ...settings.folderSort, [view.dir]: { key, dir } } })
    } else {
      get().patchSettings({ sortKey: key, sortDir: dir })
    }
  },

  patchSettings: (patch) => {
    // Changing which folders are in scope has to reconsider files already passed over,
    // or narrowing and then widening the scope would leave a permanent hole.
    if (patch.analysisTag !== undefined && patch.analysisTag !== get().settings.analysisTag) {
      resetAnalysis()
    }
    if (patch.keyCommand !== undefined && patch.keyCommand !== get().settings.keyCommand) {
      setKeyCommand(patch.keyCommand)
      // A different tool is a different answer; let it have another look at everything.
      resetAnalysis()
    }
    if (patch.analysisConcurrency !== undefined) {
      setAnalysisConcurrency(patch.analysisConcurrency)
    }
    if (patch.detectKeyFromAudio !== undefined) {
      setKeyDetectionEnabled(patch.detectKeyFromAudio)
      // Turning it back on has to reconsider files already passed over.
      if (patch.detectKeyFromAudio && !get().settings.detectKeyFromAudio) resetAnalysis()
    }
    if (patch.keyEngine !== undefined || patch.keyProfile !== undefined) {
      const current = get().settings
      const engine = patch.keyEngine ?? current.keyEngine
      const profile = patch.keyProfile ?? current.keyProfile
      setKeyEngine(engine, profile)
      // A different detector is a different answer, the same as a different key command:
      // everything already cached was worked out by the other one.
      if (engine !== current.keyEngine || profile !== current.keyProfile) resetAnalysis()
    }
    set({ settings: { ...get().settings, ...patch } })
    void window.umakbang.updateSettings(patch)
  },

  refreshDownloads: async () => {
    const downloads = await window.umakbang.listDownloads()
    // Carry over anything already analysed for these files, key as well as tempo.
    const { detectedBpm, detectedKey } = get()
    for (const track of downloads) {
      if (track.bpm === undefined && detectedBpm[track.path] !== undefined) {
        track.bpm = detectedBpm[track.path]
      }
      if (track.musicalKey === undefined && detectedKey[track.path] !== undefined) {
        track.musicalKey = detectedKey[track.path]
      }
    }
    set({ downloads })
  },

  /* ---------------------------------------------------------------- file operations */

  setClipboard: (paths, mode) => {
    set({ clipboard: paths.length > 0 ? { paths, mode } : null })
    /**
     * Copying puts the files themselves on the system clipboard, so Ctrl+C here behaves the
     * way it does in Explorer and a beat can be pasted straight into Discord.
     *
     * `copyFiles` sets the file list and the path text in one operation, which is the only
     * way to have both: two separate writes race, and whichever lands last owns the
     * clipboard. Where it isn't available - anywhere but Windows - it resolves false and the
     * paths go on as text, which is what that handler's contract asks the caller to do.
     *
     * Not on a cut. Windows tells cut from copy with a drop-effect flag this cannot set, so
     * a mirrored cut would paste as a copy and leave the original where it was.
     */
    if (mode === 'copy' && paths.length > 0) {
      void window.umakbang.copyFiles(paths).then((ok) => {
        if (!ok) void window.umakbang.copyText(paths.join('\n'))
      })
    }
  },
  clearClipboard: () => set({ clipboard: null }),

  transferPaths: async (paths, destination, mode) => {
    if (paths.length === 0) return
    const result = await window.umakbang.transfer(paths, destination, mode)
    applyTransfer(result, mode)
    if (result.error) {
      get().notify(result.error, 'error')
      return
    }
    // Sources that vanished between the copy and the paste are skipped rather than
    // failed, and there's nothing to announce if that accounted for all of them.
    if (result.moves.length === 0) return

    // What landed becomes the selection, so a paste or a duplicate can be acted on
    // straight away - renamed, dragged somewhere else, deleted again. Entries that went
    // outside the library simply aren't in the list, and resolve to nothing.
    const landed = rowIdsOf(result.moves, get().roots)
    if (landed.length > 0) set({ selection: new Set(landed), selectedPath: landed[0] })

    const verb = mode === 'move' ? 'Moved' : 'Copied'
    get().notify(`${verb} ${describeCount(result.moves.length)} to ${baseName(destination)}.`)
  },

  moveIntoFolder: async (paths, relDir) => {
    const { roots } = get()
    if (roots.length === 0) {
      get().notify('No library is open.', 'error')
      return
    }
    const destination = absolutePath(roots, relDir)
    await get().transferPaths(worthMoving(paths, destination), destination, 'move')
  },

  pasteInto: async (relDir) => {
    const { clipboard, roots } = get()
    if (!clipboard || roots.length === 0) return
    const destination = absolutePath(roots, relDir)

    if (clipboard.mode === 'move') {
      const moving = worthMoving(clipboard.paths, destination)
      // Cutting is a promise to move something; once it lands the clipboard is spent,
      // the way it is in every file manager. Copying can be pasted again and again.
      set({ clipboard: null })
      await get().transferPaths(moving, destination, 'move')
      return
    }
    await get().transferPaths(clipboard.paths, destination, 'copy')
  },

  duplicatePaths: async (paths) => {
    if (paths.length === 0) return
    // Each entry is copied beside itself rather than into one shared folder, so
    // duplicating a multi-folder selection doesn't quietly gather it all in one place.
    const landed: TransferResult['moves'] = []
    let failure: string | null = null
    for (const path of paths) {
      const result = await window.umakbang.transfer([path], parentPath(path), 'copy')
      applyTransfer(result, 'copy')
      landed.push(...result.moves)
      if (result.error) {
        failure = result.error
        break
      }
    }

    // The copies become the selection, so renaming one is the next keystroke.
    const ids = rowIdsOf(landed, get().roots)
    if (ids.length > 0) set({ selection: new Set(ids), selectedPath: ids[0] })

    if (failure) get().notify(failure, 'error')
    else if (landed.length > 0) get().notify(`Duplicated ${describeCount(landed.length)}.`)
  },

  trashPaths: async (paths) => {
    if (paths.length === 0) return
    const result = await window.umakbang.trash(paths)

    if (result.removed.length > 0) {
      const { byPath, extraDirs, roots } = get()
      get().removeTracks(result.removed.filter((path) => byPath.has(path)))
      const gone = new Set(result.removed)
      set({ downloads: get().downloads.filter((track) => !gone.has(track.path)) })

      // Any folder we were keeping alive by hand has gone with it.
      if (roots.length > 0 && extraDirs.size > 0) {
        const rels = result.trashed
          .map((path) => relativePath(roots, path))
          .filter((rel): rel is string => rel !== null)
        set({ extraDirs: withoutDirs(extraDirs, rels) })
      }
    } else if (result.trashed.length > 0) {
      // Folders holding nothing the library indexes leave no rows behind, only nodes.
      const { roots, extraDirs } = get()
      if (roots.length > 0) {
        const rels = result.trashed
          .map((path) => relativePath(roots, path))
          .filter((rel): rel is string => rel !== null)
        set({ extraDirs: withoutDirs(extraDirs, rels) })
      }
      flushRevision()
    }

    set({ selection: new Set(), selectedPath: null })
    if (result.error) {
      get().notify(result.error, 'error')
      return
    }
    if (result.trashed.length === 0) return
    const { platform } = get()
    const bin = platform?.isMac ? 'Trash' : platform?.isWindows ? 'Recycle Bin' : 'trash'
    get().notify(`Moved ${describeCount(result.trashed.length)} to the ${bin}.`)
  },

  createFolder: async (relDir, name) => {
    const { roots } = get()
    if (roots.length === 0) return 'No library is open.'
    const result = await window.umakbang.createFolder(absolutePath(roots, relDir), name)
    if (result.error || !result.path) return result.error ?? 'Could not create the folder.'

    // Nothing indexes an empty folder, so the tree is told about it directly.
    const rel = relativePath(roots, result.path)
    if (rel) {
      set({
        extraDirs: new Set([...get().extraDirs, rel]),
        selectedPath: `dir:${rel}`,
        selection: new Set([`dir:${rel}`])
      })
      flushRevision()
    }
    return null
  },

  renameEntry: async (path, newName, directory) => {
    const result = await window.umakbang.renameEntry(path, newName)
    if (result.error) return result.error
    const landed = result.moves[0]
    if (!landed) return null

    if (directory) {
      applyTransfer(result, 'move')
      const { roots, extraDirs } = get()
      const before = relativePath(roots, landed.from)
      const after = relativePath(roots, landed.to)
      if (before !== null && after !== null && extraDirs.has(before)) {
        set({ extraDirs: new Set([...withoutDirs(extraDirs, [before]), after]) })
      }
      const id = after === null ? null : `dir:${after}`
      set({ selectedPath: id, selection: id ? new Set([id]) : new Set() })
      flushRevision()
      return null
    }

    // A file keeps its identity: mutating in place means the folder tree's file lists go
    // on pointing at the same object, rather than a 250k-entry rebuild for one rename.
    const { byPath, ratings, tags } = get()
    const track = byPath.get(path)
    if (!track) return null

    const name = baseName(landed.to)
    const lastSlash = track.rel.lastIndexOf('/')
    const dot = name.lastIndexOf('.')
    track.path = landed.to
    track.name = name
    track.rel = lastSlash === -1 ? name : `${track.rel.slice(0, lastSlash)}/${name}`
    track.ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    byPath.delete(path)
    byPath.set(track.path, track)

    // Ratings, tags and detected values are keyed by path, so they have to follow the
    // file - a rename that dropped the detected tempo and key looked fine until the next
    // launch, when both came back blank.
    const rating = ratings[path]
    if (rating !== undefined) {
      const nextRatings = { ...ratings }
      delete nextRatings[path]
      nextRatings[track.path] = rating
      set({ ratings: nextRatings })
      void window.umakbang.setRating(path, 0)
      void window.umakbang.setRating(track.path, rating)
    }
    if (tags[path]) {
      const moved = tags[path]
      const next = { ...tags }
      delete next[path]
      next[track.path] = moved
      set({ tags: next })
      void window.umakbang.setTags(path, [])
      void window.umakbang.setTags(track.path, moved)
    }
    const { notes } = get()
    if (notes[path] !== undefined) {
      const moved = notes[path]
      const next = { ...notes }
      delete next[path]
      next[track.path] = moved
      set({ notes: next })
      void window.umakbang.setNote(path, '')
      void window.umakbang.setNote(track.path, moved)
    }
    const { detectedBpm, detectedKey } = get()
    if (detectedBpm[path] !== undefined || detectedKey[path] !== undefined) {
      const nextBpm = { ...detectedBpm }
      const nextKey = { ...detectedKey }
      const bpm = nextBpm[path]
      const musicalKey = nextKey[path]
      delete nextBpm[path]
      delete nextKey[path]
      if (bpm !== undefined) {
        nextBpm[track.path] = bpm
        void window.umakbang.setDetectedBpm(track.path, bpm)
      }
      if (musicalKey !== undefined) {
        nextKey[track.path] = musicalKey
        void window.umakbang.setDetectedKey(track.path, musicalKey)
      }
      void window.umakbang.clearDetected([path])
      set({ detectedBpm: nextBpm, detectedKey: nextKey })
    }

    set({ selectedPath: track.path, selection: new Set([track.path]) })
    flushRevision()
    return null
  },

  notify: (message, tone = 'info') =>
    set({ notice: { message, tone, nonce: (get().notice?.nonce ?? 0) + 1 } }),

  dismissNotice: () => set({ notice: null }),

  setMiniPlayer: (mini) => {
    // The two shrunken modes fight over the same stashed window bounds, so entering one
    // leaves the other.
    if (mini && get().settings.visualizerOnly) get().patchSettings({ visualizerOnly: false })
    set({ miniPlayer: mini })
  },

  bundleBusy: false,

  exportBundle: async (pick) => {
    if (get().bundleBusy) return
    const chosen = pick
      ? await window.umakbang.pickBundlePath()
      : await window.umakbang.defaultBundlePath()
    if (chosen.error) {
      get().notify(chosen.error, 'error')
      return
    }
    // Only the dialog can come back empty, and only because it was cancelled.
    if (!chosen.path) return

    set({ bundleBusy: true })
    // Said before the write, not only after it. Compressing a large library takes tens of
    // seconds, and the only thing on screen otherwise is a `.part` file appearing beside the
    // name the user just typed, which reads as a failure rather than as progress.
    get().notify(`Writing ${baseName(chosen.path)} - this takes a moment for a large library.`)
    try {
      const result = await window.umakbang.writeBundle(chosen.path)
      if (result.error) get().notify(result.error, 'error')
      // The whole path, not just the name. Without a dialog the user did not choose where
      // this went, so the folder is the part of the answer they don't already have.
      else if (result.path) get().notify(`Bundle written to ${result.path}.`)
    } finally {
      set({ bundleBusy: false })
    }
  },

  /**
   * Step one of an import: read the file and open the wizard.
   *
   * Applying is deliberately a second step. What a backup carries is mostly keyed by
   * absolute path, and on a machine where those paths mean nothing, folding it in blind
   * fills the store with entries that can never match a file.
   */
  beginImport: async () => {
    const result = await window.umakbang.readBackup()
    if (result.error) {
      get().notify(result.error, 'error')
      return
    }

    // A `.umak` bundle takes the other road: unpack the caches first, then either finish
    // outright or fall into the same wizard with what is left. One dialog picked the file,
    // so which of the two it was is not something the user should have had to decide.
    if (result.bundle && result.path) {
      set({ bundleBusy: true })
      try {
        const restored = await window.umakbang.restoreBundle(result.path)
        if (restored.error) {
          get().notify(restored.error, 'error')
          return
        }
        const cached = [
          restored.restored?.length ? `${restored.restored.length} folder index` : '',
          restored.metadataLines ? `${restored.metadataLines.toLocaleString()} probe results` : '',
          restored.peaks ? `${restored.peaks.toLocaleString()} waveforms` : ''
        ].filter(Boolean)

        if (restored.applied && restored.data) {
          get().adoptUserData(restored.data)
          get().notify(`Restored ${cached.join(', ') || 'settings'}.`)
          return
        }
        // Folders moved, so their caches were skipped and only the settings are left to
        // translate. Say what was skipped before the wizard covers the screen.
        if (restored.skipped?.length) {
          get().notify(
            `${restored.skipped.length} library folder${
              restored.skipped.length === 1 ? '' : 's'
            } moved, so ${
              restored.skipped.length === 1 ? 'its index was' : 'their indexes were'
            } skipped and will be rebuilt by a scan.`
          )
        }
        if (restored.backup && restored.summary && restored.here) {
          set({
            importing: {
              backup: restored.backup,
              summary: restored.summary,
              here: restored.here
            }
          })
        }
      } finally {
        set({ bundleBusy: false })
      }
      return
    }

    if (!result.backup || !result.summary || !result.here) return
    set({ importing: { backup: result.backup, summary: result.summary, here: result.here } })
  },

  cancelImport: () => set({ importing: null }),

  adoptUserData: (data) => {
    // Which folders are open is still this machine's business, not the backup's - but main
    // has just opened any library folder the user located, so its list is the current one
    // and the local copy is a step behind. Where the window sits stays local either way.
    const { lastDir, windowBounds, windowMaximized } = get().settings
    const settings: Settings = {
      ...data.settings,
      lastDir,
      windowBounds,
      windowMaximized
    }
    set({
      settings,
      // Also arrives as `library:roots` from the scan main kicked off, which sets `scanning`
      // with it. Set here too so the library appears whichever lands first.
      roots: settings.roots,
      tags: data.tags,
      ratings: data.ratings,
      detectedBpm: data.detectedBpm,
      detectedKey: data.detectedKey,
      typeFilter: settings.typeFilter ?? { kinds: [], exts: [] },
      importing: null
    })
    flushRevision()
  },

  applyBackup: async (backup, mapping) => {
    const result = await window.umakbang.applyBackup(backup, mapping)
    get().adoptUserData(result.data)

    const kept = result.kept.tags + result.kept.ratings + result.kept.detectedBpm + result.kept.detectedKey
    const dropped =
      result.dropped.tags + result.dropped.ratings + result.dropped.detectedBpm + result.dropped.detectedKey
    // Naming the folders that were opened matters more than the counts do: it is the part
    // of the import the user can see happening, and the scan behind it takes a while.
    const opened =
      result.adopted.length > 0
        ? ` Opened ${result.adopted.map((root) => root.label).join(', ')} - indexing now.`
        : ''
    get().notify(
      dropped > 0
        ? `Settings imported. ${kept.toLocaleString()} entries carried across, ${dropped.toLocaleString()} left behind.${opened}`
        : `Settings imported. ${kept.toLocaleString()} entries carried across.${opened}`
    )
  },

  setRating: (path, rating) => {
    // Clicking the star you're already on clears the rating, which is the usual idiom.
    const clamped = Math.max(0, Math.min(5, Math.round(rating)))
    const next = { ...get().ratings }
    if (clamped === 0) delete next[path]
    else next[path] = clamped
    set({ ratings: next })
    void window.umakbang.setRating(path, clamped)
  },

  setNote: (path, note) => {
    const next = { ...get().notes }
    /**
     * Stored exactly as typed, trailing space and all.
     *
     * The field is a controlled input reading straight off this map, so trimming here meant
     * the space that ends a word was deleted the moment it was typed and the next word ran
     * into the last one: "one two" came out "onetwo". Only whether the note is *empty* is a
     * question about the trimmed value, so a note of nothing but spaces still removes itself.
     * `store.ts` trims on the way to disk, which is where a tidy value actually matters.
     */
    if (note.trim()) next[path] = note
    else delete next[path]
    set({ notes: next })
    // The main store debounces the write to disk; this is per keystroke by design, so the
    // note on screen is never behind what was typed.
    void window.umakbang.setNote(path, note)
  },

  stemJob: null,

  splitStems: async (tracks) => {
    const { settings } = get()
    const playable = tracks.filter((track) => track.playable)
    if (playable.length === 0) return

    if (!settings.lalalKey.trim()) {
      get().notify('Add your LALAL.AI key in Settings → Stems first.', 'error')
      return
    }
    if (!settings.stemOutputDir.trim()) {
      get().notify('Choose where stems should be written in Settings → Stems.', 'error')
      return
    }
    if (get().stemJob) {
      get().notify('Stem separation is already running.', 'error')
      return
    }

    let done = 0
    set({ stemJob: { path: playable[0].path, phase: 'uploading', done, total: playable.length } })

    const off = window.umakbang.onStemProgress((progress) => {
      const job = get().stemJob
      if (!job) return
      if (progress.phase === 'done' || progress.phase === 'failed') done += 1
      set({
        stemJob: {
          path: progress.path,
          phase: progress.phase,
          percent: progress.percent,
          done,
          total: job.total
        }
      })
    })

    try {
      const outcomes = await window.umakbang.splitStems(
        playable.map((track) => track.path),
        {
          licenseKey: settings.lalalKey,
          outputDir: settings.stemOutputDir,
          splitter: settings.stemSplitter,
          format: settings.stemFormat,
          stem: 'vocals'
        }
      )

      const failed = outcomes.filter((outcome) => outcome.error)
      const written = outcomes.reduce((total, outcome) => total + outcome.written.length, 0)

      if (failed.length === 0) {
        get().notify(
          `Wrote ${written} stem${written === 1 ? '' : 's'} to ${baseName(settings.stemOutputDir)}.`
        )
      } else if (written > 0) {
        get().notify(
          `Wrote ${written} stem${written === 1 ? '' : 's'}; ${failed.length} failed - ${failed[0].error}`,
          'error'
        )
      } else {
        get().notify(failed[0].error ?? 'Stem separation failed.', 'error')
      }
    } finally {
      off()
      set({ stemJob: null })
    }
  },

  recalculateAnalysis: (tracks) => {
    const { detectedBpm, detectedKey } = get()
    const nextBpm = { ...detectedBpm }
    const nextKey = { ...detectedKey }
    const forget: string[] = []
    let queued = 0

    for (const track of tracks) {
      if (!track.playable) continue
      forget.push(track.path)

      // Only what analysis produced is cleared. A tempo off an ACID chunk or an ID3 tag
      // was never in these maps, and re-deriving it from the audio would be replacing a
      // fact with a guess.
      if (nextBpm[track.path] !== undefined) {
        delete nextBpm[track.path]
        track.bpm = undefined
      }
      if (nextKey[track.path] !== undefined) {
        delete nextKey[track.path]
        track.musicalKey = undefined
      }
      queued++
    }

    if (queued === 0) {
      get().notify('Nothing here can be analysed.')
      return
    }

    set({ detectedBpm: nextBpm, detectedKey: nextKey })
    void window.umakbang.clearDetected(forget)
    // Pinned, so the queue survives scrolling away from the rows that started it.
    forgetAnalysis(forget)
    for (const track of tracks) {
      if (track.playable) requestAnalysis(track, true)
    }
    flushRevision()
    get().notify(
      queued === 1 ? 'Recalculating tempo and key for 1 file.' : `Recalculating tempo and key for ${queued.toLocaleString()} files.`
    )
  },

  reprocessCached: () => {
    const { detectedBpm, detectedKey, byPath } = get()
    const nextBpm = { ...detectedBpm }
    const nextKey = { ...detectedKey }
    const forget: string[] = []
    const tracks: Track[] = []

    // Only files that actually have an analysed value: everything else either has nothing
    // to replace or carries a figure the file itself declared.
    for (const path of new Set([...Object.keys(detectedBpm), ...Object.keys(detectedKey)])) {
      const track = byPath.get(path)
      if (!track || !track.playable) continue
      forget.push(path)
      if (nextBpm[path] !== undefined) {
        delete nextBpm[path]
        track.bpm = undefined
      }
      if (nextKey[path] !== undefined) {
        delete nextKey[path]
        track.musicalKey = undefined
      }
      tracks.push(track)
    }

    if (tracks.length === 0) {
      get().notify('Nothing has been analysed yet, so there is nothing to redo.')
      return
    }

    // Cleared before the run rather than per result, because `applyAnalysis` refuses to
    // overwrite a track that still holds a value - the same reason `recalculateAnalysis`
    // does it this way.
    set({ detectedBpm: nextBpm, detectedKey: nextKey })
    void window.umakbang.clearDetected(forget)
    forgetAnalysis(forget)

    const taken = reprocessAll(tracks)
    flushRevision()
    get().notify(
      taken === 0
        ? 'Everything analysed sits outside the current analysis scope.'
        : `Reprocessing ${taken.toLocaleString()} files in the background. Browsing stays responsive.`
    )
  },

  applyAnalysis: (path, analysis) => {
    const track = get().byPath.get(path)
    if (!track) return
    let changed = false

    // Never overwrite what the file itself declared: a tag or an ACID chunk is
    // authoritative and analysis is only the fallback for files that carry neither.
    if (analysis.bpm !== undefined && track.bpm === undefined) {
      track.bpm = analysis.bpm
      set({ detectedBpm: { ...get().detectedBpm, [path]: analysis.bpm } })
      void window.umakbang.setDetectedBpm(path, analysis.bpm)
      changed = true
    }
    if (analysis.musicalKey !== undefined && track.musicalKey === undefined) {
      track.musicalKey = analysis.musicalKey
      const fits = { ...get().detectedKeyFit }
      // A key from the user's own tool arrives with no fit, and last run's number would be
      // describing an answer this one has just replaced.
      if (analysis.keyFit === undefined) delete fits[path]
      else fits[path] = analysis.keyFit
      set({ detectedKey: { ...get().detectedKey, [path]: analysis.musicalKey }, detectedKeyFit: fits })
      void window.umakbang.setDetectedKey(path, analysis.musicalKey, analysis.keyFit)
      changed = true
    }
    if (changed) bumpRevision()
  },

  applyDetectedBpm: (path, bpm) => {
    const track = get().byPath.get(path)
    // Never overwrite a tempo the file itself declared - a tag or ACID chunk is
    // authoritative, analysis is only a fallback.
    if (!track || track.bpm !== undefined) return
    track.bpm = bpm
    set({ detectedBpm: { ...get().detectedBpm, [path]: bpm } })
    void window.umakbang.setDetectedBpm(path, bpm)
    bumpRevision()
  },

  updateTags: (path, tags) => {
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    const next = { ...get().tags }
    if (cleaned.length === 0) delete next[path]
    else next[path] = cleaned
    set({ tags: next })
    void window.umakbang.setTags(path, cleaned)
  }
}))

/**
 * Folds the outcome of a copy, move or rename into the in-memory library.
 *
 * The index follows the files rather than waiting on a rescan, which on a library this
 * size would take the better part of a minute for a change whose shape we already know.
 * Ratings, tags and analysed tempo are keyed by path, so they have to follow too - moved
 * they go with the file, copied they are shared with the copy.
 */
function applyTransfer(result: TransferResult, mode: TransferMode): void {
  const store = useLibrary.getState()
  // Moves are checked too: an empty folder produces no files at all, and it still has to
  // show up where it landed.
  if (result.moves.length === 0 && result.items.length === 0 && result.removed.length === 0) {
    return
  }

  const { byPath, roots } = store
  const nextRatings = { ...store.ratings }
  const nextTags = { ...store.tags }
  const nextBpm = { ...store.detectedBpm }
  const nextKey = { ...store.detectedKey }
  const moving = mode === 'move'
  let touched = false

  for (const { from, track } of result.items) {
    // What has already been read off this file comes with it, or the row lands with an
    // empty duration and tempo until something probes it again.
    const before = byPath.get(from)
    if (before?.probed) {
      Object.assign(track, {
        probed: true,
        duration: before.duration,
        sampleRate: before.sampleRate,
        bitDepth: before.bitDepth,
        channels: before.channels,
        bitrate: before.bitrate,
        bpm: before.bpm,
        musicalKey: before.musicalKey,
        projectCreatedMs: before.projectCreatedMs,
        projectSeconds: before.projectSeconds
      })
    }

    const rating = nextRatings[from]
    if (rating !== undefined) {
      if (moving) {
        delete nextRatings[from]
        void window.umakbang.setRating(from, 0)
      }
      nextRatings[track.path] = rating
      void window.umakbang.setRating(track.path, rating)
      touched = true
    }

    const applied = nextTags[from]
    if (applied) {
      if (moving) {
        delete nextTags[from]
        void window.umakbang.setTags(from, [])
      }
      nextTags[track.path] = applied
      void window.umakbang.setTags(track.path, applied)
      touched = true
    }

    // Both detected values follow the file the same way - and on a move the old path's
    // persisted entries are cleared too, or umakbang-data.json accumulates readings for
    // paths that no longer exist while the moved file loses its own on the next launch.
    const detectedTempo = nextBpm[from]
    const detectedMusicalKey = nextKey[from]
    if (detectedTempo !== undefined || detectedMusicalKey !== undefined) {
      if (moving) {
        delete nextBpm[from]
        delete nextKey[from]
        void window.umakbang.clearDetected([from])
      }
      if (detectedTempo !== undefined) {
        nextBpm[track.path] = detectedTempo
        void window.umakbang.setDetectedBpm(track.path, detectedTempo)
      }
      if (detectedMusicalKey !== undefined) {
        nextKey[track.path] = detectedMusicalKey
        void window.umakbang.setDetectedKey(track.path, detectedMusicalKey)
      }
      touched = true
    }
  }

  // Set before the tracks are added: addTracks reads the detected maps to fill in values.
  if (touched) {
    useLibrary.setState({
      ratings: nextRatings,
      tags: nextTags,
      detectedBpm: nextBpm,
      detectedKey: nextKey
    })
  }

  if (moving && result.removed.length > 0) {
    const gone = new Set(result.removed)
    useLibrary.setState({
      downloads: store.downloads.filter((track) => !gone.has(track.path))
    })
    store.removeTracks(result.removed.filter((path) => byPath.has(path)))
  }

  // Filing something *out* of the library is a real destination - the misc folder, an
  // archive on another drive. Those files leave the index rather than reappearing at the
  // top level, which is where a path outside the root would otherwise land them.
  store.addTracks(
    result.items
      .map((item) => item.track)
      .filter((track) => relativePath(roots, track.path) !== null)
  )

  // A folder holding nothing indexable leaves no rows to stand in for it, so the tree is
  // told about it directly - otherwise pasting one looks like it did nothing.
  if (roots.length > 0) {
    const extras = result.moves
      .filter((move) => move.directory)
      .map((move) => relativePath(roots, move.to))
      .filter((rel): rel is string => rel !== null && rel !== '')
    const departed = moving
      ? result.moves
          .filter((move) => move.directory)
          .map((move) => relativePath(roots, move.from))
          .filter((rel): rel is string => rel !== null)
      : []
    if (extras.length > 0 || departed.length > 0) {
      const next = withoutDirs(store.extraDirs, departed)
      for (const rel of extras) next.add(rel)
      useLibrary.setState({ extraDirs: next })
    }
  }
  flushRevision()
}

/**
 * The sort in force right now: whatever this folder was last sorted by, falling back to
 * the library-wide default for folders you've never sorted.
 */
export function effectiveSort(
  settings: Settings,
  view: ViewMode
): { key: SortKey; dir: 'asc' | 'desc' } {
  const remembered = view.mode === 'folder' ? settings.folderSort[view.dir] : undefined
  return remembered ?? { key: settings.sortKey, dir: settings.sortDir }
}

/** Row ids for the entries a transfer produced - a file's path, a folder's `dir:` key. */
function rowIdsOf(moves: TransferResult['moves'], roots: LibraryRoot[]): string[] {
  const ids: string[] = []
  for (const move of moves) {
    if (!move.directory) {
      ids.push(move.to)
      continue
    }
    const rel = relativePath(roots, move.to)
    if (rel !== null && rel !== '') ids.push(`dir:${rel}`)
  }
  return ids
}

/**
 * Entries a move would actually change.
 *
 * Putting something back where it already is, or dropping a folder onto itself, is a
 * no-op rather than an error - and both are easy to do by accident with a mouse.
 */
function worthMoving(paths: string[], destination: string): string[] {
  return paths.filter(
    (path) => !samePath(parentPath(path), destination) && !samePath(path, destination)
  )
}

/** Drops folders, and everything beneath them, from the set of hand-held directories. */
function withoutDirs(dirs: Set<string>, removed: string[]): Set<string> {
  if (dirs.size === 0 || removed.length === 0) return new Set(dirs)
  const next = new Set<string>()
  for (const dir of dirs) {
    if (removed.some((gone) => dir === gone || dir.startsWith(`${gone}/`))) continue
    next.add(dir)
  }
  return next
}

function describeCount(count: number): string {
  return count === 1 ? '1 item' : `${count.toLocaleString()} items`
}

/**
 * Scanning emits a batch every 250 files. Recomputing the folder tree and the visible
 * rows on each one is O(n) work hundreds of times over - at 100k files that stutters
 * badly. Coalescing the change signal caps it at ~5 recomputes a second, which still
 * reads as live.
 */
/**
 * How often coalesced changes are published to the UI. Large libraries get a slower
 * cadence: each tick costs a re-derive of the visible rows, and at a quarter of a million
 * files a 200ms tick leaves the main thread no room to paint or handle input.
 */
function revisionInterval(trackCount: number): number {
  if (trackCount > 100_000) return 700
  if (trackCount > 20_000) return 400
  return 200
}

let revisionTimer: ReturnType<typeof setTimeout> | null = null
let structuralPending = false

function commitRevision(): void {
  const structural = structuralPending
  structuralPending = false
  useLibrary.setState((state) => ({
    revision: state.revision + 1,
    structureRevision: structural ? state.structureRevision + 1 : state.structureRevision
  }))
}

function bumpRevision(structural = false): void {
  if (structural) structuralPending = true
  if (revisionTimer) return
  revisionTimer = setTimeout(
    () => {
      revisionTimer = null
      commitRevision()
    },
    revisionInterval(useLibrary.getState().tracks.length)
  )
}

function flushRevision(): void {
  if (revisionTimer) clearTimeout(revisionTimer)
  revisionTimer = null
  commitRevision()
}


/**
 * Pushes the settings `lib/analysis.ts` keeps its own copies of.
 *
 * Called from `hydrate` as well as from `connectLibraryEvents`, because the latter runs in
 * a mount effect while `hydrate` is still awaiting two IPC round trips - so everything it
 * reads is `DEFAULT_SETTINGS` rather than the user's. That was invisible for as long as
 * every setting here had a default that matched the common case, and it was not harmless:
 * a configured `keyCommand` was ignored until the next time any setting was changed.
 */
function applyAnalysisSettings(settings: Settings): void {
  setKeyDetectionEnabled(settings.detectKeyFromAudio)
  setKeyCommand(settings.keyCommand)
  setKeyEngine(settings.keyEngine, settings.keyProfile)
  setAnalysisConcurrency(settings.analysisConcurrency)
}

/** Wires the main-process scan stream into the store. Returns an unsubscribe function. */
export function connectLibraryEvents(): () => void {
  const store = useLibrary.getState()

  // Row drags are pointer-driven and deliver their drop through here rather than through
  // a DOM event - see lib/drag.ts.
  setInternalDropHandler((paths, relDir) => {
    void useLibrary.getState().moveIntoFolder(paths, relDir)
  })

  // Tempo and key are worked out by `lib/analysis.ts`, which owns the queue, the scope
  // rule and the "have we already done this one" bookkeeping. These are the settings it
  // keeps its own copies of - and this call is only the defaults, because `hydrate` is
  // still in flight when this runs. `hydrate` calls it again with the real ones.
  applyAnalysisSettings(useLibrary.getState().settings)

  configureAnalysis({
    sink: (path, analysis) => useLibrary.getState().applyAnalysis(path, analysis),
    gate: (path) => {
      const state = useLibrary.getState()
      const track = state.byPath.get(path)
      if (!track) return false
      // Nothing left to find: both values already came off the file's own headers.
      if (track.bpm !== undefined && track.musicalKey !== undefined) return false
      return inAnalysisScope(track.relDir, {
        tag: state.settings.analysisTag,
        roots: state.roots,
        tags: state.tags
      })
    }
  })

  // Every decode that happens for a waveform doubles as an analysis, so a file seen for
  // the first time is measured for free - no second decode, no separate pass.
  setDecodeObserver((path, buffer) => analyseDecoded(path, buffer))

  const unsubscribes = [
    window.umakbang.onLibraryReset(({ roots }) => useLibrary.getState().resetLibrary(roots)),
    window.umakbang.onLibraryRoots(({ roots }) => useLibrary.getState().adoptRoots(roots)),
    window.umakbang.onFolderChanged(({ dir, tracks }) =>
      useLibrary.getState().applyFolder(dir, tracks)
    ),
    window.umakbang.onTracks((tracks) => useLibrary.getState().addTracks(tracks)),
    window.umakbang.onRemoved((paths) => useLibrary.getState().removeTracks(paths)),
    window.umakbang.onMetadata((patches) => useLibrary.getState().applyMetadata(patches)),
    window.umakbang.onProgress((progress) => useLibrary.getState().setProgress(progress)),
    // Both channels existed for years with no listener: a scanner crash emptied the
    // library in silence, and a declined folder pick closed its dialog and said nothing.
    window.umakbang.onLibraryError(({ message }) => useLibrary.getState().notify(message, 'error')),
    window.umakbang.onLibraryNotice(({ message }) => useLibrary.getState().notify(message))
  ]
  void store.hydrate()
  return () => unsubscribes.forEach((off) => off())
}
