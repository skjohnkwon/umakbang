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
import { startScan, type ScanHandle } from './scanner'
import { flushMetadataCache, initMetadataCache } from './metadata-cache'
import { initIndexStore, loadIndex, saveIndex } from './index-store'

export type ScannerCommand =
  | { type: 'init'; dataDir: string }
  | { type: 'scan'; roots: LibraryRoot[]; replace: boolean }
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
function scanAll(roots: LibraryRoot[], replace: boolean): void {
  loggedErrors = 0
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

async function scanOne(root: LibraryRoot, current: () => boolean): Promise<void> {
  const startedAt = Date.now()
  log(`scanning ${root.label}: ${root.path}`)

  // Replay the saved index first so the library is usable immediately. The renderer
  // ignores paths it already holds, so the live walk below can re-send everything
  // without producing duplicates.
  const cached = loadIndex(root.path)
  if (cached) {
    // Indexes saved before a folder had a label - or under a label that has since been
    // taken by another folder - hold relative paths that no longer resolve. Rebuilding
    // them from the absolute path costs one pass and saves a full rescan before the
    // library is usable.
    for (const track of cached) {
      const rel = relFor([root], track.path)
      if (rel && rel !== track.rel) {
        track.rel = rel
        const cut = rel.lastIndexOf('/')
        track.relDir = cut === -1 ? '' : rel.slice(0, cut)
      }
    }
    log(`restored ${cached.length} files from saved index`)
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
    onTracks: (tracks) => {
      for (const track of tracks) collected.push(track)
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
  })
  active.add(handle)
  await handle.done
  active.delete(handle)

  flushMetadataCache()

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
  // Saved even when the batch has been superseded: the files were found and probed, and
  // throwing that away would mean walking them again on the next launch.
  saveIndex(root.path, collected)
  log(`${root.label} finished in ${Math.round((Date.now() - startedAt) / 1000)}s, index saved`)
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
      scanAll(command.roots, command.replace)
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
