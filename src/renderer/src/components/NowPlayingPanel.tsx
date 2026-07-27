import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { VisualizerStack, type VisualizerId } from '@/components/visualizers/Visualizers'
import { InputSourceButton } from '@/components/visualizers/InputSource'
import { useLibrary } from '@/state/library'
import { maxPanelWidth, useWindowWidth } from '@/lib/layout'
import { cn } from '@/lib/utils'

const MIN_WIDTH = 220
const DEFAULT_WIDTH = 300

/**
 * The visualizer dock on the right.
 *
 * Track details and transport live at the bottom of the sidebar instead, so this panel
 * is nothing but plots and the file list keeps its full width.
 */
export function NowPlayingPanel(): React.JSX.Element {

  const width = useLibrary((s) => s.settings.panelWidth)
  const visualizers = useLibrary((s) => s.settings.visualizers)
  const sidebarWidth = useLibrary((s) => s.settings.sidebarWidth)
  const patchSettings = useLibrary((s) => s.patchSettings)

  // Everything the sidebar and the table need is what this panel can't have.
  const maxWidth = maxPanelWidth(MIN_WIDTH, useWindowWidth(), sidebarWidth)

  const widthRef = useRef(width)
  widthRef.current = width
  const maxRef = useRef(maxWidth)
  maxRef.current = maxWidth

  // Width follows the pointer through local state; settings are written once on release.
  // Persisting per frame meant an IPC round-trip every mouse-move.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragWidthRef = useRef<number | null>(null)
  dragWidthRef.current = dragWidth
  // Clamped on the way out too: a width that was legal when it was dragged has to give
  // way when the window shrinks under it.
  const effectiveWidth = Math.min(dragWidth ?? width, maxWidth)

  const beginResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX
      const startWidth = Math.min(widthRef.current, maxRef.current)

      const onMove = (move: PointerEvent): void => {
        // Dragging left widens, since the panel is anchored to the right edge.
        const next = Math.max(
          MIN_WIDTH,
          Math.min(maxRef.current, Math.round(startWidth - (move.clientX - startX)))
        )
        setDragWidth(next)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        const settled = dragWidthRef.current
        setDragWidth(null)
        if (settled !== null && settled !== widthRef.current) {
          patchSettings({ panelWidth: settled })
        }
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [patchSettings]
  )

  const resizing = dragWidth !== null

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l bg-card/30"
      style={{ width: effectiveWidth }}
      aria-label="Visualizers"
    >
      {/* Straddles the border with a 11px hit area - a hairline is impossible to grab.
          Double-click restores the default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={effectiveWidth}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onPointerDown={beginResize}
        onDoubleClick={() => patchSettings({ panelWidth: DEFAULT_WIDTH })}
        onKeyDown={(event) => {
          // Keyboard resizing, since a drag target is unusable without a pointer.
          const step = event.shiftKey ? 40 : 10
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            patchSettings({ panelWidth: Math.min(maxWidth, width + step) })
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            patchSettings({ panelWidth: Math.max(MIN_WIDTH, width - step) })
          }
        }}
        className={cn(
          'group absolute -left-[5px] top-0 z-30 flex h-full w-[11px] cursor-col-resize items-center justify-center',
          'focus-visible:outline-none'
        )}
      >
        <span
          className={cn(
            'h-full w-[3px] rounded-full transition-colors',
            resizing ? 'bg-primary' : 'bg-transparent group-hover:bg-primary/50'
          )}
        />
        {/* Always-visible grip so the handle is discoverable without hunting for it. */}
        <span
          className={cn(
            'pointer-events-none absolute top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full transition-colors',
            resizing ? 'bg-primary' : 'bg-border group-hover:bg-primary'
          )}
        />
      </div>

      <header className="flex h-[30px] shrink-0 items-center justify-between border-b px-2.5">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Visualizers
        </span>
        <div className="flex items-center gap-0.5">
          <InputSourceButton />
          <Hint label="Hide panel" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => patchSettings({ panelOpen: false })}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </Hint>
        </div>
      </header>

      {/* Needs a bounded height to divide between its panels. */}
      {/* Docked, the panel is a tall column, so the panels always stack. Side by side
          is what the full-window visualizer mode is for. */}
      <VisualizerStack
        className="min-h-0 flex-1"
        orientation="vertical"
        enabled={visualizers as VisualizerId[]}
        onChange={(ids) => patchSettings({ visualizers: ids })}
      />
    </aside>
  )
}
