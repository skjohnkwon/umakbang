/**
 * Waveform peak data, shared by the row waveforms and the now-playing view.
 *
 * Peaks are expensive: producing them means fully decoding the audio, unlike the header
 * probe that populates the rest of the table. So they are computed strictly on demand -
 * a row asks only once it scrolls into view - and cached to disk afterwards, which makes
 * every later visit free. Pre-computing them for a whole library is deliberately not
 * attempted: at a few hundred thousand files that's hours of decoding for data most of
 * which would never be looked at.
 */

import { PEAK_STRIDE, peakStride } from '@/lib/peaks-core'
import type { PeaksRequest, PeaksResponse } from '@/lib/peaks.worker'
import PeaksWorker from '@/lib/peaks.worker?worker'

export {
  PEAK_BUCKETS,
  PEAK_STRIDE,
  peakBrightness,
  peakCount,
  peakLoudness,
  peakStride
} from '@/lib/peaks-core'

/**
 * The bucket scan, in a worker.
 *
 * Built on first use and kept for the life of the page: it is one small module and the
 * files arrive one after another, so a worker per file would spend more time starting up
 * than working.
 */
let worker: Worker | null = null
let nextRequest = 0
const pendingPeaks = new Map<number, (peaks: Uint8Array) => void>()

function peaksWorker(): Worker {
  if (worker) return worker
  worker = new PeaksWorker()
  worker.addEventListener('message', (event: MessageEvent<PeaksResponse>) => {
    const resolve = pendingPeaks.get(event.data.id)
    if (!resolve) return
    pendingPeaks.delete(event.data.id)
    // A failed scan resolves to an empty set rather than rejecting: the caller's fallback
    // is "no waveform", which is what an error would produce anyway.
    resolve(event.data.peaks ?? new Uint8Array(0))
  })
  return worker
}

function computePeaks(signal: Float32Array, rate: number): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const id = ++nextRequest
    pendingPeaks.set(id, resolve)
    const message: PeaksRequest = { id, signal, rate }
    // Transferred, not copied - the downmix is ours and nothing here reads it again.
    peaksWorker().postMessage(message, [signal.buffer])
  })
}

/** Decoding a file costs many times its size in RAM; skip the giants. */
const MAX_DECODE_BYTES = 300 * 1024 * 1024

/** Decoding is CPU-bound, so only a couple run at once or scrolling stutters. */
const MAX_CONCURRENT = 2

type Peaks = Uint8Array | null

const cache = new Map<string, Peaks>()
const inFlight = new Map<string, Promise<Peaks>>()
const listeners = new Map<string, Set<(peaks: Peaks) => void>>()
/**
 * Bumped by `forgetPeaks`, checked before a load publishes. A file forgotten while its
 * old contents were mid-decode must not have those stale peaks written back into the
 * cache the moment the decode lands.
 */
const epochs = new Map<string, number>()

const queue: Array<{ path: string; size: number; run: () => void; cancel: () => void }> = []
let active = 0

let sharedContext: AudioContext | null = null
function audioContext(): AudioContext {
  sharedContext ??= new AudioContext()
  return sharedContext
}

/**
 * Notified whenever a file is decoded here. Tempo detection hangs off this so analysing a
 * track costs nothing extra - the expensive part, the decode, has already happened.
 */
type DecodeObserver = (path: string, buffer: AudioBuffer) => void
let decodeObserver: DecodeObserver | null = null

export function setDecodeObserver(observer: DecodeObserver | null): void {
  decodeObserver = observer
}

/** Synchronous peek - `undefined` means "not known yet", `null` means "unavailable". */
export function peekPeaks(path: string): Peaks | undefined {
  return cache.get(path)
}

export function subscribePeaks(path: string, listener: (peaks: Peaks) => void): () => void {
  let set = listeners.get(path)
  if (!set) {
    set = new Set()
    listeners.set(path, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) listeners.delete(path)
  }
}

function publish(path: string, peaks: Peaks): void {
  cache.set(path, peaks)
  const set = listeners.get(path)
  if (!set) return
  for (const listener of set) listener(peaks)
}

/**
 * Requests peaks for a file. Repeat calls while one is in flight share the same work, and
 * queued-but-not-started requests can be dropped again when a row scrolls away.
 */
