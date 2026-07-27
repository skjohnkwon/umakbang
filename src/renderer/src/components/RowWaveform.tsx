import type React from 'react'
import { memo, useEffect, useRef, useState } from 'react'
import {
  cancelPeaks,
  peakBrightness,
  peakCount,
  peakLoudness,
  peakStride,
  peekPeaks,
  requestPeaks,
  subscribePeaks
} from '@/lib/peaks'

import { getAudioElement, usePlayer } from '@/state/player'
import type { Settings } from '@shared/types'

/**
 * The waveform in a table row, and the app's only scrub target.
 *
 * Peaks are fetched once the row is on screen and released again if it scrolls away
 * before the work starts, so browsing a huge folder doesn't queue thousands of decodes.
 * The playing row animates its own playhead on the frame loop rather than re-rendering
 * from React state - position updates arrive about four times a second, which is far too
 * coarse to look like motion.
 */
export const RowWaveform = memo(function RowWaveform({
  path,
  size,
  playable,
  isCurrent,
  duration,
  tint,
  wave
}: {
  path: string
  size: number
  playable: boolean
  /** Only the playing row draws a playhead and accepts scrubbing. */
  isCurrent: boolean
  /** Probed duration, used until the element reports its own. */
  duration: number | undefined
  /** Handed down rather than read here: rows hold no store subscriptions of their own. */
  tint: Settings['waveformTint']
  /** The visualizer ramp, likewise subscribed to once by the table. */
  wave: readonly string[]
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [peaks, setPeaks] = useState<Uint8Array | null | undefined>(() => peekPeaks(path))
  const playing = usePlayer((s) => s.playing)
  const seek = usePlayer((s) => s.seek)

  useEffect(() => {
    if (!playable) return
    const known = peekPeaks(path)
    if (known !== undefined) {
      setPeaks(known)
      return
    }

    setPeaks(undefined)
    const unsubscribe = subscribePeaks(path, setPeaks)
    void requestPeaks(path, size, isCurrent)
    return () => {
      unsubscribe()
      // Only drops it if it hasn't started; in-flight work still populates the cache.
      cancelPeaks(path)
    }
  }, [path, size, playable, isCurrent])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    // Read once - getComputedStyle inside a frame loop is far too expensive.
    const styles = getComputedStyle(container)
    const playedColour = styles.getPropertyValue('--primary').trim() || '#4ecdc4'
    const restColour = styles.getPropertyValue('--muted-foreground').trim() || '#888'
    // Same ramp the big waveform and the visualizers use.
    const ramp = tint === 'accent' ? null : wave

    let width = 0
    let height = 0

    const resize = (): void => {
      const rect = container.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))
      // Backing store at device resolution, then scaled - otherwise the bars land on
      // fractional pixels and the whole thing looks smeared.
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    const draw = (): void => {
      const context = canvas.getContext('2d')
      if (!context || !width) return
      context.clearRect(0, 0, width, height)
      if (!peaks) return

      const mid = Math.round(height / 2)
      const element = getAudioElement()
      const total = Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : (duration ?? 0)
      const playedX =
        isCurrent && total > 0 ? Math.round((element.currentTime / total) * width) : -1

      const stride = peakStride(peaks)
      const buckets = peakCount(peaks)
      for (let x = 0; x < width; x++) {
        const bucket = Math.min(buckets - 1, Math.floor((x / width) * buckets))
        const min = peaks[bucket * stride] / 127.5 - 1
        const max = peaks[bucket * stride + 1] / 127.5 - 1
        // Rounded to whole pixels so every bar has a crisp edge.
        const top = Math.round(mid - max * (mid - 1))
        const bottom = Math.round(mid - min * (mid - 1))

        const isPlayed = x <= playedX
        if (ramp) {
          const t = peakBrightness(peaks, bucket) ?? peakLoudness(peaks, bucket)
          context.fillStyle = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]
        } else {
          context.fillStyle = isPlayed ? playedColour : restColour
        }
        context.globalAlpha = isPlayed ? 1 : 0.42
        context.fillRect(x, top, 1, Math.max(1, bottom - top))
      }
      context.globalAlpha = 1

      if (playedX >= 0) {
        context.fillStyle = playedColour
        context.fillRect(Math.min(playedX, width - 1), 0, 1, height)
      }
    }

    resize()
    draw()

    const observer = new ResizeObserver(() => {
      resize()
      draw()
    })
    observer.observe(container)

    // Only the playing row needs to animate, and only while it's actually moving.
    let frame = 0
    if (isCurrent && playing) {
      const loop = (): void => {
        draw()
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
    }

    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [peaks, isCurrent, playing, duration, tint, wave])

  const scrub = (event: React.PointerEvent<HTMLDivElement>): void => {
    const container = containerRef.current
    if (!container || !isCurrent) return
    const element = getAudioElement()
    const total =
      Number.isFinite(element.duration) && element.duration > 0 ? element.duration : (duration ?? 0)
    if (total <= 0) return
    const rect = container.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    seek(ratio * total)
  }

  return (
    <div
      ref={containerRef}
      // Scrubbing must not bubble into the row's click-to-play handler.
      onPointerDown={(event) => {
        if (!isCurrent) return
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        scrub(event)
      }}
      onPointerMove={(event) => {
        if (isCurrent && event.buttons === 1) scrub(event)
      }}
      onClick={(event) => {
        if (isCurrent) event.stopPropagation()
      }}
      className={`relative h-[18px] w-full pr-1 ${isCurrent ? 'cursor-ew-resize' : ''}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {playable && peaks === undefined && (
        <span className="pointer-events-none absolute inset-0 flex items-center">
          <span className="h-px w-full bg-muted-foreground/20" />
        </span>
      )}
    </div>
  )
})
