import type React from 'react'
import { useLayoutEffect, useRef, useState, useSyncExternalStore, useEffect } from 'react'
import { Eye, EyeOff, Pause, Play, Shuffle, SkipBack, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { SplitShuffleDialog, type SplitShuffleSettings } from './SplitShuffleDialog'
import { frameSize } from '@/lib/video/compositor'
import { stageState, subscribeStage, type VideoStage } from '@/lib/video/stage'
import { useVideos } from '@/state/videos'
import { formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Layer, Rect, VideoClip, VideoLayer } from '@shared/video'

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
type DragKind = 'move' | 'crop' | ResizeHandle

interface DragState {
  kind: DragKind
  layerIds: string[]
  startX: number
  startY: number
  /** Bounds of the whole selection when the gesture began. */
  origin: Rect
  /** Individual frames transformed inside the selection bounds. */
  origins: Record<string, Rect>
}

interface Guides {
  x: number[]
  y: number[]
}

const HANDLE_CLASS: Record<ResizeHandle, string> = {
  n: '-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize',
  ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
  e: '-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize',
  se: '-bottom-1.5 -right-1.5 cursor-nwse-resize',
  s: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize',
  sw: '-bottom-1.5 -left-1.5 cursor-nesw-resize',
  w: '-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize',
  nw: '-left-1.5 -top-1.5 cursor-nwse-resize'
}

const HANDLES = Object.keys(HANDLE_CLASS) as ResizeHandle[]
const SNAP_DISTANCE = 0.008
const MIN_SIZE = 0.025

function nearestSnap(points: number[], candidates: number[]): { delta: number; guide?: number } {
  let best = SNAP_DISTANCE
  let delta = 0
  let guide: number | undefined
  for (const point of points) {
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - point)
      if (distance <= best) {
        best = distance
        delta = candidate - point
        guide = candidate
      }
    }
  }
  return { delta, guide }
}

