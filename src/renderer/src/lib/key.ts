/**
 * Musical key estimation from decoded audio.
 *
 * Same contract as `tempo.ts`: no dependencies, no Web Audio nodes, no DOM, so it runs
 * anywhere a decoded buffer can be handed to it.
 *
 * Pipeline: mono downmix -> decimate to ~11 kHz -> windowed FFT per frame -> fold the
 * magnitude spectrum into twelve pitch classes -> correlate that chroma against the
 * Krumhansl-Schmuckler key profiles, rotated to all 24 keys.
 *
 * The output is spelled the way `normaliseKey` in the metadata probe spells it ("F#m",
 * "Bb", "Am"), so a detected key and a tagged one are the same string and sort together.
 */

import { fft, hannWindow, toMonoDecimated, type AudioBufferLike } from '@/lib/dsp'

export interface KeyResult {
  /** "C", "F#m", "Bb" - the same spelling the probe produces from tags. */
  key: string
  /**
   * 0..1. How far the winning profile beat the runner-up. Low is not a failure: the
   * runner-up is usually the relative major or minor, which correlates nearly as well by
   * construction, so a close finish is ambiguity between two related keys rather than a
   * bad reading.
   */
  confidence: number
  /**
   * The winning correlation itself, -1..1. This is what says whether the audio is tonal
   * at all - percussion and noise fit every profile equally badly - so it, not the
   * margin, is what callers should gate on.
   */
  fit: number
}

/** Enough resolution for the lowest note we look at; anything above is wasted work. */
const TARGET_RATE = 11025

/**
 * Key is a global property, and a minute is plenty to establish it. Longer costs a linear
 * amount of FFT for no better answer.
 */
const MAX_SECONDS = 60

/** Below this there aren't enough notes to correlate against anything. */
const MIN_SECONDS = 3

/**
 * 8192 at 11 kHz is a 1.35 Hz bin, which resolves adjacent semitones down to C2 (65 Hz,
 * neighbours 3.9 Hz apart). A shorter transform smears the bass into one blur, and the
 * bass is where the root usually is.
 */
const FFT_SIZE = 8192
const HOP = FFT_SIZE / 2

/**
 * The band folded into chroma. Below C2 is mostly kick fundamental and room, which
 * belongs to no key; above C7 the harmonics of everything pile up and stop discriminating.
 */
const MIN_HZ = 65
const MAX_HZ = 2100

/**
 * The band the root is looked for in, when major and its relative minor have to be told
 * apart. They share all seven notes, so pitch-class content alone genuinely cannot
 * separate them - E flat major and C minor are the same set. What does separate them is
 * which of the two is sitting in the bass, and on this material the bass line states the
 * tonic more reliably than anything else in the mix.
 */
const BASS_MAX_HZ = 200

/**
 * How each key is actually written.
 *
 * Sharps and flats are the same pitch but not the same name, and nobody writes E flat
 * major as "D#". These are the spellings in normal use, which differ between major and
 * minor for the same root: the relative minor of E flat major is C minor, and its own
 * neighbour a semitone down is written E flat minor rather than D sharp minor.
 */
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

/**
 * Krumhansl-Kessler probe-tone ratings: how well each scale degree fits a key, averaged
 * over listeners. Correlating a piece's chroma against these rotated to each root is the
 * standard way to name a key, and it degrades gracefully - a piece that modulates lands
 * on whichever key it spent longest in rather than failing.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export function detectKey(buffer: AudioBufferLike): KeyResult | null {
  if (!buffer || buffer.sampleRate <= 0 || buffer.numberOfChannels <= 0) return null
  if (buffer.duration < MIN_SECONDS) return null

  const { signal, rate } = toMonoDecimated(buffer, TARGET_RATE, MAX_SECONDS)
  if (signal.length < FFT_SIZE) return null

  const chroma = chromagram(signal, rate)
  if (!chroma) return null

  return bestKey(chroma.full)
}

/**
 * Accumulates a twelve-bin pitch-class profile over the whole signal.
 *
 * Magnitude rather than power: power lets one loud bass note outvote the entire harmonic
 * content above it, which on this material - where the kick is the loudest thing in the
 * file - reliably reports the key of the kick.
 */
function chromagram(signal: Float32Array, rate: number): { full: Float32Array; bass: Float32Array } | null {
  const window = hannWindow(FFT_SIZE)
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  const chroma = new Float32Array(12)
  const bass = new Float32Array(12)

  // Bin -> pitch class, worked out once. Every frame otherwise repeats a log per bin.
  const bins = FFT_SIZE / 2
  const pitchClass = new Int8Array(bins)
  for (let bin = 0; bin < bins; bin++) {
    const hz = (bin * rate) / FFT_SIZE
    if (hz < MIN_HZ || hz > MAX_HZ) {
      pitchClass[bin] = -1
      continue
    }
    // MIDI note number, then its pitch class. 69 is A4 = 440 Hz.
    const note = Math.round(12 * Math.log2(hz / 440) + 69)
    pitchClass[bin] = ((note % 12) + 12) % 12
  }

  const bassBins = Math.floor((BASS_MAX_HZ * FFT_SIZE) / rate)
  let frames = 0
  for (let offset = 0; offset + FFT_SIZE <= signal.length; offset += HOP) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = signal[offset + i] * window[i]
      im[i] = 0
    }
    fft(re, im)

    for (let bin = 0; bin < bins; bin++) {
      const cls = pitchClass[bin]
      if (cls < 0) continue
      const magnitude = Math.hypot(re[bin], im[bin])
      chroma[cls] += magnitude
      if (bin <= bassBins) bass[cls] += magnitude
    }
    frames++
  }

  if (frames === 0) return null

  let total = 0
  for (let i = 0; i < 12; i++) total += chroma[i]
  if (total <= 0) return null
  for (let i = 0; i < 12; i++) chroma[i] /= total
  return { full: chroma, bass }
}

/**
 * The best-correlating of the 24 keys.
 *
 * There was a tie-break here that, when the top two were a major and its relative minor,
 * handed it to whichever tonic had more bass energy. It was reasoning about the right
 * problem - those two share all seven notes and score almost identically - but measured
 * against files with known keys it flipped a correct answer to a wrong one more often than
 * the reverse. The plain correlation stands.
 */
function bestKey(chroma: Float32Array): KeyResult {
  const scored: Array<{ name: string; score: number }> = []
  for (let root = 0; root < 12; root++) {
    scored.push({ name: MAJOR_NAMES[root], score: correlate(chroma, MAJOR_PROFILE, root) })
    scored.push({ name: MINOR_NAMES[root], score: correlate(chroma, MINOR_PROFILE, root) })
  }
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]
  const second = scored[1]
  // The margin over the runner-up. Usually small and not a failure: the runner-up is
  // typically the relative major or minor, which correlates nearly as well by construction.
  const confidence = Math.max(0, Math.min(1, (best.score - second.score) * 5))
  return { key: best.name, confidence, fit: best.score }
}

/** Pearson correlation of the chroma against one profile rotated to `root`. */
function correlate(chroma: Float32Array, profile: number[], root: number): number {
  let meanC = 0
  let meanP = 0
  for (let i = 0; i < 12; i++) {
    meanC += chroma[i]
    meanP += profile[i]
  }
  meanC /= 12
  meanP /= 12

  let num = 0
  let dc = 0
  let dp = 0
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + root) % 12] - meanC
    const p = profile[i] - meanP
    num += c * p
    dc += c * c
    dp += p * p
  }
  return dc && dp ? num / Math.sqrt(dc * dp) : 0
}
