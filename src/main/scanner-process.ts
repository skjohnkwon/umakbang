/**
 * The library scanner, running in its own process.
 *
 * Walking a large tree and parsing metadata for every file is sustained CPU and I/O work.
 * Doing it on the browser process starves the window's message pump - long enough that
 * Windows declares the app unresponsive and closes it. Isolating it here keeps the UI
 * process free to paint and handle input no matter how large the library is.
 *
 * Launched by src/main/index.ts via utilityProcess.fork().
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LibraryRoot,
  MetadataPatch,
  ScanProgress,
  Track,
  TrackMetadata
} from '../shared/types'
import { relFor } from '../shared/roots'
import { plausibleBpm } from '../shared/tempo'
import { startScan, type ScanHandle } from './scanner'
import { readFlpTempo } from './flp'
import { flushMetadataCache, initMetadataCache } from './metadata-cache'
import { initIndexStore, loadIndex, saveIndex } from './index-store'

export type ScannerCommand =
  | { type: 'init'; dataDir: string }
  /**
   * `firstDir` is the folder the window is about to show, root-relative. Its rows are lifted
   * out of the saved index and sent before the rest of the file is even parsed, which is the
   * difference between a three-second loading screen and a fifth of a second.
   */
  /**
   * `full` turns off the folder-mtime skip. It is what "rescan" has to mean: the skip cannot
   * see a file overwritten in place, so the one action whose whole purpose is "I think the
   * library is wrong, read it again" must not take the shortcut. A launch is not a rescan
   * even though both replay the index first, which is why this is its own flag rather than
   * being read off `revalidating`.
   */
  | { type: 'scan'; roots: LibraryRoot[]; replace: boolean; firstDir?: string; full?: boolean }
  | { type: 'cancel' }

export type ScannerEvent =
  | { type: 'ready' }
  | { type: 'tracks'; tracks: Track[] }
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'metadata'; patches: MetadataPatch[] }
  /** Files present in the saved index that no longer exist on disk. */
  | { type: 'removed'; paths: string[] }
  | { type: 'error'; stage: string; message: string }

// `parentPort` exists only inside a utilityProcess.
const port = process.parentPort

/** Every walk currently running. More than one only while a freshly added folder scans. */
const active = new Set<ScanHandle>()
let logFile = ''
/** Errors are logged, but a broken file shouldn't spam the log 300,000 times. */
let loggedErrors = 0

/**
 * Diagnostics go to a file: a packaged GUI app has no console, and a scan that stops
 * silently is indistinguishable from a hang without a record of where it got to.
 */
function log(message: string): void {
  if (!logFile) return
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never be the thing that breaks the scan.
  }
}