export function Stage({
  stage,
  onRequestRemove
}: {
  stage: VideoStage
  onRequestRemove: (id: string) => void
}): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const selectedIds = useVideos((s) => s.selectedIds)
  const patchLayer = useVideos((s) => s.patchLayer)
  const setLayers = useVideos((s) => s.setLayers)
  const select = useVideos((s) => s.select)
  const toggleSelection = useVideos((s) => s.toggleSelection)
  const live = useSyncExternalStore(subscribeStage, stageState)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [scale, setScale] = useState(1)
  const [cropping, setCropping] = useState(false)
  const [guides, setGuides] = useState<Guides>({ x: [], y: [] })

  useEffect(() => {
    stage.attach(canvasRef.current)
    return () => stage.attach(null)
  }, [stage])

  const size = project ? frameSize(project) : { width: 1080, height: 1920 }

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const measure = (): void => {
      const box = wrap.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return
      setScale(Math.min((box.width - 24) / size.width, (box.height - 24) / size.height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [size.width, size.height])

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editing = Boolean(target?.closest('input, textarea, select, button, [contenteditable="true"]'))
      if (!editing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedIds.length > 0 && project) {
        event.preventDefault()
        const pixels = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -pixels / size.width : event.key === 'ArrowRight' ? pixels / size.width : 0
        const dy = event.key === 'ArrowUp' ? -pixels / size.height : event.key === 'ArrowDown' ? pixels / size.height : 0
        setLayers(project.layers.map((entry) =>
          selectedIds.includes(entry.id) && entry.kind !== 'audio'
            ? ({ ...entry, frame: { ...entry.frame, x: entry.frame.x + dx, y: entry.frame.y + dy } } as Layer)
            : entry
        ))
        return
      }
      if (event.key === 'Alt') setCropping(true)
      if (event.code === 'Space' && !event.repeat) {
        if (editing) return
        event.preventDefault()
        stage.togglePlayback()
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setCropping(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [project, selectedIds, setLayers, size.height, size.width, stage])

  const selectedDrawable = (project?.layers ?? []).filter(
    (entry) => selectedIds.includes(entry.id) && entry.kind !== 'audio' && !entry.hidden
  )
  const layer = selectedDrawable.length === 1 ? selectedDrawable[0] : null
  const canCrop = layer?.kind === 'video' || layer?.kind === 'image'

  function boundsOf(entries: Layer[]): Rect | null {
    if (entries.length === 0) return null
    const left = Math.min(...entries.map((entry) => entry.frame.x))
    const top = Math.min(...entries.map((entry) => entry.frame.y))
    const right = Math.max(...entries.map((entry) => entry.frame.x + entry.frame.w))
    const bottom = Math.max(...entries.map((entry) => entry.frame.y + entry.frame.h))
    return { x: left, y: top, w: right - left, h: bottom - top }
  }

  const selectionBounds = boundsOf(selectedDrawable)

  function hit(fx: number, fy: number): Layer | null {
    if (!project) return null
    for (let at = project.layers.length - 1; at >= 0; at -= 1) {
      const entry = project.layers[at]
      if (entry.hidden || entry.kind === 'audio') continue
      const { x, y, w, h } = entry.frame
      if (fx >= x && fx <= x + w && fy >= y && fy <= y + h) return entry
    }
    return null
  }

  function snapCandidates(axis: 'x' | 'y', layerIds: string[]): number[] {
    const candidates = [0, 0.5, 1]
    for (const entry of project?.layers ?? []) {
      if (layerIds.includes(entry.id) || entry.hidden || entry.kind === 'audio') continue
      if (axis === 'x') candidates.push(entry.frame.x, entry.frame.x + entry.frame.w / 2, entry.frame.x + entry.frame.w)
      else candidates.push(entry.frame.y, entry.frame.y + entry.frame.h / 2, entry.frame.y + entry.frame.h)
    }
    return candidates
  }

  function applyFrames(frames: Record<string, Rect>): void {
    if (!project) return
    setLayers(project.layers.map((entry) =>
      frames[entry.id] ? ({ ...entry, frame: frames[entry.id] } as Layer) : entry
    ))
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (!project) return
    const box = event.currentTarget.getBoundingClientRect()
    const fx = (event.clientX - box.left) / box.width
    const fy = (event.clientY - box.top) / box.height
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-resize]')?.dataset.resize as ResizeHandle | undefined

    if (handle && selectionBounds) {
      const origins = Object.fromEntries(selectedDrawable.map((entry) => [entry.id, { ...entry.frame }]))
      dragRef.current = {
        kind: handle,
        layerIds: selectedDrawable.map((entry) => entry.id),
        startX: fx,
        startY: fy,
        origin: { ...selectionBounds },
        origins
      }
    } else {
      const target = hit(fx, fy)
      if (!target) {
        select(null)
        return
      }
      if (event.ctrlKey || event.metaKey) {
        toggleSelection(target.id)
        return
      }
      const wasSelected = selectedIds.includes(target.id)
      if (!wasSelected) select(target.id)
      const active = wasSelected ? selectedDrawable : [target]
      const crop = cropping && active.length === 1 && (target.kind === 'video' || target.kind === 'image')
      const bounds = boundsOf(active)
      if (!bounds) return
      dragRef.current = {
        kind: crop ? 'crop' : 'move',
        layerIds: active.map((entry) => entry.id),
        startX: fx,
        startY: fy,
        origin: crop ? { ...(target as VideoLayer).crop } : bounds,
        origins: Object.fromEntries(active.map((entry) => [entry.id, { ...entry.frame }]))
      }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    const frame = frameRef.current
    if (!drag || !frame) return
    const box = frame.getBoundingClientRect()
    const fx = (event.clientX - box.left) / box.width
    const fy = (event.clientY - box.top) / box.height
    const dx = fx - drag.startX
    const dy = fy - drag.startY

    if (drag.kind === 'move') {
      const rawX = Math.max(-drag.origin.w + 0.05, Math.min(0.95, drag.origin.x + dx))
      const rawY = Math.max(-drag.origin.h + 0.05, Math.min(0.95, drag.origin.y + dy))
      const sx = nearestSnap([rawX, rawX + drag.origin.w / 2, rawX + drag.origin.w], snapCandidates('x', drag.layerIds))
      const sy = nearestSnap([rawY, rawY + drag.origin.h / 2, rawY + drag.origin.h], snapCandidates('y', drag.layerIds))
      const moveX = rawX + sx.delta - drag.origin.x
      const moveY = rawY + sy.delta - drag.origin.y
      const frames = Object.fromEntries(drag.layerIds.map((id) => {
        const origin = drag.origins[id]
        return [id, { ...origin, x: origin.x + moveX, y: origin.y + moveY }]
      }))
      applyFrames(frames)
      setGuides({ x: sx.guide === undefined ? [] : [sx.guide], y: sy.guide === undefined ? [] : [sy.guide] })
      return
    }

    if (drag.kind === 'crop') {
      const width = drag.origin.w
      const height = drag.origin.h
      patchLayer(drag.layerIds[0], {
        crop: {
          ...drag.origin,
          x: Math.max(0, Math.min(1 - width, drag.origin.x - dx * width)),
          y: Math.max(0, Math.min(1 - height, drag.origin.y - dy * height))
        }
      } as Partial<Layer>)
      return
    }

    const west = drag.kind.includes('w')
    const east = drag.kind.includes('e')
    const north = drag.kind.includes('n')
    const south = drag.kind.includes('s')
    let left = west ? drag.origin.x + dx : drag.origin.x
    let right = east ? drag.origin.x + drag.origin.w + dx : drag.origin.x + drag.origin.w
    let top = north ? drag.origin.y + dy : drag.origin.y
    let bottom = south ? drag.origin.y + drag.origin.h + dy : drag.origin.y + drag.origin.h
    const sx = west || east ? nearestSnap([west ? left : right], snapCandidates('x', drag.layerIds)) : { delta: 0, guide: undefined }
    const sy = north || south ? nearestSnap([north ? top : bottom], snapCandidates('y', drag.layerIds)) : { delta: 0, guide: undefined }
    if (west) left = Math.min(right - MIN_SIZE, left + sx.delta)
    if (east) right = Math.max(left + MIN_SIZE, right + sx.delta)
    if (north) top = Math.min(bottom - MIN_SIZE, top + sy.delta)
    if (south) bottom = Math.max(top + MIN_SIZE, bottom + sy.delta)
    const nextW = Math.max(MIN_SIZE, right - left)
    const nextH = Math.max(MIN_SIZE, bottom - top)
    const scaleX = nextW / Math.max(MIN_SIZE, drag.origin.w)
    const scaleY = nextH / Math.max(MIN_SIZE, drag.origin.h)
    const frames = Object.fromEntries(drag.layerIds.map((id) => {
      const origin = drag.origins[id]
      return [id, {
        x: left + (origin.x - drag.origin.x) * scaleX,
        y: top + (origin.y - drag.origin.y) * scaleY,
        w: Math.max(MIN_SIZE, origin.w * scaleX),
        h: Math.max(MIN_SIZE, origin.h * scaleY)
      }]
    }))
    applyFrames(frames)
    setGuides({ x: sx.guide === undefined ? [] : [sx.guide], y: sy.guide === undefined ? [] : [sy.guide] })
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    dragRef.current = null
    setGuides({ x: [], y: [] })
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const duration = live.duration || 1

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={wrapRef}
        onPointerDown={(event) => { if (event.target === event.currentTarget) select(null) }}
        className="relative flex min-h-[180px] flex-1 items-center justify-center overflow-hidden p-3"
      >
        {/* Named to match the Layers strip below it, in the same 9px uppercase the timeline
            header uses. Absolute and non-interactive, so it labels the area without taking a
            row of height from the picture or a click from the canvas. */}
        <span className="pointer-events-none absolute left-3 top-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          Frame
        </span>
        <div
          ref={frameRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative"
          style={{ width: size.width * scale, height: size.height * scale, touchAction: 'none' }}
        >
          <canvas
            ref={canvasRef}
            width={size.width}
            height={size.height}
            className={cn('h-full w-full border shadow-lg', cropping && canCrop ? 'cursor-move' : 'cursor-grab')}
          />

          {guides.x.map((value) => (
            <div key={`x-${value}`} className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: `${value * 100}%` }} />
          ))}
          {guides.y.map((value) => (
            <div key={`y-${value}`} className="pointer-events-none absolute inset-x-0 h-px bg-primary" style={{ top: `${value * 100}%` }} />
          ))}

          {selectionBounds && !live.exporting && (
            <div
              className="pointer-events-none absolute border border-primary"
              style={{
                left: `${selectionBounds.x * 100}%`,
                top: `${selectionBounds.y * 100}%`,
                width: `${selectionBounds.w * 100}%`,
                height: `${selectionBounds.h * 100}%`
              }}
            >
              {HANDLES.map((handle) => (
                <span
                  key={handle}
                  data-resize={handle}
                  className={cn('pointer-events-auto absolute h-3 w-3 border border-background bg-primary', HANDLE_CLASS[handle])}
                />
              ))}
            </div>
          )}

          {live.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-[12px] text-muted-foreground">
              {live.loading}…
            </div>
          )}
        </div>
      </div>

      <Timeline
        stage={stage}
        duration={duration}
        live={live}
        onRequestRemove={onRequestRemove}
      />


    </div>
  )
}

