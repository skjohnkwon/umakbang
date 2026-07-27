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
import type { SettingsBackup } from '../shared/backup'
import { isPortable } from './portable'
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
  detectedBpm: {},
  detectedKey: {}
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
      : join(app.getPath('music'), 'umakbang stems')
  }

  userData.settings.quickMove ??= []
  userData.tags ??= {}
  userData.ratings ??= {}
  userData.detectedBpm ??= {}
  userData.detectedKey ??= {}

  peaksCache = readJson(peaksFile, {})
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

/** 0 clears the rating rather than storing a meaningless zero. */
export function setRating(path: string, rating: number): Record<string, number> {
  const clamped = Math.max(0, Math.min(5, Math.round(rating)))
  if (clamped === 0) delete userData.ratings[path]
  else userData.ratings[path] = clamped
  scheduleWrite(userDataFile, () => userData)
  return userData.ratings
}

export function setDetectedBpm(path: string, bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) return
  userData.detectedBpm[path] = Math.round(bpm * 10) / 10
  // Long debounce: a browsing session can analyse hundreds of files.
  scheduleWrite(userDataFile, () => userData, 3000)
}

/** Musical key recovered by analysing the audio. Same debounce as the tempo, and why. */
export function setDetectedKey(path: string, key: string): void {
  const trimmed = key.trim()
  if (!trimmed) return
  userData.detectedKey[path] = trimmed
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
    delete userData.detectedBpm[path]
    delete userData.detectedKey[path]
  }
  scheduleWrite(userDataFile, () => userData)
}

export function setTags(path: string, tags: string[]): Record<string, string[]> {
  const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
  if (cleaned.length === 0) delete userData.tags[path]
  else userData.tags[path] = cleaned
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
  'lalalKey'
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

  userData.settings = { ...userData.settings, ...incoming }
  userData.tags = { ...userData.tags, ...(backup.tags ?? {}) }
  userData.ratings = { ...userData.ratings, ...(backup.ratings ?? {}) }
  userData.detectedBpm = { ...userData.detectedBpm, ...(backup.detectedBpm ?? {}) }
  userData.detectedKey = { ...userData.detectedKey, ...(backup.detectedKey ?? {}) }

  writeJsonAtomic(userDataFile, userData)
  return userData
}

/* ------------------------------------------------------------------ waveform peaks */

export function getPeaks(path: string): string | null {
  const entry = peaksCache[path]
  if (!entry) return null
  entry.usedAt = Date.now()
  scheduleWrite(peaksFile, () => peaksCache, 5000)
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
    if (peaksCache[path]) {
      delete peaksCache[path]
      removed = true
    }
  }
  if (removed) scheduleWrite(peaksFile, () => peaksCache, 2000)
}

export function putPeaks(path: string, data: string): void {
  peaksCache[path] = { data, usedAt: Date.now() }

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
