import type React from 'react'

/**
 * Dragging rows out of a table, without Blink's drag-and-drop.
 *
 * Three designs got here, and the two that failed are worth recording so they aren't tried
 * again.
 *
 * An HTML5 drag is the obvious choice: umakbang's own folder rows can accept it as a drop.
 * But it can only ever stay inside the window - `webContents.startDrag` is the one thing a
 * DAW or a browser can receive, and the originating window is never offered that drop back.
 * So the first design started an HTML5 drag and handed over to the OS at the window edge.
 * That crashed the app, and the minidump was unambiguous: on Windows an HTML5 drag is
 * already running `DoDragDrop` in a nested message loop on the UI thread, the `drag:start`
 * IPC is handled on that same thread inside that loop, and starting a second drag re-enters
 * Aura's drag-drop client and trips a CHECK - exception 0x80000003 in the browser process,
 * with `kRootWindowDragDropClientKey` in the dump beside our own channel name. Whether it
 * fired was a timing race, so it survived drags into a DAW and died on a browser tab. The
 * second design asked for a modifier to choose which kind of drag it was, which is only a
 * fix if you remember to hold it.
 *
 * The nested loop is Blink's, so this doesn't use Blink's drag at all. A row drag is
 * tracked with pointer events and pointer capture, which keeps delivering moves after the
 * pointer has left the window. Inside the window that drives our own drop targets; the
 * moment it crosses the edge the OS drag takes over, started from a stack that is not
 * inside anybody's message loop. Both halves work and neither knows about the other.
 *
 * Drops coming *in* from Explorer are still ordinary HTML5 drags. That is somebody else's
 * drag, and receiving one was never the problem.
 */

/** Our own drag payload, for the HTML5 drops that still arrive from outside. */
export const UMAKBANG_PATHS = 'text/umakbang-paths'

/** Marks an element as somewhere rows can be dropped. Its value is a root-relative dir. */
export const DROP_DIR_ATTRIBUTE = 'data-drop-dir'

/** Put on the element under the pointer, so highlighting costs no React renders. */
const OVER_CLASS = 'drop-over'

/** How far the pointer must move before a press is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5

interface DragSession {
  paths: string[]
  pointerId: number
  origin: HTMLElement
  startX: number
  startY: number
  /** Past the threshold: this is a drag, and the click it ends with means nothing. */
  active: boolean
  /** The OS has taken it; there is nothing further to do here. */
  handedOff: boolean
  hovered: HTMLElement | null
}

let session: DragSession | null = null
let suppressNextClick = false

/** True if the last pointer sequence was a drag, so the click that follows is not a click. */
export function consumeDragClick(): boolean {
  const was = suppressNextClick
  suppressNextClick = false
  return was
}

/** Where an in-app drop is delivered. Wired once, by the store. */
let onInternalDrop: ((paths: string[], relDir: string) => void) | null = null

export function setInternalDropHandler(handler: (paths: string[], relDir: string) => void): void {
  onInternalDrop = handler
}

/**
 * Begins tracking a possible row drag. Called from `pointerdown`; nothing happens until the
 * pointer has moved far enough to mean it, so an ordinary click is unaffected.
 */
export function beginRowDrag(event: React.PointerEvent, paths: string[]): void {
  if (event.button !== 0 || paths.length === 0) return
  endRowDrag()

  const origin = event.currentTarget as HTMLElement
  session = {
    paths,
    pointerId: event.pointerId,
    origin,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    handedOff: false,
    hovered: null
  }

  // No pointer capture yet - see `capture()` below. The window listeners are enough to
  // notice the press turning into a drag.
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', endRowDrag, true)
}

