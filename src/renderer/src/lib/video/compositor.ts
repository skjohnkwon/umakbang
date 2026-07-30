/**
 * Drawing one frame of a project.
 *
 * This is the only place a frame is composed. The preview calls it on an animation frame and
 * the export calls it on the same loop while a `MediaRecorder` samples the canvas, so what
 * gets posted is by construction the thing that was arranged on screen. Writing a second
 * "render for export" path is the classic way to ship a video whose caption sits somewhere
 * else than it did in the editor, and there is no way to notice until it is public.
 *
 * Everything is a pure function of (project, sources, time). Nothing here reads the clock,
 * so scrubbing the preview backwards draws exactly what that moment will encode to - which
 * is also why the waveform and the spectrum are precomputed from the decoded audio rather
 * than taken off a live `AnalyserNode`. An analyser can only ever tell you about now.
 */

import {
  ASPECTS,
  layerAlpha,
  projectDuration,
  type ImageLayer,
  type Layer,
  type Rect,
  type ShapeLayer,
  type SpectrumLayer,
  type TextLayer,
  type VideoLayer,
  type VideoProject,
  type VideoVisualizerId,
  type VideoVisualizerOrientation,
  type VisualizersLayer,
  type WaveformLayer
} from '@shared/video'
import {
  LEVEL_ENCODE_CEILING_DB,
  LEVEL_FLOOR_DB,
  SPECTRUM_RANGE_DB,
  type ClipAnalysis
} from './analysis'

/** What the compositor needs resolved before it can draw. */
export interface Sources {
  /** Video elements by layer id, already seeked or playing. */
  videos: Map<string, HTMLVideoElement>
  /** Images by layer id. */
  images: Map<string, HTMLImageElement>
  /** The audio, measured. Null while it is still being worked out. */
  analysis: ClipAnalysis | null
  /** Source-relative time currently being heard; null in a timeline gap. */
  analysisTime: number | null
  /** User-selected empty space above the normal 0dB point. */
  headroomDb: number
  /** The app's visualizer ramp, low to high, for layers set to `ramp`. */
  ramp: readonly string[]
}

export interface FrameSize {
  width: number
  height: number
}

export function frameSize(project: VideoProject): FrameSize {
  return ASPECTS[project.aspect]
}

/** A layer's box in device pixels. */
function boxOf(rect: Rect, size: FrameSize): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.x * size.width,
    y: rect.y * size.height,
    w: rect.w * size.width,
    h: rect.h * size.height
  }
}

/**
 * A rounded rectangle path, clamped so the radius can never exceed the box.
 *
 * `roundRect` is in this Chromium, but it throws on a radius larger than half the shorter
 * side rather than clamping, and the radius here is a fraction the user drags.
 */
function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/**
 * Draws a source into a box, honouring the crop and the fit.
 *
 * `crop` is in the source's own fractions and is applied first: it is which part of the
 * recording you are looking at. `fit` then decides what happens if that cropped piece is
 * still a different shape from the box - cover fills and overflows, contain fits and letters
 * the rest. Doing it in the other order would mean a crop that changed meaning every time
 * the box was resized.
 */
function drawSource(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  crop: Rect,
  fit: 'cover' | 'contain' | 'stretch',
  box: { x: number; y: number; w: number; h: number },
  mirror: boolean
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0) return

  const sx = Math.max(0, crop.x) * sourceWidth
  const sy = Math.max(0, crop.y) * sourceHeight
  const sw = Math.max(1, Math.min(crop.w, 1 - crop.x) * sourceWidth)
  const sh = Math.max(1, Math.min(crop.h, 1 - crop.y) * sourceHeight)

  let dx = box.x
  let dy = box.y
  let dw = box.w
  let dh = box.h
  let cx = sx
  let cy = sy
  let cw = sw
  let ch = sh

  if (fit !== 'stretch') {
    const sourceAspect = sw / sh
    const boxAspect = box.w / box.h
    if (fit === 'cover') {
      // Take a narrower slice of the source rather than overflowing the box, so the clip is
      // implicit and the caller does not have to keep a separate clip path per layer.
      if (sourceAspect > boxAspect) {
        cw = sh * boxAspect
        cx = sx + (sw - cw) / 2
      } else {
        ch = sw / boxAspect
        cy = sy + (sh - ch) / 2
      }
    } else {
      if (sourceAspect > boxAspect) {
        dh = box.w / sourceAspect
        dy = box.y + (box.h - dh) / 2
      } else {
        dw = box.h * sourceAspect
        dx = box.x + (box.w - dw) / 2
      }
    }
  }

  if (mirror) {
    ctx.save()
    ctx.translate(dx + dw, dy)
    ctx.scale(-1, 1)
    ctx.drawImage(source, cx, cy, cw, ch, 0, 0, dw, dh)
    ctx.restore()
    return
  }
  ctx.drawImage(source, cx, cy, cw, ch, dx, dy, dw, dh)
}

