import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAudioTap } from './audio-tap'
import { useLibrary } from '@/state/library'
import { brightnessOf } from '@/lib/peaks-core'
import { type Surface, useVisualizerCanvas } from './useVisualizerCanvas'

/**
 * Real-time visualizers for the playing track.
 *
 * Every panel here is a thin wrapper around `useVisualizerCanvas`, which owns the canvas
 * sizing and hands out slots on a single shared animation frame that only runs while
 * audio is actually playing. Colours come from cached theme tokens - nothing in a draw
 * path touches the DOM or allocates.
 */

/** Below ~30Hz there is nothing musical to show, and log scales blow up near zero. */
const MIN_HZ = 30

/** dB span represented by the fine analyser before user-selected headroom. */
const SPECTRUM_RANGE_DB = 84

function headroomDb(value: number | undefined): number {
  return Math.max(0, Math.min(18, value ?? 6))
}

/* ------------------------------------------------------------------ shared helpers */

/** Analyser scratch buffers live in refs - a frame must never allocate. */
function bytes(
  ref: React.RefObject<Uint8Array<ArrayBuffer> | null>,
  size: number
): Uint8Array<ArrayBuffer> {
  if (!ref.current || ref.current.length !== size) ref.current = new Uint8Array(size)
  return ref.current
}

function floats(
  ref: React.RefObject<Float32Array<ArrayBuffer> | null>,
  size: number
): Float32Array<ArrayBuffer> {
  if (!ref.current || ref.current.length !== size) ref.current = new Float32Array(size)
  return ref.current
}

/** Log-spaced FFT bin boundaries, so an octave gets equal space wherever it sits. */
/**
 * Where each row of a log frequency axis falls, in bins - fractional, not rounded.
 *
 * Rounding to whole bins is what made the bottom of the range coarse: several rows land
 * inside one bin down there, and rounding gave every one of them the same index, so the
 * low end painted in blocks while the top averaged dozens of bins per row. Keeping the
 * fraction lets `bandPeak` interpolate between neighbours instead.
 */
function logBinEdges(count: number, bins: number, sampleRate: number): Float32Array {
  const nyquist = sampleRate / 2
  const edges = new Float32Array(count + 1)
  for (let i = 0; i <= count; i++) {
    const hz = MIN_HZ * Math.pow(nyquist / MIN_HZ, i / count)
    edges[i] = Math.max(0, Math.min(bins - 1, (hz / nyquist) * bins))
  }
  return edges
}

/**
 * The band between two fractional bin positions.
 *
 * Wider than a bin it is the loudest bin in the range - averaging smears transients into
 * mush at these widths. Narrower than a bin, which is every row at the bottom of a log
 * axis, it is a linear interpolation between the two bins it sits between, so neighbouring
 * rows differ from each other rather than repeating one value in a block.
 */
function bandPeak(data: Uint8Array, from: number, to: number): number {
  const first = Math.floor(from)
  const last = Math.floor(to)
  if (last <= first) {
    const middle = (from + to) / 2
    const index = Math.floor(middle)
    const fraction = middle - index
    const low = data[index] ?? 0
    const high = data[index + 1] ?? low
    return low + (high - low) * fraction
  }
  let peak = 0
  for (let i = first; i <= last; i++) if (data[i] > peak) peak = data[i]
  return peak
}

