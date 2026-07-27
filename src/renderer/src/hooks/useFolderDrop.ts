import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useLibrary } from '@/state/library'
import { DROP_DIR_ATTRIBUTE, droppableDrag, endRowDrag, pathsFromDrop } from '@/lib/drag'

/**
 * Makes a folder - a table row, a breadcrumb, a sidebar node - accept files dropped on it.
 *
 * Two kinds of drop arrive here and they are handled differently. A drag from another
 * application is an ordinary HTML5 one and uses the handlers below. A drag of umakbang's
 * own rows is tracked with pointer events instead (see lib/drag.ts, and the crash that put
 * it there), and finds this element by the `data-drop-dir` attribute rather than by any
 * event of ours - which is why the attribute has to be spread onto the element even though
 * nothing in this file reads it.
 */
export interface FolderDrop {
  /** True while an HTML5 drop would land here - the caller lights the row up with it. */
  over: boolean
  /** Identifies the element to the pointer-driven drag. Spread onto the same element. */
  target: { [DROP_DIR_ATTRIBUTE]: string }
  handlers: {
    onDragEnter: (event: React.DragEvent) => void
    onDragOver: (event: React.DragEvent) => void
    onDragLeave: (event: React.DragEvent) => void
    onDrop: (event: React.DragEvent) => void
  }
}

const carriesFiles = droppableDrag

export function useFolderDrop(relDir: string): FolderDrop {
  const moveIntoFolder = useLibrary((s) => s.moveIntoFolder)
  const [over, setOver] = useState(false)
  // Rows have nested children, and each one fires enter/leave on the way past. Counting
  // means the highlight only clears when the pointer has actually left the row.
  const depth = useRef(0)

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    depth.current += 1
    setOver(true)
  }, [])

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return
    // Without preventDefault the drop never happens and the window navigates to the file.
    event.preventDefault()
    // The window-level guard that refuses stray drops would otherwise reset the cursor to
    // "no drop" on its way past.
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      depth.current = 0
      setOver(false)

      const paths = pathsFromDrop(event.dataTransfer)
      endRowDrag()
      if (paths.length === 0) return
      void moveIntoFolder(paths, relDir)
    },
    [moveIntoFolder, relDir]
  )

  return {
    over,
    target: { [DROP_DIR_ATTRIBUTE]: relDir },
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop }
  }
}