/** Where in the ramp a value sits, as a colour. */
function rampColor(ramp: readonly string[], t: number): string {
  if (ramp.length === 0) return '#ffffff'
  const at = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))))
  return ramp[at]
}

function drawVideoLayer(
  ctx: CanvasRenderingContext2D,
  layer: VideoLayer,
  sources: Sources,
  size: FrameSize
): void {
  const element = sources.videos.get(layer.id)
  // `readyState < 2` is HAVE_NOTHING or HAVE_METADATA: the element knows its size but has no
  // frame to paint, and `drawImage` would silently draw nothing.
  if (!element || element.readyState < 2) return
  const box = boxOf(layer.frame, size)
  drawSource(
    ctx,
    element,
    element.videoWidth,
    element.videoHeight,
    layer.crop,
    layer.fit,
    box,
    layer.mirror
  )
}

function drawImageLayer(
  ctx: CanvasRenderingContext2D,
  layer: ImageLayer,
  sources: Sources,
  size: FrameSize
): void {
  const element = sources.images.get(layer.id)
  if (!element || !element.complete || element.naturalWidth === 0) return
  const box = boxOf(layer.frame, size)
  drawSource(
    ctx,
    element,
    element.naturalWidth,
    element.naturalHeight,
    layer.crop,
    layer.fit,
    box,
    false
  )
}

function drawShapeLayer(
  ctx: CanvasRenderingContext2D,
  layer: ShapeLayer,
  size: FrameSize
): void {
  const box = boxOf(layer.frame, size)
  if (layer.color2) {
    const gradient = ctx.createLinearGradient(box.x, box.y, box.x, box.y + box.h)
    gradient.addColorStop(0, layer.color)
    gradient.addColorStop(1, layer.color2)
    ctx.fillStyle = gradient
  } else {
    ctx.fillStyle = layer.color
  }
  ctx.fillRect(box.x, box.y, box.w, box.h)
}

/**
 * The waveform, from the peaks measured over the clip.
 *
 * Two behaviours, because they say different things. Fixed draws the whole clip with a
 * playhead crossing it, which shows the shape of the beat. Scrolling draws a window either
 * side of the playhead moving under a fixed centre, which shows the moment - and is what
 * most of these reels use, because it moves whether or not the music does.
 */
