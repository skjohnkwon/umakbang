/**
 * Local persistence, backed by plain JSON files in the app's userData directory.
 *
 * Deliberately dependency-free: a native SQLite build would have to be rebuilt per
 * Electron version and per platform, which is a poor trade for what amounts to a few
 * thousand rows of favourites, tags and cached metadata.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type LibraryRoot, type Settings, type UserData } from '../shared/types'
import { labelForRoot } from '../shared/roots'
import { keyedRecord, pathKey } from '../shared/path-key'
import type { SettingsBackup } from '../shared/backup'
import { backupsDir, isPortable } from './portable'
export type { SettingsBackup }

interface PeaksEntry {
  /** Base64-encoded interleaved min/max pairs, one byte each. */
  data: string
  /** Epoch millis of last use, so the cache can be trimmed oldest-first. */
  usedAt: number
}

const MAX_PEAKS_ENTRIES = 8000

let dataDir = ''
let userDataFile = ''
let peaksFile = ''

let userData: UserData = {
  settings: { ...DEFAULT_SETTINGS },
  tags: {},
  ratings: {},
  notes: {},
  detectedBpm: {},
  detectedKey: {},
  detectedKeyFit: {}
}
let peaksCache: Record<string, PeaksEntry> = {}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

/** Where the scanner process should keep its own caches. */
export function getDataDir(): string {
  return dataDir
}

export function initStore(): void {
  dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  userDataFile = join(dataDir, 'umakbang-data.json')
  peaksFile = join(dataDir, 'umakbang-peaks-cache.json')

  userData = readJson(userDataFile, userData)
  // Merge rather than replace so settings added in later versions get their defaults.
  userData.settings = { ...DEFAULT_SETTINGS, ...userData.settings }

  // Always open on the library, never on the stage.
  //
  // Visualizers-only is a mode you step into for a while, not a preference - and it hides
  // the title bar and shrinks the window to a strip, so it is also the one mode with
  // almost nothing left to click. Restoring it on launch meant that if it was ever on
  // when the app closed, every launch after that came up in it. With no library open
  // there wasn't even a plot to hover for the way out: the welcome screen rendered with
  // no title bar above it and no way to leave the mode at all.
  userData.settings.visualizerOnly = false

  // A first-run default for where stems land: somewhere that exists on *this* machine.
  // It used to be one particular Windows path spelled out in full, which on a Mac is a
  // folder that can never be created - and the folder is made before the upload, so the
  // first split would fail before the service was ever reached.
  //
  // A portable copy defaults inside its own folder instead. The host's Music folder is a
  // real place that would work, which is the problem: stems would be written to whichever
  // machine the stick happened to be in, and the setting is remembered, so every later
  // split on every later machine would aim at the first one's path.
  if (!userData.settings.stemOutputDir) {
    userData.settings.stemOutputDir = isPortable()
      ? join(dataDir, 'stems')
      : join(musicDir(), 'umakbang stems')
  }

  // Where the Export button writes, seeded to the same folder the daily backup uses so the
  // two land together and there is one place to look. Only when empty, so choosing another
  // folder sticks - and it is `LOCAL_ONLY`, so an import can never fill it in and leave this
  // branch permanently unreachable with another machine's install path in it.
  if (!userData.settings.bundleExportDir) {
    userData.settings.bundleExportDir = backupsDir()
  }

  userData.settings.quickMove ??= []
  userData.tags ??= {}
  userData.ratings ??= {}
  userData.notes ??= {}
  userData.detectedBpm ??= {}
  userData.detectedKey ??= {}
  // Absent from every file written before the column started saying how sure it is.
  userData.detectedKeyFit ??= {}

  // Every path-keyed map composed once, here, where it arrives.
  //
  // This is not a shape migration and it is not a branch that has to live forever - it is
  // idempotent, so a file that is already composed comes out of it byte for byte the same,
  // and a file written by an older build is fixed the first time it is read and stays fixed.
  // Doing it on arrival rather than per lookup is what keeps `getUserData` a plain object the
  // renderer can iterate: the alternative is a `normalize` inside every read of every map, on
  // a library where 99% of the paths never needed one.
  //
  // A file carrying both spellings of one path loses the earlier entry (see `keyedRecord`).
  // `tools/repair-path-keys.js` is the same conversion run by hand, and it reports those
  // collisions rather than swallowing them, which is why it exists.
  userData.tags = keyedRecord(userData.tags)
  userData.ratings = keyedRecord(userData.ratings)
  userData.notes = keyedRecord(userData.notes)
  userData.detectedBpm = keyedRecord(userData.detectedBpm)
  userData.detectedKey = keyedRecord(userData.detectedKey)
  userData.detectedKeyFit = keyedRecord(userData.detectedKeyFit)

  peaksCache = keyedRecord(readJson<Record<string, PeaksEntry>>(peaksFile, {}))
}

