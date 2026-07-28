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
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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

/* ------------------------------------------------------------------ shared strings */

/**
 * Makes tracks that share a directory share one string object.
 *
 * `JSON.parse` hands back a fresh string for every field of every line, so 326,487 tracks
 * carried 326,487 copies of 15,684 distinct `dir` values and as many `relDir` values, plus
 * one copy each of the 16 extensions and 3 kinds in use. Measured on the real 222MB index:
 * the parsed tracks hold 273.8MB without this and 180.9MB with it, for about 90ms of extra
 * parse time.
 *
 * `path`, `rel` and `name` are deliberately left alone. They are distinct per track, so a
 * pool over them is a 326k-entry Map that can never return a hit.
 *
 * The pool lives for one `loadIndex` call and is dropped with it; nothing downstream needs
 * to know the strings are shared.
 */
type StringPool = Map<string, string>

function interned(pool: StringPool, value: string): string {
  const hit = pool.get(value)
  if (hit !== undefined) return hit
  pool.set(value, value)
  return value
}

function share(pool: StringPool, track: Track): void {
  if (typeof track.dir === 'string') track.dir = interned(pool, track.dir)
  if (typeof track.relDir === 'string') track.relDir = interned(pool, track.relDir)
  if (typeof track.ext === 'string') track.ext = interned(pool, track.ext)
  if (typeof track.kind === 'string') track.kind = interned(pool, track.kind) as Track['kind']
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

/** How many rows to hand over early when the folder being opened isn't in the index. */
const EARLY_FALLBACK_ROWS = 2000

/**
 * Reads the saved index.
 *
 * `early` is what stands between a launch and a three-second loading screen. Reading and
 * parsing 326k lines costs about a second, and until the first track reaches the renderer
 * there is nothing on screen at all - but the only rows anybody is waiting for are the ones
 * in the folder they left the app standing in, and those can be found without parsing
 * anything else. A raw `indexOf` over the undecoded buffer locates them in 38ms against the
 * 1,050ms the full parse takes (measured, 222MB index): 50ms to read the bytes, 38ms to
 * find the folder, and the rest of the file is decoded and parsed afterwards while the user
 * is already looking at their files.
 *
 * A database was the other candidate and it is the wrong tool for this. Measured on the
 * same index, `node:sqlite` answers the folder query in 1ms - but materialising every row
 * afterwards takes 1,194ms against JSON's 1,086ms, so the part that costs a second gets
 * *slower*, and the part that a raw byte scan already does in 38ms gets faster by an amount
 * nobody can perceive. The renderer wants the whole index in memory (`useVisibleRows` is
 * synchronous by design), so nothing about a query engine removes that second.
 */
export function loadIndex(
  root: string,
  early?: { dir: string; emit: (tracks: Track[]) => void }
): Track[] | null {
  // Whatever the last read left for the walk is superseded by this one, including when this
  // one finds nothing: a walk must never be handed an index that is not the one it is about
  // to be compared against.
  replay = null
  if (!dataDir) return null
  const file = indexPath(root)
  if (!existsSync(file)) return null

  try {
    // One pool for the whole read, the early rows included, so a folder handed over twice
    // is handed over sharing the same strings both times.
    const pool: StringPool = new Map()

    // Read as bytes and decode afterwards: the decode is 354ms of the read, and the early
    // pass below doesn't need it.
    const buffer = readFileSync(file)
    if (early) emitEarly(root, buffer, early, pool)

    const text = buffer.toString('utf8')
    const tracks: Track[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const track = JSON.parse(line) as Track
        // Guard against a truncated or hand-edited file.
        if (typeof track.path === 'string' && typeof track.rel === 'string') {
          share(pool, track)
          tracks.push(track)
        }
      } catch {
        // Skip a torn line rather than discarding the whole index.
      }
    }
    const patched = applyPatches(root, tracks, pool)
    if (patched.length === 0) return null
    replay = { root, tracks: patched, openingDir: early?.dir ?? '' }
    return patched
  } catch {
    return null
  }
}

/**
 * The index this read produced, held for the walk that is about to start.
 *
 * `scanner.ts` needs it for two things the walk cannot work out on its own: the rows to
 * re-emit for a folder it decides to skip, and which folder the window is opening on (which
 * is never skipped). Passing it as an argument would mean threading it through
 * `scanner-process.ts`, which is the module that already called `loadIndex` and is about to
 * call `startScan` in the same synchronous turn - so it is left here and taken from there
 * instead. Exactly one is ever held, and taking it drops the reference.
 */
