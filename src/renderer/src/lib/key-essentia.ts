/**
 * Key estimation through Essentia's `KeyExtractor`, in WebAssembly.
 *
 * Same contract as `key.ts` - a signal in, a key string out, spelled the way the probe
 * spells it - so `analysis.worker.ts` can pick between them without either knowing the
 * other exists.
 *
 * This is the engine behind the web tools that do key detection well, and what it has that
 * `key.ts` does not is a real HPCP front end: interpolated spectral peaks rather than every
 * bin's magnitude, harmonic weighting so a bass note's overtones count towards its own
 * pitch class, and a tuning estimate applied before any of it. Measured, hand-porting the
 * separable pieces of that (see `tools/keyeval/variants.ts`) bought nothing; the whole front
 * end is the part that works.
 *
 * **Licence.** `essentia.js` is AGPL-3.0. Using it on one machine is unencumbered, but an
 * umakbang distributed to anyone else with this compiled in has to be AGPL-3.0 as well, or
 * carry a commercial licence from MTG. That is exactly why `Settings.keyEngine` defaults to
 * the built-in detector and why `key.ts` stays a complete answer rather than a fallback
 * stub.
 *
 * Loading is lazy and once. The module carries its WebAssembly inline as base64, so there
 * is no second asset to find at runtime and nothing to resolve against a custom protocol -
 * but it is a couple of megabytes to decode and compile, which is worth paying only when
 * this engine is actually selected.
 */

/** Essentia spells with sharps; umakbang spells keys the way they are written. */
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

const PITCH_CLASS: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
}

export type KeyProfile = 'bgate' | 'edma' | 'temperley' | 'krumhansl'

export interface EssentiaKeyResult {
  key: string
  /** Essentia's own strength for the winning key, 0..1. Reported as `fit`. */
  fit: number
}

interface EssentiaLike {
  arrayToVector(array: Float32Array): { delete?: () => void }
  KeyExtractor(
    audio: unknown,
    averageDetuningCorrection: boolean,
    frameSize: number,
    hopSize: number,
    hpcpSize: number,
    maxFrequency: number,
    maximumSpectralPeaks: number,
    minFrequency: number,
    pcpThreshold: number,
    profileType: string,
    sampleRate: number,
    spectralPeaksThreshold: number,
    tuningFrequency: number,
    weightType: string,
    windowType: string
  ): { key: string; scale: string; strength: number }
}

let loading: Promise<EssentiaLike | null> | null = null

/**
 * Why the engine could not be used, if it could not.
 *
 * Falling back to the built-in detector without saying so is the worst of both: the column
 * fills in, so nothing looks broken, and the setting reads as though it took effect. This
 * is logged once and reported back with the analysis so the setting can say what happened.
 */
let unavailableReason: string | null = null

export function essentiaFailure(): string | null {
  return unavailableReason
}

/**
 * The Essentia instance, built once.
 *
 * Returns null rather than throwing if the module can't be loaded: a missing or blocked
 * WebAssembly build must leave key detection degraded, not take the analysis worker down
 * and strand every queued file with it.
 */
async function essentia(): Promise<EssentiaLike | null> {
  if (loading) return loading
  const attempt = (loading = (async () => {
    try {
      const [wasm, core] = await Promise.all([
        import('essentia.js/dist/essentia-wasm.es.js'),
        import('essentia.js/dist/essentia.js-core.es.js')
      ])
      const backend =
        (wasm as { EssentiaWASM?: unknown }).EssentiaWASM ??
        (wasm as { default?: unknown }).default ??
        wasm
      const Essentia =
        (core as { Essentia?: unknown }).Essentia ?? (core as { default?: unknown }).default
      if (!backend) {
        unavailableReason = `no WebAssembly export (saw ${Object.keys(wasm).slice(0, 5).join(', ') || 'nothing'})`
        return null
      }
      if (typeof Essentia !== 'function') {
        unavailableReason = `core module exported no constructor (saw ${Object.keys(core).slice(0, 5).join(', ') || 'nothing'})`
        return null
      }
      // Emscripten builds are sometimes a factory returning a promise and sometimes the
      // module itself, depending on how they were linked.
      const ready =
        typeof backend === 'function' ? await (backend as () => Promise<unknown>)() : backend
      return new (Essentia as new (backend: unknown) => EssentiaLike)(ready)
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error)
      return null
    }
  })())
  // A failure is not cached forever: re-selecting the engine in Settings is meant to be
  // worth another try (and another report), and a permanently pinned null promise made
  // that a restart-only affair. A success stays cached.
  void attempt.then((instance) => {
    if (instance === null && loading === attempt) loading = null
  })
  return attempt
}

/** Whether the engine can be used at all, without committing to analysing anything. */
export async function essentiaAvailable(): Promise<boolean> {
  return (await essentia()) !== null
}

/**
 * Estimates the key of a mono signal.
 *
 * `rate` is whatever the analysis pipeline already produced - 11025 Hz as things stand.
 * Measured against feeding the same files at 44100, that agreed 9 times in 10, which is why
 * nothing upstream had to change to adopt this.
 */
export async function detectKeyEssentia(
  signal: Float32Array,
  rate: number,
  profile: KeyProfile = 'edma'
): Promise<EssentiaKeyResult | null> {
  const instance = await essentia()
  if (!instance || signal.length < rate * 3) return null

  const vector = instance.arrayToVector(signal)
  try {
    const result = instance.KeyExtractor(
      vector,
      true, // average detuning correction
      4096, // frame size
      4096, // hop size
      12, // hpcp size
      3500, // max frequency
      60, // maximum spectral peaks
      25, // min frequency
      0.2, // pcp threshold
      profile,
      rate,
      0.0001, // spectral peaks threshold
      440, // tuning frequency
      'cosine',
      'hann'
    )
    const root = PITCH_CLASS[result.key?.trim()]
    if (root === undefined) return null
    const minor = result.scale?.trim().toLowerCase().startsWith('min')
    return {
      key: minor ? MINOR_NAMES[root] : MAJOR_NAMES[root],
      fit: typeof result.strength === 'number' ? result.strength : 0
    }
  } catch {
    return null
  } finally {
    // The vector lives on the WebAssembly heap, which nothing else will collect.
    vector.delete?.()
  }
}