function post(event: ScannerEvent): void {
  port.postMessage(event)
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

process.on('uncaughtException', (error) => {
  log(`UNCAUGHT ${describe(error)}\n${error.stack ?? ''}`)
  post({ type: 'error', stage: 'uncaught', message: describe(error) })
})

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED ${describe(reason)}`)
  post({ type: 'error', stage: 'unhandled', message: describe(reason) })
})

/**
 * Runs the library's folders through the scanner, in order.
 *
 * `generation` is what makes a second `scan` command safe to send while the first is still
 * running: the loop checks it between folders and after each one, so a cancelled batch
 * stops rather than continuing to stream tracks into a library that has been reset.
 */
let generation = 0
let queue: LibraryRoot[] = []
let draining = false
/**
 * The folder the window is opening on. Only the root that actually contains it pays any
 * attention: its rows go out ahead of the rest of the index.
 */
let openingDir = ''
/** Set by a rescan, so the walk visits folders the saved mtimes say are unchanged. */
let fullWalk = false

/**
 * `replace` is the difference between opening the library and adding to it.
 *
 * Opening - the first load, a removal, a rescan - cancels everything: the renderer has
 * thrown its index away and is waiting to be refilled, so nothing in flight is still
 * wanted. The folders then go through one at a time, because walking several at once only
 * contends for the same disk and finishes no sooner.
 *
 * Adding is the opposite case. The folder being walked can hold hundreds of thousands of
 * files and be minutes from finishing, and the folder just added is the one the user is
 * looking at right now - so it starts immediately, beside whatever is already running,
 * rather than joining the back of a queue it would sit in for the rest of the scan.
 */
function scanAll(roots: LibraryRoot[], replace: boolean, firstDir = '', full = false): void {
  loggedErrors = 0
  openingDir = firstDir
  fullWalk = full
  if (!replace) {
    log(`scan alongside: ${roots.map((root) => root.label).join(', ')}`)
    const mine = generation
    for (const root of roots) void scanOne(root, () => generation === mine)
    return
  }

  generation++
  for (const handle of active) handle.cancel()
  active.clear()
  queue = [...roots]
  log(`scan start: ${roots.length} folder(s)`)
  if (!draining) void drain(generation)
}

async function drain(mine: number): Promise<void> {
  draining = true
  try {
    while (queue.length > 0 && generation === mine) {
      const root = queue.shift()
      if (!root) break
      await scanOne(root, () => generation === mine)
    }
    if (generation === mine) log('all folders scanned')
  } finally {
    draining = false
    // A replace that landed mid-drain gets its own loop rather than inheriting this one's
    // generation, which the check above would immediately abandon.
    if (queue.length > 0 && generation !== mine) void drain(generation)
  }
}

/**
 * Indexes saved before a folder had a label - or under a label that has since been taken by
 * another folder - hold relative paths that no longer resolve. Rebuilding them from the
 * absolute path costs one pass and saves a full rescan before the library is usable.
 */
function fixRelativePaths(root: LibraryRoot, tracks: Track[]): void {
  for (const track of tracks) {
    const rel = relFor([root], track.path)
    if (rel && rel !== track.rel) {
      track.rel = rel
      const cut = rel.lastIndexOf('/')
      track.relDir = cut === -1 ? '' : rel.slice(0, cut)
    }
  }
}

async function scanOne(root: LibraryRoot, current: () => boolean): Promise<void> {
  const startedAt = Date.now()
  log(`scanning ${root.label}: ${root.path}`)

  // Replay the saved index first so the library is usable immediately. The renderer
  // ignores paths it already holds, so the live walk below can re-send everything
  // without producing duplicates.
  //
  // The folder the window is opening on goes out from inside the read, before the rest of
  // the file has been parsed - the renderer lifts its loading screen on the first track it
  // sees, and the first tracks it should see are the ones it is about to draw.
  // Whole segments, not a string prefix: a root labelled `Sec` must not claim a folder
  // under `Secret Sauce`.
  const mine = openingDir === root.label || openingDir.startsWith(`${root.label}/`)
  let earlyAt = 0
  const cached = loadIndex(root.path, {
    dir: mine ? openingDir : '',
    emit: (tracks) => {
      if (!current()) return
      earlyAt = Date.now() - startedAt
      fixRelativePaths(root, tracks)
      post({ type: 'tracks', tracks })
      // Something on screen is what ends the loading screen, so say a scan is under way in
      // the same breath rather than waiting for the walk's first report.
      post({
        type: 'progress',
        progress: { phase: 'walking', found: tracks.length, probed: 0, total: tracks.length, revalidating: true }
      })
      log(`opened ${openingDir || '<root>'} with ${tracks.length} files in ${earlyAt}ms`)
    }
  })
  if (cached) {
    fixRelativePaths(root, cached)
    log(`restored ${cached.length} files from saved index (+${Date.now() - startedAt}ms)`)
    for (let i = 0; i < cached.length; i += 1000) {
      if (!current()) return
      post({ type: 'tracks', tracks: cached.slice(i, i + 1000) })
    }
    post({
      type: 'progress',
      progress: {
        phase: 'walking',
        found: cached.length,
        probed: 0,
        total: cached.length,
        revalidating: true
      }
    })
  }

  const collected: Track[] = []
  const metaByPath = new Map<string, TrackMetadata>()

  const handle = startScan(root.path, root.label, {
    // Everything the walk found, kept here and never sent: `collected` is what the index is
    // saved from and what the removed-diff is computed against, so it has to be complete.
    // Filtering it would report every unchanged file as deleted.
    onTracks: (tracks) => {
      for (const track of tracks) collected.push(track)
    },
    // What the renderer does not already hold. On a revalidation the index replay filled it
    // before the walk started, so this is a few rows where `onTracks` is a few hundred
    // thousand; with no index to replay it is everything, which is the same thing said twice.
    onFresh: (tracks) => {
      if (current()) post({ type: 'tracks', tracks })
    },
    onProgress: (progress) => {
      if (current()) post({ type: 'progress', progress: { ...progress, revalidating: Boolean(cached) } })
      if (progress.phase !== 'probing' || progress.probed % 5000 === 0) {
        log(
          `${root.label} ${progress.phase} found=${progress.found} probed=${progress.probed}/${progress.total} +${Math.round((Date.now() - startedAt) / 1000)}s`
        )
      }
    },
    onMetadata: (patches) => {
      for (const patch of patches) metaByPath.set(patch.path, patch.meta)
      if (current()) post({ type: 'metadata', patches })
    },
    onError: (stage, error) => {
      // Per-file failures are expected on a big messy library; cap the noise.
      if (loggedErrors < 40) {
        loggedErrors++
        log(`ERROR ${stage}: ${describe(error)}`)
      }
      if (stage === 'run' || stage.startsWith('walk')) {
        post({ type: 'error', stage, message: describe(error) })
      }
    }
  }, { fullWalk })
  active.add(handle)
  await handle.done
  active.delete(handle)

  flushMetadataCache()

  // A walk that didn't see the whole tree - cancelled midway, or a root that couldn't be
  // opened at all - proves nothing about what is gone and holds a fraction of what is
  // there. Diffing it would report the unseen majority as removed, and saving it would
  // overwrite a complete index with a partial one. One launch with a NAS asleep must not
  // cost a 300k-entry index.
  if (!handle.walkCompleted()) {
    log(`${root.label} walk did not finish; keeping the saved index as it was`)
    return
  }

  // Anything in the old index that the walk didn't find has been deleted or moved.
  if (cached && current()) {
    const live = new Set(collected.map((track) => track.path))
    const removed = cached.filter((track) => !live.has(track.path)).map((t) => t.path)
    if (removed.length > 0) {
      log(`${removed.length} files no longer on disk`)
      post({ type: 'removed', paths: removed })
    }
  }

  // Fold the probed metadata in, so the next launch restores a fully populated
  // library rather than one that has to be re-read.
  for (const track of collected) {
    const meta = metaByPath.get(track.path)
    if (meta) Object.assign(track, meta, { probed: true })
  }

  // Then let the projects answer for the bounces beside them. It runs on the folded-in
  // tracks, so a file that declared its own tempo is never asked about, and before the save
  // below, so the number lands in the index instead of being worked out again next launch.
  const fromProjects = await fillTemposFromProjects(collected, current)
  if (fromProjects > 0) log(`${root.label} took ${fromProjects} tempos from FL Studio projects`)

  // Saved even when the batch has been superseded: the files were found and probed, and
  // throwing that away would mean walking them again on the next launch.
  saveIndex(root.path, collected)
  log(`${root.label} finished in ${Math.round((Date.now() - startedAt) / 1000)}s, index saved`)
}

/* ------------------------------------------------ tempo from the project beside the file */

/**
 * Suffixes a render carries that the project it came out of does not.
 *
 * `REFLECT.flp` sits beside `REFLECT_Master.wav`, `REFLECT.mp3` and `REFLECT_notag.wav`, and
 * all three are the same music at the same tempo. Compared lower-case, so `_Master` and
 * `_master` are one entry. Deliberately not `(1)`-style suffixes: a duplicate is a different
 * file that happens to be named after this one, and stripping them would let any project
 * claim anything named after it.
 */
const RENDER_SUFFIXES = [
  '_master',
  ' master',
  '_notag',
  '_final',
  '_mixdown',
  '_mix',
  '_render',
  '_export'
]

/** Projects are read a few at a time for the same reason the probe pass is. */
const PROJECT_READ_CONCURRENCY = 8
const TEMPO_PATCH_SIZE = 250

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase()
}

/** The stem a render shares with its project, once the render suffixes are off it. */
function renderStem(name: string): string {
  let stem = stemOf(name)
  for (;;) {
    // Longer than the suffix, or `master.wav` would reduce to nothing and match every
    // project in the folder.
    const suffix = RENDER_SUFFIXES.find((s) => stem.length > s.length && stem.endsWith(s))
    if (!suffix) return stem.trim()
    stem = stem.slice(0, -suffix.length).trimEnd()
  }
}

/**
 * Gives each audio file the tempo of the FL Studio project it was bounced from.
 *
 * Measured over 270 labelled tracks, the audio tempo detector is right two thirds of the
 * time and reports exactly half the true tempo in three cases in ten, while the project it
 * came out of stores the number exactly. In this library 2,021 audio files match a project
 * in their own folder by name, and 841 of them have no tempo of their own. So this is a
 * *declared* tempo, like an ACID chunk or an ID3 frame: it goes down the same metadata
 * stream, lands in the index the same way, and the detector never gets the chance to
 * overwrite it.
 *
 * The other 1,180 keep what they already declared, and measurement says that is the right
 * way round: 1,145 of them name the same tempo the project does.
 *
 * Each project is read once however many renders are named after it, and **every** project is
 * read, not only the ones with a bounce waiting on them: a project's tempo belongs on the
 * project's own row as much as on its renders', and the stats page's tempo panel counts
 * projects rather than audio files precisely because one project is one piece of music where
 * three renders of it are still one. Measured on this library that is 2,784 files read in
 * about a second and a half cold, against a scan that takes forty.
 *
 * The result is not written to the probe cache. That is keyed by the audio file's own mtime
 * and size, so a tempo that came out of a different file entirely would go on being handed
 * back long after the project was corrected. The index carries it instead, which is what
 * makes the next launch free without making it wrong.
 */
async function fillTemposFromProjects(collected: Track[], current: () => boolean): Promise<number> {
  const projects = new Map<string, Map<string, Track>>()
  const everyProject: Track[] = []
  for (const track of collected) {
    if (track.ext !== 'flp') continue
    let byStem = projects.get(track.relDir)
    if (!byStem) {
      byStem = new Map()
      projects.set(track.relDir, byStem)
    }
    byStem.set(stemOf(track.name), track)
    everyProject.push(track)
  }
  if (projects.size === 0) return 0

  // A second pass rather than one that collects candidates as it goes: which folders hold a
  // project is not known until the first pass ends, and a library this size has 220,000
  // audio files with no tempo to hold on to in the meantime.
  const waiting = new Map<Track, Track[]>()
  for (const track of collected) {
    if (track.kind !== 'audio' || track.bpm !== undefined) continue
    const project = projects.get(track.relDir)?.get(renderStem(track.name))
    if (!project) continue
    const already = waiting.get(project)
    if (already) already.push(track)
    else waiting.set(project, [track])
  }

  const jobs = everyProject
  let cursor = 0
  let filled = 0
  let pending: MetadataPatch[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    if (current()) post({ type: 'metadata', patches: pending })
    pending = []
  }

  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const project = jobs[cursor++]
      const bpm = await readFlpTempo(project.path)
      // A corrupt project must not be able to inject a nonsense tempo into the library.
      if (!plausibleBpm(bpm)) continue

      // The project's own row first. It is a file in the library like any other, and the one
      // row in a folder whose tempo is a fact rather than a reading.
      if (project.bpm === undefined) {
        project.bpm = bpm
        pending.push({ path: project.path, meta: { bpm } })
      }

      for (const track of waiting.get(project) ?? []) {
        track.bpm = bpm
        pending.push({ path: track.path, meta: { bpm } })
        filled++
      }
      if (pending.length >= TEMPO_PATCH_SIZE) flush()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PROJECT_READ_CONCURRENCY, jobs.length) }, () => worker())
  )
  flush()
  return filled
}

port.on('message', (message) => {
  const command = message.data as ScannerCommand
  if (!command || typeof command.type !== 'string') return

  switch (command.type) {
    case 'init': {
      logFile = join(command.dataDir, 'umakbang-scanner.log')
      log('--- scanner started ---')
      initMetadataCache(command.dataDir)
      initIndexStore(command.dataDir)
      log('caches ready')
      post({ type: 'ready' })
      break
    }

    case 'scan': {
      // One folder at a time. Walking several at once would contend for the same disk and
      // finish no sooner, and the renderer would get progress from two passes interleaved
      // into one meaningless counter.
      scanAll(command.roots, command.replace, command.firstDir, command.full)
      break
    }

    case 'cancel':
      // Bumping the generation stops the loop between folders as well as the walks.
      generation++
      queue = []
      for (const handle of active) handle.cancel()
      active.clear()
      flushMetadataCache()
      log('scan cancelled')
      break

    default:
      break
  }
})

process.on('exit', () => flushMetadataCache())