let replay: { root: string; tracks: Track[]; openingDir: string } | null = null

export function takeIndexReplay(root: string): { tracks: Track[]; openingDir: string } | null {
  if (!replay || replay.root !== root) return null
  const held = replay
  replay = null
  return { tracks: held.tracks, openingDir: held.openingDir }
}

/**
 * Finds one folder's rows in the raw index and hands them over.
 *
 * The needle is the encoded `relDir` field, so this is a byte search rather than a parse;
 * every line it hits is parsed and re-checked properly, since a substring match is a hint
 * and not a guarantee. The patch journal is folded in first because these rows reach the
 * screen seconds before the full replay does, and a file that was moved or deleted should
 * not appear at its old path in the meantime.
 */
function emitEarly(
  root: string,
  buffer: Buffer,
  early: { dir: string; emit: (tracks: Track[]) => void },
  pool: StringPool
): void {
  try {
    const journal = readPatches(root, pool)
    const rows: Track[] = []

    const take = (line: string): void => {
      try {
        const track = JSON.parse(line) as Track
        if (typeof track.path !== 'string' || typeof track.rel !== 'string') return
        if (journal.removed.has(track.path)) return
        if (early.dir !== '' && track.relDir !== early.dir) return
        share(pool, track)
        rows.push(track)
      } catch {
        // A torn line here costs one row and nothing else.
      }
    }

    if (early.dir === '') {
      // Nowhere in particular to open - the view above the roots. Any rows will do, and the
      // first ones in the file are the cheapest to reach.
      let from = 0
      for (let i = 0; i < EARLY_FALLBACK_ROWS; i++) {
        const end = buffer.indexOf(10, from)
        if (end === -1) break
        take(buffer.toString('utf8', from, end))
        from = end + 1
      }
    } else {
      const needle = Buffer.from(`"relDir":${JSON.stringify(early.dir)}`, 'utf8')
      let from = 0
      for (;;) {
        const at = buffer.indexOf(needle, from)
        if (at === -1) break
        const start = buffer.lastIndexOf(10, at) + 1
        let end = buffer.indexOf(10, at)
        if (end === -1) end = buffer.length
        take(buffer.toString('utf8', start, end))
        from = end + 1
      }
    }

    // A file moved into this folder since the last full scan lives only in the journal.
    for (const track of journal.added) {
      if (early.dir === '' || track.relDir === early.dir) rows.push(track)
    }

    if (rows.length > 0) early.emit(rows)
  } catch {
    // The early pass is an optimisation; failing it only costs the loading screen.
  }
}

/** The journal as a set of removals and a list of arrivals. Read by both replay paths. */
function readPatches(root: string, pool?: StringPool): { removed: Set<string>; added: Track[] } {
  const removed = new Set<string>()
  const added: Track[] = []
  const file = patchPath(root)
  if (!existsSync(file)) return { removed, added }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { removed, added }
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const patch = JSON.parse(line) as IndexPatch
      for (const path of patch.removed ?? []) removed.add(path)
      for (const track of patch.added ?? []) {
        // A later patch can remove something an earlier one added.
        removed.delete(track.path)
        if (pool) share(pool, track)
        added.push(track)
      }
    } catch {
      // A torn final line - a crash mid-append is exactly what a journal exists to
      // survive - costs that one line, not every patch before it.
      continue
    }
  }
  return { removed, added }
}

