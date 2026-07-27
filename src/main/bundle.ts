/**
 * Writing and reading `.umak` bundles. See `src/shared/bundle.ts` for the format.
 *
 * Everything here streams. The index alone is 200MB+ on a real library, so both directions
 * go line at a time through a gzip stream and nothing larger than one record is ever
 * resident. The one exception is the peaks cache, which is already a JSON object in memory
 * because that is how `store.ts` holds it.
 */

import { app, BrowserWindow, dialog } from 'electron'
import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from 'node:fs'
import { appendFile, open, type FileHandle } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGunzip, createGzip } from 'node:zlib'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import {
  isBundleHeader,
  isSectionMarker,
  type BundleFit,
  type BundleHeader,
  type SectionMarker
} from '../shared/bundle'
import type { SettingsBackup } from '../shared/backup'
import type { LibraryRoot } from '../shared/types'
import { exportBackup, getDataDir, getUserData, allPeaks, mergePeaks } from './store'
import { indexFileFor, patchFileFor } from './index-store'

const METADATA_CACHE = 'umakbang-metadata-cache.ndjson'

/* ------------------------------------------------------------------ writing */

/** One NDJSON line, respecting backpressure - a 300MB copy will fill the buffer. */
async function writeLine(out: Writable, value: unknown): Promise<void> {
  if (!out.write(`${JSON.stringify(value)}\n`)) await once(out, 'drain')
}

/** Copies an existing NDJSON file through, verbatim. Missing files are simply absent. */
async function copyLines(out: Writable, file: string): Promise<void> {
  if (!existsSync(file)) return
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      if (!out.write(`${line}\n`)) await once(out, 'drain')
    }
  } finally {
    lines.close()
  }
}

function sizeOf(file: string): number {
  try {
    return existsSync(file) ? statSync(file).size : 0
  } catch {
    return 0
  }
}

export async function writeBundle(file: string): Promise<void> {
  const settings = getUserData().settings
  const roots = settings.roots
  const dataDir = getDataDir()
  const peaks = allPeaks()
  const backup = exportBackup()

  const cacheBytes =
    sizeOf(join(dataDir, METADATA_CACHE)) +
    roots.reduce((total, root) => total + sizeOf(indexFileFor(root.path)), 0)

  const header: BundleHeader = {
    kind: 'umakbang-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    app: app.getVersion(),
    style: process.platform === 'win32' ? 'windows' : 'posix',
    exportedRoots: roots,
    counts: {
      tags: Object.keys(backup.tags).length,
      ratings: Object.keys(backup.ratings).length,
      detectedBpm: Object.keys(backup.detectedBpm).length,
      detectedKey: Object.keys(backup.detectedKey).length,
      peaks: peaks.length,
      cacheBytes
    }
  }

  const gzip = createGzip()
  // Written to a temporary name and renamed at the end, so a bundle that failed halfway
  // never sits on disk looking like a complete one.
  const tmp = `${file}.part`
  const done = pipeline(gzip, createWriteStream(tmp))

  await writeLine(gzip, header)

  await writeLine(gzip, { section: 'settings' } satisfies SectionMarker)
  await writeLine(gzip, backup)

  for (const root of roots) {
    await writeLine(gzip, { section: 'index', root: root.path } satisfies SectionMarker)
    await copyLines(gzip, indexFileFor(root.path))
    // The journal goes too. Without it a move made since the last full scan comes back at
    // its old path on the machine this is restored onto, which is the bug the journal
    // exists to prevent in the first place.
    await writeLine(gzip, { section: 'indexPatch', root: root.path } satisfies SectionMarker)
    await copyLines(gzip, patchFileFor(root.path))
  }

  await writeLine(gzip, { section: 'metadata' } satisfies SectionMarker)
  await copyLines(gzip, join(dataDir, METADATA_CACHE))

  await writeLine(gzip, { section: 'peaks' } satisfies SectionMarker)
  for (const entry of peaks) await writeLine(gzip, entry)

  gzip.end()
  await done
  renameSync(tmp, file)
}

/* ------------------------------------------------------------------ reading */

