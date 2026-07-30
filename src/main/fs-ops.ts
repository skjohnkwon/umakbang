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
import { pathKey } from '../shared/path-key'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ naming */

/**
 * The names Windows keeps for devices. Reserved with any extension and in any case, so
 * `CON`, `con.wav` and `Con.tar.gz` are all the same name to Windows.
 *
 * `COM0` and `LPT0` are deliberately absent, and so are the superscript spellings `COM¹`
 * and `LPT²` that some of Microsoft's own documentation lists: measured with `CreateFileW`
 * on Windows 11 25H2, none of them opens a device, and refusing a name that works
 * everywhere costs the user something for nothing.
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/**
 * The longest a single name may be, and the only path limit this app can actually reach.
 *
 * MAX_PATH is not one. libuv prefixes every absolute path with `\\?\` - measured, a
 * recursive `mkdirSync` under a 99-character root returns `\\?\C:\...` - so the ceiling is
 * 32,742 characters rather than 260, and the machine's `LongPathsEnabled` setting doesn't
 * come into it. Directories 285, 1,029 and 4,005 characters deep were created, written,
 * stat'd, renamed, `cp`'d and `rm`'d here without a complaint. A guard on total path length
 * would never fire, so there isn't one.
 *
 * A single component over 255 is reachable by typing, though, and it fails as `ENOENT: no
 * such file or directory` for a file and `EINVAL` for a folder - measured, 255 writes and
 * 256 does not. Neither of those is a sentence about the name being too long.
 */
const MAX_NAME_LENGTH = 255

/**
 * Why a name can't be used, or null if it can.
 *
 * Windows is the strict one, so its rules are applied everywhere - a library shared over
 * a network drive or a synced folder shouldn't produce names that only work on one
 * machine.
 *
 * Node is no help with any of it, and that is the point. The `\\?\` prefix libuv puts on
 * every absolute path skips Win32 path normalization entirely, so `writeFile` cheerfully
 * creates `nul`, `con.wav` and `trailing.` as literal names - and Windows then disagrees
 * about what those files are called. Measured with `CreateFileW`: `X:\dir\nul` opens the
 * null device rather than the file sitting there, and `X:\dir\trailing.` opens `trailing`.
 * A beat renamed to `nul` in umakbang is a file nothing else on the machine can open.
 */
export function nameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name cannot be empty.'
  if (/[\\/]/.test(trimmed)) return 'Name cannot contain a path separator.'
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) return 'Name contains a character Windows forbids.'
  if (trimmed === '.' || trimmed === '..') return 'Not a valid name.'
  if (/[. ]$/.test(trimmed)) return 'Name cannot end with a dot or a space.'

  // The device rule looks at the segment before the *first* dot, which is why `CON.tar.gz`
  // is `CON`, and it looks at it with trailing dots and spaces stripped, because Win32
  // strips those before it looks. Only `nul` is still intercepted inside a folder on this
  // Windows build - `X:\dir\con.wav` is an ordinary file here - but the whole set is
  // intercepted when the name stands alone, it is what Microsoft documents as reserved, and
  // it is what archivers, sync clients and non-Windows SMB servers refuse. A library on a
  // network drive lives under somebody else's rules.
  const device = trimmed.split('.')[0].replace(/[. ]+$/, '').toLowerCase()
  if (RESERVED_DEVICE_NAMES.has(device)) {
    return `Windows reserves "${device.toUpperCase()}" for a device, with or without an extension.`
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    return `Name is too long - ${MAX_NAME_LENGTH} characters at most.`
  }
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
  const track: Track = {
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

  // Same rule as the scanner's `makeTrack`: the composed spelling rides along, and only when
  // it differs from the path. A row that reached the index this way - through a paste, a move
  // or the watched folder being re-read - has to carry it too, or the file's tags and rating
  // would go missing the moment it was operated on.
  const key = pathKey(full)
  if (key !== full) track.pathKey = key

  return track
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
      // `shell.trashItem` has a limit of its own and it is not MAX_PATH. Measured on
      // Windows 11 25H2: an entry 34 folders and 740 characters down fails with "Failed to
      // perform delete operation", while 32 folders at 700 characters, 27 at 740 and 54 at
      // 275 all succeed - so it takes deep *and* long together, and no single number
      // describes it. It is left to report the OS's own sentence rather than guarded
      // against, because a guard would have to guess where the line is. What must never
      // happen is a fallback to `rm`: this function exists so that a misclick is a trip to
      // the recycle bin rather than a loss.
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