function onPointerMove(event: PointerEvent): void {
  const active = session
  if (!active || event.pointerId !== active.pointerId || active.handedOff) return

  if (!active.active) {
    const moved = Math.abs(event.clientX - active.startX) + Math.abs(event.clientY - active.startY)
    if (moved < DRAG_THRESHOLD_PX) return
    active.active = true
    document.body.style.cursor = 'grabbing'
    capture(active)
  }

  // Outside the window the drop belongs to another application, so the OS takes over.
  // Capture is dropped first: the native drag runs its own loop, and a still-captured
  // pointer would go on firing into ours.
  if (
    event.clientX <= 0 ||
    event.clientY <= 0 ||
    event.clientX >= window.innerWidth ||
    event.clientY >= window.innerHeight
  ) {
    active.handedOff = true
    suppressNextClick = true
    highlight(active, null)
    releaseCapture(active)
    const paths = active.paths
    finish()
    window.umakbang.startDrag(paths)
    return
  }

  highlight(active, dropTargetAt(event.clientX, event.clientY))
}

function onPointerUp(event: PointerEvent): void {
  const active = session
  if (!active || event.pointerId !== active.pointerId) return

  const target = active.active ? dropTargetAt(event.clientX, event.clientY) : null
  const dir = target?.getAttribute(DROP_DIR_ATTRIBUTE) ?? null
  const paths = active.paths
  suppressNextClick = active.active

  highlight(active, null)
  releaseCapture(active)
  finish()

  if (dir !== null) onInternalDrop?.(paths, dir)
}

/** The nearest drop target under a point, or null. */
function dropTargetAt(x: number, y: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y)
  return element ? (element.closest(`[${DROP_DIR_ATTRIBUTE}]`) as HTMLElement | null) : null
}

function highlight(active: DragSession, next: HTMLElement | null): void {
  if (active.hovered === next) return
  active.hovered?.classList.remove(OVER_CLASS)
  next?.classList.add(OVER_CLASS)
  active.hovered = next
}

/**
 * Takes pointer capture, but only once the press has become a drag.
 *
 * Capture is what keeps the moves coming after the pointer leaves the window, which is the
 * only way to notice that it has. Taking it at `pointerdown` - where it used to be - broke
 * every ordinary click in the table: with the row capturing, the `click` that ends the
 * press is no longer dispatched inside the row at all, so the row's own handler never ran.
 * Rows still selected, because that happens on the press, which made it look like the
 * click had worked. Nothing played on select, clicking a selected row didn't open it, and
 * a click on the rating stars did nothing at all.
 */
function capture(active: DragSession): void {
  try {
    active.origin.setPointerCapture(active.pointerId)
  } catch {
    // Nothing to capture; the window listeners still see the drag through.
  }
}

function releaseCapture(active: DragSession): void {
  try {
    if (active.origin.hasPointerCapture(active.pointerId)) {
      active.origin.releasePointerCapture(active.pointerId)
    }
  } catch {
    // Nothing to release.
  }
}

function finish(): void {
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onPointerMove, true)
  window.removeEventListener('pointerup', onPointerUp, true)
  window.removeEventListener('pointercancel', endRowDrag, true)
  session = null
}

/** Abandons whatever is in flight. */
export function endRowDrag(): void {
  if (!session) return
  highlight(session, null)
  releaseCapture(session)
  finish()
}

/** Whether a row drag is being tracked and has passed the threshold. */
export function isCarrying(): boolean {
  return session !== null && session.active
}

/* ------------------------------------------------------- drags from other apps */

/** True if an incoming HTML5 drag is one umakbang can act on. */
export function droppableDrag(transfer: DataTransfer): boolean {
  const types = Array.from(transfer.types)
  return types.includes(UMAKBANG_PATHS) || types.includes('Files')
}

/** The paths behind a drop from another application. */
export function pathsFromDrop(transfer: DataTransfer): string[] {
  const payload = transfer.getData(UMAKBANG_PATHS)
  if (payload) {
    try {
      const parsed: unknown = JSON.parse(payload)
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string')
      }
    } catch {
      // Fall through to the files below rather than dropping the drag on the floor.
    }
  }
  if (transfer.files.length > 0) {
    return Array.from(transfer.files)
      .map((file) => window.umakbang.pathForFile(file))
      .filter((path) => path.length > 0)
  }
  return []
}
