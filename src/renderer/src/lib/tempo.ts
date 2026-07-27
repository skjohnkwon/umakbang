/**
 * Automatic tempo (BPM) estimation from decoded audio.
 *
 * Self-contained: no dependencies, no Web Audio nodes, no DOM. The only thing
 * it needs from the `AudioBuffer` is `getChannelData`, so it is equally happy
 * with a plain object in a worker or a test harness.
 *
 * Pipeline: mono downmix -> decimate to ~11 kHz -> spectral-flux onset
 * envelope -> autocorrelation -> octave-aware peak picking.
 */

import { fft, hannWindow } from '@/lib/dsp'

export interface TempoResult {
  bpm: number
  confidence: number
}

/** Anything with enough of an AudioBuffer surface to analyse. */
interface AudioBufferLike {
  numberOfChannels: number
  length: number
  sampleRate: number
  duration: number
  getChannelData(channel: number): Float32Array
}

/** Beat periods below ~11 kHz analysis rate carry no useful rhythmic detail, and
 * decimating this far makes the FFT stage roughly 4x cheaper on 44.1k material. */
const TARGET_RATE = 11025

/** Long files add nothing: tempo is stable, and an unbounded scan would block
 * the renderer on a 10 minute mixdown. */
const MAX_SECONDS = 60

/** Below this there are too few beat periods for autocorrelation to mean anything. */
const MIN_SECONDS = 5

const FFT_SIZE = 512
const ENVELOPE_RATE = 100 // onset-envelope frames per second (10 ms hop)

/** Reportable tempo range. */
const MIN_BPM = 60
const MAX_BPM = 200

/**
 * Centre of the octave the result is folded into: the reported tempo is pushed
 * towards [CENTER/sqrt2, CENTER*sqrt2) = ~88..177 BPM, which is where humans
 * actually tap. 125 rather than 120 because it puts drum & bass (174) on the
 * fast side of the fence while leaving hip-hop (90) on the slow side -- those
 * two are only 3% apart in the ambiguous 87-vs-90 region, so the boundary is
 * necessarily a judgement call rather than something the signal can settle.
 */
const PRIOR_CENTER_BPM = 125

/**
 * Deliberately wide. A narrow prior starts outranking the autocorrelation
 * itself and lets non-octave relatives win (a 174 BPM track has a decent
 * correlation at 116 BPM, three eighth-notes, which a tight prior loves).
 * Octave errors are corrected explicitly below instead.
 */
const PRIOR_WIDTH_OCTAVES = 1.5

/** How much raw correlation an octave sibling may give up and still be taken. */
const OCTAVE_TOLERANCE = 0.82

/** How much *better* the 2/3 relative must correlate before it is believed. */
const TRIPLET_MARGIN = 1.02

/**
 * A candidate is only doubled if the envelope actually has events halfway
 * between its beats, worth at least this fraction of the on-beat energy.
 * Without it, any slow-but-genuine tempo (a 75 BPM ballad with no offbeat
 * content) would be dragged up into the preferred octave.
 */
const SUBDIVISION_THRESHOLD = 0.5

/**
 * Weights over the metrical hierarchy: beat, 2 beats, 3 beats, bar. The bar is
 * weighted almost as heavily as the beat and 3 beats barely at all, because
 * that is what separates a real beat from the "three eighth-notes" lag: with
 * offbeat hi-hats every multiple of 1.5 beats correlates well too, but only the
 * true beat has its 4th multiple land on the bar line where the pattern repeats.
 */
const HARMONIC_WEIGHTS = [1, 0.6, 0.1, 0.7]

/**
 * Minimum 95th-percentile-to-mean ratio of the onset envelope. Percussive
 * material spikes (measured 3.8-9.5 on drum loops); sustained pads and noise
 * beds ripple gently (1.8-2.0) yet still autocorrelate beautifully, which would
 * otherwise produce a confident, meaningless number. A ratio is used rather
 * than an absolute floor so the gate is independent of how loud the file is.
 */
const MIN_ONSET_PEAKINESS = 2.5

