/**
 * Append-only metadata cache, owned by the scanner process.
 *
 * Stored as one JSON object per line rather than a single document: a large library
 * produces a cache far too big to re-serialise on every update, and appending only the
 * entries just probed keeps each write proportional to the work done. The log is
 * compacted the first time it is read, once it accumulates too many superseded lines.
 *
 * **It is loaded on first use, not at startup, and that is a launch-time decision.** Reading
 * and parsing it is 823ms on this library's 277,139 lines, and it used to sit inside the
 * scanner's `init` - so `ready` was 823ms late, the `scan` command waited behind it, and the
 * opening folder's rows were 823ms later still. Nothing on the way to those rows consults it:
 * the only reader is the probe phase, which is on the far side of a walk that takes seconds.
 * Deferred, the parse lands where there is already work to hide it behind.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrackMetadata } from '../shared/types'

interface CacheEntry extends TrackMetadata {
  /** Cache key components - a file is re-probed when either changes. */
  mtimeMs: number
  size: number
}

const APPEND_BATCH = 500

let cacheFile = ''
let cache: Record<string, CacheEntry> = {}
let pendingLines: string[] = []
let linesOnDisk = 0
/** False until the log has been read. Every reader and writer goes through `ensureLoaded`. */
let loaded = false

/**
 * Names the file. The read itself waits for the first lookup - see the note at the top.
 */
export function initMetadataCache(dataDir: string): void {
  cacheFile = join(dataDir, 'umakbang-metadata-cache.ndjson')
  cache = {}
  linesOnDisk = 0
  loaded = false
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true

  if (existsSync(cacheFile)) {
    try {
      for (const line of readFileSync(cacheFile, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const { p, ...entry } = JSON.parse(line) as CacheEntry & { p: string }
          if (typeof p === 'string') {
            // A later line for the same path supersedes an earlier one.
            cache[p] = entry
            linesOnDisk++
          }
        } catch {
          // Skip a torn final line rather than discarding the whole cache.
        }
      }
    } catch {
      cache = {}
    }
  }

  compact()
}

function compact(): void {
  const entries = Object.entries(cache)
  if (linesOnDisk <= entries.length * 1.5) return
  try {
    const tmp = `${cacheFile}.tmp`
    const body = entries.map(([p, entry]) => JSON.stringify({ p, ...entry })).join('\n')
    writeFileSync(tmp, body ? `${body}\n` : '', 'utf8')
    renameSync(tmp, cacheFile)
    linesOnDisk = entries.length
  } catch {
    // Compaction is an optimisation; a failure just leaves the log as it was.
  }
}

export function getCachedMetadata(
  path: string,
  mtimeMs: number,
  size: number
): TrackMetadata | null {
  ensureLoaded()
  const entry = cache[path]
  if (!entry) return null
  // Re-probe when the file changed underneath us.
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) return null
  const { mtimeMs: _m, size: _s, ...meta } = entry
  return meta
}

export function putCachedMetadata(
  path: string,
  mtimeMs: number,
  size: number,
  meta: TrackMetadata
): void {
  // Before the mutation, or the load would land on top of it and throw the entry away.
  ensureLoaded()
  const entry: CacheEntry = { ...meta, mtimeMs, size }
  cache[path] = entry
  pendingLines.push(JSON.stringify({ p: path, ...entry }))
  if (pendingLines.length >= APPEND_BATCH) flushMetadataCache()
}

export function flushMetadataCache(): void {
  if (pendingLines.length === 0) return

  // Drop the buffer even with nowhere to write it. Holding it would grow without bound
  // across a 300k-file scan, and losing an append only costs a re-probe next run.
  const payload = `${pendingLines.join('\n')}\n`
  const count = pendingLines.length
  pendingLines = []
  if (!cacheFile) return

  linesOnDisk += count
  try {
    appendFileSync(cacheFile, payload, 'utf8')
  } catch {
    // Best effort; the cache is an optimisation, not a source of truth.
  }
}