function drawWaveformLayer(
  ctx: CanvasRenderingContext2D,
  layer: WaveformLayer,
  sources: Sources,
  size: FrameSize,
  _time: number,
  _duration: number
): void {
  const analysis = sources.analysis
  if (!analysis || sources.analysisTime === null) return
  const box = boxOf(layer.frame, size)
  const bars = Math.max(2, Math.round(layer.bars))
  const slot = box.w / bars
  const width = Math.max(1, slot * (1 - layer.gap))
  const analysisTime = Math.max(0, sources.analysisTime)
  const progress =
    analysis.duration > 0 ? Math.max(0, Math.min(1, analysisTime / analysis.duration)) : 0

  // Which stretch of the clip is on screen. Fixed is all of it; scrolling is a window that
  // runs off both ends, which is deliberate - a waveform that stopped scrolling for the
  // first and last few seconds would read as the video having frozen.
  const columns = analysis.columns
  const total = analysis.columnCount
  let firstColumn = 0
  let spanColumns = total
  if (layer.scroll) {
    const span = Math.max(0.5, layer.window * 2)
    spanColumns = Math.max(4, (span / Math.max(0.05, analysis.duration)) * total)
    // Keep the display causal: the sample being heard enters at the right edge and then
    // travels left. Centering now in the window exposed future peaks before their audio.
    firstColumn = progress * total - spanColumns
  }

  ctx.save()
  for (let bar = 0; bar < bars; bar += 1) {
    const at = firstColumn + ((bar + 0.5) / bars) * spanColumns
    const index = Math.round(at)
    let low = 0
    let high = 0
    if (index >= 0 && index < total) {
      low = columns[index * 2]
      high = columns[index * 2 + 1]
    }
    const amplitude = Math.max(Math.abs(low), Math.abs(high))
    if (amplitude <= 0) continue

    const x = box.x + bar * slot + (slot - width) / 2
    const played = layer.scroll ? at <= progress * total : (bar + 0.5) / bars <= progress

    if (layer.colorMode === 'ramp') {
      // Match the player waveform: hue follows local tonal brightness, while the bar's
      // height continues to carry amplitude. This is precomputed, so a paused/exported
      // frame has exactly the same colour as live playback at that time.
      const tone = index >= 0 && index < total ? (analysis.tones[index] ?? 0) / 255 : amplitude
      ctx.fillStyle = rampColor(sources.ramp, tone)
    } else ctx.fillStyle = layer.color
    if (layer.playedColor && played) ctx.fillStyle = layer.playedColor

    let y: number
    let h: number
    if (layer.style === 'mirror') {
      h = Math.max(1, amplitude * box.h)
      y = box.y + (box.h - h) / 2
    } else if (layer.style === 'bars') {
      h = Math.max(1, amplitude * box.h)
      y = box.y + box.h - h
    } else if (layer.style === 'filled') {
      h = Math.max(1, ((high - low) / 2) * box.h)
      y = box.y + box.h / 2 - ((high + low) / 4) * box.h - h / 2
    } else {
      // 'line' draws a constant-thickness trace at the sample's own height.
      h = Math.max(2, box.h * 0.03)
      y = box.y + box.h / 2 - ((high + low) / 4) * box.h
    }

    if (layer.rounded && width > 2) {
      roundedPath(ctx, x, y, width, h, Math.min(width / 2, h / 2))
      ctx.fill()
    } else {
      ctx.fillRect(x, y, width, h)
    }
  }
  ctx.restore()
}

function drawSpectrumLayer(
  ctx: CanvasRenderingContext2D,
  layer: SpectrumLayer,
  sources: Sources,
  size: FrameSize,
  _time: number
): void {
  const analysis = sources.analysis
  if (!analysis || sources.analysisTime === null) return
  const box = boxOf(layer.frame, size)
  const bars = Math.max(2, Math.round(layer.bars))
  const slot = box.w / bars
  const width = Math.max(1, slot * (1 - layer.gap))

  const frame = Math.max(
    0,
    Math.min(analysis.frameCount - 1, Math.round(Math.max(0, sources.analysisTime) * analysis.frameRate))
  )
  // Smoothing reads backwards over frames that have already happened rather than keeping
  // state between calls, so scrubbing to a moment draws the same bars the export will.
  const held = Math.max(0, Math.min(0.95, layer.smoothing))
  const lookback = held > 0 ? Math.min(frame, Math.round(held * 12)) : 0
  const spectrumZero = SPECTRUM_RANGE_DB / (SPECTRUM_RANGE_DB + sources.headroomDb)

  ctx.save()
  for (let bar = 0; bar < bars; bar += 1) {
    const band = Math.min(analysis.bandCount - 1, Math.floor((bar / bars) * analysis.bandCount))
    let value = 0
    for (let back = 0; back <= lookback; back += 1) {
      const at = (frame - back) * analysis.bandCount + band
      const sample = (analysis.bands[at] / 255) * spectrumZero
      value = Math.max(value, sample * (1 - (back / (lookback + 1)) * 0.55))
    }
    if (value <= 0.002) continue

    const x = box.x + bar * slot + (slot - width) / 2
    if (layer.colorMode === 'ramp') ctx.fillStyle = rampColor(sources.ramp, value)
    else ctx.fillStyle = layer.color

    let y: number
    let h: number
    if (layer.mirror) {
      h = Math.max(1, value * box.h)
      y = box.y + (box.h - h) / 2
    } else {
      h = Math.max(1, value * box.h)
      y = box.y + box.h - h
    }
    if (layer.rounded && width > 2) {
      roundedPath(ctx, x, y, width, h, Math.min(width / 2, h / 2))
      ctx.fill()
    } else {
      ctx.fillRect(x, y, width, h)
    }
  }
  ctx.restore()
}