/**
 * Not every Linux setup defines a music directory, and `getPath` throws when one doesn't.
 * Thrown here it would take `initStore` - and with it the whole first launch - down, so
 * fall back to the conventional place instead.
 */
function musicDir(): string {
  try {
    return app.getPath('music')
  } catch {
    return join(app.getPath('home'), 'Music')
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    // A corrupt cache is not worth crashing over - start clean.
    return fallback
  }
}

/** Writes via a temp file + rename so a crash mid-write can't truncate the real file. */
function writeJsonAtomic(file: string, value: unknown): void {
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Persistence is best-effort; losing a cache write must not break the session.
  }
}

function scheduleWrite(file: string, getValue: () => unknown, delayMs = 400): void {
  const existing = pendingWrites.get(file)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pendingWrites.delete(file)
    writeJsonAtomic(file, getValue())
  }, delayMs)
  // Don't hold the process open just to flush a cache.
  timer.unref?.()
  pendingWrites.set(file, timer)
}

/** Flushes every debounced write immediately. Called on quit. */
export function flushStore(): void {
  for (const [file, timer] of pendingWrites) {
    clearTimeout(timer)
    if (file === userDataFile) writeJsonAtomic(file, userData)
    else if (file === peaksFile) writeJsonAtomic(file, peaksCache)
  }
  pendingWrites.clear()
}

/* ------------------------------------------------------------------ user data */

export function getUserData(): UserData {
  return userData
}

export function updateSettings(patch: Partial<Settings>): Settings {
  userData.settings = { ...userData.settings, ...patch }
  scheduleWrite(userDataFile, () => userData)
  return userData.settings
}

/**
 * Adds a folder to the library, unless it is already in it.
 *
 * Nesting is refused rather than merged: a root inside another root would index every file
 * beneath it twice, under two different labels, and every rating, tag and pin would then
 * belong to whichever copy you happened to be looking at.
 *
 * `preferredLabel` is for the one caller that has a label worth keeping: an import adopting
 * a folder a backup was exported from. The backup's `folderSort` keys, `pinnedDirs` and
 * `randomExcludeDirs` all start with that machine's label, so deriving a fresh one from a
 * folder that was located under a different name would orphan every one of them. It is only
 * honoured when free - labels have to stay unique or `rootOf` resolves a path to the wrong
 * folder.
 */
export function addRoot(
  path: string,
  preferredLabel?: string
): { settings: Settings; added: LibraryRoot | null; reason?: string } {
  const roots = userData.settings.roots
  const existing = roots.find((root) => samePath(root.path, path))
  if (existing) return { settings: userData.settings, added: null, reason: 'already' }

  const parent = roots.find((root) => isUnder(path, root.path))
  if (parent) {
    return { settings: userData.settings, added: null, reason: `already inside ${parent.label}` }
  }
  const child = roots.find((root) => isUnder(root.path, path))
  if (child) {
    return { settings: userData.settings, added: null, reason: `holds ${child.label}, which is already open` }
  }

  const taken = new Set(roots.map((root) => root.label.toLowerCase()))
  const label =
    preferredLabel && !taken.has(preferredLabel.toLowerCase())
      ? preferredLabel
      : labelForRoot(path, roots)
  const added: LibraryRoot = { path, label }
  const recent = [path, ...userData.settings.recentRoots.filter((r) => r !== path)].slice(0, 8)
  const settings = updateSettings({ roots: [...roots, added], recentRoots: recent })
  return { settings, added }
}

/** Removes a folder from the library. The files themselves are never touched. */
export function removeRoot(label: string): Settings {
  return updateSettings({
    roots: userData.settings.roots.filter((root) => root.label !== label)
  })
}

function samePath(a: string, b: string): boolean {
  return normalise(a) === normalise(b)
}

function isUnder(path: string, parent: string): boolean {
  const base = normalise(parent)
  return normalise(path).startsWith(base.endsWith('/') ? base : `${base}/`)
}

function normalise(path: string): string {
  return path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 0 clears the rating rather than storing a meaningless zero.
 *
 * The key is composed here, and at every other write into a path-keyed map below. The caller
 * hands over a path the way the filesystem gave it, which is the only form that can be opened
 * again (see `path-key.ts`), and the two forms are only ever reconciled on the key side.
 */
export function setRating(path: string, rating: number): Record<string, number> {
  const key = pathKey(path)
  const clamped = Math.max(0, Math.min(5, Math.round(rating)))
  if (clamped === 0) delete userData.ratings[key]
  else userData.ratings[key] = clamped
  scheduleWrite(userDataFile, () => userData)
  return userData.ratings
}

export function setDetectedBpm(path: string, bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) return
  userData.detectedBpm[pathKey(path)] = Math.round(bpm * 10) / 10
  // Long debounce: a browsing session can analyse hundreds of files.
  scheduleWrite(userDataFile, () => userData, 3000)
}

