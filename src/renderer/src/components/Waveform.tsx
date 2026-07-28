import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Track } from '@shared/types'
import { enforceRegion, getAudioElement, usePlayer } from '@/state/player'
import {
  peakBrightness,
  peakCount,
  peakLoudness,
  peakStride,
  peekPeaks,
  requestPeaks,
  subscribePeaks
} from '@/lib/peaks'
import { usePalette } from '@/components/visualizers/palette'
import { useLibrary } from '@/state/library'
import type { Settings } from '@shared/types'
import { formatDurationPrecise } from '@/lib/format'
import { cn } from '@/lib/utils'

/** How close to a region edge, in pixels, counts as taking hold of it. */
const HANDLE_HIT = 7

/** A drag under three pixels is a click, and a click clears the region. */
const MIN_DRAG = 3

/** What a pointer is currently doing to the waveform. */
type Drag = { kind: 'seek' } | { kind: 'region'; anchor: number }

/** Pre-rendered waveform in both tints, so a frame is two blits instead of 1024 fills. */
interface Shape {
  played: HTMLCanvasElement
  rest: HTMLCanvasElement
  ratio: number
}

function renderShape(
  peaks: Uint8Array,
  width: number,
  height: number,
  ratio: number,
  playedColor: string,
  restColor: string,
  tint: Settings['waveformTint'],
  wave: readonly string[]
): Shape {
  const stride = peakStride(peaks)
  const buckets = peakCount(peaks)
  const ramp = tint === 'accent' ? null : wave

  const build = (color: string, alpha: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(width * ratio))
    canvas.height = Math.max(1, Math.floor(height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return canvas
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.fillStyle = color
    context.globalAlpha = alpha

    const mid = height / 2
    // The colour is chosen per column and the shape is rendered once, so this costs
    // nothing per frame - a playing waveform is still two blits.
    let current = color
    for (let x = 0; x < width; x++) {
      const bucket = Math.min(buckets - 1, Math.floor((x / width) * buckets))
      const min = peaks[bucket * stride] / 127.5 - 1
      const max = peaks[bucket * stride + 1] / 127.5 - 1
      if (ramp) {
        // Where the energy sits, or how loud it is for peaks cached before brightness
        // was recorded. Both read as "this part is different from that part".
        const brightness = peakBrightness(peaks, bucket)
        const t = brightness ?? peakLoudness(peaks, bucket)
        const next = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]
        if (next !== current) {
          context.fillStyle = next
          current = next
        }
      }
      const top = mid - max * mid
      const bottom = mid - min * mid
      // Always paint at least a hairline so silence stays visible.
      context.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
    return canvas
  }

  return { played: build(playedColor, 1), rest: build(restColor, 0.45), ratio }
}

/**
 * The large, seekable waveform for the track being played. Peak data comes from the
 * shared cache, so a file the row waveforms already decoded is instant here.
 */
export function Waveform({
  track,
  className,
  style,
  selectable = false
}: {
  track: Track | null
  className?: string
  /** For a caller that sizes the canvas itself, such as the resizable transport strip. */
  style?: React.CSSProperties
  /**
   * Turn a plain drag into painting a loop region rather than scrubbing.
   *
   * A mode rather than a modifier because the two want the same gesture: dragging is how
   * you scrub, and it is also how anybody would expect to select. Alt+drag selects whatever
   * this says, since it costs nothing and is the first thing a DAW user tries.
   */
  selectable?: boolean
}): React.JSX.Element {
  const tint = useLibrary((s) => s.settings.waveformTint)
  const wave = usePalette().wave
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const peaksRef = useRef<Uint8Array | null>(null)
  const shapeRef = useRef<Shape | null>(null)
  const paintRef = useRef<() => void>(() => {})

  const region = usePlayer((s) => s.region)
  const setRegion = usePlayer((s) => s.setRegion)
  /**
   * The committed region and the one being dragged, both read from inside the paint
   * closure. Refs rather than props into it because a region moves with the pointer: going
   * through React for each move would re-render the whole transport strip sixty times a
   * second to move two lines on a canvas, which is exactly what the strip's own resize
   * handles keep out of the store.
   */
  const regionRef = useRef(region)
  const draftRef = useRef<{ start: number; end: number } | null>(null)
  const dragRef = useRef<Drag | null>(null)

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  // Bumped on every peaks publish. Status alone can transition to itself - a re-exported
  // file re-publishes while status is already 'ready', React bails out on the same-value
  // set, and the nulled shape was then never rebuilt: the waveform degraded to the slim
  // progress line until a resize.
  const [peaksVersion, setPeaksVersion] = useState(0)
  const seek = usePlayer((s) => s.seek)
  const playing = usePlayer((s) => s.playing)
  const time = usePlayer((s) => s.time)

  /** The element's own duration once known, else what the metadata probe found. */
  const effectiveDuration = useCallback((): number => {
    const element = getAudioElement()
    if (Number.isFinite(element.duration) && element.duration > 0) return element.duration
    return track?.duration ?? 0
  }, [track])

  useEffect(() => {
    peaksRef.current = null
    shapeRef.current = null
    if (!track || !track.playable) {
      setStatus('unavailable')
      return
    }

    const apply = (peaks: Uint8Array | null): void => {
      peaksRef.current = peaks
      shapeRef.current = null
      setStatus(peaks ? 'ready' : 'unavailable')
      setPeaksVersion((version) => version + 1)
    }

    const known = peekPeaks(track.path)
    if (known !== undefined) {
      apply(known)
      return
    }

    setStatus('loading')
    const unsubscribe = subscribePeaks(track.path, apply)
    // The playing track jumps the queue ahead of any background row work.
    void requestPeaks(track.path, track.size, true)
    return unsubscribe
  }, [track])

  // Canvas sizing and the paint function. Rebuilt only when the source, the size or the
  // tint changes - never per frame.
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const styles = getComputedStyle(document.documentElement)
    const playedColor = styles.getPropertyValue('--primary').trim() || 'oklch(0.76 0.12 195)'
    const restColor =
      styles.getPropertyValue('--muted-foreground').trim() || 'oklch(0.65 0.014 260)'
    const dimColor = styles.getPropertyValue('--background').trim() || 'oklch(0.16 0.01 260)'

    let width = 0
    let height = 0
    let ratio = 1

    const paint = (): void => {
      const context = canvas.getContext('2d')
      if (!context || width === 0) return

      context.clearRect(0, 0, width, height)

      const duration = effectiveDuration()
      const element = getAudioElement()
      const progress = duration > 0 ? Math.min(1, element.currentTime / duration) : 0
      const playedX = Math.round(progress * width)
      const mid = height / 2
      const shape = shapeRef.current

      if (shape) {
        if (playedX > 0) {
          context.drawImage(
            shape.played,
            0,
            0,
            playedX * shape.ratio,
            height * shape.ratio,
            0,
            0,
            playedX,
            height
          )
        }
        if (playedX < width) {
          context.drawImage(
            shape.rest,
            playedX * shape.ratio,
            0,
            (width - playedX) * shape.ratio,
            height * shape.ratio,
            playedX,
            0,
            width - playedX,
            height
          )
        }
      } else {
        // No waveform available - still show position as a slim progress track.
        context.globalAlpha = 0.25
        context.fillStyle = restColor
        context.fillRect(0, mid - 1, width, 2)
        context.globalAlpha = 1
        context.fillStyle = playedColor
        context.fillRect(0, mid - 1, playedX, 2)
      }

      // The region rides on the same paint as everything else. A second animation loop over
      // the same canvas would be two writers racing for the last frame.
      const area = draftRef.current ?? regionRef.current
      if (area && duration > 0) {
        const x1 = Math.max(0, Math.min(width, (area.start / duration) * width))
        const x2 = Math.max(0, Math.min(width, (area.end / duration) * width))

        // Everything outside the loop is pushed back rather than the inside being lit up.
        // The waveform is already coloured by its own frequency content, and a wash laid
        // over the part being kept would fight that colouring on the one stretch where it
        // is being looked at hardest.
        context.globalAlpha = 0.6
        context.fillStyle = dimColor
        context.fillRect(0, 0, x1, height)
        context.fillRect(x2, 0, width - x2, height)
        context.globalAlpha = 1

        context.fillStyle = playedColor
        context.fillRect(x1, 0, 1.5, height)
        context.fillRect(x2 - 1.5, 0, 1.5, height)
        // Grips at each edge, so the bounds read as something to take hold of rather than
        // as a picture of where the drag happened to end.
        context.fillRect(x1, mid - 9, 5, 18)
        context.fillRect(x2 - 5, mid - 9, 5, 18)

        // How long the selection is, printed where it is being dragged. The strip shows it
        // too, but only once the pointer is up - during the drag this is the readout.
        if (x2 - x1 > 52) {
          context.font = '10px ui-sans-serif, system-ui, sans-serif'
          context.textAlign = 'center'
          context.textBaseline = 'top'
          context.fillText(formatDurationPrecise(area.end - area.start), (x1 + x2) / 2, 3)
        }
      }

      if (duration > 0) {
        context.fillStyle = playedColor
        context.fillRect(Math.min(playedX, width - 1), 0, 1, height)
      }
    }

    const resize = (): void => {
      const nextRatio = window.devicePixelRatio || 1
      const rect = container.getBoundingClientRect()
      const nextWidth = Math.max(1, Math.floor(rect.width))
      const nextHeight = Math.max(1, Math.floor(rect.height))
      const sizeChanged = nextWidth !== width || nextHeight !== height || nextRatio !== ratio
      if (!sizeChanged && shapeRef.current) return

      width = nextWidth
      height = nextHeight
      ratio = nextRatio
      // Rounded, with the CSS size derived back from the backing store - the same fix
      // useVisualizerCanvas carries, and for the same reason: flooring left the bitmap up
      // to a device pixel short of its box at 125%/150%, and the compositor resampled the
      // whole strip soft to cover the difference.
      canvas.width = Math.max(1, Math.round(width * ratio))
      canvas.height = Math.max(1, Math.round(height * ratio))
      canvas.style.width = `${canvas.width / ratio}px`
      canvas.style.height = `${canvas.height / ratio}px`
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0)

      const peaks = peaksRef.current
      shapeRef.current = peaks
        ? renderShape(peaks, width, height, ratio, playedColor, restColor, tint, wave)
        : null
      paint()
    }

    paintRef.current = paint
    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(container)

    // Same DPR trap as useVisualizerCanvas: a monitor change alters devicePixelRatio
    // without a box resize, and nothing else re-runs `resize`.
    let dprQuery: MediaQueryList | null = null
    const onDprChange = (): void => {
      resize()
      armDpr()
    }
    const armDpr = (): void => {
      dprQuery?.removeEventListener('change', onDprChange)
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    armDpr()

    return () => {
      observer.disconnect()
      dprQuery?.removeEventListener('change', onDprChange)
    }
  }, [status, peaksVersion, effectiveDuration, tint, wave])

  // Animate only while audio is actually moving. A permanently running rAF loop was
  // burning a core for nothing.
  useEffect(() => {
    if (!playing) {
      paintRef.current()
      return
    }
    let frame = 0
    const loop = (): void => {
      // The tight half of the loop. `timeupdate` in the player is the one that always runs,
      // but it fires about four times a second, so it can overshoot the end of the region by
      // a quarter of a second; here the wrap lands within a frame.
      enforceRegion()
      paintRef.current()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // Repaint on discrete position changes while paused, e.g. after a seek.
  useEffect(() => {
    if (!playing) paintRef.current()
  }, [time, playing])

  // The paint closure reads the committed region through a ref, so a change made anywhere
  // else - the strip's toggle clearing it, a new track loading - has to ask for a repaint.
  useEffect(() => {
    regionRef.current = region
    paintRef.current()
  }, [region])

  /** Where in the track the pointer is, or null when there is no duration to divide by. */
  const timeAt = (event: React.PointerEvent<HTMLDivElement>): number | null => {
    const container = containerRef.current
    const duration = effectiveDuration()
    if (!container || duration <= 0) return null
    const rect = container.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    return ratio * duration
  }

  /** A pixel distance in seconds, for hit-testing the handles against the current zoom. */
  const secondsPerPixel = (): number => {
    const container = containerRef.current
    const duration = effectiveDuration()
    const width = container?.getBoundingClientRect().width ?? 0
    return width > 0 && duration > 0 ? duration / width : 0
  }

  /**
   * Settles a dragged region.
   *
   * `regionRef` is written here as well as the store, because the store's value only
   * reaches the ref on the next render: without this the canvas would draw the previous
   * region for a frame the moment the pointer came up.
   */
  const commit = (area: { start: number; end: number } | null): void => {
    regionRef.current = area
    draftRef.current = null
    setRegion(area)
    paintRef.current()
  }

  const endDrag = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.kind !== 'region') return
    const draft = draftRef.current
    const min = MIN_DRAG * secondsPerPixel()
    commit(draft && draft.end - draft.start > min ? draft : null)
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={(event) => {
        if (!track?.playable) return
        const at = timeAt(event)
        if (at === null) return
        event.currentTarget.setPointerCapture(event.pointerId)

        // An edge under the pointer is an edge being taken hold of, whether or not
        // selection mode is on: a region on screen was put there deliberately, and its
        // handles have to do what they look like they do.
        const grab = HANDLE_HIT * secondsPerPixel()
        const area = regionRef.current
        if (area) {
          if (Math.abs(at - area.start) <= grab) {
            dragRef.current = { kind: 'region', anchor: area.end }
            draftRef.current = area
            return
          }
          if (Math.abs(at - area.end) <= grab) {
            dragRef.current = { kind: 'region', anchor: area.start }
            draftRef.current = area
            return
          }
        }

        if (selectable || event.altKey) {
          dragRef.current = { kind: 'region', anchor: at }
          // Zero length until the pointer moves, which `endDrag` reads as a click and turns
          // into clearing whatever region was there.
          draftRef.current = { start: at, end: at }
          paintRef.current()
          return
        }

        dragRef.current = { kind: 'seek' }
        seek(at)
        paintRef.current()
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag) {
          // Hover feedback for the handles, written straight to the element. A state update
          // per pointer move to change one cursor is a render for nothing, and this fires
          // across the whole width of the strip.
          const area = regionRef.current
          const at = area ? timeAt(event) : null
          const grab = HANDLE_HIT * secondsPerPixel()
          const onEdge =
            area !== null &&
            at !== null &&
            (Math.abs(at - area.start) <= grab || Math.abs(at - area.end) <= grab)
          // Cleared rather than set back to a value, so the class below stays in charge.
          event.currentTarget.style.cursor = onEdge ? 'ew-resize' : ''
          return
        }
        const at = timeAt(event)
        if (at === null) return
        if (drag.kind === 'seek') {
          seek(at)
          paintRef.current()
          return
        }
        draftRef.current = { start: Math.min(drag.anchor, at), end: Math.max(drag.anchor, at) }
        paintRef.current()
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={style}
      className={cn(
        'relative h-full w-full',
        !track?.playable ? 'cursor-default' : selectable ? 'cursor-crosshair' : 'cursor-pointer',
        className
      )}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {status === 'loading' && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10.5px] text-muted-foreground/70">
          reading waveform…
        </span>
      )}
      {status === 'unavailable' && track && !track.playable && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10.5px] text-muted-foreground/50">
          .{track.ext} can&apos;t be previewed
        </span>
      )}
    </div>
  )
}
