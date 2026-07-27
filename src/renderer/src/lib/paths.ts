/**
 * Path arithmetic for the renderer, which has no `node:path`.
 *
 * Library paths come in two flavours: absolute ones from the OS (whatever separator the
 * platform uses) and relative ones with forward slashes, whose first segment is the label
 * of the library folder they belong to. These convert between them without assuming
 * Windows. The relative form and its labels are explained in `src/shared/roots.ts`.
 */

import type { LibraryRoot } from '@shared/types'
import { absoluteFor, relFor } from '@shared/roots'

/**
 * Turns a relative folder path into an absolute one.
 *
 * '' is the virtual root that holds every library folder. It has no path of its own, so it
 * comes back unchanged - callers that can be handed it check for it first.
 */
export function absolutePath(roots: LibraryRoot[], rel: string): string {
  return absoluteFor(roots, rel) ?? rel
}

/** The containing folder of an absolute path, with no trailing separator. */
export function parentPath(absolute: string): string {
  const cut = Math.max(absolute.lastIndexOf('\\'), absolute.lastIndexOf('/'))
  return cut <= 0 ? absolute : absolute.slice(0, cut)
}

/** The final segment of a path, separator-agnostic. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * Turns an absolute path into a label-prefixed relative one, the form the folder tree is
 * keyed by. Null when the path falls outside every library folder.
 */
export function relativePath(roots: LibraryRoot[], absolute: string): string | null {
  return relFor(roots, absolute)
}

/**
 * Whether a relative folder path sits at or below one of `dirs`, which are also relative.
 * Excluding a folder is understood to exclude its subfolders, so this is a prefix test on
 * whole segments rather than a string prefix: `Drums` must not swallow `Drums Old`.
 */
export function isUnderAnyDir(rel: string, dirs: string[]): boolean {
  if (dirs.length === 0) return false
  const target = rel.toLowerCase()
  return dirs.some((dir) => {
    const candidate = dir.toLowerCase()
    // The virtual root would swallow the whole library, so it never counts as a folder.
    if (candidate === '') return false
    return target === candidate || target.startsWith(`${candidate}/`)
  })
}

/** Case-insensitive comparison, since Windows paths differ only in case all the time. */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
