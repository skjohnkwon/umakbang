/**
 * Library scanning, in two phases.
 *
 * Phase 1 walks the tree and emits every indexable file as soon as it is found, so the
 * UI becomes usable almost immediately. Phase 2 probes metadata in the background with
 * bounded concurrency and streams patches back, so a 30k-file library doesn't block on
 * a full metadata pass before showing anything.
 *
 * Most runs are not the first one. The saved index has already been replayed into the
 * renderer before the walk starts, so a revalidation pass is only looking for what has
 * changed, and almost all of the work below is about not repeating what has not:
 * `planRevalidation` skips a folder whose own mtime has not moved, reuses the saved row for
 * a file whose size and mtime have not moved, and reports through `onFresh` and `onMetadata`
 * only what the window does not already have. Measured on a 326,487-file library, the walk
 * went from 46.9s to 2.9s, and a pass over an unchanged library went from 326,487 rows and
 * 276,466 metadata patches to none of either.
 */

import { opendir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { MetadataPatch, ScanProgress, Track, TrackMetadata } from '../shared/types'
import {
  IGNORED_DIRS,
  PLAYABLE_EXTENSIONS,
  classifyKind,
  extensionOf,
  isIndexable
} from '../shared/files'
import { probeFile } from './probe'
import { flushMetadataCache, getCachedMetadata, putCachedMetadata } from './metadata-cache'
import { loadFolderMtimes, recordFolderMtimes, takeIndexReplay } from './index-store'

const PROBE_CONCURRENCY = 8
const PATCH_FLUSH_SIZE = 250
const PATCH_FLUSH_MS = 250

export interface ScanCallbacks {
  /**
   * Everything the walk found, which is what the index is written from. On a revalidation
   * most of these are the very objects the saved index was replayed from rather than fresh
   * ones, so a file that has not changed costs no allocation and keeps the metadata it was
   * saved with.
   */
  onTracks: (tracks: Track[]) => void
  /**
   * The subset of `onTracks` that the renderer has not already got: a file that is new, or
   * whose size or mtime has moved since the index was written. A scan with no index to
   * revalidate against reports everything here, since then nothing is already held.
   *
   * It exists because on a revalidation the renderer was filled from the index replay before
   * the walk started, and re-sending all 326,487 rows means structured-cloning them across
   * two process boundaries so that `addTracks` can look each one up and throw it away.
   * `onTracks` still carries the full set because the caller diffs it against the index to
   * find what has been deleted, and a row missing from that diff is a row reported as gone.
   */
  onFresh?: (tracks: Track[]) => void
  onProgress: (progress: ScanProgress) => void
  onMetadata: (patches: MetadataPatch[]) => void
  /** Anything that aborts the scan. Never swallow these - a silent stop looks like a hang. */
  onError: (stage: string, error: unknown) => void
}

export interface ScanHandle {
  cancel: () => void
  done: Promise<void>
  /**
   * Whether the walk saw the whole tree. The saved index is only structurally right when
   * it did: a cancelled or failed walk holds a fraction of the library, and writing that
   * over the complete index - or diffing it against the cache and calling the difference
   * "removed" - trades a good index for a partial one. Metadata is a different matter; a
   * fully-walked index with half its probes done is still worth saving.
   */
  walkCompleted: () => boolean
}

export interface ScanOptions {
  /**
   * Visit every folder for real, even one the saved index says has not changed.
   *
   * The skip below cannot see a file overwritten in place, since that moves the file's mtime
   * and not its folder's, so the one thing "rescan" means - I think the library is wrong,
   * read it again - has to be able to turn it off.
   */
  fullWalk?: boolean
}

/**
 * `label` prefixes every relative path this scan produces, naming which library folder the
 * file came from. See src/shared/roots.ts.
 */
export function startScan(
  root: string,
  label: string,
  callbacks: ScanCallbacks,
  options: ScanOptions = {}
): ScanHandle {
  let cancelled = false
  let walkCompleted = false
  // Taken here rather than inside the walk so it happens in the same synchronous turn as
  // the `loadIndex` that produced it, and so the reference is dropped either way - holding
  // a second one to a 326k-entry array for the life of a scan is what this pass exists to
  // stop doing.
  const plan = planRevalidation(root, label, options.fullWalk === true)
  const done = run(root, label, callbacks, () => cancelled, () => {
    walkCompleted = true
  }, plan).catch((error) => {
    callbacks.onError('run', error)
  })
  return {
    cancel: () => {
      cancelled = true
    },
    done,
    walkCompleted: () => walkCompleted
  }
}

async function run(
  root: string,
  label: string,
  cb: ScanCallbacks,
  isCancelled: () => boolean,
  onWalkComplete: () => void,
  plan: Revalidation | null
): Promise<void> {
  const tracks = await walk(root, label, cb, isCancelled, plan)
  if (isCancelled()) return
  onWalkComplete()

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

/**
 * What the last complete walk found, and what it lets this one skip.
 *
 * `mtimes` is every folder that walk visited; `children` is the same list read as a tree, so
 * a folder that is skipped still hands its subfolders to the queue - a change inside a
 * subfolder does not move its parent's mtime, so a subtree can never be pruned from the top.
 * `byDir` holds the rows a skipped folder is to hand back, which is not an optimisation: the
 * caller diffs what the walk found against the saved index and calls the difference deleted,
 * so a folder that is skipped and silent is a folder whose every file is reported as gone.
 *
 * `keep` is the folder the window is opening on. It is never skipped - the one folder the
 * user is looking at is the one place a stale row is read as a bug rather than as a cache.
 */
interface Revalidation {
  /**
   * Every row the saved index held, by absolute path. Present whenever there is an index to
   * revalidate at all, which is what decides whether a row is news to the renderer - a
   * rescan re-reads the disk but the window is still holding the replay, so it is told about
   * what changed and nothing else.
   */
  byPath: Map<string, Track>
  /** Folder skipping, which additionally needs a record of what the folders looked like. */
  skip: {
    mtimes: Map<string, number>
    children: Map<string, string[]>
    byDir: Map<string, Track[]>
    keep: string
  } | null
}

/**
 * Windows lets a library root be a bare drive, and then `Z:\` is the folder the walk queues
 * while `Z:` is what `Track.dir` holds for a file sitting directly in it - two spellings of
 * one place, and the maps below are keyed by one of them. Only a root can differ this way,
 * and the root is queued from the settings rather than out of the record, so nothing ever
 * calls `opendir('Z:')`, which means the process's current directory on that drive and not
 * its top.
 */
function dirKey(dir: string): string {
  const last = dir.charCodeAt(dir.length - 1)
  if (dir.length > 1 && (last === 92 || last === 47)) return dir.slice(0, -1)
  return dir
}

function planRevalidation(root: string, label: string, fullWalk: boolean): Revalidation | null {
  const replay = takeIndexReplay(root)
  if (!replay) return null

  const byPath = new Map<string, Track>()
  for (const track of replay.tracks) byPath.set(track.path, track)

  // No record yet - the first launch after this was written, or a bundle restore, or a
  // rescan asking for the disk to be read properly. Walking everything is what writes one.
  const mtimes = fullWalk ? null : loadFolderMtimes(root)
  if (!mtimes || mtimes.size === 0) return { byPath, skip: null }

  const children = new Map<string, string[]>()
  for (const dir of mtimes.keys()) {
    const parent = dirKey(dirname(dir))
    // The root's parent is itself once a drive letter runs out of path, and a folder listed
    // as its own child is a queue that never empties.
    if (parent === dirKey(dir)) continue
    const list = children.get(parent)
    if (list) list.push(dir)
    else children.set(parent, [dir])
  }

  const byDir = new Map<string, Track[]>()
  for (const track of replay.tracks) {
    const key = dirKey(track.dir)
    const list = byDir.get(key)
    if (list) list.push(track)
    else byDir.set(key, [track])
  }

  // `openingDir` is root-relative and led by the folder's label; the walk deals in absolute
  // paths, so it is converted once here rather than per folder.
  const parts = replay.openingDir.split('/')
  const keep =
    replay.openingDir && parts[0] === label ? dirKey(join(root, ...parts.slice(1))) : ''

  return { byPath, skip: { mtimes, children, byDir, keep } }
}

async function walk(
  root: string,
  label: string,
  cb: ScanCallbacks,
  isCancelled: () => boolean,
  plan: Revalidation | null
): Promise<Track[]> {
  const all: Track[] = []
  let batch: Track[] = []
  let fresh: Track[] = []
  const queue: string[] = [root]
  /** Every folder this walk visited, for the next one to compare against. */
  const visited = new Map<string, number>()
  const report = throttledProgress(cb)

  const flush = (): void => {
    if (batch.length > 0) {
      cb.onTracks(batch)
      batch = []
    }
    if (fresh.length > 0) {
      cb.onFresh?.(fresh)
      fresh = []
    }
  }

  /** `news` is false only for a row the renderer already has, byte for byte. */
  const emit = (track: Track, news: boolean): void => {
    all.push(track)
    batch.push(track)
    if (news) fresh.push(track)
    if (batch.length >= PATCH_FLUSH_SIZE) {
      flush()
      report({ phase: 'walking', found: all.length, probed: 0, total: all.length })
    }
  }

  /**
   * The row for a file, reusing the one the index already holds when nothing about the file
   * has moved. Reuse is not only about the allocation: the saved row carries the metadata it
   * was probed with, so the index written at the end of this scan keeps it without the probe
   * pass having to put it back, and the renderer needs to hear nothing about it at all.
   */
  const rowFor = (full: string, name: string, ext: string, size: number, mtimeMs: number): [Track, boolean] => {
    const known = plan?.byPath.get(full)
    if (known && known.size === size && known.mtimeMs === mtimeMs) return [known, false]
    return [makeTrack(root, label, full, name, ext, size, mtimeMs), true]
  }

  // A cursor rather than shift(): shifting re-indexes the whole array each time, which
  // over tens of thousands of directories turns the walk quadratic.
  let head = 0
  while (head < queue.length) {
    if (isCancelled()) return all
    const dir = queue[head++]
    const key = dirKey(dir)

    // The mtime is taken before the folder is read, never after. A change landing between
    // the two would otherwise be recorded against contents taken before it, and the folder
    // would be skipped for good; recording the older of the two only costs one extra visit.
    let dirMtimeMs: number | null = null
    try {
      dirMtimeMs = (await stat(dir)).mtimeMs
    } catch {
      // Gone between being queued and being reached. The root's own failure is left to
      // `opendir` below, which is where it is deliberately not swallowed.
      if (dir !== root) continue
    }

    // Unchanged since the last complete walk, so it holds the names it held then: hand back
    // the rows the index already has and move on to its subfolders. What this cannot see is
    // a file overwritten in place, which moves the file's mtime and not the folder's - the
    // row keeps the old size and date, and its probed duration with them, until something
    // else touches the folder. The app survives that because it is not the only thing
    // looking: main watches whichever folder is on screen and re-reads it 600ms after any
    // change, the toolbar re-reads it by hand for a share where the watch never fires, and
    // a rescan walks everything. This is also why `keep` exists.
    const skip = plan?.skip
    if (skip && dirMtimeMs !== null && key !== skip.keep && skip.mtimes.get(key) === dirMtimeMs) {
      visited.set(key, dirMtimeMs)
      for (const track of skip.byDir.get(key) ?? []) emit(track, false)
      for (const child of skip.children.get(key) ?? []) queue.push(child)
      continue
    }

    let entries: Awaited<ReturnType<typeof opendir>> | null = null
    try {
      entries = await opendir(dir)
    } catch (error) {
      // The root itself failing to open is not "an empty library" - it is a NAS that is
      // offline or a drive that is asleep, and swallowing it here made the scan report
      // zero files, empty the renderer and overwrite the saved index with nothing.
      if (dir === root) throw error
      // Permission denied, or the folder vanished mid-scan. Skip it.
      continue
    }

    try {
      for await (const entry of entries) {
        if (isCancelled()) return all

        const full = join(dir, entry.name)

        if (entry.isDirectory()) {
          // A macOS package like Foo.logicx or Foo.band is a directory to the filesystem
          // and one project to the user: index it as a single entry and don't descend
          // into it. Without this branch it was walked and never indexed at all.
          const packageExt = extensionOf(entry.name)
          if (isIndexable(packageExt)) {
            try {
              const info = await stat(full)
              emit(...rowFor(full, entry.name, packageExt, info.size, info.mtimeMs))
            } catch {
              // An unreadable package is skipped like any other unreadable file.
            }
            continue
          }
          if (shouldSkipDir(entry.name)) continue
          queue.push(full)
          continue
        }

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

        emit(...rowFor(full, entry.name, ext, size, mtimeMs))
      }
    } catch {
      continue
    }

    // Recorded only now that the whole folder has been read. A folder that failed to open,
    // or that threw partway through, has not been seen and must be visited again next time -
    // recording it would turn one locked folder into one that is never looked at again.
    if (dirMtimeMs !== null) visited.set(key, dirMtimeMs)
  }

  // Only here, where the queue has emptied without a cancellation, is the record complete
  // enough to be worth anything. It is handed over rather than written: a record saying a
  // folder is current alongside an index that failed to save would skip that folder forever
  // and diff every file in it as deleted, so `saveIndex` writes the two together.
  recordFolderMtimes(root, visited)

  flush()
  // Forced: this is the count the probe phase is about to be measured against, and it is the
  // one report the throttle must never be the reason nobody sees.
  cb.onProgress({ phase: 'walking', found: all.length, probed: 0, total: all.length })
  return all
}

/**
 * Caps how often progress reaches the renderer.
 *
 * Every report is a zustand `set`, which re-renders `App` and the toolbar. The walk flushes
 * a batch every 250 files and the scanner log shows those landing about 25ms apart, so the
 * counter was published around 40 times a second and each one cost a repaint of the chrome.
 * A counter that moves in steps of a few thousand reads exactly the same to a human, so the
 * throttle is in the scanner rather than in the renderer: it is the cheapest place, and it
 * stops the message crossing two process boundaries as well as the render.
 *
 * Phase changes and the final count of a phase go through `cb.onProgress` directly. They are
 * not counter ticks, and `App`'s loading screen and the store's `scanning` flag key off them.
 */
const PROGRESS_MIN_MS = 200

function throttledProgress(cb: ScanCallbacks): (progress: ScanProgress) => void {
  let last = 0
  return (progress) => {
    const now = Date.now()
    if (now - last < PROGRESS_MIN_MS) return
    last = now
    cb.onProgress(progress)
  }
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

/** Every field the probe can fill in. Kept beside the comparison that reads it. */
const META_FIELDS: (keyof TrackMetadata)[] = [
  'duration',
  'sampleRate',
  'bitDepth',
  'channels',
  'bitrate',
  'bpm',
  'musicalKey',
  'projectCreatedMs',
  'projectSeconds'
]

/**
 * Whether a probe result says anything the track does not already hold.
 *
 * On a revalidation most rows come back out of the saved index carrying the metadata they
 * were saved with, and the probe then reads the same answer out of the metadata cache - so
 * without this every one of the ~200,000 playable files streams a patch the renderer already
 * has, which is the same flood as re-sending the tracks themselves.
 *
 * The probe still *runs*, which is deliberate: a probe that failed is not cached, so a file
 * a DAW held locked mid-export is retried on the next scan exactly as before, and the only
 * thing that changes is whether a result identical to the last one is worth sending.
 */
function metadataChanged(track: Track, meta: TrackMetadata): boolean {
  if (!track.probed) return true
  for (const field of META_FIELDS) {
    if (meta[field] !== track[field]) return true
  }
  return false
}

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
  const report = throttledProgress(cb)

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
          putCachedMetadata(track.path, track.mtimeMs, track.size, meta)
        } catch (error) {
          // One unreadable file must never stop the pass for the other 300,000. The
          // failure is not cached, though: a file a DAW held locked mid-export changes
          // neither mtime nor size when the lock lifts, so a cached failure would read
          // as "no metadata" forever. One retry per scan is cheap.
          cb.onError(`probe:${track.path}`, error)
          meta = {}
        }
      }

      if (metadataChanged(track, meta)) pending.push({ path: track.path, meta })

      probed++
      flush(false)

      // Frequent early ticks so the counter visibly moves; coarser once it's clearly alive.
      // The throttle is what decides whether any of them actually goes out.
      if (probed < 500 ? probed % 25 === 0 : probed % 250 === 0) {
        report({
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