interface TimelineClip {
  id: string
  from: number
  to: number
  offset?: number
}

function shuffledClips(clip: VideoClip, settings: SplitShuffleSettings): VideoClip[] {
  const count = settings.cuts + 1
  const total = clip.to - clip.from
  // A floor keeps high cut counts from creating zero-length decoder flashes. The remainder
  // is distributed by weights, so the generated pieces still add up to the exact clip.
  const minimum = Math.min(0.04, total / (count * 1.5))
  const distributable = Math.max(0, total - minimum * count)
  const weights = Array.from({ length: count }, () =>
    Math.max(0.1, 1 + (Math.random() * 2 - 1) * settings.unevenness * 0.78)
  )
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  const sourcePieces: Array<{ offset: number; length: number }> = []
  let sourceOffset = clip.offset
  for (let index = 0; index < count; index += 1) {
    const length = minimum + distributable * (weights[index] / weightTotal)
    sourcePieces.push({ offset: sourceOffset, length })
    sourceOffset += length
  }

  const order = sourcePieces.map((_, index) => index)
  const firstMovable = settings.keepFirst ? 1 : 0
  for (let index = order.length - 1; index > firstMovable; index -= 1) {
    if (Math.random() > settings.shuffle) continue
    const other = firstMovable + Math.floor(Math.random() * (index - firstMovable + 1))
    ;[order[index], order[other]] = [order[other], order[index]]
  }

  let timeline = clip.from
  return order.map((sourceIndex, index) => {
    const piece = sourcePieces[sourceIndex]
    const from = timeline
    // Pin the final edge to the original edge, removing floating-point accumulation.
    const to = index === order.length - 1 ? clip.to : from + piece.length
    timeline = to
    return {
      id: 'clip-' + crypto.randomUUID(),
      from,
      to,
      offset: piece.offset
    }
  })
}