/** Musical key recovered by analysing the audio. Same debounce as the tempo, and why. */
export function setDetectedKey(path: string, key: string, fit?: number): void {
  const trimmed = key.trim()
  if (!trimmed) return
  const at = pathKey(path)
  userData.detectedKey[at] = trimmed
  // A key that arrived from the user's own tool has no fit of its own, and last run's number
  // would describe a different answer entirely.
  if (fit !== undefined && Number.isFinite(fit)) userData.detectedKeyFit[at] = fit
  else delete userData.detectedKeyFit[at]
  scheduleWrite(userDataFile, () => userData, 3000)
}

/**
 * Forgets analysed tempo and key for these files, so they get worked out again.
 *
 * Only the detected values go: anything the file itself declared was never in here, and a
 * recalculation has no business overruling a tag or an ACID chunk.
 */
export function clearDetected(paths: string[]): void {
  for (const path of paths) {
    const key = pathKey(path)
    delete userData.detectedBpm[key]
    delete userData.detectedKey[key]
    delete userData.detectedKeyFit[key]
  }
  scheduleWrite(userDataFile, () => userData)
}

/**
 * Whatever the user wrote about a file. Emptied means removed, so the map holds notes and
 * not a trail of blank strings for every file that was ever clicked into.
 */
export function setNote(path: string, note: string): void {
  const trimmed = note.trim()
  const key = pathKey(path)
  if (trimmed) userData.notes[key] = trimmed
  else delete userData.notes[key]
  // Short debounce, unlike the analysis maps: this is typing, and a note lost to a crash is
  // a sentence the user has to remember writing.
  scheduleWrite(userDataFile, () => userData, 800)
}

export function setTags(path: string, tags: string[]): Record<string, string[]> {
  const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
  const key = pathKey(path)
  if (cleaned.length === 0) delete userData.tags[key]
  else userData.tags[key] = cleaned
  scheduleWrite(userDataFile, () => userData)
  return userData.tags
}

/* ------------------------------------------------------------------ backup */

/**
 * Everything worth carrying to another machine.
 *
 * Ratings, tags and analysed tempo come along because they're the part nobody can
 * reproduce - the settings are ten minutes of clicking, but a tagged library is months.
 * They're keyed by absolute path, so they land on their feet only if the library sits at
 * the same place; that's why the export records where it came from.
 */
/**
 * Settings that describe *this* machine rather than how you like to work. They're left
 * out of an export: the new machine has its own screen to place a window on, and its own
 * copy of the library - which the user points umakbang at themselves.
 */
const LOCAL_ONLY = [
  'roots',
  'recentRoots',
  'lastDir',
  'windowBounds',
  'windowMaximized',
  // Which mode the window happens to be in, like the bounds beside it. It no longer
  // survives a restart on the machine it was set on (see `initStore`), so carrying it to
  // another one would be the only way left to inherit it - and arriving in a mode with no
  // title bar, on a machine whose library isn't open yet, is how this became unescapable
  // in the first place.
  'visualizerOnly',
  // Names a tool installed on this machine, and a settings file is something people send
  // each other - an imported one must not be able to bring a command with it.
  'keyCommand',
  // An account credential. Nothing that bills by the minute travels in a file people send
  // each other.
  'lalalKey',
  // Where *this install* keeps its own files, derived from where the executable sits, rather
  // than a preference about how you like to work. It is seeded only when empty, so an
  // imported value would not just point at the exporting machine's install folder - it would
  // stop the seeding from ever running again and leave it pointing there for good.
  'bundleExportDir',
  // A piece of hardware plugged into *this* machine, and an id that means nothing anywhere
  // else: Chromium salts device ids per profile, so the exporting machine's interface id
  // matches nothing on the importing one. Carried across, it would put the receiving app
  // into the one state this setting is built to explain - asked for a device that does not
  // exist - on a machine where nobody had chosen anything.
  'outputDevice'
] as const

export function exportBackup(): SettingsBackup {
  const settings: Partial<Settings> = { ...userData.settings }
  for (const key of LOCAL_ONLY) delete settings[key]
  return {
    kind: 'umakbang-settings',
    // 2 carries the library folders themselves, which is what an import on a different
    // kind of machine needs in order to ask where each of them lives now.
    version: 2,
    exportedAt: new Date().toISOString(),
    exportedRoot: userData.settings.roots[0]?.path ?? null,
    exportedRoots: userData.settings.roots,
    settings,
    tags: userData.tags,
    ratings: userData.ratings,
    notes: userData.notes,
    detectedBpm: userData.detectedBpm,
    detectedKey: userData.detectedKey
  }
}

