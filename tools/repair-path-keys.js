/**
 * Rewrites the six path-keyed maps in `umakbang-data.json` under composed (NFC) keys.
 *
 *     node tools/repair-path-keys.js [path to umakbang-data.json]
 *
 * Nothing runs this for you, and nothing should.
 *
 * CLAUDE.md says this app has no data migrations, and that is still true. What it threw away
 * were one-shot conversions of the *shape* of a setting - a boolean that became an enum, a
 * list that grew a field - each of which had to be a branch the reader carried forever, on the
 * chance of meeting a file written before the change. This is not one of those. It converts a
 * key *encoding*: the same paths, spelled the way Unicode says they should be. That makes it
 * idempotent - a file already composed comes out byte for byte identical - so it is genuinely
 * a one-shot rather than a branch, and `initStore` composing every map as it reads it means
 * the app repairs itself on the next launch anyway.
 *
 * So why does this exist at all? Because `initStore` cannot *tell you* what it did. When two
 * entries compose to one key, one of them is silently the winner, and that is a tag or a note
 * disappearing. On a real file it is nearly always the same file recorded twice under two
 * spellings, and the two agree - but "nearly always" is not a thing to decide on somebody's
 * behalf without showing them. This prints every collision and what each side held, so the
 * one case that matters can be looked at before the app quietly settles it.
 *
 * It copies the file to a timestamped backup beside itself before writing anything.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** The maps keyed by absolute path. `settings` is not one of them and is left alone. */
const KEYED_MAPS = ['tags', 'ratings', 'notes', 'detectedBpm', 'detectedKey', 'detectedKeyFit']

/**
 * The same rule as `src/shared/path-key.ts`, restated rather than imported: this is a plain
 * Node script with no build step behind it, and the module it would import is TypeScript.
 * Both are three lines and both are exact - an all-ASCII string is already NFC, because there
 * is no combining mark below U+0080 for anything to decompose into.
 */
function pathKey(value) {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return value.normalize('NFC')
  }
  return value
}

function defaultDataFile() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'umakbang', 'umakbang-data.json')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'umakbang', 'umakbang-data.json')
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(config, 'umakbang', 'umakbang-data.json')
}

/** Whether two values are the same as far as "did the collision lose anything" goes. */
function agree(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A path with its non-ASCII escaped, for the collision report.
 *
 * Printed as they are, the two sides of a collision are identical on screen - that is the
 * entire nature of the problem - and a report that shows the same string twice and calls one
 * of them lost is no help to anybody. Escaped, `á` and `á` say which is which.
 */
function showable(value) {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)
    out += code > 127 ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }
  return out
}

function main() {
  const file = process.argv[2] || defaultDataFile()
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`)
    console.error('Pass the path to umakbang-data.json as the first argument.')
    process.exitCode = 1
    return
  }

  const raw = fs.readFileSync(file, 'utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    console.error(`${file} is not readable JSON: ${error.message}`)
    process.exitCode = 1
    return
  }

  let rewritten = 0
  let collisions = 0
  let losses = 0
  const out = {}

  for (const name of KEYED_MAPS) {
    const map = data[name]
    if (!map || typeof map !== 'object') continue

    const next = {}
    // Which original key claimed each composed key, so a collision can name both sides.
    const claimedBy = new Map()

    for (const [original, value] of Object.entries(map)) {
      const key = pathKey(original)
      if (key !== original) rewritten++

      if (Object.prototype.hasOwnProperty.call(next, key)) {
        collisions++
        const previous = claimedBy.get(key)
        const same = agree(next[key], value)
        if (!same) losses++
        console.log('')
        console.log(`collision in ${name}: two entries compose to one key`)
        console.log(`  key   ${key}`)
        console.log(`  kept  ${JSON.stringify(value)}   from ${showable(original)}`)
        console.log(`  lost  ${JSON.stringify(next[key])}   from ${showable(previous)}`)
        console.log(same ? '  (they agree, so nothing is lost)' : '  ** THEY DIFFER - the "lost" line is being discarded **')
      }

      // Last write wins, which is what `keyedRecord` does and therefore what the app will do
      // to this file anyway. The point of the script is that it said so first.
      next[key] = value
      claimedBy.set(key, original)
    }

    out[name] = next
  }

  console.log('')
  console.log(`${file}`)
  console.log(`  keys rewritten   ${rewritten}`)
  console.log(`  collisions       ${collisions}${losses ? `  (${losses} where the two entries differed)` : ''}`)

  if (rewritten === 0 && collisions === 0) {
    console.log('  nothing to do - every key is already composed.')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.${stamp}.bak`
  fs.copyFileSync(file, backup)
  console.log(`  backup written   ${backup}`)

  for (const name of Object.keys(out)) data[name] = out[name]

  // Through a temp file and a rename, the way the app writes it: a crash mid-write must not
  // be able to truncate the real thing.
  const tmp = `${file}.repair.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
  fs.renameSync(tmp, file)
  console.log('  written.')
}

main()
