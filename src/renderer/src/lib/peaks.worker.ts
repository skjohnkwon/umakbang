/**
 * Waveform peaks, off the main thread.
 *
 * Producing them is a pass over every sample of a decoded file - plus a second pass per
 * bucket for the tone estimate - which on a three-minute track is tens of millions of
 * comparisons. On the renderer thread that lands on whatever frame happens to be running,
 * and it is the visible hitch when a row scrolls into view.
 *
 * Decoding stays on the main thread: `decodeAudioData` needs an AudioContext and there
 * isn't one in a worker. What crosses is the already-downmixed mono signal.
 */

import { PEAK_BUCKETS, PEAK_STRIDE, brightnessOf, TONE_WINDOW } from '@/lib/peaks-core'

export interface PeaksRequest {
  id: number
  /** Mono samples, -1..1. */
  signal: Float32Array
  rate: number
}

export interface PeaksResponse {
  id: number
  peaks?: Uint8Array
  error?: string
}

interface WorkerScope {
  addEventListener(type: 'message', handler: (event: MessageEvent<PeaksRequest>) => void): void
  postMessage(message: PeaksResponse, transfer?: Transferable[]): void
}

const ctx = self as unknown as WorkerScope

ctx.addEventListener('message', (event) => {
  const { id, signal, rate } = event.data
  try {
    const peaks = buildPeaks(signal, rate)
    ctx.postMessage({ id, peaks }, [peaks.buffer])
  } catch (error) {
    ctx.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})

function buildPeaks(signal: Float32Array, rate: number): Uint8Array {
  const peaks = new Uint8Array(PEAK_BUCKETS * PEAK_STRIDE)
  const samplesPerBucket = Math.max(1, Math.floor(signal.length / PEAK_BUCKETS))

  for (let bucket = 0; bucket < PEAK_BUCKETS; bucket++) {
    const start = bucket * samplesPerBucket
    const end = Math.min(start + samplesPerBucket, signal.length)
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      const value = signal[i]
      if (value < min) min = value
      else if (value > max) max = value
    }

    // Counted over at least TONE_WINDOW samples rather than just the bucket: the count
    // resolves frequency in steps of `rate / 2 / samples`, so a short file, whose buckets
    // are only a few dozen samples each, would otherwise have steps hundreds of hertz wide
    // and nothing left to see in the bottom octaves.
    const toneEnd = Math.min(signal.length, Math.max(end, start + TONE_WINDOW))
    let crossings = 0
    let previous = signal[start] ?? 0
    for (let i = start + 1; i < toneEnd; i++) {
      const value = signal[i]
      if ((value < 0) !== (previous < 0)) crossings++
      previous = value
    }

    peaks[bucket * PEAK_STRIDE] = Math.round((Math.max(-1, min) + 1) * 127.5)
    peaks[bucket * PEAK_STRIDE + 1] = Math.round((Math.min(1, max) + 1) * 127.5)
    peaks[bucket * PEAK_STRIDE + 2] = Math.round(brightnessOf(crossings, toneEnd - start, rate) * 255)
  }

  return peaks
}
