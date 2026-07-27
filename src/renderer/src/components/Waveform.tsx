import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Track } from '@shared/types'
import { getAudioElement, usePlayer } from '@/state/player'
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
import { cn } from '@/lib/utils'

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
  style
}: {
  track: Track | null
  className?: string
  /** For a caller that sizes the canvas itself, such as the resizable transport strip. */
  style?: React.CSSProperties
}): React.JSX.Element {
  const tint = useLibrary((s) => s.settings.waveformTint)
  const wave = usePalette().wave
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const peaksRef = useRef<Uint8Array | null>(null)
  const shapeRef = useRef<Shape | null>(null)
  const paintRef = useRef<() => void>(() => {})

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
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

      if (duration > 0) {
        context.fillStyle = playedColor
        context.fillRect(Math.min(playedX, width - 1), 0, 1, height)
      }
    }

    const resize = (): void => {
      ratio = window.devicePixelRatio || 1
      const rect = container.getBoundingClientRect()
      const nextWidth = Math.max(1, Math.floor(rect.width))
      const nextHeight = Math.max(1, Math.floor(rect.height))
      const sizeChanged = nextWidth !== width || nextHeight !== height
      if (!sizeChanged && shapeRef.current) return

      width = nextWidth
      height = nextHeight
      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
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
    return () => observer.disconnect()
  }, [status, effectiveDuration, tint, wave])

  // Animate only while audio is actually moving. A permanently running rAF loop was
  // burning a core for nothing.
  useEffect(() => {
    if (!playing) {
      paintRef.current()
      return
    }
    let frame = 0
    const loop = (): void => {
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

  const seekFromEvent = (event: React.PointerEvent<HTMLDivElement>): void => {
    const container = containerRef.current
    const duration = effectiveDuration()
    if (!container || duration <= 0) return
    const rect = container.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    seek(ratio * duration)
    paintRef.current()
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={(event) => {
        if (!track?.playable) return
        event.currentTarget.setPointerCapture(event.pointerId)
        seekFromEvent(event)
      }}
      onPointerMove={(event) => {
        if (track?.playable && event.buttons === 1) seekFromEvent(event)
      }}
      style={style}
      className={cn(
        'relative h-full w-full',
        track?.playable ? 'cursor-pointer' : 'cursor-default',
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
