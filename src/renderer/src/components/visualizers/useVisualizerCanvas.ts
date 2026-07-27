import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { usePlayer } from '@/state/player'
import { subscribeFrames } from './audio-tap'
import { type Palette, usePalette } from './palette'

export interface Surface {
  context: CanvasRenderingContext2D
  /** CSS pixels - the context is pre-scaled by `ratio`. */
  width: number
  height: number
  ratio: number
  /** Frame timestamp, shared by every panel so none of them calls `performance.now()`. */
  time: number
  palette: Palette
}

/**
 * Canvas plumbing shared by every visualizer: a container-sized, devicePixelRatio-aware
 * canvas plus a slot on the one shared animation frame loop.
 *
 * `draw` runs per frame while audio plays and once when it stops (`active` false), so a
 * paused panel settles instead of freezing mid-transient. `resize` is the place to build
 * anything size-dependent - gradients, lookup tables, offscreen buffers - since it is the
 * only hook that fires on layout and theme changes rather than every frame.
 *
 * It fires on theme changes too, and those are frequent: the loudness-reactive tint
 * rewrites `--visualizer` several times a second. So `resize` must rebuild colours but
 * treat buffers as keep-if-unchanged - see the guards in the panels.
 */
export interface VisualizerCanvasOptions {
  /** Rebuilds size-dependent state. Fires on layout *and* theme changes. */
  resize?: (surface: Surface) => void
  /** Drops the alpha channel. Only for panels that paint every pixel they own. */
  opaque?: boolean
  /**
   * Throws away whatever the panel has accumulated - scroll history, peak holds - after
   * playback has been stopped long enough that leaving it on screen would be misleading.
   * Panels that only ever draw the current instant don't need one: their idle frame is
   * already empty.
   */
  clear?: (surface: Surface) => void
}

export function useVisualizerCanvas(
  draw: (surface: Surface, active: boolean) => void,
  { resize, opaque = false, clear }: VisualizerCanvasOptions = {}
): {
  containerRef: React.RefObject<HTMLDivElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** Repaints one idle frame - for state that changes outside the audio loop. */
  repaint: () => void
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = usePalette()

  // Kept in refs so an inline arrow in the caller doesn't re-create the whole surface.
  const drawRef = useRef(draw)
  const resizeRef = useRef(resize)
  const clearRef = useRef(clear)
  drawRef.current = draw
  resizeRef.current = resize
  clearRef.current = clear

  // Outlives the effect. A theme change re-runs the effect, and a surface rebuilt with
  // width 0 would look like a resize to every panel - wiping scroll history and, via
  // `canvas.width`, the bitmap itself.
  const surfaceRef = useRef<Surface | null>(null)
  const repaintRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas) return
    const context = canvas.getContext('2d', { alpha: !opaque })
    if (!container || !context) return

    // One mutable surface object, reused forever - a frame must not allocate.
    const surface = (surfaceRef.current ??= {
      context,
      width: 0,
      height: 0,
      ratio: 1,
      time: 0,
      palette
    })
    surface.context = context
    surface.palette = palette

    /** True when the pixel dimensions actually moved. */
    const measure = (): boolean => {
      const rect = container.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      if (width === surface.width && height === surface.height && ratio === surface.ratio) {
        return false
      }

      surface.width = width
      surface.height = height
      surface.ratio = ratio
      // The backing store is rounded to whole device pixels and the CSS size is derived
      // back from it, so one canvas pixel is exactly one screen pixel. Flooring it and
      // then displaying the result at `width` CSS pixels leaves the bitmap up to a device
      // pixel short of the box it fills, and the compositor resamples the whole canvas to
      // cover the difference - which softens every panel on a fractionally scaled display,
      // and 125% and 150% are the common Windows settings.
      canvas.width = Math.max(1, Math.round(width * ratio))
      canvas.height = Math.max(1, Math.round(height * ratio))
      canvas.style.width = `${canvas.width / ratio}px`
      canvas.style.height = `${canvas.height / ratio}px`
      // Resizing resets all context state, so the transform is re-applied every time.
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      resizeRef.current?.(surface)
      drawRef.current(surface, false)
      return true
    }

    // A theme change arrives at the same size, so `measure` no-ops; the colour-dependent
    // state still has to be rebuilt.
    if (!measure()) {
      resizeRef.current?.(surface)
      // Only settle the panel when nothing is playing. Mid-playback the next real frame
      // lands within ~16ms, and painting an `active: false` frame in between snaps every
      // panel back to its idle state - which reads as flashing, because the
      // loudness-reactive tint rewrites the theme several times a second.
      if (!usePlayer.getState().playing) drawRef.current(surface, false)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(container)

    repaintRef.current = () => {
      if (surface.width > 0) drawRef.current(surface, false)
    }

    const unsubscribe = subscribeFrames((phase, time) => {
      surface.time = time
      if (surface.width === 0) return
      // A wipe drops the panel's own history first, then paints the empty result - so
      // what's left is the panel's resting state (a centre line, meter ticks) rather than
      // a blank rectangle.
      if (phase === 'clear') clearRef.current?.(surface)
      drawRef.current(surface, phase === 'live')
    })

    return () => {
      observer.disconnect()
      unsubscribe()
      repaintRef.current = null
    }
  }, [palette, opaque])

  return { containerRef, canvasRef, repaint: useCallback(() => repaintRef.current?.(), []) }
}
