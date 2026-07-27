/**
 * Candidate detectors, scored on self-consistency across the library.
 *
 * `key.ts` sums every FFT bin's magnitude over every frame and correlates the result
 * against Krumhansl-Kessler. The MTG-derived approach that TuneBat and Essentia use differs
 * in separable ways, and adopting all of them at once would leave nobody able to say which
 * one earned the improvement - the exact mistake the removed bass-energy tie-break was.
 *
 * So each is measured alone, against pairs of the same music in two formats. No labels are
 * needed for that and it can be run today over hundreds of tracks. It bounds accuracy from
 * above rather than measuring it: a detector that cannot agree with itself cannot be right
 * more often than it is consistent. A variant that wins here still has to be scored against
 * `manifest.csv` before it ships.
 *
 *   npx esbuild tools/keyeval/variants.ts --bundle --platform=node \
 *     --alias:@=./src/renderer/src --outfile=variants.js
 *   node variants.js "Z:\SAMPLES" 60
 */
import { fft, hannWindow, toMonoDecimated, type AudioBufferLike } from '../../src/renderer/src/lib/dsp'
import { findGroups, load, pairOf, sampleGroups } from './pairs'

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

/**
 * Krumhansl-Kessler and Temperley come from listening tests on Western classical tonality.
 * EDMA was derived from electronic dance music by the same group whose work sits behind
 * Essentia - which is the relevant one here, since that is what this library is.
 */
const PROFILES: Record<string, [number[], number[]]> = {
  krumhansl: [
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
  ],
  temperley: [
    [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]
  ],
  edma: [
    [0.169, 0.045, 0.084, 0.049, 0.113, 0.093, 0.052, 0.148, 0.049, 0.084, 0.05, 0.063],
    [0.172, 0.048, 0.081, 0.111, 0.049, 0.087, 0.052, 0.143, 0.08, 0.049, 0.07, 0.058]
  ]
}

// Matching key.ts, so the baseline row really is the shipping detector.
const FFT_SIZE = 8192
const HOP = FFT_SIZE / 2
const MIN_HZ = 65
const MAX_HZ = 2100
const TARGET_RATE = 11025
const MAX_SECONDS = 60

type Fold = 'raw' | 'even' | 'median'

interface Variant {
  label: string
  fold: Fold
  peaks: boolean
  profiles: string[]
}

const VARIANTS: Variant[] = [
  { label: 'SHIPPING raw + KK', fold: 'raw', peaks: false, profiles: ['krumhansl'] },
  { label: 'raw + EDMA', fold: 'raw', peaks: false, profiles: ['edma'] },
  { label: 'equal-weight frames + KK', fold: 'even', peaks: false, profiles: ['krumhansl'] },
  { label: 'median frames + KK', fold: 'median', peaks: false, profiles: ['krumhansl'] },
  { label: 'peak-picking + KK', fold: 'raw', peaks: true, profiles: ['krumhansl'] },
  { label: 'equal-weight + EDMA', fold: 'even', peaks: false, profiles: ['edma'] },
  { label: 'median + EDMA', fold: 'median', peaks: false, profiles: ['edma'] },
  { label: 'median + 3 profiles', fold: 'median', peaks: false, profiles: ['krumhansl', 'temperley', 'edma'] },
  { label: 'peaks + median + EDMA', fold: 'median', peaks: true, profiles: ['edma'] }
]

/** Per-frame chroma, left un-normalised so `fold` owns the weighting decision. */
function frameChromas(signal: Float32Array, rate: number, peaks: boolean): Float32Array[] {
  const window = hannWindow(FFT_SIZE)
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  const bins = FFT_SIZE / 2

  const pitchClass = new Int8Array(bins)
  for (let bin = 0; bin < bins; bin++) {
    const hz = (bin * rate) / FFT_SIZE
    if (hz < MIN_HZ || hz > MAX_HZ) {
      pitchClass[bin] = -1
      continue
    }
    pitchClass[bin] = ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12
  }

  const out: Float32Array[] = []
  const magnitude = new Float32Array(bins)
  for (let offset = 0; offset + FFT_SIZE <= signal.length; offset += HOP) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = signal[offset + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 0; bin < bins; bin++) magnitude[bin] = Math.hypot(re[bin], im[bin])

    const chroma = new Float32Array(12)
    for (let bin = 1; bin < bins - 1; bin++) {
      const cls = pitchClass[bin]
      if (cls < 0) continue
      // Peak-picking: only spectral local maxima, so broadband noise between partials
      // stops contributing. The idea behind HPCP, without the harmonic weighting.
      if (peaks && !(magnitude[bin] > magnitude[bin - 1] && magnitude[bin] >= magnitude[bin + 1]))
        continue
      chroma[cls] += magnitude[bin]
    }
    let total = 0
    for (let i = 0; i < 12; i++) total += chroma[i]
    if (total > 0) out.push(chroma)
  }
  return out
}

/**
 * `raw` is what key.ts does - accumulate across frames and normalise once, so a loud frame
 * counts for more. In a mastered beat the loudest frames are the drum hits, which carry
 * broadband energy belonging to no key. `even` gives every frame one vote; `median` takes
 * the per-class median, which ignores outliers entirely.
 */
