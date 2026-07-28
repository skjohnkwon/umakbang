/**
 * The file operations behind the explorer's copy / cut / paste / delete actions.
 *
 * Everything here reports what it did in terms the renderer's index can absorb: a moved
 * folder comes back as the list of files that went with it, paired with where each one
 * used to be. That is what lets a drag or a paste update the visible library immediately
 * instead of waiting on a rescan, which on a quarter-million-file tree is a minute of
 * walking for a change we already know the shape of.
 */

import { basename, dirname, join } from 'node:path'
import { existsSync, type Dirent } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { shell } from 'electron'
import {
  IGNORED_DIRS,
  PLAYABLE_EXTENSIONS,
  classifyKind,
  extensionOf,
  isIndexable
} from '../shared/files'
import type {
  LibraryRoot,
  Track,
  TransferItem,
  TransferMode,
  TransferResult,
  TrashResult
} from '../shared/types'
import { relFor } from '../shared/roots'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ naming */

/**
 * Why a name can't be used, or null if it can.
 *
 * Windows is the strict one, so its rules are applied everywhere - a library shared over
 * a network drive or a synced folder shouldn't produce names that only work on one
 * machine.
 */
export function nameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name cannot be empty.'
  if (/[\\/]/.test(trimmed)) return 'Name cannot contain a path separator.'
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) return 'Name contains a character Windows forbids.'
  if (trimmed === '.' || trimmed === '..') return 'Not a valid name.'
  if (/[. ]$/.test(trimmed)) return 'Name cannot end with a dot or a space.'
  return null
}

/** A path that doesn't exist yet: "name.wav", then "name (2).wav", "name (3).wav", … */
function uniqueTarget(destination: string, base: string, directory: boolean): string {
  const first = join(destination, base)
  if (!existsSync(first)) return first

  // A folder has no extension to preserve, so the counter goes on the end.
  const dot = directory ? -1 : base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const suffix = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 1000; n++) {
    const candidate = join(destination, `${stem} (${n})${suffix}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(destination, `${stem} (${Date.now()})${suffix}`)
}

/** True if `inner` is `outer` itself or sits somewhere beneath it. */
function isInside(inner: string, outer: string): boolean {
  const a = inner.toLowerCase().replace(/[\\/]+$/, '')
  const b = outer.toLowerCase().replace(/[\\/]+$/, '')
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)
}

/* ------------------------------------------------------------------ describing */

/**
 * A Track for a file that has just appeared somewhere, so an operation can update the
 * renderer's index in place. Null for anything the library wouldn't index anyway.
 */
export async function describeFile(full: string, roots: LibraryRoot[]): Promise<Track | null> {
  const name = basename(full)
  const ext = extensionOf(name)
  if (!isIndexable(ext)) return null

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(full)
  } catch {
    return null
  }

  // Paths are relative to the library folder they're in, labelled with which one, and
  // always use forward slashes. A file outside every open folder keeps just its name, so
  // it still renders as something sane.
  const rel = relFor(roots, full) ?? name
  const cut = rel.lastIndexOf('/')
  return {
    path: full,
    rel,
    dir: dirname(full),
    relDir: cut === -1 ? '' : rel.slice(0, cut),
    name,
    ext,
    size: info.size,
    mtimeMs: info.mtimeMs,
    kind: classifyKind(ext),
    playable: PLAYABLE_EXTENSIONS.has(ext)
  }
}

/** Every indexable file at or beneath a path. A plain file describes to a list of one. */
export async function describeTree(full: string, roots: LibraryRoot[]): Promise<Track[]> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(full)
  } catch {
    return []
  }
  if (!info.isDirectory()) {
    const track = await describeFile(full, roots)
    return track ? [track] : []
  }
  const out: Track[] = []
  await walk(full, roots, out)
  return out
}

/**
 * The indexable files sitting directly in a folder - no recursion.
 *
 * What a folder being watched needs after something in it changed: re-reading the one
 * folder is cheap enough to do on every save, where re-walking its subtree would not be.
 */
export async function describeDir(dir: string, roots: LibraryRoot[]): Promise<Track[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Track[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    const track = await describeFile(join(dir, entry.name), roots)
    if (track) out.push(track)
  }
  return out
}

async function walk(dir: string, roots: LibraryRoot[], out: Track[]): Promise<void> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Same exclusions the scanner uses, so the index sees exactly one set of files.
      if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue
      await walk(full, roots, out)
    } else if (entry.isFile()) {
      const track = await describeFile(full, roots)
      if (track) out.push(track)
    }
  }
}

/**
 * The old paths of everything in `landed`, given the entry as a whole moved from
 * `source` to `target`. Both are absolute and share a separator, so the prefix swap is
 * exact rather than a reconstruction.
 */
function originsOf(landed: Track[], source: string, target: string): string[] {
  return landed.map((track) => source + track.path.slice(target.length))
}

/* ------------------------------------------------------------------ operations */

const EMPTY: TransferResult = { moves: [], items: [], removed: [] }

/**
 * Copies or moves entries into a folder, creating it if needed.
 *
 * Never overwrites: a collision lands as "name (2)". A failure stops the run and reports
 * what had already succeeded, so the renderer's index still matches the disk.
 */
export async function transfer(
  paths: string[],
  destination: string,
  mode: TransferMode,
  roots: LibraryRoot[]
): Promise<TransferResult> {
  if (!destination) return { ...EMPTY, error: 'No destination is configured.' }
  if (paths.length === 0) return EMPTY

  try {
    await mkdir(destination, { recursive: true })
  } catch (error) {
    return { ...EMPTY, error: `Can't create ${destination}: ${describeError(error)}` }
  }

  const moves: TransferResult['moves'] = []
  const items: TransferItem[] = []
  const removed: string[] = []

  for (const source of paths) {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(source)
    } catch {
      // Already gone - nothing to move, and nothing worth failing the whole run over.
      continue
    }

    const directory = info.isDirectory()
    if (directory && isInside(destination, source)) {
      return {
        moves,
        items,
        removed,
        error: `Can't put ${basename(source)} inside itself.`
      }
    }

    const target = uniqueTarget(destination, basename(source), directory)
    try {
      if (mode === 'move') {
        try {
          await rename(source, target)
        } catch {
          // rename fails across volumes; fall back to copy-then-delete.
          await cp(source, target, { recursive: true })
          await rm(source, { recursive: true, force: true })
        }
      } else {
        await cp(source, target, { recursive: true })
      }
    } catch (error) {
      return {
        moves,
        items,
        removed,
        error: `Couldn't ${mode} ${basename(source)}: ${describeError(error)}`
      }
    }

    const landed = await describeTree(target, roots)
    const origins = originsOf(landed, source, target)
    landed.forEach((track, index) => items.push({ from: origins[index], track }))
    if (mode === 'move') {
      // A file the library doesn't index still has to leave the index if it was in it -
      // and a folder's non-indexable contents were never in it to begin with.
      removed.push(...(directory ? origins : [source]))
    }
    moves.push({ from: source, to: target, directory })
  }

  return { moves, items, removed }
}

