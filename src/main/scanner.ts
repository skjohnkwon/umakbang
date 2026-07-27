/**
 * Library scanning, in two phases.
 *
 * Phase 1 walks the tree and emits every indexable file as soon as it is found, so the
 * UI becomes usable almost immediately. Phase 2 probes metadata in the background with
 * bounded concurrency and streams patches back, so a 30k-file library doesn't block on
 * a full metadata pass before showing anything.
 */

import { opendir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { MetadataPatch, ScanProgress, Track } from '../shared/types'
import {
  IGNORED_DIRS,
  PLAYABLE_EXTENSIONS,
  classifyKind,
  extensionOf,
  isIndexable
} from '../shared/files'
import { probeFile } from './probe'
import { flushMetadataCache, getCachedMetadata, putCachedMetadata } from './metadata-cache'

const PROBE_CONCURRENCY = 8
const PATCH_FLUSH_SIZE = 250
const PATCH_FLUSH_MS = 250

export interface ScanCallbacks {
  onTracks: (tracks: Track[]) => void
  onProgress: (progress: ScanProgress) => void
  onMetadata: (patches: MetadataPatch[]) => void
  /** Anything that aborts the scan. Never swallow these - a silent stop looks like a hang. */
  onError: (stage: string, error: unknown) => void
}

export interface ScanHandle {
  cancel: () => void
  done: Promise<void>
}

/**
 * `label` prefixes every relative path this scan produces, naming which library folder the
 * file came from. See src/shared/roots.ts.
 */
export function startScan(root: string, label: string, callbacks: ScanCallbacks): ScanHandle {
  let cancelled = false
  const done = run(root, label, callbacks, () => cancelled).catch((error) => {
    callbacks.onError('run', error)
  })
  return {
    cancel: () => {
      cancelled = true
    },
    done
  }
}

async function run(
  root: string,
  label: string,
  cb: ScanCallbacks,
  isCancelled: () => boolean
): Promise<void> {
  const tracks = await walk(root, label, cb, isCancelled)
  if (isCancelled()) return

  cb.onProgress({ phase: 'probing', found: tracks.length, probed: 0, total: tracks.length })
  await probeAll(tracks, cb, isCancelled)
  if (isCancelled()) return

  cb.onProgress({
    phase: 'done',
    found: tracks.length,
    probed: tracks.length,
    total: tracks.length
  })
}

/* ------------------------------------------------------------------ phase 1: walk */

async function walk(
  root: string,
  label: string,
  cb: ScanCallbacks,
  isCancelled: () => boolean
): Promise<Track[]> {
  const all: Track[] = []
  let batch: Track[] = []
  const queue: string[] = [root]

  const flush = (): void => {
    if (batch.length === 0) return
    cb.onTracks(batch)
    batch = []
  }

  while (queue.length > 0) {
    if (isCancelled()) return all
    const dir = queue.shift() as string

    let entries: Awaited<ReturnType<typeof opendir>> | null = null
    try {
      entries = await opendir(dir)
    } catch {
      // Permission denied, or the folder vanished mid-scan. Skip it.
      continue
    }

    try {
      for await (const entry of entries) {
        if (isCancelled()) return all

        const full = join(dir, entry.name)

        if (entry.isDirectory()) {
          if (shouldSkipDir(entry.name)) continue
          queue.push(full)
          continue
        }

        // A macOS package like Foo.logicx is a directory, not a file - index it as a
        // single project entry and don't descend into it.
        if (!entry.isFile() && !entry.isSymbolicLink()) continue

        const ext = extensionOf(entry.name)
        if (!isIndexable(ext)) continue

        let size = 0
        let mtimeMs = 0
        try {
          const info = await stat(full)
          if (info.isDirectory()) continue
          size = info.size
          mtimeMs = info.mtimeMs
        } catch {
          continue
        }

        const track = makeTrack(root, label, full, entry.name, ext, size, mtimeMs)
        all.push(track)
        batch.push(track)

        if (batch.length >= PATCH_FLUSH_SIZE) {
          flush()
          cb.onProgress({ phase: 'walking', found: all.length, probed: 0, total: all.length })
        }
      }
    } catch {
      continue
    }
  }

  // Directories that are really packages (.logicx, .band) are surfaced by the loop
  // above only when they are plain files, so pick them up on the way out.
  flush()
  cb.onProgress({ phase: 'walking', found: all.length, probed: 0, total: all.length })
  return all
}

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase()
  if (IGNORED_DIRS.has(lower)) return true
  // Hidden folders on both platforms, plus Windows' junk.
  if (name.startsWith('.')) return true
  return false
}

function makeTrack(
  root: string,
  label: string,
  full: string,
  name: string,
  ext: string,
  size: number,
  mtimeMs: number
): Track {
  // Normalise to forward slashes so relative paths compare identically on both platforms,
  // and lead with the folder's label so paths from different library folders can't collide.
  const within = relative(root, full).split(sep).join('/')
  const rel = within ? `${label}/${within}` : label
  const lastSlash = rel.lastIndexOf('/')
  const relDir = lastSlash === -1 ? '' : rel.slice(0, lastSlash)
  const dir = full.slice(0, full.length - name.length - 1)

  return {
    path: full,
    rel,
    dir,
    relDir,
    name,
    ext,
    size,
    mtimeMs,
    kind: classifyKind(ext),
    playable: PLAYABLE_EXTENSIONS.has(ext)
  }
}

/* ------------------------------------------------------------------ phase 2: probe */

async function probeAll(
  tracks: Track[],
  cb: ScanCallbacks,
  isCancelled: () => boolean
): Promise<void> {
  // Playable audio for its headers, plus .flp for FL Studio's time-tracking record.
  const targets = tracks.filter((t) => t.playable || t.ext === 'flp')

  // Report the real denominator straight away, so the counter is meaningful from the
  // first tick rather than showing a total it will never reach.
  cb.onProgress({ phase: 'probing', found: tracks.length, probed: 0, total: targets.length })

  let cursor = 0
  let probed = 0
  let pending: MetadataPatch[] = []
  let lastFlush = Date.now()

  const flush = (force: boolean): void => {
    if (pending.length === 0) return
    if (!force && pending.length < PATCH_FLUSH_SIZE && Date.now() - lastFlush < PATCH_FLUSH_MS) {
      return
    }
    cb.onMetadata(pending)
    pending = []
    lastFlush = Date.now()
  }

  const worker = async (): Promise<void> => {
    while (!isCancelled()) {
      const index = cursor++
      if (index >= targets.length) return
      const track = targets[index]

      let meta = getCachedMetadata(track.path, track.mtimeMs, track.size)
      if (!meta) {
        try {
          meta = await probeFile(track.path, track.ext)
        } catch (error) {
          // One unreadable file must never stop the pass for the other 300,000.
          cb.onError(`probe:${track.path}`, error)
          meta = {}
        }
        putCachedMetadata(track.path, track.mtimeMs, track.size, meta)
      }

      pending.push({ path: track.path, meta })

      probed++
      flush(false)

      // Frequent early ticks so the counter visibly moves; coarser once it's clearly alive.
      if (probed < 500 ? probed % 25 === 0 : probed % 250 === 0) {
        cb.onProgress({
          phase: 'probing',
          found: tracks.length,
          probed,
          total: targets.length
        })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length || 1) }, () => worker())
  )

  flush(true)
  flushMetadataCache()
  cb.onProgress({ phase: 'probing', found: tracks.length, probed, total: targets.length })
}
