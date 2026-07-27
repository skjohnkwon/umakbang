/**
 * Turning the explorer's selection into something the file operations can act on.
 *
 * A row is identified by a string - a file by its absolute path, a folder by `dir:` and
 * its root-relative one - because that is what survives the list being re-sorted, filtered
 * or rebuilt mid-scan. Acting on the selection means resolving those ids back to real
 * paths, in the order they appear on screen.
 */

import type { LibraryRoot, Track } from '@shared/types'
import type { Row } from '@/hooks/useLibraryView'
import { absolutePath } from '@/lib/paths'

export function rowId(row: Row): string {
  return row.type === 'folder' ? `dir:${row.node.path}` : row.track.path
}

export interface Selected {
  ids: string[]
  /** Absolute paths of everything selected, folders included, in row order. */
  paths: string[]
  /** Only the file rows, for the actions that don't apply to a folder. */
  tracks: Track[]
  /** Root-relative paths of the selected folders. */
  dirs: string[]
  count: number
  /** The one entry selected, when there is exactly one. */
  only: { path: string; name: string; directory: boolean } | null
}

export const NOTHING_SELECTED: Selected = {
  ids: [],
  paths: [],
  tracks: [],
  dirs: [],
  count: 0,
  only: null
}

/**
 * Reads the selection off the visible rows.
 *
 * Deriving it from `rows` rather than from the ids alone is deliberate: it keeps the order
 * the same as the screen, and it silently drops anything a navigation or a filter has
 * taken away, so an action can never reach a row the user can no longer see.
 */
export function resolveSelection(
  rows: Row[],
  selection: Set<string>,
  roots: LibraryRoot[]
): Selected {
  if (selection.size === 0) return NOTHING_SELECTED

  const ids: string[] = []
  const paths: string[] = []
  const tracks: Track[] = []
  const dirs: string[] = []
  let only: Selected['only'] = null

  for (const row of rows) {
    const id = rowId(row)
    if (!selection.has(id)) continue
    ids.push(id)
    if (row.type === 'file') {
      paths.push(row.track.path)
      tracks.push(row.track)
      only = { path: row.track.path, name: row.track.name, directory: false }
    } else {
      const absolute = roots.length > 0 ? absolutePath(roots, row.node.path) : row.node.path
      paths.push(absolute)
      dirs.push(row.node.path)
      only = { path: absolute, name: row.node.name, directory: true }
    }
  }

  return { ids, paths, tracks, dirs, count: ids.length, only: ids.length === 1 ? only : null }
}

/** How the selection reads in a menu heading. */
export function selectionLabel(selected: Selected): string {
  if (selected.only) return selected.only.name
  return `${selected.count.toLocaleString()} items`
}

/** Where a popover anchored to a row should open, in viewport coordinates. */
export function anchorOfRow(id: string): { x: number; y: number } {
  const element = document.querySelector(`[data-row-id="${CSS.escape(id)}"]`)
  const rect = element?.getBoundingClientRect()
  return rect ? { x: rect.left + 24, y: rect.top } : { x: 240, y: 160 }
}