/**
 * Folds an exported file back in. Tags and ratings are merged rather than replaced, so
 * importing onto a machine that already has some doesn't throw them away.
 */
export function importBackup(backup: SettingsBackup): UserData {
  const incoming: Partial<Settings> = { ...backup.settings }
  for (const key of LOCAL_ONLY) delete incoming[key]

  // The incoming maps are composed before they are merged in, even though `remapBackup`
  // already composes what it rewrites. This is the path a backup takes when it needs no
  // mapping at all - a reinstall on the same machine, or one platform to itself - which goes
  // straight from the file into here without passing through the wizard, and it is exactly
  // the case where two spellings of one library would land side by side in the same map.
  userData.settings = { ...userData.settings, ...incoming }
  userData.tags = { ...userData.tags, ...keyedRecord(backup.tags ?? {}) }
  userData.ratings = { ...userData.ratings, ...keyedRecord(backup.ratings ?? {}) }
  userData.notes = { ...userData.notes, ...keyedRecord(backup.notes ?? {}) }
  userData.detectedBpm = { ...userData.detectedBpm, ...keyedRecord(backup.detectedBpm ?? {}) }
  userData.detectedKey = { ...userData.detectedKey, ...keyedRecord(backup.detectedKey ?? {}) }

  writeJsonAtomic(userDataFile, userData)
  return userData
}

/* ------------------------------------------------------------------ waveform peaks */

export function getPeaks(path: string): string | null {
  const entry = peaksCache[pathKey(path)]
  if (!entry) return null
  // The stamp is recorded in memory only. Scheduling a write here meant browsing rows
  // (pure cache hits) re-serialised an up-to-11MB JSON document on the same thread that
  // streams audio; the stamps ride along with the next real write instead, and an LRU
  // that is a session behind is still an LRU.
  entry.usedAt = Date.now()
  return entry.data
}

/**
 * Throws away the cached waveform for a file whose contents have changed.
 *
 * The cache is keyed by path alone, so a file re-exported over itself would otherwise keep
 * drawing the shape of the take before it - which is the one moment somebody is looking at
 * the waveform to see whether the change landed.
 */
export function forgetPeaks(paths: string[]): void {
  let removed = false
  for (const path of paths) {
    const key = pathKey(path)
    if (peaksCache[key]) {
      delete peaksCache[key]
      removed = true
    }
  }
  if (removed) scheduleWrite(peaksFile, () => peaksCache, 2000)
}

/** Every cached waveform, for the bundle writer. */
export function allPeaks(): Array<{ p: string; d: string }> {
  return Object.entries(peaksCache).map(([p, entry]) => ({ p, d: entry.data }))
}

/**
 * Folds imported waveforms in, keeping anything already here.
 *
 * Imported entries are stamped as used now, so if the merge overflows the cache it is the
 * local ones that go - which is the right way round: the file was just chosen by hand, and
 * anything trimmed off it is a decode away from coming back.
 */
export function mergePeaks(entries: Array<{ p: string; d: string }>): number {
  const now = Date.now()
  let added = 0
  for (const { p, d } of entries) {
    if (typeof p !== 'string' || typeof d !== 'string') continue
    // Composed like everything else that arrives from another machine's file. A bundle's
    // peaks are only restored when the roots are present under the same paths, so a mismatch
    // here is a spelling difference and nothing else.
    peaksCache[pathKey(p)] = { data: d, usedAt: now }
    added++
  }
  trimPeaks()
  scheduleWrite(peaksFile, () => peaksCache, 2000)
  return added
}

function trimPeaks(): void {
  const keys = Object.keys(peaksCache)
  if (keys.length <= MAX_PEAKS_ENTRIES) return
  keys.sort((a, b) => peaksCache[a].usedAt - peaksCache[b].usedAt)
  for (const key of keys.slice(0, keys.length - MAX_PEAKS_ENTRIES)) delete peaksCache[key]
}

export function putPeaks(path: string, data: string): void {
  peaksCache[pathKey(path)] = { data, usedAt: Date.now() }

  const keys = Object.keys(peaksCache)
  if (keys.length > MAX_PEAKS_ENTRIES) {
    // Drop the least recently used quarter so trimming isn't a per-insert cost.
    keys.sort((a, b) => peaksCache[a].usedAt - peaksCache[b].usedAt)
    for (const key of keys.slice(0, Math.floor(MAX_PEAKS_ENTRIES / 4))) {
      delete peaksCache[key]
    }
  }

  scheduleWrite(peaksFile, () => peaksCache, 2000)
}