export function requestPeaks(path: string, size: number, priority = false): Promise<Peaks> {
  const cached = cache.get(path)
  if (cached !== undefined) return Promise.resolve(cached)

  const existing = inFlight.get(path)
  if (existing) return existing

  const promise = new Promise<Peaks>((resolve) => {
    const startEpoch = epochs.get(path) ?? 0
    const current = (): boolean => (epochs.get(path) ?? 0) === startEpoch
    const run = (): void => {
      active++
      void load(path, size)
        .then((peaks) => {
          // A forget mid-decode means these peaks describe the file's old contents;
          // the caller still gets them, the cache doesn't.
          if (current()) publish(path, peaks)
          resolve(peaks)
        })
        .catch(() => {
          if (current()) publish(path, null)
          resolve(null)
        })
        .finally(() => {
          active--
          // Only this request's own entry: a forget may have registered a replacement.
          if (inFlight.get(path) === promise) inFlight.delete(path)
          pump()
        })
    }

    const entry = { path, size, run, cancel: () => resolve(null) }
    // The playing track jumps the queue; rows are best-effort background work.
    if (priority) queue.unshift(entry)
    else queue.push(entry)
    pump()
  })

  inFlight.set(path, promise)
  return promise
}

/**
 * Forgets everything known about these files' waveforms, on disk and in memory.
 *
 * For a file that has been written over: the shape it had is no longer the shape it has,
 * and the cache is keyed by path alone.
 */
export function forgetPeaks(paths: string[]): void {
  if (paths.length === 0) return
  for (const path of paths) {
    cache.delete(path)
    inFlight.delete(path)
    epochs.set(path, (epochs.get(path) ?? 0) + 1)
  }
  void window.umakbang.forgetPeaks(paths)
  // Nothing is re-requested here: a file that changed also changed size, and the row
  // waveform keys its request on that, so whatever is on screen asks again by itself.
}

/** Drops a not-yet-started request, so scrolling past a row doesn't leave work behind. */
export function cancelPeaks(path: string): void {
  const index = queue.findIndex((entry) => entry.path === path)
  if (index !== -1) {
    const [entry] = queue.splice(index, 1)
    inFlight.delete(path)
    // The promise still has to settle: analysis awaits it while holding one of its two
    // slots, and an await that never returns leaks the slot for the rest of the session.
    entry.cancel()
  }
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift()
    next?.run()
  }
}

async function load(path: string, size: number): Promise<Peaks> {
  const stored = await window.umakbang.getPeaks(path)
  if (stored) {
    const cached = base64ToBytes(stored)
    // Entries from before frequency was recorded are decoded again rather than tinted by
    // loudness instead. Keeping them was the cheaper answer and the wrong one: the same
    // file then drew one set of colours in the transport strip and another in the live
    // trace beside it, which reads as a bug rather than as two measures of the same sound.
    if (peakStride(cached) === PEAK_STRIDE) return cached
  }

  if (size > MAX_DECODE_BYTES) return null

  const response = await fetch(window.umakbang.fileUrl(path))
  if (!response.ok) return null
  const encoded = await response.arrayBuffer()
  const buffer = await audioContext().decodeAudioData(encoded)

  // Handed over before the peaks come back: the analysis worker and the peaks worker are
  // separate, and there is no reason for the second to wait on the first.
  try {
    decodeObserver?.(path, buffer)
  } catch {
    // Analysis is a bonus; never let it cost us the peaks.
  }

  const peaks = await computePeaks(downmix(buffer), buffer.sampleRate)
  void window.umakbang.putPeaks(path, bytesToBase64(peaks))

  return peaks
}

/**
 * Downmixes to mono, which is the only form the peaks and the detectors want.
 *
 * One linear pass on the main thread, and then nothing else here touches every sample: the
 * bucket scan runs in `peaks.worker.ts`. A stereo waveform at these widths reads as noise
 * anyway, so nothing is lost by collapsing first.
 */
function downmix(buffer: AudioBuffer): Float32Array {
  const channelCount = buffer.numberOfChannels
  if (channelCount === 1) return buffer.getChannelData(0).slice()

  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c))
  const mono = new Float32Array(buffer.length)
  for (let i = 0; i < mono.length; i++) {
    let sum = 0
    for (let c = 0; c < channelCount; c++) sum += channels[c][i]
    mono[i] = sum / channelCount
  }
  return mono
}


export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked to stay clear of the argument-count limit on String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Decoded audio for the current track, so tempo detection can reuse the decode. */
export async function decodeTrack(path: string, size: number): Promise<AudioBuffer | null> {
  if (size > MAX_DECODE_BYTES) return null
  const response = await fetch(window.umakbang.fileUrl(path))
  if (!response.ok) return null
  return audioContext().decodeAudioData(await response.arrayBuffer())
}
