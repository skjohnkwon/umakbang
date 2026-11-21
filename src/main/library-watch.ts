/**
 * Watches the whole library while there is no window, so the index keeps up with the disk.
 *
 * Running in the background (`background.ts`), the index on disk is what the server hands to
 * other machines - and with the window closed nothing was keeping it current. The folder watch
 * in `index.ts` follows the folder on *screen*, so it goes when the window does, and the next
 * scan was at the next login or the next time somebody opened the window. A beat bounced at
 * 3am into a machine sitting in the tray was invisible to the phone it was bounced for.
 *
 * One recursive watch per library folder. On Windows that is a single `ReadDirectoryChangesW`
 * handle however many folders are beneath it, and FSEvents on a Mac likewise, so watching a
 * 22,000-folder library costs what watching one costs. Only while there is no window: with one
 * open, the on-screen watch and the launch scan already cover what the user is looking at, and
 * a refresh of the whole library on every save would be work the window then repeats.
 *
 * What it hands over is *which folders* changed, not merely that something did. The scan's
 * revalidation skips any folder whose own mtime has not moved, and a file saved over in place
 * moves only its own - so "rescan" alone would miss exactly the re-exported beat this exists
 * to catch. The changed folders go to the scanner as `touched`, which it reads regardless.
 */

import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LibraryRoot } from '../shared/types'

/**
 * Quiet time before a batch is handed over. A DAW export is not one write: FL writes a
 * temporary file, renames it, then touches it again, over a second or two - and a large
 * bounce or a sample pack being unzipped is a stream of events for much longer than that.
 */
const SETTLE_MS = 15_000

/** The most a batch waits, so a folder that never stops changing is still caught up with. */
const MAX_WAIT_MS = 120_000

interface Pending {
  root: LibraryRoot
  /** Changed folders, absolute. Null means the watcher lost count and the root needs a full walk. */
  dirs: Set<string> | null
  settle: NodeJS.Timeout | null
  deadline: NodeJS.Timeout | null
}

const watchers = new Map<string, FSWatcher>()
const pending = new Map<string, Pending>()
let onChanged: ((root: LibraryRoot, dirs: string[] | null) => void) | null = null
/**
 * When the current watch started. A `change` event for a file whose mtime is older than this
 * was not a write - see `consider`.
 */
let armedAt = 0

/** Whether this platform watches a tree with one handle. Elsewhere it is not attempted. */
function supported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/**
 * Starts watching every local library folder. Replaces any watch already running.
 *
 * `changed` is called once per root per batch, with the folders that moved or null for "walk
 * all of it". A peer's library is skipped: it is another machine's disk, and its own copy of
 * umakbang watches it.
 */
export function watchLibrary(
  roots: LibraryRoot[],
  changed: (root: LibraryRoot, dirs: string[] | null) => void
): void {
  unwatchLibrary()
  if (!supported()) return
  onChanged = changed
  armedAt = Date.now()
  for (const root of roots) {
    if (root.remote) continue
    try {
      const watcher = watch(root.path, { recursive: true }, (eventType, filename) => {
        void consider(root, eventType, filename)
      })
      // An unplugged drive or a share that dropped. Nothing to watch until it is back, and the
      // next window or the next login scans it properly; throwing here would take the app down.
      watcher.on('error', () => {
        watcher.close()
        watchers.delete(root.path)
      })
      watchers.set(root.path, watcher)
    } catch {
      // A root that is not there right now. Same answer as the error above.
    }
  }
}

/** Stops watching and drops whatever had not been handed over yet. */
export function unwatchLibrary(): void {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
  for (const entry of pending.values()) {
    if (entry.settle) clearTimeout(entry.settle)
    if (entry.deadline) clearTimeout(entry.deadline)
  }
  pending.clear()
  onChanged = null
}

/**
 * Decides whether one event is a change worth re-reading a folder for, and files it.
 *
 * `rename` is a file appearing, going, or changing name, and always counts. `change` needs a
 * second look, because it also fires when a file is merely *read*: Windows can keep last-access
 * times, and the scan this watcher triggers reads thousands of files - left unfiltered, each
 * refresh would report its own reads and schedule the next refresh, for ever. A write moves
 * the file's mtime, a read does not, so a `change` on a file older than the watch is noise. A
 * `change` on a folder is dropped outright: what moved inside it arrives as its own event.
 */
async function consider(root: LibraryRoot, eventType: string, filename: string | Buffer | null): Promise<void> {
  if (!onChanged) return
  // No name means the OS buffer overflowed and the events in it were lost - a big unzip can
  // do it. Which folders changed is no longer known, so the whole root is walked.
  if (filename === null) {
    note(root, null)
    return
  }
  const full = join(root.path, filename.toString())
  if (eventType === 'change') {
    try {
      const info = await stat(full)
      if (info.isDirectory() || info.mtimeMs < armedAt) return
    } catch {
      // Gone already. Its folder changed, which a rename event will say too; noting it here
      // as well costs nothing.
    }
  }
  note(root, dirname(full))
}

function note(root: LibraryRoot, dir: string | null): void {
  let entry = pending.get(root.path)
  if (!entry) {
    entry = { root, dirs: new Set(), settle: null, deadline: null }
    pending.set(root.path, entry)
    const created = entry
    created.deadline = setTimeout(() => flush(root.path), MAX_WAIT_MS)
  }
  if (dir === null) entry.dirs = null
  else entry.dirs?.add(dir)
  if (entry.settle) clearTimeout(entry.settle)
  entry.settle = setTimeout(() => flush(root.path), SETTLE_MS)
}

function flush(path: string): void {
  const entry = pending.get(path)
  if (!entry) return
  pending.delete(path)
  if (entry.settle) clearTimeout(entry.settle)
  if (entry.deadline) clearTimeout(entry.deadline)
  // Anything changed from here on is newer than this batch; `change` events for files the
  // refresh is about to read must not count against the next one.
  armedAt = Date.now()
  onChanged?.(entry.root, entry.dirs ? [...entry.dirs] : null)
}
