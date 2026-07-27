/**
 * Self-consistency: how often does the detector give two answers for the same music?
 *
 * A library that holds both a master and its MP3 is a labelled set nobody had to label.
 * The two files are the same performance, so any disagreement is the detector contradicting
 * itself - and a detector that cannot agree with itself cannot be more accurate than its
 * own consistency. It needs no ground truth, which is what makes it worth running now.
 */
import { detectKey } from '../../src/renderer/src/lib/key'
import { findGroups, load, pairOf, sampleGroups } from './pairs'

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

/** key name -> [pitch class, minor?] */
function parseKey(name: string): [number, boolean] | null {
  const major = MAJOR_NAMES.indexOf(name)
  if (major >= 0) return [major, false]
  const minor = MINOR_NAMES.indexOf(name)
  if (minor >= 0) return [minor, true]
  return null
}

/** What umakbang would actually print: a guessed key is shown as its relative pair. */
function displayed(name: string): string {
  const parsed = parseKey(name)
  if (!parsed) return name
  const [root, minor] = parsed
  const majorRoot = minor ? (root + 3) % 12 : root
  const minorRoot = minor ? root : (root + 9) % 12
  return `${MAJOR_NAMES[majorRoot]}/${MINOR_NAMES[minorRoot]}`
}

function relation(a: string, b: string): string {
  const pa = parseKey(a)
  const pb = parseKey(b)
  if (!pa || !pb) return 'unparsed'
  if (a === b) return 'same'
  if (displayed(a) === displayed(b)) return 'relative'
  const [ra, ma] = pa
  const [rb, mb] = pb
  if (ra === rb && ma !== mb) return 'parallel'
  const up = (rb - ra + 12) % 12
  if (ma === mb && up === 7) return 'dominant'
  if (ma === mb && up === 5) return 'subdominant'
  return 'unrelated'
}

const root = process.argv[2]
if (!root) {
  console.error('usage: consistency <library folder> [pairs]')
  process.exit(1)
}
const limit = Number(process.argv[3] ?? 60)
process.stderr.write(`scanning ${root}…\n`)
const groups = findGroups(root)
process.stderr.write(`${groups.length} cross-format groups found\n`)

const sample = sampleGroups(groups, limit)

const counts: Record<string, number> = {}
const margins: number[] = []
let compared = 0
const disagreements: string[] = []

for (const group of sample) {
  const pair = pairOf(group)
  if (!pair) continue
  const [lossless, lossy] = pair

  const a = load(lossless)
  const b = load(lossy)
  if (!a || !b) continue
  // Different lengths mean different renders, not the same music in two containers.
  if (Math.abs(a.duration - b.duration) > 2) continue

  const ka = detectKey(a)
  const kb = detectKey(b)
  if (!ka || !kb) continue

  compared++
  const rel = relation(ka.key, kb.key)
  counts[rel] = (counts[rel] ?? 0) + 1
  margins.push(Math.min(ka.confidence, kb.confidence))
  if (rel !== 'same') {
    disagreements.push(
      `  ${lossless.split(/[\\/]/).pop()}\n    lossless ${ka.key.padEnd(4)} (${displayed(ka.key)}, margin ${ka.confidence.toFixed(3)})   mp3 ${kb.key.padEnd(4)} (${displayed(kb.key)}, margin ${kb.confidence.toFixed(3)})   ${rel}`
    )
  }
  if (compared % 10 === 0) process.stderr.write(`  ...${compared} pairs\n`)
}

console.log(`\n=== same music, two files: ${compared} pairs compared`)
const agree = counts['same'] ?? 0
const sameDisplay = agree + (counts['relative'] ?? 0)
console.log(`  identical key      ${agree}/${compared}  ${((agree / compared) * 100).toFixed(0)}%`)
console.log(
  `  same on screen     ${sameDisplay}/${compared}  ${((sameDisplay / compared) * 100).toFixed(0)}%   (relative pairs display alike)`
)
console.log(`\n  how the rest differ:`)
for (const [rel, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
  if (rel === 'same') continue
  console.log(`    ${rel.padEnd(12)} ${n}`)
}

const visible = compared - sameDisplay
console.log(
  `\n  ${visible} of ${compared} (${((visible / compared) * 100).toFixed(0)}%) would show the user two different keys for one track.`
)

console.log('\n=== the disagreements')
for (const line of disagreements) console.log(line)
