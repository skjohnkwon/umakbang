/**
 * Local persistence, backed by plain JSON files in the app's userData directory.
 *
 * Deliberately dependency-free: a native SQLite build would have to be rebuilt per
 * Electron version and per platform, which is a poor trade for what amounts to a few
 * thousand rows of favourites, tags and cached metadata.
 */

import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

  // The developer switch that puts the app back to a first launch, and the restore that
  // undoes it. Before anything else, because everything below seeds defaults into whatever
  // survives them.
  if (userData.settings.resetOnLaunch) userData = enterFirstRun()
  else if (existsSync(stashFile())) userData = leaveFirstRun()

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
 * Where the real profile waits while the app pretends to be a fresh install.
 *
 * One fixed name rather than a stamped one, because this is not a rescue copy - it is the
 * live document, moved out of the way, and the app has to be able to find it again. Its mere
 * existence is the flag that says a reset is in force.
 */
function stashFile(): string {
  return join(dataDir, 'umakbang-data.stashed.json')
}

/**
 * Puts the app into a first launch: no library, no tags, default settings, welcome screen.
 *
 * The first run is the hardest state in the app to get back to and the one most worth being
 * able to look at, which before this meant deleting a file in `%APPDATA%` by hand and hoping
 * it was the right one.
 *
 * **Reversible, and that is the whole design.** The real document is *moved*, never copied
 * and never overwritten, and `leaveFirstRun` moves it back the moment the switch goes off -
 * so "turn it off and the next start loads like normal" means the library, the tags and the
 * ratings are all there again, not merely that it stops wiping. It is stashed exactly once,
 * on the launch that enters the mode: every launch after that is already running on a
 * throwaway document, and stashing that one over the top would destroy the real thing on the
 * second reboot, which is the one accident this switch must not be able to cause.
 *
 * Every armed launch does start over, though. Testing a first run is something you do more
 * than once, and having to disarm and rearm between attempts is the friction the switch
 * exists to remove.
 *
 * `developerMode` and `resetOnLaunch` are carried across on purpose. Without them the switch
 * that did this would be invisible on the screen it lands you on, and every launch after it
 * would reset the app again with nothing on screen able to stop it.
 *
 * The scanner's index files are left alone: they are keyed by the hash of a root's path, so
 * re-adding the same folder replays them in a second rather than costing a full walk. They
 * describe the disk, not the user, and there is nothing about them to reset.
 */
function enterFirstRun(): UserData {
  const stash = stashFile()
  try {
    if (!existsSync(stash)) {
      if (existsSync(userDataFile)) renameSync(userDataFile, stash)
      console.log(`[store] first-run mode: real profile stashed at ${stash}`)
    } else {
      console.log('[store] first-run mode: already stashed, starting over from defaults')
    }
  } catch (error) {
    // A profile that could not be set aside is a reason not to proceed: the whole reason
    // this is safe to offer is that the real one is still there afterwards.
    console.error('[store] refusing to reset - could not set the real profile aside', error)
    return userData
  }

  const fresh: UserData = {
    settings: { ...DEFAULT_SETTINGS, developerMode: true, resetOnLaunch: true },
    tags: {},
    ratings: {},
    notes: {},
    detectedBpm: {},
    detectedKey: {},
    detectedKeyFit: {}
  }
  // Written now rather than left to the first patch, so what is on disk matches what is on
  // screen even if the session is killed rather than quit.
  writeJsonAtomic(userDataFile, fresh)
  return fresh
}

/**
 * Takes the app back out of the first-run pretence and returns the real profile.
 *
 * Reached when the switch is off and a stash is sitting there, which is exactly the state the
 * user creates by turning it off inside the temporary session. The throwaway document is kept
 * under one fixed name rather than deleted - it should never hold anything that matters, and
 * "should never" is not a reason to be the one thing here that destroys a file.
 *
 * `resetOnLaunch` is forced off in what comes back, because the profile was stashed *with the
 * switch on* and restoring it verbatim would arm the next launch all over again.
 */