export function detectTempo(buffer: AudioBufferLike): TempoResult | null {
  if (!buffer || buffer.sampleRate <= 0 || buffer.numberOfChannels <= 0) return null
  if (buffer.duration < MIN_SECONDS || buffer.length < buffer.sampleRate * MIN_SECONDS) return null

  const { signal, rate } = toMonoDecimated(buffer)
  if (signal.length < rate * MIN_SECONDS) return null

  // The hop must be a whole number of samples, so the real frame rate drifts
  // from the nominal 100 Hz (11025/110 = 100.23). Carrying the exact value is
  // the difference between reporting 120.0 and 119.7.
  const hop = Math.max(1, Math.round(rate / ENVELOPE_RATE))

  // Correlating at integer frame lags quantises the beat period to ~10 ms, and
  // a tempo whose period lands on a half-frame (145 BPM at 100 fps = 41.5) has
  // its correlation split across two lags and loses to spurious relatives.
  // The envelope is Gaussian-smoothed, hence band-limited, so interpolating it
  // to a finer grid recovers the resolution without doubling the FFT work.
  const envelope = upsample2(onsetEnvelope(signal, hop))
  const fps = (2 * rate) / hop
  if (envelope.length < fps * 3) return null

  return pickTempo(envelope, fps)
}

/** Linear 2x interpolation. Valid here only because `smooth` band-limits first. */
function upsample2(x: Float32Array): Float32Array {
  const n = x.length
  if (n === 0) return x
  const out = new Float32Array(n * 2 - 1)
  for (let i = 0; i < n; i++) {
    out[i * 2] = x[i]
    if (i + 1 < n) out[i * 2 + 1] = 0.5 * (x[i] + x[i + 1])
  }
  return out
}

/**
 * Downmix to mono and decimate by an integer factor. The boxcar average over
 * each output sample doubles as the anti-alias filter -- crude, but onset
 * detection only cares about broad energy movement, not fidelity.
 */
function toMonoDecimated(buffer: AudioBufferLike): { signal: Float32Array; rate: number } {
  const sampleRate = buffer.sampleRate
  const usable = Math.min(buffer.length, Math.floor(sampleRate * MAX_SECONDS))
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE))
  const outLength = Math.floor(usable / factor)
  const out = new Float32Array(outLength)

  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  const channelCount = channels.length
  const invChannels = 1 / channelCount
  const invFactor = 1 / factor

  for (let i = 0; i < outLength; i++) {
    const start = i * factor
    let acc = 0
    for (let j = 0; j < factor; j++) {
      const idx = start + j
      let sum = 0
      for (let c = 0; c < channelCount; c++) sum += channels[c][idx]
      acc += sum * invChannels
    }
    out[i] = acc * invFactor
  }

  return { signal: out, rate: sampleRate * invFactor }
}

/**
 * Spectral flux onset envelope: half-wave-rectified sum of positive
 * frame-to-frame change in log magnitude. Log compression is what keeps a
 * quiet hi-hat from being buried by a loud kick, which matters because tempo
 * lives in the *timing* of events, not their loudness.
 */
function onsetEnvelope(signal: Float32Array, hop: number): Float32Array {
  const frameCount = Math.max(0, Math.floor((signal.length - FFT_SIZE) / hop) + 1)
  if (frameCount < 2) return new Float32Array(0)

  const bins = FFT_SIZE / 2
  const window = hannWindow(FFT_SIZE)
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  const prev = new Float32Array(bins)
  const curr = new Float32Array(bins)
  const flux = new Float32Array(frameCount)

  for (let f = 0; f < frameCount; f++) {
    const offset = f * hop
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = signal[offset + i] * window[i]
      im[i] = 0
    }
    fft(re, im)

    let sum = 0
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const value = Math.log1p(200 * mag)
      curr[k] = value
      if (f > 0) {
        const diff = value - prev[k]
        if (diff > 0) sum += diff
      }
    }
    flux[f] = sum
    prev.set(curr)
  }

  // Frame 0 has no predecessor; copy its neighbour so the series has no hole.
  if (frameCount > 1) flux[0] = flux[1]

  // Widen each onset spike before correlating. A beat period is rarely a whole
  // number of frames (174 BPM = 34.5 frames at 100 fps), so a needle-thin pulse
  // correlates worse at its true lag than at double it -- pure quantisation
  // artefact that reads as an octave error. Smoothing removes the penalty.
  return smooth(detrend(flux, Math.round(ENVELOPE_RATE * 0.8)), 1.4)
}

/** Gaussian blur with a small fixed-radius kernel. */
function smooth(x: Float32Array, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 2))
  const kernel = new Float64Array(radius * 2 + 1)
  let norm = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-0.5 * (i * i)) / (sigma * sigma))
    kernel[i + radius] = v
    norm += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= norm

  const n = x.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j < 0 || j >= n) continue
      acc += x[j] * kernel[k + radius]
    }
    out[i] = acc
  }
  return out
}

/**
 * Subtract a moving average and half-wave rectify. Removes slow loudness drift
 * (build-ups, fades) that would otherwise dominate the autocorrelation with a
 * huge low-frequency component unrelated to the beat.
 */
