import { useSyncExternalStore } from 'react'
import type { Row } from '@/hooks/useLibraryView'
import type { PaneId } from '@/state/library'

/**
 * What each explorer pane is showing, for the controls that work on "what is on screen"
 * from outside the pane - the title bar's recalculate button.
 *
 * Published by the panes rather than derived again where it is needed: `useVisibleRows`
 * filters and sorts the whole view, and calling it a second time from the title bar would
 * double a 300k-row sort in the all-files view for the sake of one button's tooltip.
 */
const published = new Map<PaneId, Row[]>()
const listeners = new Set<() => void>()
const EMPTY: Row[] = []

export function publishPaneRows(pane: PaneId, rows: Row[] | null): void {
  if (rows === null) published.delete(pane)
  else published.set(pane, rows)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The rows a pane last published; empty while it is not on screen. */
export function usePaneRows(pane: PaneId): Row[] {
  return useSyncExternalStore(subscribe, () => published.get(pane) ?? EMPTY)
}
