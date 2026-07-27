/**
 * How wide the side panels are allowed to get.
 *
 * A fixed ceiling is wrong at both ends: 480px is most of a 1366-wide window and a sliver
 * of an ultrawide one. So the limit is whatever is left over after the *other* panel and
 * a file table you can still read, which on a big display is very wide indeed and on a
 * small one still leaves something to browse.
 */

import { useSyncExternalStore } from 'react'

/**
 * The narrowest the file table is allowed to be squeezed to: about the name column plus
 * one value column, below which it stops being something you can pick a file out of.
 *
 * Deliberately mean rather than comfortable. It is the only thing standing between the
 * panels and the whole window, and someone dragging a panel that far has decided the
 * table is not what they are looking at - a 1360-wide window has to give up something
 * real for the dock to get meaningfully wider than the 720px ceiling this replaced.
 */
export const MIN_TABLE_WIDTH = 280

/**
 * The widest a panel may be dragged, given what else is on screen.
 *
 * Never below `minWidth`: on a window narrow enough that the sum doesn't fit, the panel
 * keeps its own minimum rather than collapsing to nothing.
 */
export function maxPanelWidth(minWidth: number, windowWidth: number, occupied: number): number {
  return Math.max(minWidth, Math.round(windowWidth - occupied - MIN_TABLE_WIDTH))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

const snapshot = (): number => window.innerWidth

/**
 * The window's inner width, re-rendering the caller when it changes.
 *
 * The panels need it live rather than once: a width that was legal when it was dragged
 * has to be reined back in when the window shrinks under it, or the sidebar's own resize
 * handle ends up past the right edge of the screen where nothing can reach it.
 */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