type PixelBox = { x: number; y: number; w: number; h: number }

function normalizedBox(box: PixelBox, size: FrameSize): Rect {
  return { x: box.x / size.width, y: box.y / size.height, w: box.w / size.width, h: box.h / size.height }
}

function visualizerColor(layer: VisualizersLayer, sources: Sources, amount: number): string {
  return layer.colorMode === 'ramp' ? rampColor(sources.ramp, amount) : layer.color
}

function analysisFrame(analysis: ClipAnalysis, time: number): number {
  return Math.max(0, Math.min(analysis.frameCount - 1, Math.round(time * analysis.frameRate)))
}

function drawSpectrogramPanel(ctx: CanvasRenderingContext2D, box: PixelBox, layer: VisualizersLayer, sources: Sources, time: number): void {
  const analysis = sources.analysis
  if (!analysis || box.w <= 0 || box.h <= 0) return
  const current = analysisFrame(analysis, time)
  const columns = Math.max(12, Math.min(72, Math.floor(box.w / 3)))
  const rows = Math.max(8, Math.min(32, analysis.bandCount))
  const history = Math.max(columns, Math.round(analysis.frameRate * 3))
  const cellW = box.w / columns
  const cellH = box.h / rows
  for (let x = 0; x < columns; x += 1) {
    const frame = current - history + Math.round((x / Math.max(1, columns - 1)) * history)
    if (frame < 0 || frame >= analysis.frameCount) continue
    for (let y = 0; y < rows; y += 1) {
      const band = Math.min(analysis.bandCount - 1, Math.floor(((rows - y - 1) / rows) * analysis.bandCount))
      const amount = analysis.bands[frame * analysis.bandCount + band] / 255
      if (amount < 0.025) continue
      ctx.save()
      ctx.globalAlpha = Math.max(0.14, amount)
      ctx.fillStyle = visualizerColor(layer, sources, amount)
      ctx.fillRect(box.x + x * cellW, box.y + y * cellH, Math.ceil(cellW), Math.ceil(cellH))
      ctx.restore()
    }
  }
}