function detrend(x: Float32Array, windowSize: number): Float32Array {
  const n = x.length
  const out = new Float32Array(n)
  const half = Math.max(1, Math.floor(windowSize / 2))

  // Prefix sums keep the moving average O(n) regardless of window width.
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i]

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(n, i + half + 1)
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo)
    const v = x[i] - mean
    out[i] = v > 0 ? v : 0
  }
  return out
}

function pickTempo(envelope: Float32Array, fps: number): TempoResult | null {
  const n = envelope.length

  const searchMin = Math.max(2, Math.floor((fps * 60) / MAX_BPM))
  const searchMax = Math.ceil((fps * 60) / MIN_BPM)
  if (n <= searchMax * 2) return null

  // Zero-mean the envelope so the autocorrelation measures periodicity rather
  // than the (always positive) average onset level.
  let mean = 0
  for (let i = 0; i < n; i++) mean += envelope[i]
  mean /= n
  if (mean <= 0) return null
  if (percentile(envelope, 0.95) / mean < MIN_ONSET_PEAKINESS) return null

  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = envelope[i] - mean

  let energy = 0
  for (let i = 0; i < n; i++) energy += x[i] * x[i]
  if (energy <= 1e-12) return null
  const zeroLag = energy / n

  // Reach far enough that every candidate can be scored over the same number of
  // metrical multiples; scoring some lags on more terms than others is a bias
  // towards fast tempos, not a musical judgement.
  const maxLag = Math.min(Math.floor(n / 2), searchMax * HARMONIC_WEIGHTS.length)
  if (maxLag <= searchMin) return null

  // Unbiased normalisation: without dividing by the overlap length, long lags
  // are systematically underestimated and every track "detects" as fast.
  const acf = new Float64Array(maxLag + 1)
  for (let lag = searchMin; lag <= maxLag; lag++) {
    let sum = 0
    const limit = n - lag
    for (let i = 0; i < limit; i++) sum += x[i] * x[i + lag]
    acf[lag] = sum / limit / zeroLag
  }

  const effectiveMax = Math.min(searchMax, maxLag - 1)
  if (effectiveMax <= searchMin) return null

  // Score each lag by the mean correlation over its metrical multiples. A real
  // beat period also repeats at 2, 3 and 4 beats, so this rewards genuine
  // pulses over lags that merely happen to line up once.
  const score = new Float64Array(effectiveMax + 1)
  for (let lag = searchMin; lag <= effectiveMax; lag++) {
    let s = 0
    let weight = 0
    for (let h = 0; h < HARMONIC_WEIGHTS.length; h++) {
      const l = lag * (h + 1)
      if (l > maxLag) break
      s += HARMONIC_WEIGHTS[h] * acf[l]
      weight += HARMONIC_WEIGHTS[h]
    }
    if (weight === 0) continue
    score[lag] = (s / weight) * tempoPrior((fps * 60) / lag)
  }

  let bestLag = -1
  let bestScore = -Infinity
  for (let lag = searchMin; lag <= effectiveMax; lag++) {
    // Local maxima only: interior points of a broad slope are not real periods.
    const isPeak =
      (lag === searchMin || score[lag] >= score[lag - 1]) &&
      (lag === effectiveMax || score[lag] >= score[lag + 1])
    if (isPeak && score[lag] > bestScore) {
      bestScore = score[lag]
      bestLag = lag
    }
  }
  if (bestLag < 0) return null

  bestLag = resolveOctave(acf, envelope, bestLag, searchMin, maxLag, fps)

  // Parabolic interpolation around the integer lag: even at 200 frames/s one
  // lag step is ~1 BPM near 140, coarser than the precision users expect.
  const refined = interpolatePeak(acf, bestLag, searchMin, maxLag)
  const bpm = (fps * 60) / refined
  if (bpm < MIN_BPM || bpm > MAX_BPM) return null

  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence: confidenceOf(acf, bestLag, searchMin, effectiveMax)
  }
}

/**
 * A track at 87 BPM autocorrelates just as strongly at 174 -- the signal itself
 * cannot say which is "the" beat. Fold the candidate into the octave around
 * PRIOR_CENTER_BPM, but only across steps that the envelope actually supports:
 * doubling requires real events between the beats, halving requires the longer
 * period to correlate about as well.
 */
