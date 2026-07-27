/**
 * Append-only metadata cache, owned by the scanner process.
 *
 * Stored as one JSON object per line rather than a single document: a large library
 * produces a cache far too big to re-serialise on every update, and appending only the
 * entries just probed keeps each write proportional to the work done. The log is
 * compacted at startup once it accumulates too many superseded lines.
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

export function initMetadataCache(dataDir: string): void {
  cacheFile = join(dataDir, 'umakbang-metadata-cache.ndjson')
  cache = {}
  linesOnDisk = 0

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