function drawScopePanel(ctx: CanvasRenderingContext2D, box: PixelBox, layer: VisualizersLayer, sources: Sources, time: number): void {
  const analysis = sources.analysis
  if (!analysis || analysis.scopePoints < 2) return
  const frame = analysisFrame(analysis, time)
  ctx.beginPath()
  for (let point = 0; point < analysis.scopePoints; point += 1) {
    const sample = analysis.scope[frame * analysis.scopePoints + point] / 127
    const x = box.x + (point / (analysis.scopePoints - 1)) * box.w
    const y = box.y + box.h / 2 - sample * box.h * 0.44
    if (point === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = visualizerColor(layer, sources, 0.76)
  ctx.lineWidth = Math.max(1.5, box.h * 0.025)
  ctx.lineJoin = 'round'
  ctx.stroke()
}

function drawLevelsPanel(
  ctx: CanvasRenderingContext2D,
  box: PixelBox,
  layer: VisualizersLayer,
  sources: Sources,
  time: number,
  orientation: VideoVisualizerOrientation
): void {
  const analysis = sources.analysis
  if (!analysis) return
  const frame = analysisFrame(analysis, time)
  const horizontal = orientation === 'horizontal'
  const short = horizontal ? box.h : box.w
  const barSize = Math.max(3, short * 0.28)
  const gap = Math.max(2, short * 0.1)
  const pairSize = barSize * 2 + gap
  const pairStart = (short - pairSize) / 2
  let meterFill: string | CanvasGradient = layer.color
  if (layer.colorMode === 'ramp' && sources.ramp.length > 0) {
    const gradient = horizontal
      ? ctx.createLinearGradient(box.x, 0, box.x + box.w, 0)
      : ctx.createLinearGradient(0, box.y + box.h, 0, box.y)
    sources.ramp.forEach((color, index) => {
      gradient.addColorStop(index / Math.max(1, sources.ramp.length - 1), color)
    })
    meterFill = gradient
  }
  for (let channel = 0; channel < 2; channel += 1) {
    const encoded = analysis.levels[frame * 2 + channel] / 255
    const db = LEVEL_FLOOR_DB + encoded * (LEVEL_ENCODE_CEILING_DB - LEVEL_FLOOR_DB)
    const amount = Math.max(
      0,
      Math.min(1, (db - LEVEL_FLOOR_DB) / (sources.headroomDb - LEVEL_FLOOR_DB))
    )
    const cross = pairStart + channel * (barSize + gap)
    ctx.fillStyle = 'rgba(255,255,255,0.11)'
    if (horizontal) ctx.fillRect(box.x, box.y + cross, box.w, barSize)
    else ctx.fillRect(box.x + cross, box.y, barSize, box.h)
    if (amount <= 0) continue
    // The meter is a window onto one fixed ramp, so growing level reveals the colours
    // instead of repainting the whole bar a different colour each frame.
    ctx.fillStyle = meterFill
    if (horizontal) {
      ctx.fillRect(box.x, box.y + cross, Math.max(1, box.w * amount), barSize)
    } else {
      ctx.fillRect(box.x + cross, box.y + box.h * (1 - amount), barSize, Math.max(1, box.h * amount))
    }
  }
}

function drawStereoPanel(ctx: CanvasRenderingContext2D, box: PixelBox, layer: VisualizersLayer, sources: Sources, time: number): void {
  const analysis = sources.analysis
  if (!analysis || analysis.stereoPoints < 2) return
  const frame = analysisFrame(analysis, time)
  const centerX = box.x + box.w / 2
  const arc = layer.stereoMode !== 'fill'
  const radius = Math.max(2, Math.min(box.w / 2, arc ? box.h * 0.9 : box.h / 2) * 0.9)
  // Center the semicircle's visible bounds, not its off-screen circle centre.
  const centerY = arc ? box.y + box.h / 2 + radius / 2 : box.y + box.h / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(centerX, centerY, radius, arc ? Math.PI : 0, Math.PI * 2)
  ctx.stroke()

  if (arc) {
    const dot = Math.max(1, Math.min(3, box.w * 0.018))
    ctx.save()
    // The player burns overlapping dots brighter; doing the same here keeps dense stereo
    // information legible without introducing state that would make scrubbing inconsistent.
    ctx.globalCompositeOperation = 'lighter'
    for (let point = 0; point < analysis.stereoPoints; point += 1) {
      const at = (frame * analysis.stereoPoints + point) * 2
      const left = analysis.stereo[at] / 127
      const right = analysis.stereo[at + 1] / 127
      const magnitude = Math.min(1, Math.sqrt(left * left + right * right))
      if (magnitude < 0.015) continue
      const pan = Math.atan2(Math.abs(right), Math.abs(left)) / (Math.PI / 2)
      const angle = Math.PI * (1 - pan)
      const reach = radius * Math.sqrt(magnitude)
      const x = centerX + Math.cos(angle) * reach
      const y = centerY - Math.sin(angle) * reach
      // Hot at the stereo edges and cool through the mono centre, matching the audio-player
      // stereo field. In solid mode the user's chosen colour remains authoritative.
      ctx.fillStyle = visualizerColor(layer, sources, Math.abs(pan - 0.5) * 2)
      ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot)
    }
    ctx.restore()
    return
  }

  ctx.beginPath()
  for (let point = 0; point < analysis.stereoPoints; point += 1) {
    const at = (frame * analysis.stereoPoints + point) * 2
    const left = analysis.stereo[at] / 127
    const right = analysis.stereo[at + 1] / 127
    const x = centerX + ((left - right) / 2) * radius
    const y = centerY - ((left + right) / 2) * radius
    if (point === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()

  let paint: string | CanvasGradient = layer.color
  if (layer.colorMode === 'ramp' && sources.ramp.length > 0) {
    // A mirrored horizontal ramp carries the same message as the arc dots: cool in the
    // mono centre, increasingly hot toward either stereo edge.
    const gradient = ctx.createLinearGradient(centerX - radius, centerY, centerX + radius, centerY)
    const last = Math.max(1, sources.ramp.length - 1)
    for (let index = 0; index < sources.ramp.length; index += 1) {
      gradient.addColorStop(index / last / 2, sources.ramp[sources.ramp.length - 1 - index])
      gradient.addColorStop(0.5 + index / last / 2, sources.ramp[index])
    }
    paint = gradient
  }
  ctx.fillStyle = paint
  ctx.globalAlpha *= 0.28
  ctx.fill()
  ctx.globalAlpha /= 0.28
  ctx.strokeStyle = paint
  ctx.lineWidth = Math.max(1, box.h * 0.018)
  ctx.stroke()
}

/** Rotates a panel only when that visualizer explicitly asks for a vertical drawing axis. */
function withVisualizerOrientation(
  ctx: CanvasRenderingContext2D,
  box: PixelBox,
  orientation: VideoVisualizerOrientation,
  draw: (oriented: PixelBox) => void
): void {
  if (orientation === 'horizontal') {
    draw(box)
    return
  }
  ctx.save()
  ctx.translate(box.x + box.w, box.y)
  ctx.rotate(Math.PI / 2)
  draw({ x: 0, y: 0, w: box.h, h: box.w })
  ctx.restore()
}

function visualizerOrientation(
  layer: VisualizersLayer,
  visualizer: VideoVisualizerId
): VideoVisualizerOrientation {
  return layer.orientations?.[visualizer] ?? 'horizontal'
}

/** Draws the selected visualizers as one layer, side by side or as horizontal bands. */
function drawVisualizersLayer(ctx: CanvasRenderingContext2D, layer: VisualizersLayer, sources: Sources, size: FrameSize, time: number, duration: number): void {
  if (!sources.analysis || sources.analysisTime === null || layer.enabled.length === 0) return
  const analysisTime = Math.max(0, sources.analysisTime)
  const outer = boxOf(layer.frame, size)
  const bands = Boolean(layer.horizontalBands)
  const panelWidth = bands ? outer.w : outer.w / layer.enabled.length
  const panelHeight = bands ? outer.h / layer.enabled.length : outer.h
  ctx.save()
  ctx.beginPath()
  ctx.rect(outer.x, outer.y, outer.w, outer.h)
  ctx.clip()
  ctx.fillStyle = 'rgba(7, 10, 18, 0.58)'
  ctx.fillRect(outer.x, outer.y, outer.w, outer.h)
  layer.enabled.forEach((visualizer, index) => {
    const content: PixelBox = bands
      ? { x: outer.x, y: outer.y + index * panelHeight, w: panelWidth, h: panelHeight }
      : { x: outer.x + index * panelWidth, y: outer.y, w: panelWidth, h: panelHeight }
    const orientation = visualizerOrientation(layer, visualizer)
    if (visualizer === 'spectrogram') {
      withVisualizerOrientation(ctx, content, orientation, (box) =>
        drawSpectrogramPanel(ctx, box, layer, sources, analysisTime)
      )
    } else if (visualizer === 'scope') {
      withVisualizerOrientation(ctx, content, orientation, (box) =>
        drawScopePanel(ctx, box, layer, sources, analysisTime)
      )
    } else if (visualizer === 'levels') {
      drawLevelsPanel(ctx, content, layer, sources, analysisTime, orientation)
    } else if (visualizer === 'stereo') {
      withVisualizerOrientation(ctx, content, orientation, (box) =>
        drawStereoPanel(ctx, box, layer, sources, analysisTime)
      )
    } else if (visualizer === 'wave') {
      withVisualizerOrientation(ctx, content, orientation, (box) => {
        const wave: WaveformLayer = {
          ...layer,
          kind: 'waveform',
          frame: normalizedBox(box, size),
          style: 'mirror',
          bars: Math.max(10, Math.floor(box.w / 5)),
          gap: 0.62,
          playedColor: '',
          scroll: true,
          window: 0.75,
          rounded: false
        }
        drawWaveformLayer(ctx, wave, sources, size, time, duration)
      })
    } else {
      withVisualizerOrientation(ctx, content, orientation, (box) => {
        const spectrum: SpectrumLayer = {
          ...layer,
          kind: 'spectrum',
          frame: normalizedBox(box, size),
          bars: Math.max(8, Math.min(32, Math.floor(box.w / 5))),
          gap: 0.18,
          smoothing: 0.68,
          mirror: false,
          rounded: false
        }
        drawSpectrumLayer(ctx, spectrum, sources, size, time)
      })
    }
  })
  ctx.restore()
}

/**
 * Wraps text to the layer's width and draws it inside the box.
 *
 * The box is where the text is anchored, not a clip: a caption whose second line pushed past
 * the bottom of a hand-dragged rectangle would silently lose a word, and the user cannot see
 * the rectangle in the exported file to know why.
 */
function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  size: FrameSize
): void {
  const box = boxOf(layer.frame, size)
  const fontSize = layer.size * size.height
  if (fontSize < 1) return
  const text = layer.uppercase ? layer.text.toUpperCase() : layer.text
  if (!text.trim()) return

  ctx.save()
  ctx.font = `${layer.weight} ${fontSize}px ${layer.family}, system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.letterSpacing = `${layer.tracking * fontSize}px`

  // Explicit newlines are kept; everything else wraps to the box.
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = words[0]
    for (let at = 1; at < words.length; at += 1) {
      const candidate = `${line} ${words[at]}`
      if (ctx.measureText(candidate).width > box.w && line) {
        lines.push(line)
        line = words[at]
      } else {
        line = candidate
      }
    }
    lines.push(line)
  }

  const lineHeight = fontSize * layer.lineHeight
  const blockHeight = lines.length * lineHeight
  const startY = box.y + Math.max(0, (box.h - blockHeight) / 2)

  if (layer.background) {
    const padding = layer.padding * fontSize
    const widest = lines.reduce((most, line) => Math.max(most, ctx.measureText(line).width), 0)
    const plateX =
      layer.align === 'left'
        ? box.x
        : layer.align === 'right'
          ? box.x + box.w - widest
          : box.x + (box.w - widest) / 2
    ctx.fillStyle = layer.background
    roundedPath(
      ctx,
      plateX - padding,
      startY - padding * 0.6,
      widest + padding * 2,
      blockHeight + padding * 1.2,
      Math.min(fontSize * 0.35, (blockHeight + padding * 1.2) / 2)
    )
    ctx.fill()
  }

  ctx.textAlign = layer.align
  const x = layer.align === 'left' ? box.x : layer.align === 'right' ? box.x + box.w : box.x + box.w / 2

  if (layer.shadow > 0) {
    ctx.shadowColor = 'rgba(0,0,0,0.75)'
    ctx.shadowBlur = layer.shadow * fontSize
    ctx.shadowOffsetY = layer.shadow * fontSize * 0.25
  }

  lines.forEach((line, at) => {
    const y = startY + at * lineHeight
    if (layer.stroke > 0) {
      ctx.lineWidth = layer.stroke * fontSize
      ctx.strokeStyle = layer.strokeColor
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = layer.color
    ctx.fillText(line, x, y)
  })
  ctx.restore()
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  sources: Sources,
  size: FrameSize,
  time: number,
  duration: number
): void {
  switch (layer.kind) {
    case 'video':
      drawVideoLayer(ctx, layer, sources, size)
      break
    case 'image':
      drawImageLayer(ctx, layer, sources, size)
      break
    case 'shape':
      drawShapeLayer(ctx, layer, size)
      break
    case 'waveform':
      drawWaveformLayer(ctx, layer, sources, size, time, duration)
      break
    case 'spectrum':
      drawSpectrumLayer(ctx, layer, sources, size, time)
      break
    case 'visualizers':
      drawVisualizersLayer(ctx, layer, sources, size, time, duration)
      break
    case 'text':
      drawTextLayer(ctx, layer, size)
      break
    default:
      break
  }
}

/** Composes one frame. The canvas is expected to already be the frame's own size. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  sources: Sources,
  time: number
): void {
  const size = frameSize(project)
  const duration = projectDuration(project)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = project.background
  ctx.fillRect(0, 0, size.width, size.height)

  for (const layer of project.layers) {
    if (layer.hidden) continue
    const alpha = layerAlpha(layer, time, duration)
    if (alpha <= 0) continue

    ctx.save()
    ctx.globalAlpha = alpha
    drawLayer(ctx, layer, sources, size, time, duration)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}