function leaveFirstRun(): UserData {
  const stash = stashFile()
  try {
    if (existsSync(userDataFile)) {
      renameSync(userDataFile, join(dataDir, 'umakbang-data.discarded-first-run.json'))
    }
    renameSync(stash, userDataFile)
  } catch (error) {
    console.error('[store] could not restore the stashed profile', error)
    return userData
  }

  const restored = readJson<UserData>(userDataFile, userData)
  restored.settings = { ...DEFAULT_SETTINGS, ...restored.settings, resetOnLaunch: false }
  writeJsonAtomic(userDataFile, restored)
  console.log('[store] first-run mode off: real profile restored')
  return restored
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
  // One hook for all seven callers, rather than a call beside each of them that the eighth
  // would forget. The peaks cache is regenerable and enormous; only the document nobody can
  // rebuild gets snapshots.
  if (file === userDataFile) scheduleDataBackup()
}

/**
 * Rolling snapshots of the one file nobody can rebuild.
 *
 * `umakbang-data.json` holds months of tagging, rating and notes, and every write to it is a
 * write *over* it - the atomic rename means a corrupt or wrong version replaces the good one
 * with nothing left behind. The daily `.umak` bundle covers the disaster case, but a day is a
 * long time to lose an afternoon's work in, and it is skipped entirely while a scan is
 * running.
 *
 * Debounced five minutes from the last change rather than written per change: tagging is a
 * burst of thirty edits in a minute, and thirty copies of a 300KB document says nothing that
 * one copy afterwards doesn't. The timer is reset by each new edit, so a working session
 * writes one snapshot five minutes after it stops.
 *
 * Bounded at `MAX_DATA_BACKUPS`, oldest first. Unbounded, this is a 300KB file every five
 * minutes of a working day, and a backup scheme that fills the disk is a bug rather than a
 * safety net.
 */
// Five minutes, or five seconds under the same flag `auto-backup.ts` already answers to -
// otherwise finding out whether any of this works costs five minutes a run.
const BACKUP_DEBOUNCE_MS = process.env.UMAKBANG_BACKUP_NOW === '1' ? 5_000 : 5 * 60_000
const MAX_DATA_BACKUPS = 12
const BACKUP_PREFIX = 'umakbang-data.backup-'
let backupTimer: ReturnType<typeof setTimeout> | null = null

function scheduleDataBackup(): void {
  if (backupTimer) clearTimeout(backupTimer)
  const timer = setTimeout(writeDataBackup, BACKUP_DEBOUNCE_MS)
  // Same as the writes above: a pending snapshot must not be a reason the process stays up.
  // `flushStore` takes the last one on the way out, which is the case this would have missed.
  timer.unref?.()
  backupTimer = timer
}

function writeDataBackup(): void {
  backupTimer = null
  // Sortable and second-resolution, matching the name older builds already left here so
  // there is one convention and the trim below sweeps both.
  const now = new Date()
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  writeJsonAtomic(join(dataDir, `${BACKUP_PREFIX}${stamp}.json`), userData)
  trimDataBackups()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function trimDataBackups(): void {
  try {
    const kept = readdirSync(dataDir)
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.json'))
      // The stamp is fixed-width and big-endian, so lexical order is chronological order.
      .sort()
    for (const stale of kept.slice(0, Math.max(0, kept.length - MAX_DATA_BACKUPS))) {
      rmSync(join(dataDir, stale), { force: true })
    }
  } catch {
    // Trimming is housekeeping. A directory that could not be read is not a reason to lose
    // the snapshot that has just been written.
  }
}

/** Flushes every debounced write immediately. Called on quit. */
export function flushStore(): void {
  for (const [file, timer] of pendingWrites) {
    clearTimeout(timer)
    if (file === userDataFile) writeJsonAtomic(file, userData)
    else if (file === peaksFile) writeJsonAtomic(file, peaksCache)
  }
  pendingWrites.clear()
  // A session shorter than the debounce is the one this would otherwise have no snapshot of,
  // and quitting is exactly when the last edit stops being re-editable.
  if (backupTimer) {
    clearTimeout(backupTimer)
    writeDataBackup()
  }
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
  'outputDevice',
  // Whether *this* install is being worked on, and whether it is due to throw itself away on
  // the next launch. A backup is a file people send each other, and an imported setting that
  // silently wipes the receiving machine's library on its next start is the worst thing in
  // this file by a distance.
  'developerMode',
  'resetOnLaunch'
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
