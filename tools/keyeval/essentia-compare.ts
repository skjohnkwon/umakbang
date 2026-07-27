/**
 * Essentia against the built-in detector, on the same audio.
 *
 * TuneBat states it is "powered by industry leading technology developed by the Music
 * Technology Group at UPF" - that is Essentia, and `essentia.js` is its WebAssembly build,
 * which is how it runs in a browser and therefore how it could run in umakbang's analysis
 * worker. `variants.ts` established that hand-porting the separable pieces of that approach
 * buys nothing measurable; this asks whether the real thing does.
 *
 * Both detectors are fed the identical 60 seconds so the comparison is of algorithms and
 * not of how much audio each chose to read.
 *
 *   npx esbuild tools/keyeval/essentia-compare.ts --bundle --platform=node \
 *     --alias:@=./src/renderer/src --external:essentia.js --outfile=ess.js
 *   node ess.js "Z:\SAMPLES" 50
 *
 * essentia.js is AGPL-3.0. Measuring with it here commits nothing; shipping it is the
 * decision this is meant to inform.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectKey } from '../../src/renderer/src/lib/key'
import { findGroups, load, pairOf, sampleGroups } from './pairs'
import type { AudioBufferLike } from '../../src/renderer/src/lib/dsp'

// Resolved from the working directory, not from this file: the bundle esbuild produces is
// written wherever the caller asked for it, and `node_modules` is next to the repo.
const require_ = createRequire(join(process.cwd(), 'package.json'))
const DIST = 'essentia.js/dist/'

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

/** Essentia spells with sharps; umakbang spells the way the key is written. */
const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6,
  Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
}

function toUmakbang(key: string, scale: string): string | null {
  const root = PITCH[key.trim()]
  if (root === undefined) return null
  return scale.trim().toLowerCase().startsWith('min') ? MINOR_NAMES[root] : MAJOR_NAMES[root]
}

/** The relative pair, which is what the app actually prints for a guessed key. */
function displayed(name: string): string {
  const major = MAJOR_NAMES.indexOf(name)
  const minor = MINOR_NAMES.indexOf(name)
  const root = major >= 0 ? major : minor
  if (root < 0) return name
  const isMinor = minor >= 0
  return `${MAJOR_NAMES[isMinor ? (root + 3) % 12 : root]}/${MINOR_NAMES[isMinor ? root : (root + 9) % 12]}`
}

function mono(buffer: AudioBufferLike, seconds: number): Float32Array {
  const frames = Math.min(buffer.length, Math.floor(buffer.sampleRate * seconds))
  const out = new Float32Array(frames)
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  const inverse = 1 / channels.length
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    out[i] = sum * inverse
  }
  return out
}

const PROFILES = ['edma', 'bgate', 'temperley']
const SECONDS = 60

