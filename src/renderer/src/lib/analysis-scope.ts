/**
 * Which files the tempo and key passes are allowed to touch.
 *
 * Analysing a file means decoding it in full, so on a library that is mostly sample packs
 * and one-shots the work is nearly all wasted: a kick sample has no tempo and no key worth
 * the name. Folders carry tags the same way files do, and one of those tags nominates the
 * parts of the tree that are actually finished music.
 *
 * The rule for a folder, walking up from the file:
 *
 *   - the nearest ancestor that carries *any* tag decides, and it decides by whether that
 *     tag set includes the chosen one;
 *   - a folder with no tags of its own inherits that answer, so tagging `Beats` covers
 *     everything filed underneath it without tagging each subfolder;
 *   - nothing tagged anywhere above means no, since the whole point is to opt a part of
 *     the library in rather than to opt the rest out.
 *
 * With no tag chosen the gate is open: that is the behaviour the app had before any of
 * this existed, and it is what an install that has never heard of folder tags should do.
 */

import type { LibraryRoot } from '@shared/types'
import { pathKey } from '@shared/path-key'
import { absolutePath } from '@/lib/paths'

export interface AnalysisScope {
  /** The tag that nominates a folder, or null for "analyse everything". */
  tag: string | null
  roots: LibraryRoot[]
  /** Absolute path -> tags. The same map files use. */
  tags: Record<string, string[]>
}

/**
 * Whether a file in `relDir` may be analysed.
 *
 * `relDir` is label-prefixed with forward slashes; '' is the virtual root above them all.
 */
export function inAnalysisScope(relDir: string, scope: AnalysisScope): boolean {
  const { tag, roots, tags } = scope
  if (!tag) return true
  if (roots.length === 0) return false

  const wanted = tag.toLowerCase()
  const segments = relDir ? relDir.split('/') : []

  // Nearest first: the deepest folder that has an opinion is the one that holds.
  //
  // Composed before it is looked up, because this path is built by string arithmetic - a
  // root's stored path joined to segments of `relDir` - rather than taken off a Track, so
  // nothing upstream of it has been through `pathKey`.
  //
  // That closes only half the gap. `Track.rel` and `Track.relDir` are *not* canonical: the
  // scanner builds them from what `readdir` handed back, so a folder whose name is stored
  // decomposed on disk produces decomposed segments, and composing the joined result gives a
  // key the tag was never filed under. Closing that means canonicalising the relative paths
  // themselves, which reaches the folder tree, `folderSort`, `pinnedDirs` and
  // `randomExcludeDirs`, and is a separate change.
  for (let depth = segments.length; depth >= 1; depth--) {
    const applied = tags[pathKey(absolutePath(roots, segments.slice(0, depth).join('/')))]
    if (!applied || applied.length === 0) continue
    return applied.some((entry) => entry.toLowerCase() === wanted)
  }

  return false
}

/**
 * Every tag applied to a folder rather than a file, so Settings can offer the ones that
 * could actually gate anything. A tag only ever used on files would select nothing.
 */
export function folderTags(
  tags: Record<string, string[]>,
  isFolder: (path: string) => boolean
): string[] {
  const found = new Set<string>()
  for (const [path, applied] of Object.entries(tags)) {
    if (!isFolder(path)) continue
    for (const tag of applied) found.add(tag)
  }
  return [...found].sort((a, b) => a.localeCompare(b))
}
