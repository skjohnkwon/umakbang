import { createContext, useContext } from 'react'
import { useLibrary, type PaneId, type PaneState } from '@/state/library'

/**
 * Which explorer pane a component is drawing.
 *
 * A context rather than a prop: `FileTable` and the hooks under it read where they are
 * standing from a dozen places, and `useVisibleRows` and `useSort` have callers other than
 * the table. Null - outside any pane - means "whichever pane is active", which is exactly
 * what the store's own fields hold, so a component that never heard of panes keeps working.
 */
export const PaneContext = createContext<PaneId | null>(null)

export function usePaneId(): PaneId | null {
  return useContext(PaneContext)
}

/**
 * One of the per-pane fields, for the pane this component is in.
 *
 * The active pane's values are the store's own fields and the other pane's are parked (see
 * `parked` in state/library.ts), so this reads one or the other. It returns the stored
 * object itself, never a fresh one, so a pane that did not change does not re-render.
 */
export function usePaneValue<K extends keyof PaneState>(key: K): PaneState[K] {
  const pane = useContext(PaneContext)
  return useLibrary((s) =>
    pane === null || pane === s.activePane || !s.parked ? s[key] : s.parked[key]
  )
}

/** True when this pane is the one the keyboard and the store's actions belong to. */
export function useIsActivePane(): boolean {
  const pane = useContext(PaneContext)
  return useLibrary((s) => pane === null || pane === s.activePane || !s.parked)
}

/** True while the explorer is split in two. */
export function useSplit(): boolean {
  return useLibrary((s) => s.parked !== null)
}
