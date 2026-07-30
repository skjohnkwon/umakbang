/**
 * Measuring the clip once, up front, so every frame of it can be drawn from a table.
 *
 * The visualizers elsewhere in the app read an `AnalyserNode`, which is right for them: they
 * are watching whatever is playing now and there is no other answer to give. A video is the
 * opposite case. Its frames are drawn while scrubbing, drawn again during the export, and
 * have to come out the same both times, and an analyser can only ever describe the moment it
 * was asked. So the audio is decoded once and folded into two small tables - an envelope for
 * the waveform, a band spectrum per video frame - and the compositor indexes them by time.
 *
 * It also means the preview is honest at a stop. Pause on a moment and the bars stay where
 * that moment puts them, rather than collapsing to silence because nothing is playing.
 */

import { fft, hannWindow } from '@/lib/dsp'
import { brightnessOf } from '@/lib/peaks-core'

/** Envelope columns across the clip. Enough that a 1080-wide waveform never repeats one. */
const COLUMNS = 1200

/** Bands in the spectrum table, spread logarithmically across the audible range. */
const BANDS = 64

/** Window for each spectrum frame. 2048 at 44.1k is 46ms, which is a bar's worth of detail. */
const FFT_SIZE = 2048
const SCOPE_POINTS = 160
const STEREO_POINTS = 96

const MIN_HZ = 30
const MAX_HZ = 16000

/** dB window the bands are normalised over. Below the floor is drawn as nothing. */
const DB_FLOOR = -72
const DB_TOP = -8
export const SPECTRUM_RANGE_DB = DB_TOP - DB_FLOOR
export const LEVEL_FLOOR_DB = -60
/** Encoded above every selectable ceiling so changing the setting never needs a re-analysis. */
export const LEVEL_ENCODE_CEILING_DB = 24

/** Stores level independently of the user-selected display ceiling. */
function meterByte(rms: number): number {
  const db = 20 * Math.log10(rms + 1e-9)
  const unit =
    (db - LEVEL_FLOOR_DB) / (LEVEL_ENCODE_CEILING_DB - LEVEL_FLOOR_DB)
  return Math.max(0, Math.min(255, Math.round(unit * 255)))
}

export interface ClipAnalysis {
  /** min/max pairs, `columnCount * 2`, each in -1..1. */
  columns: Float32Array
  columnCount: number
  /** Tonal brightness for every waveform column, 0..255, matching the player waveform. */
  tones: Uint8Array
  /** Band magnitudes 0..255, `frameCount * bandCount`, row-major by frame. */
  bands: Uint8Array
  frameCount: number
  bandCount: number
  /** Mono sample trace for a deterministic oscilloscope, signed -127..127. */
  scope: Int8Array
  scopePoints: number
  /** Left/right point pairs for the stereo field, signed -127..127. */
  stereo: Int8Array
  stereoPoints: number
  /** Left/right RMS levels per frame, 0..255. */
  levels: Uint8Array
  /** Frames a second the table was built at, which is the project's fps. */
  frameRate: number
  /** Seconds the tables cover. */
  duration: number
}

/** An empty analysis, so a layer has something to index while the decode is still running. */
export function emptyAnalysis(): ClipAnalysis {
  return {
    columns: new Float32Array(2),
    columnCount: 1,
    tones: new Uint8Array(1),
    bands: new Uint8Array(1),
    frameCount: 1,
    bandCount: 1,
    scope: new Int8Array(1),
    scopePoints: 1,
    stereo: new Int8Array(2),
    stereoPoints: 1,
    levels: new Uint8Array(2),
    frameRate: 30,
    duration: 0
  }
}

/** Downmixes to mono in one pass, the way `peaks.ts` does before handing off to its worker. */
function downmix(buffer: AudioBuffer, from: number, to: number): Float32Array {
  const rate = buffer.sampleRate
  const start = Math.max(0, Math.floor(from * rate))
  const end = Math.min(buffer.length, Math.ceil(to * rate))
  const length = Math.max(1, end - start)
  const mono = new Float32Array(length)
  const channels = buffer.numberOfChannels

  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let at = 0; at < length; at += 1) mono[at] += data[start + at] ?? 0
  }
  if (channels > 1) {
    for (let at = 0; at < length; at += 1) mono[at] /= channels
  }
  return mono
}

/** Where each band starts and ends in bins, log-spaced the way hearing is. */
function bandEdges(binCount: number, sampleRate: number): Int32Array {
  const edges = new Int32Array(BANDS + 1)
  const nyquist = sampleRate / 2
  const span = Math.log(MAX_HZ / MIN_HZ)
  for (let band = 0; band <= BANDS; band += 1) {
    const hz = MIN_HZ * Math.exp((band / BANDS) * span)
    edges[band] = Math.max(0, Math.min(binCount - 1, Math.round((hz / nyquist) * binCount)))
  }
  return edges
}

/**
 * Builds both tables from one decoded buffer.
 *
 * Synchronous and on the main thread, deliberately. Measured on a 30 second clip at 30fps
 * this is 900 transforms of 2048 points and takes well under a second, which is less than the
 * decode that produced the buffer; a worker would add a transfer and a second file to keep in
 * step with the format for no gain anybody could feel. If clips ever got long enough for it
 * to matter, `peaks.worker.ts` is the shape to copy.
 */