/** True if the file starts with gzip's magic number, which a `.json` export never does. */
export async function looksLikeBundle(file: string): Promise<boolean> {
  let handle: FileHandle | null = null
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(2)
    const { bytesRead } = await handle.read(buffer, 0, 2, 0)
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

/**
 * The header alone.
 *
 * Reads a few hundred bytes and stops, so the import screen can describe a 22MB file
 * without inflating it. Destroying the stream mid-flight is the point, not a leak.
 */
export async function readBundleHeader(file: string): Promise<BundleHeader | null> {
  const source = createReadStream(file)
  const lines = createInterface({ input: source.pipe(createGunzip()), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      const parsed = JSON.parse(line) as unknown
      return isBundleHeader(parsed) ? parsed : null
    }
    return null
  } catch {
    return null
  } finally {
    lines.close()
    source.destroy()
  }
}

/** Which of a bundle's library folders are on this machine, at the same path. */
export function fitFor(roots: LibraryRoot[]): BundleFit {
  const present: LibraryRoot[] = []
  const missing: LibraryRoot[] = []
  for (const root of roots) {
    if (existsSync(root.path)) present.push(root)
    else missing.push(root)
  }
  return { present, missing }
}

export interface RestoreResult {
  settings: SettingsBackup | null
  /** Roots whose index was written here. */
  restored: string[]
  /** Roots whose index was in the file but whose folder isn't on this machine. */
  skipped: string[]
  metadataLines: number
  peaks: number
}

/**
 * Unpacks a bundle onto this machine.
 *
 * The settings section is handed back rather than applied, because which of the two ways it
 * should be applied - straight in, or through the folder-mapping wizard - is the caller's
 * decision and depends on whether the folders are here.
 *
 * The caches are applied directly, and only for folders that exist at the same absolute
 * path. Everything in them is keyed by absolute path, and unlike a tag there is nothing
 * lost by declining to translate: an index for a folder that moved is worth one rescan.
 */
export async function restoreBundle(file: string): Promise<RestoreResult> {
  const dataDir = getDataDir()
  const result: RestoreResult = {
    settings: null,
    restored: [],
    skipped: [],
    metadataLines: 0,
    peaks: 0
  }

  let section: SectionMarker | null = null
  /** Where the current index/indexPatch section is being written, if it is being written. */
  let sink: { stream: Writable; tmp: string; final: string } | null = null
  let metadata: string[] = []
  let peaks: Array<{ p: string; d: string }> = []

  const closeSink = async (): Promise<void> => {
    if (!sink) return
    const { stream, tmp, final } = sink
    sink = null
    stream.end()
    await once(stream, 'close')
    renameSync(tmp, final)
  }

  const flushMetadata = async (): Promise<void> => {
    if (metadata.length === 0) return
    const count = metadata.length
    const payload = `${metadata.join('\n')}\n`
    metadata = []
    // Appended, not written over. The cache is a log where a later line supersedes an
    // earlier one, so appending makes the imported entries win while leaving anything this
    // machine probed for itself intact - and the compaction at next startup dedups it.
    await appendFile(join(dataDir, METADATA_CACHE), payload, 'utf8')
    result.metadataLines += count
  }

  const source = createReadStream(file)
  const lines = createInterface({ input: source.pipe(createGunzip()), crlfDelay: Infinity })

  let first = true
  try {
    for await (const line of lines) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A torn line costs one record, the same way the index reader treats one.
        continue
      }

      if (first) {
        first = false
        if (!isBundleHeader(parsed)) throw new Error('Not a umakbang bundle.')
        continue
      }

      if (isSectionMarker(parsed)) {
        await closeSink()
        await flushMetadata()
        section = parsed

        if ((section.section === 'index' || section.section === 'indexPatch') && section.root) {
          const root = section.root
          if (!existsSync(root)) {
            if (!result.skipped.includes(root)) result.skipped.push(root)
            section = null
            continue
          }
          if (!result.restored.includes(root)) result.restored.push(root)
          const final = section.section === 'index' ? indexFileFor(root) : patchFileFor(root)
          const tmp = `${final}.part`
          sink = { stream: createWriteStream(tmp, 'utf8'), tmp, final }
        }
        continue
      }

      if (!section) continue

      if (sink) {
        if (!sink.stream.write(`${line}\n`)) await once(sink.stream, 'drain')
      } else if (section.section === 'settings') {
        result.settings = parsed as SettingsBackup
      } else if (section.section === 'metadata') {
        metadata.push(line)
        if (metadata.length >= 5000) await flushMetadata()
      } else if (section.section === 'peaks') {
        peaks.push(parsed as { p: string; d: string })
        if (peaks.length >= 20000) {
          result.peaks += mergePeaks(peaks)
          peaks = []
        }
      }
    }
  } finally {
    lines.close()
    source.destroy()
    await closeSink()
    await flushMetadata()
  }

  if (peaks.length > 0) result.peaks += mergePeaks(peaks)
  return result
}

/**
 * Offers the restart a restored index needs.
 *
 * The scanner reads the index and the metadata cache once, at startup, and rewrites the
 * index when a scan finishes. So a bundle unpacked underneath a running app is both unread
 * and liable to be overwritten by the scan already in flight. Restarting is the whole of
 * the fix, and it is offered rather than taken because quitting out from under someone is
 * not something to do without asking.
 */
export async function offerRestart(window: BrowserWindow | null): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Restore complete',
    message: 'umakbang needs to restart to load the restored index.',
    detail:
      'Until it does, the library will keep showing what was already indexed, and the next scan may overwrite what was just restored.'
  }
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (response === 0) {
    app.relaunch()
    app.quit()
  }
}
