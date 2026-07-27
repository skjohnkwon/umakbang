/**
 * Persisted file index, owned by the scanner process.
 *
 * Walking a quarter-million files takes the better part of a minute, and doing it before
 * the library appears makes every launch feel like a fresh install. The index is saved
 * after each scan and replayed on the next one, so the UI is populated immediately while
 * the real walk runs behind it to pick up anything that changed.
 *
 * Stored as NDJSON: one track per line, appended in batches, so writing it never means
 * serialising a 60MB document in one go.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Track } from '../shared/types'

let dataDir = ''

export function initIndexStore(dir: string): void {
  dataDir = dir
}

/**
 * Where a root's index and journal live, for the bundle writer and reader.
 *
 * Exported rather than reimplemented there because the name is `sha1(root)` and the two
 * would have to agree on the hash, the truncation and the lowercasing forever. A bundle
 * restored under a filename the scanner doesn't look for is a 200MB file that silently
 * does nothing.
 */
export function indexFileFor(root: string): string {
  return indexPath(root)
}

export function patchFileFor(root: string): string {
  return patchPath(root)
}

/** One index file per library root, named by a hash so any path is a safe filename. */
function indexPath(root: string): string {
  const hash = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
  return join(dataDir, `umakbang-index-${hash}.ndjson`)
}

/**
 * Changes made since the index was written, kept beside it.
 *
 * Moving or renaming a file makes the index wrong, and the index is only rewritten when a
 * full scan finishes - so without this the file reappears at its old path on the next
 * launch. Rewriting a 200MB index for a drag and drop is not an option, so the change is
 * appended here instead and folded in on load.
 */
function patchPath(root: string): string {
  return `${indexPath(root)}.patch`
}

interface IndexPatch {
  /** Paths that are no longer there. */
  removed?: string[]
  /** Files at their new location. */
  added?: Track[]
}

export function appendIndexPatch(root: string, patch: IndexPatch): void {
  if (!dataDir) return
  if (!patch.removed?.length && !patch.added?.length) return
  try {
    appendFileSync(patchPath(root), `${JSON.stringify(patch)}\n`, 'utf8')
  } catch {
    // Worst case the next launch shows a stale row until the scan catches up.
  }
}

export function loadIndex(root: string): Track[] | null {
  if (!dataDir) return null
  const file = indexPath(root)
  if (!existsSync(file)) return null

  try {
    const text = readFileSync(file, 'utf8')
    const tracks: Track[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const track = JSON.parse(line) as Track
        // Guard against a truncated or hand-edited file.
        if (typeof track.path === 'string' && typeof track.rel === 'string') tracks.push(track)
      } catch {
        // Skip a torn line rather than discarding the whole index.
      }
    }
    const patched = applyPatches(root, tracks)
    return patched.length > 0 ? patched : null
  } catch {
    return null
  }
}

/** Folds the patch journal into a freshly-read index. */
function applyPatches(root: string, tracks: Track[]): Track[] {
  const file = patchPath(root)
  if (!existsSync(file)) return tracks

  const removed = new Set<string>()
  const added: Track[] = []
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      const patch = JSON.parse(line) as IndexPatch
      for (const path of patch.removed ?? []) removed.add(path)
      for (const track of patch.added ?? []) {
        // A later patch can remove something an earlier one added.
        removed.delete(track.path)
        added.push(track)
      }
    }
  } catch {
    return tracks
  }

  const result = removed.size > 0 ? tracks.filter((track) => !removed.has(track.path)) : tracks
  if (added.length === 0) return result

  const known = new Set(result.map((track) => track.path))
  for (const track of added) {
    if (known.has(track.path)) continue
    known.add(track.path)
    result.push(track)
  }
  return result
}

export function saveIndex(root: string, tracks: Track[]): void {
  if (!dataDir) return
  const file = indexPath(root)
  try {
    const tmp = `${file}.tmp`
    // Built in chunks so a huge library doesn't need one enormous string in memory.
    const parts: string[] = []
    const CHUNK = 5000
    for (let i = 0; i < tracks.length; i += CHUNK) {
      parts.push(
        tracks
          .slice(i, i + CHUNK)
          .map((track) => JSON.stringify(track))
          .join('\n')
      )
    }
    writeFileSync(tmp, parts.length > 0 ? `${parts.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, file)
    // A completed scan saw the filesystem itself, so anything the journal was holding is
    // already reflected here.
    rmSync(patchPath(root), { force: true })
  } catch {
    // The index is a cache; failing to write it only costs a slower next launch.
  }
}

export function clearIndex(root: string): void {
  if (!dataDir) return
  try {
    rmSync(indexPath(root), { force: true })
    rmSync(patchPath(root), { force: true })
  } catch {
    // Nothing depends on removal succeeding.
  }
}