export function analyseBuffer(
  buffer: AudioBuffer,
  from: number,
  to: number,
  frameRate: number
): ClipAnalysis {
  const duration = Math.max(0.05, to - from)
  const mono = downmix(buffer, from, to)
  const rate = buffer.sampleRate
  const sourceStart = Math.max(0, Math.floor(from * rate))
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left

  const columns = new Float32Array(COLUMNS * 2)
  const tones = new Uint8Array(COLUMNS)
  const perColumn = mono.length / COLUMNS
  for (let column = 0; column < COLUMNS; column += 1) {
    const start = Math.floor(column * perColumn)
    const end = Math.min(mono.length, Math.floor((column + 1) * perColumn))
    let low = 0
    let high = 0
    for (let at = start; at < end; at += 1) {
      const sample = mono[at]
      if (sample < low) low = sample
      if (sample > high) high = sample
    }
    columns[column * 2] = low
    columns[column * 2 + 1] = high

    // Use a few neighbouring columns of context, like the live player. A single narrow
    // column quantises zero crossings into visible colour blocks on low notes.
    const toneStart = Math.max(0, Math.floor(start - perColumn * 3))
    let crossings = 0
    let previous = mono[toneStart] ?? 0
    for (let at = toneStart + 1; at < end; at += 1) {
      const sample = mono[at] ?? 0
      if ((sample < 0) !== (previous < 0)) crossings += 1
      previous = sample
    }
    tones[column] = Math.max(
      0,
      Math.min(255, Math.round(brightnessOf(crossings, Math.max(1, end - toneStart), rate) * 255))
    )
  }

  const frameCount = Math.max(1, Math.ceil(duration * frameRate))
  const bands = new Uint8Array(frameCount * BANDS)
  const scope = new Int8Array(frameCount * SCOPE_POINTS)
  const stereo = new Int8Array(frameCount * STEREO_POINTS * 2)
  const levels = new Uint8Array(frameCount * 2)
  const window = hannWindow(FFT_SIZE)
  const edges = bandEdges(FFT_SIZE / 2, rate)
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  const magnitude = new Float32Array(FFT_SIZE / 2)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const centre = Math.floor((frame / frameRate) * rate)
    const start = Math.max(0, Math.min(mono.length - FFT_SIZE, centre - FFT_SIZE / 2))

    for (let at = 0; at < FFT_SIZE; at += 1) {
      re[at] = (mono[start + at] ?? 0) * window[at]
      im[at] = 0
    }
    fft(re, im)
    for (let bin = 0; bin < FFT_SIZE / 2; bin += 1) {
      magnitude[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    }

    for (let band = 0; band < BANDS; band += 1) {
      const first = edges[band]
      const last = Math.max(first + 1, edges[band + 1])
      let peak = 0
      for (let bin = first; bin < last; bin += 1) {
        if (magnitude[bin] > peak) peak = magnitude[bin]
      }
      // Normalised by the window's own gain so the numbers mean roughly dBFS, then mapped
      // over the window the panels elsewhere use. Linear magnitude would put everything
      // above a kick in the bottom tenth of the box.
      const db = 20 * Math.log10(peak / (FFT_SIZE / 4) + 1e-9)
      const level = (db - DB_FLOOR) / (DB_TOP - DB_FLOOR)
      bands[frame * BANDS + band] = Math.max(0, Math.min(255, Math.round(level * 255)))
    }

    let sumLeft = 0
    let sumRight = 0
    for (let at = 0; at < FFT_SIZE; at += 1) {
      const absolute = Math.min(buffer.length - 1, sourceStart + start + at)
      const l = left[absolute] ?? 0
      const r = right[absolute] ?? 0
      sumLeft += l * l
      sumRight += r * r
    }
    levels[frame * 2] = meterByte(Math.sqrt(sumLeft / FFT_SIZE))
    levels[frame * 2 + 1] = meterByte(Math.sqrt(sumRight / FFT_SIZE))

    for (let point = 0; point < SCOPE_POINTS; point += 1) {
      const at = start + Math.floor((point / Math.max(1, SCOPE_POINTS - 1)) * (FFT_SIZE - 1))
      scope[frame * SCOPE_POINTS + point] = Math.max(-127, Math.min(127, Math.round((mono[at] ?? 0) * 127)))
    }
    for (let point = 0; point < STEREO_POINTS; point += 1) {
      const at = start + Math.floor((point / Math.max(1, STEREO_POINTS - 1)) * (FFT_SIZE - 1))
      const absolute = Math.min(buffer.length - 1, sourceStart + at)
      stereo[(frame * STEREO_POINTS + point) * 2] = Math.max(-127, Math.min(127, Math.round((left[absolute] ?? 0) * 127)))
      stereo[(frame * STEREO_POINTS + point) * 2 + 1] = Math.max(-127, Math.min(127, Math.round((right[absolute] ?? 0) * 127)))
    }
  }

  return {
    columns,
    columnCount: COLUMNS,
    tones,
    bands,
    frameCount,
    bandCount: BANDS,
    scope,
    scopePoints: SCOPE_POINTS,
    stereo,
    stereoPoints: STEREO_POINTS,
    levels,
    frameRate,
    duration
  }
}