/** Folds the patch journal into a freshly-read index. */
function applyPatches(root: string, tracks: Track[], pool?: StringPool): Track[] {
  const { removed, added } = readPatches(root, pool)
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

/* --------------------------------------------------- folder mtimes, beside the index */

/**
 * Every folder the last complete walk visited, and the mtime it had when it was read.
 *
 * Re-walking 326,487 files to find what changed costs 45-48s of every launch. Creating,
 * deleting or renaming anything in a folder moves that folder's own mtime, so a folder whose
 * mtime still matches holds the same names it did and its `readdir` plus one `stat` per file
 * can be skipped. Measured on the real library, 22,201 folder stats take 1.5s against the
 * 45-48s of the full walk. `scanner.ts` owns the skipping; this owns remembering.
 *
 * A change inside a subfolder does *not* move its parent's mtime, so a skipped folder's
 * children cannot be pruned with it and have to come from somewhere. That is why every
 * folder is recorded, not just the ones holding indexed files: the record is also the folder
 * tree, and the children of a skipped folder are read back out of it.
 *
 * It sits beside the index rather than inside it because the index file is copied verbatim
 * into a bundle and scanned raw for the opening folder's rows, and a line that is not a track
 * means teaching both of those to skip it.
 */
interface FolderRecord {
  /** The index this describes. See `loadFolderMtimes`. */
  indexMtimeMs: number
  indexSize: number
  dirs: Record<string, number>
}

function dirsPath(root: string): string {
  return `${indexPath(root)}.dirs`
}

/**
 * The recorded folder mtimes, or null when there is nothing safe to use.
 *
 * The record names the index file it was written beside and is refused when that file has
 * since changed, because the two only mean anything together: a bundle restore replaces the
 * index underneath it, and folder mtimes describing another machine's index would skip
 * folders whose rows this one has never seen. A restore therefore costs one full walk, which
 * is what it already costs.
 */
export function loadFolderMtimes(root: string): Map<string, number> | null {
  if (!dataDir) return null
  const file = dirsPath(root)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as FolderRecord
    if (!record || typeof record.dirs !== 'object') return null
    const info = statSync(indexPath(root))
    if (info.mtimeMs !== record.indexMtimeMs || info.size !== record.indexSize) return null
    return new Map(Object.entries(record.dirs))
  } catch {
    // Unreadable or torn: the walk falls back to visiting everything, which is correct and
    // only slow.
    return null
  }
}

/**
 * What the walk saw, handed over for `saveIndex` to write.
 *
 * Held here rather than passed to `saveIndex` because the call site is in
 * `scanner-process.ts`, which has the tracks and not the folders. The write has to happen
 * there and not in the walk: a record claiming folders are current while the index it
 * belongs to failed to save would skip those folders forever, and every one of their files
 * would be diffed as removed on the scan after that.
 */
const pendingDirs = new Map<string, Map<string, number>>()

export function recordFolderMtimes(root: string, dirs: Map<string, number>): void {
  pendingDirs.set(root, dirs)
}

function writeFolderMtimes(root: string, file: string): void {
  const dirs = pendingDirs.get(root)
  if (!dirs) return
  pendingDirs.delete(root)
  try {
    const info = statSync(file)
    const record: FolderRecord = {
      indexMtimeMs: info.mtimeMs,
      indexSize: info.size,
      dirs: Object.fromEntries(dirs)
    }
    writeFileSync(dirsPath(root), JSON.stringify(record), 'utf8')
  } catch {
    // No record means a full walk next launch, which is only the cost this exists to avoid.
  }
}

export function saveIndex(root: string, tracks: Track[]): void {
  if (!dataDir) return
  const file = indexPath(root)
  try {
    // Moves keep happening while a scan runs, and main appends them to the journal the
    // whole time - the walk's snapshot holds a file moved mid-scan at its *old* path.
    // Folding the journal in before deleting it keeps those moves; entries the walk
    // already reflects apply as no-ops.
    const patched = applyPatches(root, tracks)

    // Dropped before anything is written, so no failure below can leave a record standing
    // that describes an index which is no longer the one on disk. A missing record costs a
    // full walk; a wrong one costs a folder that is never looked at again.
    rmSync(dirsPath(root), { force: true })

    const tmp = `${file}.tmp`
    // Written in chunks so a huge library doesn't need one enormous string in memory -
    // joining the chunks back together would materialise exactly that string.
    writeFileSync(tmp, '', 'utf8')
    const CHUNK = 5000
    for (let i = 0; i < patched.length; i += CHUNK) {
      appendFileSync(
        tmp,
        `${patched
          .slice(i, i + CHUNK)
          .map((track) => JSON.stringify(track))
          .join('\n')}\n`,
        'utf8'
      )
    }
    renameSync(tmp, file)
    writeFolderMtimes(root, file)
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
    rmSync(dirsPath(root), { force: true })
  } catch {
    // Nothing depends on removal succeeding.
  }
}