function resolveOctave(
  acf: Float64Array,
  envelope: Float32Array,
  lag: number,
  minLag: number,
  maxLag: number,
  fps: number
): number {
  const foldMin = PRIOR_CENTER_BPM / Math.SQRT2
  const foldMax = PRIOR_CENTER_BPM * Math.SQRT2
  let current = lag

  // With offbeat eighth-notes, three of them (1.5 beats) also correlate well
  // and land nearer the middle of the tempo range, so the scorer can settle on
  // 2/3 of the real tempo. The real beat lag always correlates *better* than
  // its own 1.5x relative, so a straight comparison recovers it -- and requires
  // a margin, since in a genuine triplet feel there is no such relative to find.
  const triplet = Math.round((current * 2) / 3)
  if (
    triplet >= minLag &&
    (fps * 60) / triplet <= MAX_BPM &&
    localMax(acf, triplet, minLag, maxLag) > TRIPLET_MARGIN * localMax(acf, current, minLag, maxLag)
  ) {
    current = triplet
  }

  // Two steps is plenty: a candidate more than 4x off is a detection failure,
  // not an octave error, and chasing it further only invents tempo.
  for (let step = 0; step < 2; step++) {
    const bpm = (fps * 60) / current

    if (bpm < foldMin) {
      const faster = Math.round(current / 2)
      const fasterBpm = (fps * 60) / faster
      if (faster < minLag || fasterBpm > MAX_BPM) break
      if (localMax(acf, faster, minLag, maxLag) < OCTAVE_TOLERANCE * localMax(acf, current, minLag, maxLag)) break
      if (subdivisionStrength(envelope, current) < SUBDIVISION_THRESHOLD) break
      current = faster
      continue
    }

    if (bpm > foldMax) {
      const slower = current * 2
      const slowerBpm = (fps * 60) / slower
      if (slower > maxLag || slowerBpm < MIN_BPM) break
      if (localMax(acf, slower, minLag, maxLag) < OCTAVE_TOLERANCE * localMax(acf, current, minLag, maxLag)) break
      current = slower
      continue
    }

    break
  }

  return current
}

/**
 * Energy of the onset envelope midway between beats, relative to the energy on
 * the beats themselves, for a hypothesised period of `lag` frames. Near 1 means
 * the "beats" are indistinguishable from the events between them, i.e. the real
 * pulse is twice as fast.
 */
function subdivisionStrength(envelope: Float32Array, lag: number): number {
  const n = envelope.length
  const at = (i: number): number => {
    const j = Math.round(i)
    return j < 0 || j >= n ? 0 : envelope[j]
  }
  // Peak-pick a small neighbourhood: onsets drift a frame or two either way.
  const comb = (phase: number): number => {
    let sum = 0
    for (let t = phase; t < n; t += lag) sum += Math.max(at(t - 1), at(t), at(t + 1))
    return sum
  }

  let bestPhase = 0
  let bestEnergy = -1
  const step = Math.max(1, Math.round(lag / 48))
  for (let p = 0; p < lag; p += step) {
    const e = comb(p)
    if (e > bestEnergy) {
      bestEnergy = e
      bestPhase = p
    }
  }
  if (bestEnergy <= 0) return 0
  return comb(bestPhase + lag / 2) / bestEnergy
}

function percentile(x: Float32Array, q: number): number {
  const sorted = Float32Array.from(x).sort()
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))
  return sorted[index]
}

/** Peak value within +/-1 lag, so rounding lag/2 does not miss the actual crest. */
function localMax(acf: Float64Array, lag: number, minLag: number, maxLag: number): number {
  let m = -Infinity
  for (let l = lag - 1; l <= lag + 1; l++) {
    if (l < minLag || l > maxLag) continue
    if (acf[l] > m) m = acf[l]
  }
  return m === -Infinity ? 0 : m
}

/** Log-normal preference curve centred on PRIOR_CENTER_BPM. */
function tempoPrior(bpm: number): number {
  const z = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH_OCTAVES
  return Math.exp(-0.5 * z * z)
}

function interpolatePeak(acf: Float64Array, lag: number, minLag: number, maxLag: number): number {
  if (lag <= minLag || lag >= maxLag) return lag
  const a = acf[lag - 1]
  const b = acf[lag]
  const c = acf[lag + 1]
  const denom = a - 2 * b + c
  if (Math.abs(denom) < 1e-12) return lag
  const delta = (0.5 * (a - c)) / denom
  if (!Number.isFinite(delta) || Math.abs(delta) > 1) return lag
  return lag + delta
}

/**
 * Prominence of the winning peak over the average correlation across the search
 * range, mapped to 0..1. A track with no pulse has a flat ACF and scores near 0.
 */
function confidenceOf(acf: Float64Array, lag: number, searchMin: number, searchMax: number): number {
  let sum = 0
  let count = 0
  for (let l = searchMin; l <= searchMax; l++) {
    sum += acf[l]
    count++
  }
  if (count === 0) return 0
  const mean = sum / count
  const peak = acf[lag]
  if (peak <= 0) return 0
  const prominence = (peak - mean) / (1 - Math.min(mean, 0.99))
  return Math.max(0, Math.min(1, prominence))
}