async function main(): Promise<void> {
  const wasmModule = require_(DIST + 'essentia-wasm.umd.js')
  const coreModule = require_(DIST + 'essentia.js-core.umd.js')
  const Backend = wasmModule.EssentiaWASM ?? wasmModule.default ?? wasmModule
  const Essentia = coreModule.Essentia ?? coreModule.default ?? coreModule
  const backend = typeof Backend === 'function' ? await Backend() : Backend
  const essentia = new Essentia(backend)

  const root = process.argv[2]
  if (!root) {
    console.error('usage: essentia-compare <library folder> [pairs]')
    process.exit(1)
  }
  const limit = Number(process.argv[3] ?? 50)

  /** Every detector's answer for one buffer, keyed by detector name. */
  const answersFor = (buffer: AudioBufferLike): Record<string, string | null> => {
    const out: Record<string, string | null> = {}
    out['builtin'] = detectKey(buffer)?.key ?? null

    const signal = mono(buffer, SECONDS)
    const vector = essentia.arrayToVector(signal)
    try {
      for (const profile of PROFILES) {
        const r = essentia.KeyExtractor(
          vector, true, 4096, 4096, 12, 3500, 60, 25, 0.2, profile, buffer.sampleRate, 0.0001, 440, 'cosine', 'hann'
        )
        out[`essentia:${profile}`] = toUmakbang(r.key, r.scale)
      }
    } finally {
      // Emscripten heap: a vector per file over hundreds of files adds up.
      vector.delete?.()
    }
    return out
  }

  const names = ['builtin', ...PROFILES.map((p) => `essentia:${p}`)]

  // --- accuracy, on whatever has been labelled by hand
  const labelled: Array<{ file: string; key: string }> = []
  try {
    const csv = readFileSync(join(process.cwd(), 'tools/keyeval/manifest.csv'), 'utf8').split(/\r?\n/)
    const header = csv[0].split(',')
    const fileAt = header.indexOf('file')
    const keyAt = header.indexOf('reference_key')
    for (const line of csv.slice(1)) {
      if (!line.trim()) continue
      const cells = line.split(',')
      const reference = (cells[keyAt] ?? '').trim()
      if (!reference) continue
      labelled.push({ file: cells[fileAt].trim(), key: reference })
    }
  } catch {
    // No manifest is survivable: the consistency half needs no labels at all.
  }
  // Every label comes from the manifest and none are hardcoded here. There were two, for the
  // pair of files that started this - they named somebody's actual library on disk, which is
  // not something to commit. A file you know the key of goes in `manifest.csv` with its
  // `reference_key` filled in; the manifest is gitignored precisely so it can hold real paths.

  const normaliseReference = (text: string): string | null => {
    const match = text.trim().match(/^([A-Ga-g][#b]?)\s*(m|min|minor|maj|major)?$/i)
    if (!match) return null
    const root = PITCH[match[1][0].toUpperCase() + (match[1][1] ?? '')]
    if (root === undefined) return null
    const minor = /^m(in(or)?)?$/i.test(match[2] ?? '')
    return minor ? MINOR_NAMES[root] : MAJOR_NAMES[root]
  }

  if (labelled.length > 0) {
    console.log(`\n=== accuracy on ${labelled.length} hand-labelled files`)
    const right: Record<string, number> = {}
    const rightShown: Record<string, number> = {}
    let scored = 0
    for (const item of labelled) {
      const buffer = load(item.file)
      const truth = normaliseReference(item.key)
      if (!buffer || !truth) continue
      scored++
      const answers = answersFor(buffer)
      console.log(`  ${item.file.split(/[\\/]/).pop()}  (truth ${truth}, ${displayed(truth)})`)
      for (const name of names) {
        const answer = answers[name]
        const exact = answer === truth
        const shown = answer !== null && displayed(answer) === displayed(truth)
        if (exact) right[name] = (right[name] ?? 0) + 1
        if (shown) rightShown[name] = (rightShown[name] ?? 0) + 1
        console.log(
          `      ${name.padEnd(20)} ${(answer ?? '-').padEnd(5)} ${exact ? 'exact' : shown ? 'same pair' : ''}`
        )
      }
    }
    console.log(`\n  totals over ${scored}:`)
    for (const name of names) {
      console.log(
        `    ${name.padEnd(20)} exact ${right[name] ?? 0}/${scored}   as displayed ${rightShown[name] ?? 0}/${scored}`
      )
    }
  }

  // --- self-consistency, which needs no labels
  process.stderr.write(`\nscanning ${root}…\n`)
  const groups = findGroups(root)
  process.stderr.write(`${groups.length} cross-format groups found\n`)

  const same: Record<string, number> = {}
  const shown: Record<string, number> = {}
  let compared = 0

  for (const group of sampleGroups(groups, limit)) {
    const pair = pairOf(group)
    if (!pair) continue
    const a = load(pair[0])
    const b = load(pair[1])
    if (!a || !b) continue
    if (Math.abs(a.duration - b.duration) > 2) continue

    const first = answersFor(a)
    const second = answersFor(b)
    compared++
    for (const name of names) {
      if (first[name] && first[name] === second[name]) same[name] = (same[name] ?? 0) + 1
      if (first[name] && second[name] && displayed(first[name]!) === displayed(second[name]!)) {
        shown[name] = (shown[name] ?? 0) + 1
      }
    }
    if (compared % 10 === 0) process.stderr.write(`  ...${compared} pairs\n`)
  }

  console.log(`\n=== self-consistency over ${compared} same-music pairs\n`)
  console.log(`  ${'detector'.padEnd(20)} ${'identical'.padEnd(16)} same on screen`)
  const rows = names
    .map((name) => ({ name, same: same[name] ?? 0, shown: shown[name] ?? 0 }))
    .sort((x, y) => y.same - x.same)
  for (const row of rows) {
    const pct = (n: number): string => `${n}/${compared} (${((n / compared) * 100).toFixed(0)}%)`
    console.log(`  ${row.name.padEnd(20)} ${pct(row.same).padEnd(16)} ${pct(row.shown)}`)
  }
}

main().catch((error) => {
  console.error('FAILED:', error)
  process.exit(1)
})
