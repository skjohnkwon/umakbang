/**
 * Tempo and key detection, off the main thread.
 *
 * The detectors are a few hundred milliseconds of straight-line FFT per file. On the
 * renderer thread that lands squarely on the visualizers' animation frame, and a dropped
 * frame in a spectrogram is far more visible than a slow BPM reading. Nothing here touches
 * the DOM or Web Audio, which is exactly why `tempo.ts` and `key.ts` were written to take
 * a plain buffer-shaped object rather than a real AudioBuffer.
 *
 * Decoding stays on the main thread: `decodeAudioData` needs an AudioContext, and there
 * isn't one in a worker. What crosses is the already-downmixed mono signal, transferred
 * rather than copied - about 2.6MB for a minute of audio against 21MB for the raw stereo.
 */

import { detectTempo } from '@/lib/tempo'
import { detectKey } from '@/lib/key'
import { detectKeyEssentia, essentiaFailure, type KeyProfile } from '@/lib/key-essentia'

export interface AnalyseRequest {
  id: number
  /** Mono, already decimated to `rate`. */
  signal: Float32Array
  rate: number
  /**
   * Which key detector to use. Absent means the built-in one, so an older caller - or one
   * that has no opinion - gets exactly the previous behaviour.
   */
  keyEngine?: 'builtin' | 'essentia'
  keyProfile?: KeyProfile
}

export interface AnalyseResponse {
  id: number
  bpm?: number
  tempoConfidence?: number
  key?: string
  keyFit?: number
  /**
   * Set when Essentia was asked for and could not answer, with the reason. The key in this
   * response is then the built-in detector's - a fallback that says nothing is worse than
   * no fallback, because the column fills in and the setting looks as though it took.
   */
  keyEngineFailure?: string
  error?: string
}

/** The worker globals, without pulling the whole webworker lib into a DOM-typed project. */
interface WorkerScope {
  addEventListener(type: 'message', handler: (event: MessageEvent<AnalyseRequest>) => void): void
  postMessage(message: AnalyseResponse): void
}

const ctx = self as unknown as WorkerScope

ctx.addEventListener('message', (event) => {
  void handle(event.data)
})

async function handle(request: AnalyseRequest): Promise<void> {
  const { id, signal, rate, keyEngine, keyProfile } = request
  const response: AnalyseResponse = { id }

  // The detectors decimate on their way in. Handing them a signal already at the target
  // rate makes that a straight copy rather than a resample, so the shared code path costs
  // nothing extra and neither detector needs to know where its input came from.
  const buffer = {
    numberOfChannels: 1,
    length: signal.length,
    sampleRate: rate,
    duration: signal.length / rate,
    getChannelData: () => signal
  }

  try {
    const tempo = detectTempo(buffer)
    if (tempo) {
      response.bpm = tempo.bpm
      response.tempoConfidence = tempo.confidence
    }
  } catch (error) {
    // One detector failing must not cost the other its result, nor take the worker down.
    response.error = error instanceof Error ? error.message : String(error)
  }

  try {
    // Essentia falls back rather than failing: a WebAssembly build that would not load
    // leaves a working detector behind instead of a blank column.
    let key = null as { key: string; fit: number } | null
    if (keyEngine === 'essentia') {
      key = await detectKeyEssentia(signal, rate, keyProfile)
      if (!key) {
        response.keyEngineFailure = essentiaFailure() ?? 'no result'
        key = detectKey(buffer)
      }
    } else {
      key = detectKey(buffer)
    }
    if (key) {
      response.key = key.key
      response.keyFit = key.fit
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  ctx.postMessage(response)
}