function toUnitDb(amplitude: number): number {
  // -60dBFS floor: quieter than that is visually indistinguishable from silence.
  const db = 20 * Math.log10(Math.max(amplitude, 1e-5))
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

interface Hold {
  value: number
  at: number
}

/** Peak hold: snap up instantly, sit for a beat, then fall at a readable rate. */
function updateHold(hold: Hold, unit: number, now: number): number {
  if (unit >= hold.value) {
    hold.value = unit
    hold.at = now
  } else if (now - hold.at > 800) {
    hold.value = Math.max(unit, hold.value - 0.008)
  }
  return hold.value
}

/* ------------------------------------------------------------------ panel shell */

export type StackOrientation = 'vertical' | 'horizontal'

export interface VisualizerProps {
  /** Rendered as the hide control in the panel header when provided. */
  onDisable?: () => void
  className?: string
  /** How the stack is laid out - a panel may want to flip its own axis to match. */
  orientation?: StackOrientation
}

function Panel({
  name,
  onDisable,
  className,
  controls,
  children
}: VisualizerProps & {
  name: string
  /** Panel-local switches, sat left of the hide button. */
  controls?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className={cn(
        'group flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-card/50',
        className
      )}
    >
      <header className="flex h-[17px] shrink-0 items-center justify-between pl-2 pr-0.5">
        <span className="text-[9.5px] font-medium uppercase tracking-[0.09em] text-muted-foreground/70">
          {name}
        </span>
        <div className="flex items-center gap-0.5">
          {controls}
          {onDisable && (
            <button
              type="button"
              title={`Hide ${name}`}
              onClick={onDisable}
              className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      </header>
      {children}
    </section>
  )
}

/** Header switch - deliberately quiet, since the plot is the thing worth looking at. */
function PanelToggle({
  label,
  title,
  onClick
}: {
  label: string
  title: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-4 items-center rounded px-1 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
    >
      {label}
    </button>
  )
}

/**
 * Each canvas gets its own compositor layer: a repaint then uploads one texture instead
 * of dirtying the panel stack behind it. `will-change` is the whole trick - a
 * `translateZ(0)` on top would request the same promotion twice.
 */
const PLOT_STYLE: React.CSSProperties = { willChange: 'transform' }

function Plot({
  containerRef,
  canvasRef
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
}): React.JSX.Element {
  return (
    <div ref={containerRef} className="relative min-h-0 flex-1">
      <canvas ref={canvasRef} style={PLOT_STYLE} className="block h-full w-full" />
    </div>
  )
}

/* ------------------------------------------------------------------ spectrogram */

interface History {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  column: ImageData
  /** Device pixels. */
  width: number
  height: number
  /** Ring buffer write head - scrolling by re-blitting the whole image every frame is
   *  an order of magnitude more work than moving one column. */
  head: number
  /** Bin boundary per pixel row, high frequency at the top. */
  edges: Float32Array
}

export function Spectrogram(props: VisualizerProps): React.JSX.Element {
  const historyRef = useRef<History | null>(null)
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  /** Smoothed 0..1 "how bright and how loud", which picks the ramp stage. */

  const resize = (surface: Surface): void => {
    const tap = getAudioTap()
    if (!tap) return
    // The visible canvas has no alpha, so every frame repaints its own backdrop. Colour
    // set here - before the buffer guard, since a theme change stops there - so the draw
    // never pays for parsing it.
    //
    // The backdrop is the ramp's own low end, not the app background: the panel is a scale,
    // and its empty state should be the bottom of that scale rather than the colour of the
    // window behind it.
    surface.context.fillStyle = surface.palette.quiet

    // The heatmap is written at device resolution so it stays crisp on scaled displays.
    const width = Math.max(1, Math.floor(surface.width * surface.ratio))
    const height = Math.max(1, Math.floor(surface.height * surface.ratio))

    // `resize` also runs on a *theme* change, not just a geometry change - and the user's
    // loudness-reactive tint changes colours while audio plays. Reallocating here would
    // throw away the scroll history several times a second, which reads as the
    // spectrogram restarting over and over. Only real pixel changes rebuild it.
    const existing = historyRef.current
    if (existing && existing.width === width && existing.height === height) return

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    // Columns not yet written have to read as silence, not as the black an opaque canvas
    // starts on - and silence is the ramp's low end.
    context.fillStyle = surface.palette.quiet
    context.fillRect(0, 0, width, height)

    // What was already on screen is carried into the new size rather than thrown away.
    // Dragging a panel edge used to wipe the last minute of sound, which is the one thing
    // a scrolling history is for. The ring is unrolled into time order on the way across,
    // so the oldest column lands at the left and the write head starts there.
    if (existing) {
      const tail = existing.width - existing.head
      const scale = width / existing.width
      context.drawImage(
        existing.canvas,
        existing.head,
        0,
        tail,
        existing.height,
        0,
        0,
        tail * scale,
        height
      )
      if (existing.head > 0) {
        context.drawImage(
          existing.canvas,
          0,
          0,
          existing.head,
          existing.height,
          tail * scale,
          0,
          existing.head * scale,
          height
        )
      }
    }

    historyRef.current = {
      canvas,
      context,
      column: context.createImageData(1, height),
      width,
      height,
      head: 0,
      edges: logBinEdges(height, tap.fineBins, tap.context.sampleRate)
    }
  }

  const draw = (surface: Surface, active: boolean): void => {
    const history = historyRef.current
    const tap = getAudioTap()
    if (!history || !tap) return
    const { context, width, height, palette } = surface

    if (active) {
      const data = bytes(dataRef, tap.fineBins)
      tap.fine.getByteFrequencyData(data)

      // One ramp, read per pixel: colour is how much energy is in that bin, so a column
      // is as varied as the sound in it. It used to be one colour for the whole frame,
      // chosen from a smoothed average that stopped moving a second or two into a track.
      const heat = palette.heat

      const pixels = history.column.data
      const edges = history.edges
      for (let y = 0; y < history.height; y++) {
        // Row 0 is the top of the panel, so it reads the *last* (highest) band.
        const low = edges[history.height - 1 - y]
        const high = edges[history.height - y]
        // Rounded: the band is interpolated now, and a fractional index into the ramp's
        // bytes reads back undefined.
        const peak = Math.round(bandPeak(data, low, Math.max(low, high)))
        const source = peak * 4
        const target = y * 4
        pixels[target] = heat[source]
        pixels[target + 1] = heat[source + 1]
        pixels[target + 2] = heat[source + 2]
        pixels[target + 3] = heat[source + 3]
      }
      history.context.putImageData(history.column, history.head, 0)
      history.head = (history.head + 1) % history.width
    }

    // Two blits stitch the ring buffer back into time order, newest at the right edge;
    // the fill underneath covers the sub-pixel seam between them.
    context.fillRect(0, 0, width, height)
    const scale = width / history.width
    const tail = history.width - history.head
    context.drawImage(
      history.canvas,
      history.head,
      0,
      tail,
      history.height,
      0,
      0,
      tail * scale,
      height
    )
    if (history.head > 0) {
      context.drawImage(
        history.canvas,
        0,
        0,
        history.head,
        history.height,
        tail * scale,
        0,
        history.head * scale,
        height
      )
    }
  }

  // Opaque: the two blits cover every pixel, so there is nothing to composite against.
  /** The heatmap is the whole panel, so wiping it is wiping the scroll history. */
  const clear = (surface: Surface): void => {
    const history = historyRef.current
    if (!history) return
    history.context.fillStyle = surface.palette.quiet
    history.context.fillRect(0, 0, history.width, history.height)
    history.head = 0
  }

  const { containerRef, canvasRef } = useVisualizerCanvas(draw, { resize, opaque: true, clear })
  return (
    <Panel name="Spectrogram" {...props}>
      <Plot containerRef={containerRef} canvasRef={canvasRef} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ frequency bars */

interface BarLayout {
  edges: Float32Array
  peaks: Float32Array
  holds: Float32Array
  /** Which colour band each bar landed in this frame; 255 means "silent, skip". */
  bands: Uint8Array
  count: number
}


export function FrequencyBars(props: VisualizerProps): React.JSX.Element {
  const headroom = headroomDb(useLibrary((state) => state.settings.visualizerHeadroomDb))
  const spectrumZero = SPECTRUM_RANGE_DB / (SPECTRUM_RANGE_DB + headroom)
  const layoutRef = useRef<BarLayout | null>(null)
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  const resize = (surface: Surface): void => {
    const tap = getAudioTap()
    if (!tap) return
    // ~2.5px per bar: fine enough to read as a comb rather than a bar chart, which is
    // what makes harmonics and noise floors distinguishable at a glance.
    const count = Math.max(24, Math.min(192, Math.round(surface.width / 2.5)))

    // A theme change re-runs this too, so the falling peak caps are carried over when
    // only the colours moved - otherwise they'd snap to zero several times a second.
    const previous = layoutRef.current
    if (previous && previous.count === count) return

    layoutRef.current = {
      edges: logBinEdges(count, tap.fineBins, tap.context.sampleRate),
      peaks: new Float32Array(count),
      holds: new Float32Array(count),
      bands: new Uint8Array(count),
      count
    }
  }

  const draw = (surface: Surface, active: boolean): void => {
    const layout = layoutRef.current
    const tap = getAudioTap()
    if (!layout || !tap) return
    const { context, width, height, palette } = surface
    context.clearRect(0, 0, width, height)

    const data = bytes(dataRef, tap.fineBins)
    if (active) tap.fine.getByteFrequencyData(data)
    else data.fill(0)

    const slot = width / layout.count
    const barWidth = Math.max(0.75, slot - Math.min(1, slot * 0.4))
    const bands = palette.bands
    const hottest = bands.length - 1

    for (let i = 0; i < layout.count; i++) {
      const from = layout.edges[i]
      const value =
        (bandPeak(data, from, Math.max(from, layout.edges[i + 1] - 1)) / 255) * spectrumZero
      layout.peaks[i] = value
      // Bars are coloured by their own magnitude, so a spike reads hot against the cool
      // floor around it - the flat gradient said the same thing at every level.
      //
      // A band with no energy at all is still the bottom of the ramp rather than nothing:
      // it used to be skipped, which left the panel background showing through wherever
      // the signal happened to reach exactly zero. Against a background that isn't the
      // ramp's own low colour that reads as a hole in the spectrum, and the boundary moved
      // with the audio. Every band now draws, so the floor is one continuous line of the
      // quietest colour the user chose.
      layout.bands[i] = Math.min(hottest, (value * bands.length) | 0)
      // The decay line falls on a fixed per-frame step; exact ballistics aren't worth a
      // timestamp.
      layout.holds[i] = value >= layout.holds[i] ? value : Math.max(value, layout.holds[i] - 0.006)
    }

    // One path per colour band rather than one fill per bar: assigning `fillStyle` parses
    // a colour string, and at this bar count paying that per bar costs more than the fills
    // themselves. The extra passes only compare bytes.
    for (let band = 0; band <= hottest; band++) {
      let drew = false
      context.beginPath()
      for (let i = 0; i < layout.count; i++) {
        if (layout.bands[i] !== band) continue
        const barHeight = Math.max(1, layout.peaks[i] * height)
        context.rect(i * slot, height - barHeight, barWidth, barHeight)
        drew = true
      }
      if (!drew) continue
      context.fillStyle = bands[band]
      context.fill()
    }

    // One continuous line over the bars rather than a cap floating above each of them.
    // The caps were a row of disconnected grey ticks that read as debris; the same numbers
    // joined up are the shape of the spectrum a moment ago, which is what they were for.
    context.strokeStyle = palette.foreground
    context.globalAlpha = 0.5
    context.lineWidth = 1
    context.lineJoin = 'round'
    context.beginPath()
    let started = false
    for (let i = 0; i < layout.count; i++) {
      const x = i * slot + barWidth / 2
      const y = Math.max(0.5, height - layout.holds[i] * height)
      if (started) context.lineTo(x, y)
      else {
        context.moveTo(x, y)
        started = true
      }
    }
    if (started) context.stroke()
    context.globalAlpha = 1
  }

  /** The decay line hangs in the air after the bars have gone, so it goes too. */
  const clear = (): void => {
    const layout = layoutRef.current
    if (!layout) return
    layout.peaks.fill(0)
    layout.holds.fill(0)
  }

  const { containerRef, canvasRef } = useVisualizerCanvas(draw, { resize, clear })
  return (
    <Panel name="Spectrum" {...props}>
      <Plot containerRef={containerRef} canvasRef={canvasRef} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ oscilloscope */

export function Oscilloscope(props: VisualizerProps): React.JSX.Element {
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  const resize = (surface: Surface): void => {
    surface.context.lineWidth = 1.25
    surface.context.lineJoin = 'round'
  }

  const draw = (surface: Surface, active: boolean): void => {
    const tap = getAudioTap()
    const { context, width, height, palette } = surface
    context.clearRect(0, 0, width, height)

    const mid = height / 2
    context.fillStyle = palette.border
    context.fillRect(0, Math.round(mid), width, 1)
    if (!tap) return

    const size = tap.mono.fftSize
    const data = bytes(dataRef, size)
    if (active) tap.mono.getByteTimeDomainData(data)
    else data.fill(128)

    // Trigger on a rising zero crossing so the trace stands still instead of crawling.
    const span = size >> 1
    let start = 0
    for (let i = 1; i < span; i++) {
      if (data[i - 1] < 128 && data[i] >= 128) {
        start = i
        break
      }
    }

    const points = Math.max(2, Math.min(span, Math.floor(width)))
    const step = span / points
    const ramp = palette.wave

    // The trace takes its colour from how far the signal is from the centre line, so the
    // shape is read twice over: by where it goes and by what it turns into on the way.
    // Stroked in runs of one colour rather than segment by segment - a run is typically
    // dozens of points wide, and a stroke() per point would be a stroke per pixel column.
    let index = -1
    let previousX = 0
    let previousY = mid
    for (let i = 0; i < points; i++) {
      const sample = data[start + Math.floor(i * step)]
      const unit = Math.min(1, Math.abs(sample - 128) / 128)
      const y = mid - ((sample - 128) / 128) * (mid - 1)
      const x = (i / (points - 1)) * width
      const next = Math.min(ramp.length - 1, Math.floor(unit * ramp.length))

      if (i === 0) {
        index = next
        context.strokeStyle = ramp[index]
        context.beginPath()
        context.moveTo(x, y)
      } else if (next === index) {
        context.lineTo(x, y)
      } else {
        // Close the run *through* this point so the colours meet rather than leaving a gap.
        context.lineTo(x, y)
        context.stroke()
        index = next
        context.strokeStyle = ramp[index]
        context.beginPath()
        context.moveTo(previousX, previousY)
        context.lineTo(x, y)
      }
      previousX = x
      previousY = y
    }
    context.stroke()
  }

  // No clear: the scope only ever draws the instant it's looking at, so its idle frame
  // is already a flat line.
  const { containerRef, canvasRef } = useVisualizerCanvas(draw, { resize })
  return (
    <Panel name="Scope" {...props}>
      <Plot containerRef={containerRef} canvasRef={canvasRef} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ rolling waveform */

/** Min/max envelope per column, so the history keeps its shape instead of aliasing. */
interface Envelope {
  min: Float32Array
  max: Float32Array
  /** Where each column's energy sat, 0 (low) to 1 (high), for the colour ramp. */
  tone: Float32Array
  /** Ring-buffer write position - the newest column, drawn at the right edge. */
  head: number
  columns: number
  /** Frame timestamp of the last column written, so the next frame knows how much audio
   *  has actually gone past. 0 means "nothing written yet". */
  lastTime: number
  /** Samples that have gone by but don't yet add up to a whole column. */
  carry: number
}

/**
 * The waveform as it goes past: each frame contributes a few columns and the history
 * slides right to left. Unlike the scope - which freezes one cycle in place - this is the
 * shape of what you actually just heard.
 */
/**
 * Columns pushed per second, i.e. the scroll rate, and with it the time axis: one column
 * is 1/this seconds of audio, so a 600px-wide panel holds about 1.7 seconds.
 *
 * This used to be a per-*frame* count, which quietly made the two disagree: six columns a
 * frame at 60fps is this same 360/s of travel, but each column was cut from a share of the
 * whole analyser buffer, which is worth two and a half frames. See `draw`.
 */
const COLUMNS_PER_SECOND = 360

/**
 * Alpha of the oldest column. The trail fades so the leading edge reads as "now", but a
 * deep fade turns the history into a smear that looks like motion blur rather than sound.
 */
const OLDEST_ALPHA = 0.55

/**
 * How many columns' worth of audio each column's min/max is taken over.
 *
 * One would be the literal reading and it looks like a comb: at 360 columns a second a
 * column is a third of a cycle of a bass note, so whether it lands on a peak or a crossing
 * is luck. Three overlaps its neighbours enough for the trace to read as one shape.
 */
const ENVELOPE_OVERLAP = 3

/**
 * Extra columns of context behind each one when estimating where its energy sits.
 *
 * The count of sign changes over a window resolves frequency in steps of
 * `sampleRate / 2 / samples`, so a narrow window is coarse exactly where the ear is most
 * sensitive to it: at four columns the whole octave from 40 to 90Hz was one step, and bass
 * came out a single flat colour. Sixteen columns is ~45ms - still local enough to follow a
 * hi-hat, and fine enough that the bottom of the range has somewhere to move.
 */
const TONE_WINDOW_COLUMNS = 16

export function RollingWaveform(props: VisualizerProps): React.JSX.Element {
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const envelopeRef = useRef<Envelope | null>(null)
  // Read through a ref: `draw` is built once and runs on the animation frame, so it must
  // not close over a value that changes.
  const tint = useLibrary((s) => s.settings.waveformTint)
  const tintRef = useRef(tint)
  tintRef.current = tint

  const resize = (surface: Surface): void => {
    // One column per *device* pixel. Allocating per CSS pixel meant each column was
    // drawn 1.25 or 1.5 device pixels wide on a scaled display, so every edge landed on
    // a fraction and the whole trace came out soft.
    const columns = Math.max(1, Math.round(surface.width * surface.ratio))
    const existing = envelopeRef.current
    if (existing && existing.columns === columns) return

    const next: Envelope = {
      min: new Float32Array(columns),
      max: new Float32Array(columns),
      tone: new Float32Array(columns),
      head: 0,
      columns,
      lastTime: existing?.lastTime ?? 0,
      carry: 0
    }

    // Carried across rather than started again: dragging the panel edge used to blank the
    // trace. Read out of the old ring in time order and stretched to the new width, so the
    // sound stays where it was on the time axis.
    if (existing) {
      for (let x = 0; x < columns; x++) {
        const from = (existing.head + Math.floor((x / columns) * existing.columns)) % existing.columns
        next.min[x] = existing.min[from]
        next.max[x] = existing.max[from]
        next.tone[x] = existing.tone[from]
      }
    }

    envelopeRef.current = next
  }

  const draw = (surface: Surface, active: boolean): void => {
    const { context, width, height, palette, ratio } = surface
    const envelope = envelopeRef.current
    context.clearRect(0, 0, width, height)

    // A device-pixel step, so everything below lands on the pixel grid rather than
    // straddling two and being drawn as a pair of half-lit ones.
    const step = 1 / ratio
    const mid = height / 2
    context.fillStyle = palette.border
    context.fillRect(0, Math.round(mid * ratio) * step, width, step)
    if (!envelope) return

    const tap = getAudioTap()
    if (tap && active) {
      const size = tap.mono.fftSize
      const data = floats(dataRef, size)
      // Float rather than byte: the 8-bit form quantises to 1/128, which at these
      // amplitudes is a visible stair-step on anything quiet.
      tap.mono.getFloatTimeDomainData(data)

      // Only the audio that has actually gone past since the last frame becomes new
      // columns.
      //
      // The analyser holds the most recent fftSize samples, about two and a half frames'
      // worth, and this used to cut every frame's columns from the whole of it. So roughly
      // 60% of each frame was audio the previous frame had already drawn, re-drawn a few
      // columns further left: every transient appeared two or three times, marching across
      // the panel. That is the ghosting, and no amount of alpha or pixel snapping touches
      // it - the trace was genuinely showing the same sound several times over.
      const samplesPerColumn = tap.context.sampleRate / COLUMNS_PER_SECOND
      const elapsed = envelope.lastTime === 0 ? 1000 / 60 : surface.time - envelope.lastTime
      envelope.carry += (Math.max(0, elapsed) / 1000) * tap.context.sampleRate

      let count = Math.floor(envelope.carry / samplesPerColumn)
      // Nothing older than the buffer can be recovered, so a hitch drops the backlog
      // rather than replaying stale audio at the wrong place on the time axis.
      const available = Math.floor(size / samplesPerColumn)
      if (count >= available) {
        count = available
        envelope.carry = 0
      } else {
        envelope.carry -= count * samplesPerColumn
      }

      // The newest samples sit at the end of the buffer, so the window we consume ends
      // there and the columns are cut back from it, oldest first.
      for (let c = 0; c < count; c++) {
        const from = size - Math.round((count - c) * samplesPerColumn)
        const to = size - Math.round((count - c - 1) * samplesPerColumn)
        // The envelope is read from a window wider than the column it fills, so
        // neighbouring columns overlap. A column is only ~120 samples - a third of a cycle
        // at 100Hz - so one landing near a zero crossing found almost no excursion and drew
        // a stub, which across the panel is the comb of gaps between the loud columns. The
        // extra samples are ones the buffer is already holding; nothing is resampled.
        const envelopeFrom = Math.max(0, from - Math.round((ENVELOPE_OVERLAP - 1) * samplesPerColumn))
        let low = 0
        let high = 0
        for (let i = envelopeFrom; i < to; i++) {
          const sample = data[i]
          if (sample < low) low = sample
          else if (sample > high) high = sample
        }

        // Crossings are counted over a wider window than the column itself. A column is
        // only ~120 samples, which quantises the estimate to steps of nearly 200Hz and
        // makes the colour march in visible blocks; four columns of context is still
        // local enough to follow a hi-hat, and reads as a gradient rather than a staircase.
        const windowStart = Math.max(0, from - TONE_WINDOW_COLUMNS * samplesPerColumn)
        let crossings = 0
        let previous = data[Math.floor(windowStart)]
        for (let i = Math.floor(windowStart) + 1; i < to; i++) {
          const sample = data[i]
          if ((sample < 0) !== (previous < 0)) crossings++
          previous = sample
        }
        envelope.min[envelope.head] = low
        envelope.max[envelope.head] = high
        envelope.tone[envelope.head] = brightnessOf(
          crossings,
          to - Math.floor(windowStart),
          tap.context.sampleRate
        )
        envelope.head = (envelope.head + 1) % envelope.columns
      }
    }
    envelope.lastTime = surface.time

    // Oldest at the left, newest at the right - the direction the sound travelled.
    const ramp = tintRef.current === 'accent' ? null : palette.wave
    context.fillStyle = palette.primary
    let current = palette.primary
    const scale = mid - 1
    for (let x = 0; x < envelope.columns; x++) {
      const index = (envelope.head + x) % envelope.columns
      const low = envelope.min[index]
      const high = envelope.max[index]
      if (low === 0 && high === 0) continue
      if (ramp) {
        const tone = envelope.tone[index]
        const next = ramp[Math.min(ramp.length - 1, Math.floor(tone * ramp.length))]
        if (next !== current) {
          context.fillStyle = next
          current = next
        }
      }
      // Older columns fade out, so the leading edge reads as "now".
      context.globalAlpha = OLDEST_ALPHA + (1 - OLDEST_ALPHA) * (x / envelope.columns)
      // Snapped like the centre line: a fractional top and bottom means every column is
      // capped with a half-lit row, and across the whole trace that reads as softness.
      const top = Math.round((mid - high * scale) * ratio) * step
      const bottom = Math.round((mid - low * scale) * ratio) * step
      context.fillRect(x * step, top, step, Math.max(step, bottom - top))
    }
    context.globalAlpha = 1
  }

  /** The trace is the last few seconds of sound - once it's stale, it's noise. */
  const clear = (): void => {
    const envelope = envelopeRef.current
    if (!envelope) return
    envelope.min.fill(0)
    envelope.max.fill(0)
    envelope.tone.fill(0)
    envelope.head = 0
    envelope.lastTime = 0
    envelope.carry = 0
  }

  const { containerRef, canvasRef } = useVisualizerCanvas(draw, { resize, clear })
  return (
    <Panel name="Waveform" {...props}>
      <Plot containerRef={containerRef} canvasRef={canvasRef} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ level meter */

const TICKS_DB = [-48, -36, -24, -12, -6, 0]

export function LevelMeter(props: VisualizerProps): React.JSX.Element {
  const vertical = props.orientation === 'horizontal'
  const headroom = headroomDb(useLibrary((state) => state.settings.visualizerHeadroomDb))
  const meterRangeDb = 60 + headroom
  const meterZero = 60 / meterRangeDb
  const leftRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const rightRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const holdsRef = useRef<[Hold, Hold]>([
    { value: 0, at: 0 },
    { value: 0, at: 0 }
  ])
  const fillRef = useRef<CanvasGradient | null>(null)

  const resize = (surface: Surface): void => {
    // The gradient runs along whichever axis the meter grows on, so the top of the ramp
    // always sits at the full-scale end. The whole ramp is spread across it rather than
    // the first colour holding for four fifths and then jumping to the last - a meter is
    // the one place where "how far along" is the entire message.
    const fill = vertical
      ? surface.context.createLinearGradient(0, surface.height, 0, 0)
      : surface.context.createLinearGradient(0, 0, surface.width, 0)
    const wave = surface.palette.wave
    for (let i = 0; i < wave.length; i++) {
      fill.addColorStop(i / (wave.length - 1), wave[i])
    }
    fillRef.current = fill
  }

  const draw = (surface: Surface, active: boolean): void => {
    const tap = getAudioTap()
    const { context, width, height, palette } = surface
    context.clearRect(0, 0, width, height)
    if (!tap || !fillRef.current) return

    const size = tap.mono.fftSize
    const left = floats(leftRef, size)
    const right = floats(rightRef, size)
    if (active) {
      tap.left.getFloatTimeDomainData(left)
      tap.right.getFloatTimeDomainData(right)
    } else {
      left.fill(0)
      right.fill(0)
    }

    // The shared frame timestamp - every panel reading the clock separately would be
    // asking for the same number six times.
    const now = surface.time
    // Across the short axis: bar thickness and the pair's offset from the panel edge.
    const span = vertical ? width : height
    const barSize = Math.max(4, Math.min(20, (span - 10) / 2 - 2))
    const gap = 3
    const start = (span - (barSize * 2 + gap)) / 2
    const length = vertical ? height : width
    const peaks: [number, number] = [0, 0]

    // Ticks first, so the bars read as sitting on the scale.
    const thickness = barSize * 2 + gap
    context.fillStyle = palette.muted
    context.globalAlpha = 0.22
    for (const db of TICKS_DB) {
      const at = Math.round(((db + 60) / meterRangeDb) * (length - 1))
      if (vertical) context.fillRect(start, length - 1 - at, thickness, 1)
      else context.fillRect(at, start, 1, thickness)
    }
    context.globalAlpha = 1

    // The numbers on the scale. A meter without them says "loud-ish"; with them it says
    // how much headroom is left, which is the question anyone actually has.
    const room = vertical ? width - (start + thickness) : height - (start + thickness)
    const labelled = room >= 22
    if (labelled) {
      context.fillStyle = palette.muted
      context.globalAlpha = 0.75
      context.font = '9px system-ui, sans-serif'
      context.textAlign = vertical ? 'left' : 'center'
      context.textBaseline = vertical ? 'middle' : 'top'
      for (const db of TICKS_DB) {
        const at = Math.round(((db + 60) / meterRangeDb) * (length - 1))
        const text = db === 0 ? '0' : String(db)
        if (vertical) context.fillText(text, start + thickness + 3, length - 1 - at)
        else context.fillText(text, at, start + thickness + 2)
      }
      context.globalAlpha = 1
    }

    for (let channel = 0; channel < 2; channel++) {
      const samples = channel === 0 ? left : right
      let sum = 0
      let peak = 0
      for (let i = 0; i < samples.length; i++) {
        const value = samples[i]
        sum += value * value
        const magnitude = value < 0 ? -value : value
        if (magnitude > peak) peak = magnitude
      }
      const rms = toUnitDb(Math.sqrt(sum / samples.length)) * meterZero
      const held = updateHold(holdsRef.current[channel], toUnitDb(peak) * meterZero, now)
      const offset = start + channel * (barSize + gap)

      context.fillStyle = palette.border
      context.globalAlpha = 0.5
      if (vertical) context.fillRect(offset, 0, barSize, length)
      else context.fillRect(0, offset, length, barSize)
      context.globalAlpha = 1

      context.fillStyle = fillRef.current
      // Vertical meters fill upward from the bottom, which is the only way anyone reads one.
      if (vertical) context.fillRect(offset, length - rms * length, barSize, rms * length)
      else context.fillRect(0, offset, rms * length, barSize)

      if (held > 0.01) {
        context.fillStyle = held >= meterZero - 0.002 ? palette.hot : palette.foreground
        const at = Math.min(length - 2, held * length)
        if (vertical) context.fillRect(offset, length - at - 2, barSize, 2)
        else context.fillRect(at, offset, 2, barSize)
      }

      peaks[channel] = peak
    }

    // What the loudest channel is peaking at, in dBFS, since that is the number people
    // are watching for. Over is drawn in the hot colour: at 0dBFS it has already clipped.
    const loudest = Math.max(peaks[0], peaks[1])
    const rawDb = loudest > 0 ? 20 * Math.log10(loudest) : -Infinity
    const db = rawDb === -Infinity ? rawDb : Math.min(0, rawDb)
    context.font = '10px system-ui, sans-serif'
    context.textAlign = 'right'
    context.textBaseline = 'top'
    context.fillStyle = db >= -0.1 ? palette.hot : palette.foreground
    context.globalAlpha = db === -Infinity ? 0.35 : 0.9
    context.fillText(
      db === -Infinity ? '−∞ dB' : `${db > -10 ? db.toFixed(1) : Math.round(db)} dB`,
      width - 3,
      2
    )
    context.globalAlpha = 1
  }

  /** Peak holds freeze where they were when the sound stopped; drop them with it. */
  const clear = (): void => {
    for (const hold of holdsRef.current) {
      hold.value = 0
      hold.at = 0
    }
  }

  const { containerRef, canvasRef } = useVisualizerCanvas(draw, { resize, clear })
  return (
    <Panel name="Levels" {...props}>
      <Plot containerRef={containerRef} canvasRef={canvasRef} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ stereo field */

/** Points per frame in the goniometer - enough for a solid figure, cheap to stroke. */
const TRACE_POINTS = 480

/** `full` is the rotated square goniometer; `arc` is the DJ-deck half circle of dots. */
type StereoMode = 'full' | 'arc'

/** Dot size in the arc, in CSS pixels. */
const DOT = 2.5

export function StereoField(props: VisualizerProps): React.JSX.Element {
  const leftRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const rightRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  // Arc mode plots each point before it draws any, so it can batch by colour. Scratch
  // lives in refs like every other buffer here.
  const dotXRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const dotYRef = useRef<Float32Array<ArrayBuffer> | null>(null)
  const dotBandRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  // Arc is the default: it reads as width at a glance, where the goniometer needs
  // interpreting.
  const [mode, setMode] = useState<StereoMode>('arc')

  const resize = (surface: Surface): void => {
    surface.context.lineWidth = 1
    surface.context.lineJoin = 'round'
  }

  const draw = (surface: Surface, active: boolean): void => {
    const tap = getAudioTap()
    const { context, width, height, palette } = surface
    const arc = mode === 'arc'

    // A strip at the bottom carries correlation; the plot owns everything above it.
    const stripHeight = 3
    const plotHeight = Math.max(1, height - stripHeight - 4)

    if (active) {
      // Phosphor decay instead of a hard clear - the trace keeps a readable tail.
      context.globalCompositeOperation = 'destination-out'
      context.fillStyle = '#000'
      // Slow decay: at 0.3 the trace was erased about as fast as it was drawn, leaving
      // a couple of faint pixels. This holds a readable tail for a few hundred ms.
      context.globalAlpha = 0.12
      context.fillRect(0, 0, width, height)
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
    } else {
      context.clearRect(0, 0, width, height)
    }

    const centerX = width / 2
    // The arc stands on the bottom of the plot area, so the half circle gets the full
    // height instead of the top half of a square.
    const centerY = arc ? plotHeight - 1 : plotHeight / 2
    const radius = arc
      ? Math.max(4, Math.min(centerX - 2, plotHeight - 2))
      : Math.max(4, Math.min(centerX, plotHeight / 2) - 2)

    context.strokeStyle = palette.muted
    context.globalAlpha = 0.5
    context.lineWidth = 1
    context.beginPath()
    if (arc) {
      context.arc(centerX, centerY, radius, Math.PI, 0)
      context.moveTo(centerX - radius, centerY)
      context.lineTo(centerX + radius, centerY)
      // Centre tick: mono content piles up on it, so it's the line you actually read.
      context.moveTo(centerX, centerY - radius)
      context.lineTo(centerX, centerY - radius * 0.82)
    } else {
      context.arc(centerX, centerY, radius, 0, Math.PI * 2)
      context.moveTo(centerX, centerY - radius)
      context.lineTo(centerX, centerY + radius)
    }
    context.stroke()
    context.globalAlpha = 1
    if (!tap) return

    const size = tap.mono.fftSize
    const left = floats(leftRef, size)
    const right = floats(rightRef, size)
    if (!active) return
    tap.left.getFloatTimeDomainData(left)
    tap.right.getFloatTimeDomainData(right)

    const step = Math.max(1, Math.floor(size / TRACE_POINTS))
    const points = Math.ceil(size / step)
    const scale = radius * 0.72
    const bands = palette.bands
    const dotX = floats(dotXRef, points)
    const dotY = floats(dotYRef, points)
    const dotBand = bytes(dotBandRef, points)

    if (!arc) {
      // Rotated 45°: mono content stands up as a vertical line, out-of-phase lies flat.
      // Drawn additively so where the trace crosses itself it burns brighter, which is
      // what makes the shape legible rather than a faint scribble.
      context.globalCompositeOperation = 'lighter'
      context.strokeStyle = palette.primary
      context.lineWidth = 1.75
      context.globalAlpha = 0.9
      context.beginPath()
    }

    let correlation = 0
    let energyLeft = 0
    let energyRight = 0
    let dots = 0
    for (let i = 0, n = 0; i < size; i += step, n++) {
      const l = left[i]
      const r = right[i]
      correlation += l * r
      energyLeft += l * l
      energyRight += r * r

      if (!arc) {
        const x = centerX + (l - r) * scale
        const y = centerY - (l + r) * scale
        if (n === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
        continue
      }

      // Angle is where the pair sits between hard left and hard right, radius is how loud
      // it was. Magnitudes only: the arc says nothing about phase, which is what the
      // correlation strip underneath is for.
      const magnitude = Math.sqrt(l * l + r * r)
      if (magnitude < 0.002) continue
      const absLeft = l < 0 ? -l : l
      const absRight = r < 0 ? -r : r
      const pan = Math.atan2(absRight, absLeft) / (Math.PI / 2)
      const angle = Math.PI * (1 - pan)
      // Radius on the dB scale, not linear: music sits well below full scale, so a linear
      // one would pile every dot into a blob at the origin instead of spreading an arc.
      const reach = radius * toUnitDb(magnitude)
      dotX[dots] = centerX + Math.cos(angle) * reach
      dotY[dots] = centerY - Math.sin(angle) * reach
      // Hot at the edges, cool up the middle: the colour reads as width, rather than as
      // decoration that happens to tell left from right.
      dotBand[dots] = Math.min(bands.length - 1, (Math.abs(pan - 0.5) * 2 * bands.length) | 0)
      dots++
    }

    if (arc) {
      // Same batching as the spectrum: a fill per colour band, not per dot. Additive so
      // a dense cluster reads as bright rather than flat.
      context.globalCompositeOperation = 'lighter'
      context.globalAlpha = 1
      for (let band = 0; band < bands.length; band++) {
        let drew = false
        context.beginPath()
        for (let i = 0; i < dots; i++) {
          if (dotBand[i] !== band) continue
          context.rect(dotX[i] - DOT / 2, dotY[i] - DOT / 2, DOT, DOT)
          drew = true
        }
        if (!drew) continue
        context.fillStyle = bands[band]
        context.fill()
      }
    } else {
      context.stroke()
    }
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = 1
    context.lineWidth = 1

    const denominator = Math.sqrt(energyLeft * energyRight)
    const phase = denominator > 1e-9 ? correlation / denominator : 0
    const stripY = height - stripHeight
    context.fillStyle = palette.border
    context.globalAlpha = 0.5
    context.fillRect(0, stripY, width, stripHeight)
    context.globalAlpha = 1
    // Centre is uncorrelated, right is mono-compatible, left means phase trouble.
    context.fillStyle = phase < 0 ? palette.hot : palette.primary
    const from = Math.min(centerX, centerX + phase * centerX)
    context.fillRect(from, stripY, Math.abs(phase) * centerX, stripHeight)
    context.fillStyle = palette.muted
    context.fillRect(Math.round(centerX), stripY - 1, 1, stripHeight + 2)
  }

  // No clear: every dot comes from the samples in hand, so silence already draws nothing.
  const { containerRef, canvasRef, repaint } = useVisualizerCanvas(draw, { resize })

  // Paused audio means no frames, so switching shape has to ask for the repaint itself.
  useEffect(repaint, [mode, repaint])

  return (
    <Panel
      name="Stereo field"
      {...props}
      controls={
        <PanelToggle
          label={mode === 'full' ? 'Full' : 'Arc'}
          title={mode === 'full' ? 'Switch to half circle' : 'Switch to full goniometer'}
          onClick={() => setMode((current) => (current === 'full' ? 'arc' : 'full'))}
        />
      }
    >
      <Plot containerRef={containerRef} canvasRef={canvasRef} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ registry */

export type VisualizerId =
  | 'spectrogram'
  | 'spectrum'
  | 'wave'
  | 'scope'
  | 'levels'
  | 'stereo'

export interface VisualizerDefinition {
  id: VisualizerId
  name: string
  /** Share of the stack's height relative to the other enabled panels. */
  grow: number
  minHeight: number
  render: (onDisable: () => void, orientation: StackOrientation) => React.JSX.Element
}

/** Canonical order - the stack always renders in this order, whatever `enabled` says. */
export const VISUALIZERS: readonly VisualizerDefinition[] = [
  {
    id: 'spectrogram',
    name: 'Spectrogram',
    grow: 1.6,
    minHeight: 64,
    render: (onDisable) => <Spectrogram onDisable={onDisable} />
  },
  {
    id: 'spectrum',
    name: 'Spectrum',
    grow: 1,
    minHeight: 56,
    render: (onDisable) => <FrequencyBars onDisable={onDisable} />
  },
  {
    id: 'wave',
    name: 'Waveform',
    grow: 1,
    minHeight: 56,
    render: (onDisable) => <RollingWaveform onDisable={onDisable} />
  },
  {
    id: 'scope',
    name: 'Scope',
    grow: 1,
    minHeight: 56,
    render: (onDisable) => <Oscilloscope onDisable={onDisable} />
  },
  {
    id: 'levels',
    name: 'Levels',
    grow: 0.35,
    minHeight: 44,
    render: (onDisable, orientation) => <LevelMeter onDisable={onDisable} orientation={orientation} />
  },
  {
    id: 'stereo',
    name: 'Stereo field',
    grow: 1.1,
    minHeight: 72,
    render: (onDisable) => <StereoField onDisable={onDisable} />
  }
]

export interface VisualizerStackProps {
  /** Which panels to show. Order is ignored; `VISUALIZERS` defines it. */
  enabled: readonly VisualizerId[]
  /** Called with the new enabled set - the caller owns persistence. */
  onChange: (next: VisualizerId[]) => void
  className?: string
  /** Side by side instead of stacked - for the wide, short visualizer-only window. */
  orientation?: 'vertical' | 'horizontal'
}

/**
 * Stacks the enabled visualizers vertically, each taking a weighted share of the height.
 * Disabled ones stay reachable from the row of chips at the bottom.
 */
export function VisualizerStack({
  enabled,
  onChange,
  className,
  orientation = 'vertical'
}: VisualizerStackProps): React.JSX.Element {
  const active = VISUALIZERS.filter((item) => enabled.includes(item.id))
  const inactive = VISUALIZERS.filter((item) => !enabled.includes(item.id))
  const horizontal = orientation === 'horizontal'

  const set = (id: VisualizerId, on: boolean): void => {
    onChange(
      VISUALIZERS.filter((item) =>
        item.id === id ? on : enabled.includes(item.id)
      ).map((item) => item.id)
    )
  }

  return (
    <div
      className={cn('flex gap-1', horizontal ? 'min-w-0 flex-row' : 'min-h-0 flex-col', className)}
    >
      {active.map((item) => (
        <div
          key={item.id}
          className={horizontal ? 'min-w-0' : 'min-h-0'}
          style={
            horizontal
              ? // Side by side the panels share width instead of height, and the
                // per-panel minimums become horizontal ones.
                { flexGrow: item.grow, flexBasis: 0, minWidth: item.minHeight * 1.6 }
              : { flexGrow: item.grow, flexBasis: 0, minHeight: item.minHeight }
          }
        >
          {item.render(() => set(item.id, false), orientation)}
        </div>
      ))}

      {active.length === 0 && (
        <p className="flex-1 py-4 text-center text-[11px] text-muted-foreground/60">
          No visualizers enabled.
        </p>
      )}

      {inactive.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-0.5 pb-0.5">
          {inactive.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => set(item.id, true)}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-2.5 w-2.5" />
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