/**
 * Sends entries to the OS trash.
 *
 * Deliberately not an unlink: everything here is somebody's work, and the recycle bin is
 * the difference between a misclick and a loss.
 */
export async function trashEntries(paths: string[], roots: LibraryRoot[]): Promise<TrashResult> {
  const trashed: string[] = []
  const removed: string[] = []

  for (const path of paths) {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch {
      continue
    }

    // Read the folder before it goes, or there's nothing left to enumerate.
    const doomed = info.isDirectory() ? (await describeTree(path, roots)).map((t) => t.path) : [path]
    try {
      await shell.trashItem(path)
    } catch (error) {
      return { trashed, removed, error: `Couldn't delete ${basename(path)}: ${describeError(error)}` }
    }
    trashed.push(path)
    removed.push(...doomed)
  }

  return { trashed, removed }
}

/** Creates a folder inside `parent`. Refuses a name that is already taken. */
export async function createFolder(
  parent: string,
  name: string
): Promise<{ path?: string; error?: string }> {
  const invalid = nameError(name)
  if (invalid) return { error: invalid }

  const target = join(parent, name.trim())
  if (existsSync(target)) return { error: 'Something with that name is already there.' }
  try {
    await mkdir(target, { recursive: true })
    return { path: target }
  } catch (error) {
    return { error: describeError(error) }
  }
}

/**
 * Renames a file or folder in place.
 *
 * Reported the same way as a transfer, because renaming a folder moves every file
 * underneath it as far as the index is concerned.
 */
export async function renameEntry(
  path: string,
  newName: string,
  roots: LibraryRoot[]
): Promise<TransferResult> {
  const invalid = nameError(newName)
  if (invalid) return { ...EMPTY, error: invalid }

  const trimmed = newName.trim()
  const target = join(dirname(path), trimmed)
  if (target === path) return EMPTY

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    return { ...EMPTY, error: 'That file is no longer there.' }
  }
  const directory = info.isDirectory()

  // Changing only the case of a name is a real rename on NTFS but reads as a collision to
  // existsSync, which is case-insensitive there. Only there, though: on a case-sensitive
  // filesystem `kick.wav` and `Kick.wav` are two different files, and skipping the
  // collision check would let the rename silently replace the other one.
  const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
  const caseOnly = caseInsensitiveFs && target.toLowerCase() === path.toLowerCase()
  if (!caseOnly && existsSync(target)) {
    return { ...EMPTY, error: 'Something with that name is already there.' }
  }

  try {
    await rename(path, target)
  } catch (error) {
    return { ...EMPTY, error: describeError(error) }
  }

  const landed = await describeTree(target, roots)
  const origins = originsOf(landed, path, target)
  return {
    moves: [{ from: path, to: target, directory }],
    items: landed.map((track, index) => ({ from: origins[index], track })),
    removed: directory ? origins : [path]
  }
}