function fold(frames: Float32Array[], how: Fold): Float32Array {
  const unit =
    how === 'raw'
      ? frames
      : frames.map((frame) => {
          let total = 0
          for (let i = 0; i < 12; i++) total += frame[i]
          if (total <= 0) return frame
          const scaled = new Float32Array(12)
          for (let i = 0; i < 12; i++) scaled[i] = frame[i] / total
          return scaled
        })

  const out = new Float32Array(12)
  for (let i = 0; i < 12; i++) {
    if (how === 'median') {
      const values = unit.map((f) => f[i]).sort((a, b) => a - b)
      out[i] = values.length ? values[Math.floor(values.length / 2)] : 0
    } else {
      let acc = 0
      for (const f of unit) acc += f[i]
      out[i] = acc
    }
  }
  let total = 0
  for (let i = 0; i < 12; i++) total += out[i]
  if (total > 0) for (let i = 0; i < 12; i++) out[i] /= total
  return out
}

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

/** The winner across one or more profiles, each shifted off its floor before summing. */
function best(chroma: Float32Array, which: string[]): { key: string; margin: number } {
  const totals = new Map<string, number>()
  for (const name of which) {
    const [major, minor] = PROFILES[name]
    const per: Array<[string, number]> = []
    for (let root = 0; root < 12; root++) {
      per.push([MAJOR_NAMES[root], correlate(chroma, major, root)])
      per.push([MINOR_NAMES[root], correlate(chroma, minor, root)])
    }
    const floor = Math.min(...per.map(([, v]) => v))
    const sum = per.reduce((acc, [, v]) => acc + (v - floor), 0) || 1
    for (const [key, value] of per) totals.set(key, (totals.get(key) ?? 0) + (value - floor) / sum)
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1])
  return { key: ranked[0][0], margin: ranked[0][1] - ranked[1][1] }
}

function displayed(name: string): string {
  const major = MAJOR_NAMES.indexOf(name)
  const minor = MINOR_NAMES.indexOf(name)
  const root = major >= 0 ? major : minor
  if (root < 0) return name
  const isMinor = minor >= 0
  return `${MAJOR_NAMES[isMinor ? (root + 3) % 12 : root]}/${MINOR_NAMES[isMinor ? root : (root + 9) % 12]}`
}

const root = process.argv[2]
if (!root) {
  console.error('usage: variants <library folder> [pairs]')
  process.exit(1)
}
const limit = Number(process.argv[3] ?? 60)

process.stderr.write(`scanning ${root}…\n`)
const groups = findGroups(root)
process.stderr.write(`${groups.length} cross-format groups found\n`)

const identical = new Map<string, number>()
const onScreen = new Map<string, number>()
const margins = new Map<string, number[]>()
let compared = 0

for (const group of sampleGroups(groups, limit)) {
  const pair = pairOf(group)
  if (!pair) continue
  const buffers = pair.map((f) => load(f)) as Array<AudioBufferLike | null>
  if (!buffers[0] || !buffers[1]) continue
  // Different lengths mean different renders, not one track in two containers.
  if (Math.abs(buffers[0].duration - buffers[1].duration) > 2) continue

  // The chroma frames are computed once per file and reused by every variant, so adding a
  // variant costs correlation arithmetic rather than another decode.
  const framesFor = buffers.map((buffer) => {
    const { signal, rate } = toMonoDecimated(buffer!, TARGET_RATE, MAX_SECONDS)
    if (signal.length < FFT_SIZE) return null
    return { plain: frameChromas(signal, rate, false), picked: frameChromas(signal, rate, true) }
  })
  if (!framesFor[0] || !framesFor[1]) continue

  compared++
  for (const variant of VARIANTS) {
    const answers = framesFor.map((f) => {
      const chroma = fold(variant.peaks ? f!.picked : f!.plain, variant.fold)
      return best(chroma, variant.profiles)
    })
    if (answers[0].key === answers[1].key) {
      identical.set(variant.label, (identical.get(variant.label) ?? 0) + 1)
    }
    if (displayed(answers[0].key) === displayed(answers[1].key)) {
      onScreen.set(variant.label, (onScreen.get(variant.label) ?? 0) + 1)
    }
    const list = margins.get(variant.label) ?? []
    list.push(Math.min(answers[0].margin, answers[1].margin))
    margins.set(variant.label, list)
  }
  if (compared % 10 === 0) process.stderr.write(`  ...${compared} pairs\n`)
}

console.log(`\n=== self-consistency over ${compared} same-music pairs\n`)
console.log(`  ${'variant'.padEnd(26)} ${'identical'.padEnd(14)} ${'same on screen'.padEnd(16)} median margin`)
const rows = VARIANTS.map((variant) => ({
  label: variant.label,
  same: identical.get(variant.label) ?? 0,
  screen: onScreen.get(variant.label) ?? 0,
  margin: (() => {
    const list = (margins.get(variant.label) ?? []).slice().sort((a, b) => a - b)
    return list.length ? list[Math.floor(list.length / 2)] : 0
  })()
})).sort((a, b) => b.same - a.same)

for (const row of rows) {
  const pct = (n: number): string => `${n}/${compared} (${((n / compared) * 100).toFixed(0)}%)`
  console.log(
    `  ${row.label.padEnd(26)} ${pct(row.same).padEnd(14)} ${pct(row.screen).padEnd(16)} ${row.margin.toFixed(4)}`
  )
}
console.log(
  '\n  Consistency is a ceiling, not accuracy. A variant that wins here still has to be\n' +
    '  scored against labelled keys (score.py) before it replaces anything.'
)
