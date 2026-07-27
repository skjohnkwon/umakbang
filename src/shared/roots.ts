import type { LibraryRoot } from './types'

/**
 * Several folders, one address space.
 *
 * umakbang started with a single library root, and every path it stores - `Track.rel`, the
 * folder tree's node paths, the keys of `folderSort`, `pinnedDirs`, `randomExcludeDirs` -
 * is written relative to it. Rather than teach all of those to carry a root alongside the
 * path, each root gets a label and that label becomes the first segment of every relative
 * path underneath it. `Drums/kicks/909.wav` names a file in the root labelled `Drums`, and
 * the tree builds the top-level node for free because it is just another path segment.
 *
 * The label is assigned once, when the folder is added, and stored next to the path. It is
 * never re-derived: it is baked into everything persisted about the files beneath it, so a
 * label that drifted would silently orphan a folder's sort order, its tags and its pins.
 */

/** A label the given roots don't already use, derived from the folder's own name. */
export function labelForRoot(path: string, existing: LibraryRoot[]): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  // A drive root has no last segment worth using: `Z:\` gives `Z:`.
  const stem = base.replace(/:$/, '') || 'Library'
  const taken = new Set(existing.map((root) => root.label.toLowerCase()))
  if (!taken.has(stem.toLowerCase())) return stem
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** The root a relative path belongs to, or null when its label names no open folder. */
export function rootOf(roots: LibraryRoot[], rel: string): LibraryRoot | null {
  const slash = rel.indexOf('/')
  const label = (slash === -1 ? rel : rel.slice(0, slash)).toLowerCase()
  return roots.find((root) => root.label.toLowerCase() === label) ?? null
}

/** Everything after the label. '' when the path names the root folder itself. */
export function withinRoot(rel: string): string {
  const slash = rel.indexOf('/')
  return slash === -1 ? '' : rel.slice(slash + 1)
}

/** The relative path of a root's own folder - its label, and nothing else. */
export function relOfRoot(root: LibraryRoot): string {
  return root.label
}

/** The open folder an absolute path lives in, or null when it falls outside all of them. */
export function rootFor(roots: LibraryRoot[], absolute: string): LibraryRoot | null {
  const target = norm(absolute)
  // Longest first, so a root nested inside another would still resolve to the nearer one.
  // Nesting is refused when folders are added, but a settings file can be edited by hand.
  const ordered = [...roots].sort((a, b) => b.path.length - a.path.length)
  return (
    ordered.find((root) => {
      const base = norm(root.path)
      return target === base || target.startsWith(`${base}/`)
    }) ?? null
  )
}

/**
 * An absolute path as a label-prefixed relative one, or null when it is outside every
 * open folder.
 */
export function relFor(roots: LibraryRoot[], absolute: string): string | null {
  const root = rootFor(roots, absolute)
  if (!root) return null
  const rest = norm(absolute).slice(norm(root.path).length).replace(/^\//, '')
  // Keep the caller's own casing for the part below the root; only the root's own prefix
  // is matched case-insensitively, because that is where Windows disagrees with itself.
  const tail = rest ? absolute.slice(absolute.length - rest.length).split('\\').join('/') : ''
  return tail ? `${root.label}/${tail}` : root.label
}

/** A relative path back to an absolute one, or null when its label names no open folder. */
export function absoluteFor(roots: LibraryRoot[], rel: string): string | null {
  const root = rootOf(roots, rel)
  if (!root) return null
  const within = withinRoot(rel)
  if (!within) return root.path
  const sep = root.path.includes('\\') ? '\\' : '/'
  const base = /[\\/]$/.test(root.path) ? root.path.slice(0, -1) : root.path
  return `${base}${sep}${within.split('/').join(sep)}`
}

function norm(path: string): string {
  return path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
}
