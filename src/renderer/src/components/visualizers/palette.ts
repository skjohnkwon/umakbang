import { useSyncExternalStore } from 'react'
import { DEFAULT_VISUALIZER_STOPS } from '@shared/types'

/**
 * Theme colours resolved once and cached.
 *
 * getComputedStyle is far too expensive to touch inside a draw loop, so the tokens are
 * read here, kept until the theme actually changes, and handed to the visualizers as
 * plain strings.
 */

/** Quantisation of the bar heat map - panels batch their fills one band at a time. */
const BAND_COUNT = 10

/** Steps the waveform ramp is quantised to. Enough to read as a gradient, few enough that
 * a 1024-column waveform changes fillStyle a handful of times rather than every column. */
const WAVE_STEPS = 16

export interface Palette {
  primary: string
  /** Primary at low opacity - grids, idle fills. */
  primaryFaint: string
  muted: string
  border: string
  foreground: string
  hot: string
  /** Opaque panel backdrop, for canvases that own every pixel and so skip alpha. */
  surface: string
  /**
   * Silence → full energy as 256 RGBA entries, indexed `heat[value * 4]`.
   *
   * One ramp, read per pixel. It used to be a dozen ramps that the spectrogram drifted
   * between over seconds, picking one for the whole frame from a smoothed average of the
   * spectrum - which meant that after the first second or two of a track the average
   * stopped moving and every column came out the same colour. Colour now says how much
   * energy is in that bin, which is the thing that actually changes.
   */
  heat: Uint8ClampedArray
  /** Magnitude → bar colour, dim (0) → hot (last). Sampled from the same ramp family. */
  bands: readonly string[]
  /**
   * The user's ramp on its own, low → high, with none of the panel/foreground shoulders
   * the bar ramp carries. What the waveforms tint themselves with.
   */
  wave: readonly string[]
}

const FALLBACK = {
  primary: 'oklch(0.76 0.12 195)',
  muted: 'oklch(0.655 0.014 260)',
  border: 'oklch(0.285 0.011 260)',
  foreground: 'oklch(0.93 0.005 260)',
  hot: 'oklch(0.62 0.19 25)',
  surface: 'oklch(0.205 0.009 260)'
}

let cache: Palette | null = null
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback

  // The visualizers are tinted by a ramp, quiet → loud, that the user owns end to end.
  // It arrives as one comma-separated variable; unset, it is the built-in five.
  const foreground = token('--foreground', FALLBACK.foreground)
  const surface = token('--card', FALLBACK.surface)
  const declared = token('--visualizer-stops', '')
  const stops = declared
    ? declared.split(',').map((stop) => stop.trim()).filter(Boolean)
    : [...DEFAULT_VISUALIZER_STOPS]
  const primary = stops[0]
  const hot = stops[stops.length - 1]

  return {
    primary,
    primaryFaint: `color-mix(in oklab, ${primary} 22%, transparent)`,
    muted: token('--muted-foreground', FALLBACK.muted),
    border: token('--border', FALLBACK.border),
    foreground,
    hot,
    surface,
    ...buildRamps(stops, surface)
  }
}

/** `amount` of the way from `from` to `to`, as a colour the browser resolves. */
function mix(from: string, to: string, amount: number): string {
  return `color-mix(in oklab, ${from} ${Math.round((1 - amount) * 100)}%, ${to})`
}

/**
 * The colour at `t` along the ramp - the two stops it falls between, mixed.
 *
 * Sampling in CSS rather than by rasterising keeps every colour in oklab and keeps this
 * cheap enough to run on every tint change.
 */
function sampleStops(stops: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  const span = 1 / (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(clamped / span))
  return mix(stops[index], stops[index + 1], (clamped - index * span) / span)
}

const RAMP_WIDTH = 256
const STRIDE = RAMP_WIDTH * 4

/**
 * Rasterises every ramp the visualizers need, so a draw can look a colour up as raw bytes
 * instead of parsing a colour string.
 *
 * All of them go into one strip and come back in a single `getImageData` - the loudness-
 * reactive tint rewrites `--visualizer` several times a second, and each rewrite lands
 * here, so this has to stay cheap.
 */
function buildRamps(
  stops: string[],
  surface: string
): { heat: Uint8ClampedArray; bands: string[]; wave: string[] } {
  const primary = stops[0]
  const canvas = document.createElement('canvas')
  canvas.width = RAMP_WIDTH
  canvas.height = 2
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return {
      heat: new Uint8ClampedArray(STRIDE),
      bands: Array.from({ length: BAND_COUNT }, () => primary),
      wave: Array.from({ length: WAVE_STEPS }, () => primary)
    }
  }

  // Silence is the opaque panel colour rather than transparent: the spectrogram paints
  // every pixel it owns, which is what lets its canvas drop the alpha channel. Everything
  // above it is the user's ramp, so a quiet bin sits at its low end and a loud one at its
  // high end - the same reading the waveforms give.
  const heatRamp = context.createLinearGradient(0, 0, RAMP_WIDTH, 0)
  heatRamp.addColorStop(0, surface)
  heatRamp.addColorStop(0.06, `color-mix(in oklab, ${primary} 30%, ${surface})`)
  for (let i = 0; i < stops.length; i++) {
    heatRamp.addColorStop(0.12 + (0.88 * i) / (stops.length - 1), stops[i])
  }
  context.fillStyle = heatRamp
  context.fillRect(0, 0, RAMP_WIDTH, 1)

  // The bars are the ramp itself, edge to edge - the same colours a waveform of the same
  // sound would draw. They used to start faded into the panel and end past the top stop in
  // the foreground token, which put a third of their range on colours the ramp never
  // named.
  const bar = context.createLinearGradient(0, 0, RAMP_WIDTH, 0)
  for (let i = 0; i < stops.length; i++) {
    bar.addColorStop(i / (stops.length - 1), stops[i])
  }
  context.fillStyle = bar
  context.fillRect(0, 1, RAMP_WIDTH, 1)

  const pixels = context.getImageData(0, 0, RAMP_WIDTH, 2).data
  // A view, not a copy - the ramp is only ever read.
  const heat = pixels.subarray(0, STRIDE)

  const bands: string[] = []
  for (let band = 0; band < BAND_COUNT; band++) {
    const at = STRIDE + Math.round(((band + 0.5) / BAND_COUNT) * 255) * 4
    bands.push(`rgb(${pixels[at]}, ${pixels[at + 1]}, ${pixels[at + 2]})`)
  }

  // The ramp on its own terms, for the waveforms: they draw on the panel already and want
  // the colours the user picked, not those colours faded into the panel behind them.
  const wave: string[] = []
  for (let step = 0; step < WAVE_STEPS; step++) {
    wave.push(sampleStops(stops, step / (WAVE_STEPS - 1)))
  }

  return { heat, bands, wave }
}

export function getPalette(): Palette {
  cache ??= readPalette()
  return cache
}

/** Drops the cached colours and re-renders every visualizer. */
export function invalidatePalette(): void {
  cache = null
  for (const notify of listeners) notify()
}

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  // Two things move the palette: the `dark` class, and the user's colour overrides -
  // which land as inline custom properties on <html>. Watching only `class` meant a
  // changed accent or visualizer tint never invalidated this cache.
  observer ??= new MutationObserver(invalidatePalette)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style']
  })
  return () => {
    listeners.delete(listener)
  }
}

/** Re-renders the caller when the theme flips, so cached colours get rebuilt. */
export function usePalette(): Palette {
  return useSyncExternalStore(subscribeTheme, getPalette)
}