function Timeline({
  stage,
  duration,
  live,
  onRequestRemove
}: {
  stage: VideoStage
  duration: number
  live: ReturnType<typeof stageState>
  onRequestRemove: (id: string) => void
}): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const selectedIds = useVideos((s) => s.selectedIds)
  const select = useVideos((s) => s.select)
  const setSelection = useVideos((s) => s.setSelection)
  const toggleSelection = useVideos((s) => s.toggleSelection)
  const inspect = useVideos((s) => s.inspect)
  const patchLayer = useVideos((s) => s.patchLayer)
  const [timelineHeight, setTimelineHeight] = useState(180)
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({})
  const [shuffleTarget, setShuffleTarget] = useState<{ layerId: string; clipId: string } | null>(null)
  const anchorRef = useRef(-1)
  const rows = project ? [...project.layers].reverse() : []

  function beginTimelineResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = timelineHeight
    const move = (pointer: PointerEvent): void => {
      const max = Math.max(180, window.innerHeight * 0.68)
      setTimelineHeight(Math.max(116, Math.min(max, startHeight + startY - pointer.clientY)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function selectRow(event: React.MouseEvent | React.PointerEvent, index: number, id: string): void {
    if (event.shiftKey) {
      const anchor = anchorRef.current < 0 ? index : anchorRef.current
      const lo = Math.min(anchor, index)
      const hi = Math.max(anchor, index)
      setSelection(rows.slice(lo, hi + 1).map((entry) => entry.id), id)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      toggleSelection(id)
      anchorRef.current = index
      return
    }
    select(id)
    anchorRef.current = index
  }

  function beginRowResize(id: string, event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    const startY = event.clientY
    const startHeight = rowHeights[id] ?? 28
    const move = (pointer: PointerEvent): void => {
      setRowHeights((current) => ({ ...current, [id]: Math.max(24, Math.min(120, startHeight + pointer.clientY - startY)) }))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function clipEnd(layer: Layer): number {
    if (layer.kind === 'video' && layer.clips?.length) {
      return Math.max(...layer.clips.map((clip) => clip.to))
    }
    if (layer.to !== undefined) return layer.to
    if (layer.kind === 'audio' || layer.kind === 'video') {
      const available = Math.max(0.05, (layer.sourceDuration ?? 0) - layer.offset)
      if (layer.sourceDuration) return (layer.from ?? 0) + available
    }
    return duration
  }

  function timelineClips(layer: Layer): TimelineClip[] {
    if (layer.kind === 'video' && layer.clips?.length) return layer.clips
    return [{
      id: layer.id,
      from: layer.from ?? 0,
      to: clipEnd(layer),
      offset: layer.kind === 'video' || layer.kind === 'audio' ? layer.offset : undefined
    }]
  }

  function snapPoints(movingClipId: string): number[] {
    const points = [0, duration, live.time, ...ticks]
    for (const other of rows) {
      for (const clip of timelineClips(other)) {
        if (clip.id === movingClipId) continue
        points.push(clip.from, clip.to)
      }
    }
    return points
  }

  function patchTimelineClip(layer: Layer, clip: TimelineClip, patch: Partial<VideoClip>): void {
    if (layer.kind === 'video' && layer.clips?.length) {
      const clips = layer.clips.map((entry) => entry.id === clip.id ? { ...entry, ...patch } : entry)
      patchLayer(layer.id, {
        clips,
        from: Math.min(...clips.map((entry) => entry.from)),
        to: Math.max(...clips.map((entry) => entry.to))
      } as Partial<VideoLayer>)
      return
    }
    patchLayer(layer.id, patch as Partial<Layer>)
  }

  function beginClipDrag(
    layer: Layer,
    clip: TimelineClip,
    mode: 'move' | 'start' | 'end',
    event: React.PointerEvent<HTMLElement>
  ): void {
    event.stopPropagation()
    // Secondary click belongs to the clip tool menu, never to the drag gesture.
    if (event.button !== 0) return
    const index = rows.findIndex((entry) => entry.id === layer.id)
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      selectRow(event, index, layer.id)
      return
    }
    if (!selectedIds.includes(layer.id)) selectRow(event, index, layer.id)
    const track = event.currentTarget.closest<HTMLElement>('[data-track]')
    if (!track) return
    const width = track.getBoundingClientRect().width
    const startX = event.clientX
    const from = clip.from
    const to = clip.to
    const sourceOffset = clip.offset ?? 0
    const threshold = (duration / Math.max(1, width)) * 9
    const points = snapPoints(clip.id)
    const snap = (value: number): number => {
      let best = value
      let distance = threshold
      for (const point of points) {
        const nextDistance = Math.abs(point - value)
        if (nextDistance <= distance) {
          best = point
          distance = nextDistance
        }
      }
      return best
    }
    const move = (pointer: PointerEvent): void => {
      const delta = ((pointer.clientX - startX) / Math.max(1, width)) * duration
      if (mode === 'start') {
        const raw = Math.max(0, Math.min(to - 0.05, from + delta))
        const nextFrom = Math.max(0, Math.min(to - 0.05, snap(raw)))
        patchTimelineClip(layer, clip, {
          from: nextFrom,
          ...((layer.kind === 'video' || layer.kind === 'audio')
            ? { offset: Math.max(0, sourceOffset + nextFrom - from) }
            : {})
        })
      } else if (mode === 'end') {
        const sourceEnd =
          layer.kind === 'audio' || layer.kind === 'video'
            ? from + Math.max(0.05, (layer.sourceDuration ?? duration) - sourceOffset)
            : duration
        const raw = Math.min(sourceEnd, Math.max(from + 0.05, to + delta))
        patchTimelineClip(layer, clip, { to: Math.min(sourceEnd, Math.max(from + 0.05, snap(raw))) })
      } else {
        const length = to - from
        let nextFrom = Math.max(0, Math.min(duration - length, from + delta))
        const snappedStart = snap(nextFrom)
        const snappedEnd = snap(nextFrom + length) - length
        nextFrom = Math.abs(snappedStart - nextFrom) <= Math.abs(snappedEnd - nextFrom)
          ? snappedStart
          : snappedEnd
        nextFrom = Math.max(0, Math.min(duration - length, nextFrom))
        patchTimelineClip(layer, clip, { from: nextFrom, to: nextFrom + length })
      }
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function applySplitShuffle(settings: SplitShuffleSettings): void {
    if (!project || !shuffleTarget) return
    const layer = project.layers.find(
      (entry): entry is VideoLayer => entry.id === shuffleTarget.layerId && entry.kind === 'video'
    )
    if (!layer || layer.source === 'camera') return
    const existing = layer.clips?.length
      ? layer.clips
      : [{
          id: layer.id,
          from: layer.from ?? 0,
          to: clipEnd(layer),
          offset: layer.offset
        }]
    const target = existing.find((clip) => clip.id === shuffleTarget.clipId)
    if (!target) return
    const generated = shuffledClips(target, settings)
    const clips = existing.flatMap((clip) => clip.id === target.id ? generated : [clip])
    patchLayer(layer.id, {
      clips,
      from: Math.min(...clips.map((clip) => clip.from)),
      to: Math.max(...clips.map((clip) => clip.to)),
      offset: clips[0]?.offset ?? layer.offset
    } as Partial<VideoLayer>)
    setShuffleTarget(null)
  }

  function beginTimelineScrub(event: React.PointerEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).closest('[data-clip], [data-row-resize]')) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    const seek = (clientX: number): void => {
      const ratio = Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width)))
      stage.seek(ratio * duration)
    }
    stage.beginScrub()
    seek(event.clientX)
    const move = (pointer: PointerEvent): void => seek(pointer.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      stage.endScrub()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const ticks = Array.from({ length: 6 }, (_, index) => (duration * index) / 5)
  const targetLayer = shuffleTarget
    ? project?.layers.find((layer) => layer.id === shuffleTarget.layerId) ?? null
    : null
  const targetClip = targetLayer && shuffleTarget
    ? timelineClips(targetLayer).find((clip) => clip.id === shuffleTarget.clipId) ?? null
    : null

  return (
    <>
    <div
      className="relative flex shrink-0 flex-col border-t bg-card/25"
      style={{ height: timelineHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        onPointerDown={beginTimelineResize}
        className="absolute inset-x-0 -top-1 z-20 h-2 cursor-ns-resize"
      >
        <span className="absolute inset-x-0 top-1 h-px bg-border transition-colors hover:bg-primary" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back to start" onClick={() => stage.seek(0)}>
          <SkipBack className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={live.playing ? 'Pause' : 'Play'} onClick={() => stage.togglePlayback()}>
          {live.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <span className="w-10 text-right font-mono text-[11px] text-muted-foreground">{formatTime(live.time)}</span>
        <span className="min-w-0 flex-1" />
        <span className="w-10 font-mono text-[11px] text-muted-foreground">{formatTime(duration)}</span>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="flex h-5 border-b text-[9px] text-muted-foreground">
          {/* "Layers" rather than "Timeline": the column underneath is one row per layer,
              and it is the same set the Layers panel lists. Naming the two halves of the
              editor after what is in them - Frame above, Layers below - says which one an
              edit is going to land in. */}
          <div className="w-[116px] shrink-0 border-r px-2 py-0.5 font-semibold uppercase tracking-wide">Layers</div>
          <div className="relative min-w-0 flex-1 cursor-ew-resize" onPointerDown={beginTimelineScrub}>
            {ticks.map((tick) => (
              <span key={tick} className="absolute top-0 -translate-x-1/2 font-mono" style={{ left: `${(tick / duration) * 100}%` }}>
                {formatTime(tick)}
              </span>
            ))}
          </div>
        </div>

        {rows.map((entry, index) => {
          const selected = selectedIds.includes(entry.id)
          return (
            <div
              key={entry.id}
              className={cn('relative flex border-b', selected && 'bg-accent/40')}
              style={{ height: rowHeights[entry.id] ?? 28 }}
            >
              <div className="flex w-[116px] shrink-0 items-center gap-1 border-r px-1.5">
                <button type="button" aria-label={entry.hidden ? 'Show layer' : 'Hide layer'} onClick={() => patchLayer(entry.id, { hidden: !entry.hidden } as Partial<Layer>)} className="text-muted-foreground hover:text-foreground">
                  {entry.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={(event) => selectRow(event, index, entry.id)}
                  onDoubleClick={() => inspect(entry.id)}
                  className="min-w-0 flex-1 truncate text-left text-[10.5px]"
                >
                  {entry.name}
                </button>
                <button type="button" aria-label="Remove layer" onClick={() => onRequestRemove(entry.id)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div data-track className="relative min-w-0 flex-1 bg-muted/20" onPointerDown={beginTimelineScrub}>
                {timelineClips(entry).map((clip) => (
                  <ContextMenu key={clip.id}>
                    <ContextMenuTrigger asChild>
                      <div
                        data-clip
                        onPointerDown={(event) => beginClipDrag(entry, clip, 'move', event)}
                        onContextMenu={(event) => {
                          event.stopPropagation()
                          select(entry.id)
                        }}
                        onDoubleClick={() => inspect(entry.id)}
                        className={cn(
                          'absolute inset-y-1 cursor-grab border bg-primary/20',
                          selected ? 'border-primary' : 'border-primary/45'
                        )}
                        style={{
                          left: ((clip.from / duration) * 100) + '%',
                          width: (((clip.to - clip.from) / duration) * 100) + '%'
                        }}
                      >
                        <span
                          data-clip
                          onPointerDown={(event) => beginClipDrag(entry, clip, 'start', event)}
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize border-r border-primary bg-primary/35"
                        />
                        <span
                          data-clip
                          onPointerDown={(event) => beginClipDrag(entry, clip, 'end', event)}
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize border-l border-primary bg-primary/35"
                        />
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuLabel>Tools &amp; macros</ContextMenuLabel>
                      <ContextMenuItem
                        disabled={
                          entry.kind !== 'video' ||
                          entry.source === 'camera' ||
                          clip.to - clip.from < 0.1
                        }
                        onSelect={() => setShuffleTarget({ layerId: entry.id, clipId: clip.id })}
                      >
                        <Shuffle className="h-3.5 w-3.5" /> Split &amp; shuffle…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
                <Playhead time={live.time} duration={duration} />
              </div>
              <div
                data-row-resize
                role="separator"
                aria-orientation="horizontal"
                aria-label={'Resize ' + entry.name + ' row'}
                onPointerDown={(event) => beginRowResize(entry.id, event)}
                className="absolute inset-x-0 -bottom-1 z-20 h-2 cursor-ns-resize"
              />
            </div>
          )
        })}
        {rows.length === 0 && (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">Add audio or video to begin.</p>
        )}
      </div>
    </div>
    {targetClip && (
      <SplitShuffleDialog
        duration={targetClip.to - targetClip.from}
        onApply={applySplitShuffle}
        onClose={() => setShuffleTarget(null)}
      />
    )}
    </>
  )
}

function Playhead({ time, duration }: { time: number; duration: number }): React.JSX.Element {
  return (
    <span className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary" style={{ left: `${(time / duration) * 100}%` }} />
  )
}
