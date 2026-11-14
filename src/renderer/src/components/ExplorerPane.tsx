import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PaneBar } from '@/components/Toolbar'
import { FileTable } from '@/components/FileTable'
import { NoResults } from '@/components/EmptyState'
import { useLibrary, type PaneId } from '@/state/library'
import { PaneContext, usePaneValue, useSplit } from '@/state/pane'
import { useVisibleRows } from '@/hooks/useLibraryView'
import { publishPaneRows } from '@/lib/pane-rows'
import { DROP_DIR_ATTRIBUTE, PANE_ATTRIBUTE } from '@/lib/drag'
import { baseName } from '@/lib/format'

/** How far either half may be squeezed, as a fraction of the explorer's width. */
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

/**
 * Where the divider was last left, for the rest of the session.
 *
 * A module variable rather than a setting: the split itself is not restored at launch - it
 * is something you step into for a job, the way visualizers-only is - so a remembered ratio
 * would only ever describe a split that no longer exists. It does have to survive a trip to
 * Stats and back, which unmounts the explorer, and this is all that takes.
 */
let rememberedRatio = 0.5

/**
 * The explorer: one pane, or two side by side.
 *
 * One `BrowserWindow` split down the middle, never a second window - a second renderer would
 * need its own copy of a 326,000-row index and the two would have to agree about tags and
 * selection over IPC. Both halves read the same index; only where each one stands differs.
 */
export function Explorer(): React.JSX.Element {
  const split = useSplit()
  const container = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(rememberedRatio)

  const beginResize = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const box = container.current?.getBoundingClientRect()
    if (!box) return

    // The same shape as a column resize: document listeners for the drag and nothing written
    // anywhere until the pointer comes up.
    const onMove = (move: PointerEvent): void => {
      const next = (move.clientX - box.left) / box.width
      setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)))
    }
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [])

  useEffect(() => {
    rememberedRatio = ratio
  }, [ratio])

  if (!split) return <ExplorerPane pane="main" />

  return (
    <div ref={container} className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flexBasis: `${ratio * 100}%` }}>
        <ExplorerPane pane="main" />
      </div>
      {/* Wider to the pointer than it looks: a 1px line is the right thing to draw and the
          wrong thing to have to hit. Double-click puts it back in the middle. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        onPointerDown={beginResize}
        onDoubleClick={() => setRatio(0.5)}
        className="group relative z-20 w-px shrink-0 cursor-col-resize bg-border"
      >
        <div className="absolute inset-y-0 -left-[3px] -right-[3px] transition-colors group-hover:bg-primary/40" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ExplorerPane pane="second" />
      </div>
    </div>
  )
}

function ExplorerPane({ pane }: { pane: PaneId }): React.JSX.Element {
  return (
    <PaneContext.Provider value={pane}>
      <PaneBody pane={pane} />
    </PaneContext.Provider>
  )
}

/**
 * One half of the explorer: its own strip, its own table.
 *
 * Inside the provider rather than beside it, because every hook here - `useVisibleRows`,
 * `useSort` under it, `usePaneValue` - asks the context which pane it is drawing.
 */
function PaneBody({ pane }: { pane: PaneId }): React.JSX.Element {
  const rows = useVisibleRows()
  const scanning = useLibrary((s) => s.scanning)
  const view = usePaneValue('view')
  const split = useSplit()

  // Memoised on the rows themselves: a pane re-renders on every scan progress tick, and a
  // 300k-row reduce per tick is real work for a number that only changes with the rows.
  const folderCount = useMemo(
    () => rows.reduce((total, row) => total + (row.type === 'folder' ? 1 : 0), 0),
    [rows]
  )

  // For the title bar's recalculate button, which sweeps whatever the active pane shows.
  useEffect(() => {
    publishPaneRows(pane, rows)
  }, [pane, rows])
  useEffect(() => () => publishPaneRows(pane, null), [pane])

  /**
   * Any press, key, focus or right-click inside a pane makes it the active one - in the
   * capture phase, so it has happened before the row or the button underneath reads the
   * store. The store's selection and view are the active pane's (see `parked`), so a click
   * on a row in the other half has to swap the halves first or it would select into the
   * wrong one. Capturing at the pane rather than wiring each control means there is no
   * control in a pane that can act before the swap, including ones added later.
   */
  const activate = useCallback(() => useLibrary.getState().activatePane(pane), [pane])

  // The whole pane is a drop target for the folder it is standing in, while the explorer is
  // split - see `PANE_ATTRIBUTE`. Not without a split: with one pane the only folder it could
  // offer is the one the files came from. Not at the virtual root or in a saved view either,
  // since neither is a folder on disk.
  const dropDir = split && view.mode === 'folder' && view.dir !== '' ? view.dir : null

  return (
    <div
      {...{ [PANE_ATTRIBUTE]: pane }}
      {...(dropDir !== null
        ? { [DROP_DIR_ATTRIBUTE]: dropDir, 'data-drop-label': `Move to ${baseName(dropDir)}` }
        : {})}
      onPointerDownCapture={activate}
      onKeyDownCapture={activate}
      onFocusCapture={activate}
      onContextMenuCapture={activate}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <PaneBar folderCount={folderCount} fileCount={rows.length - folderCount} />
      {/* The table renders even with nothing in it: an empty folder is still somewhere you
          paste into and make folders in. */}
      <FileTable rows={rows} empty={<NoResults scanning={scanning} />} />
    </div>
  )
}
