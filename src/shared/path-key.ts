/**
 * One spelling of a path, for looking things up by.
 *
 * Nearly everything umakbang remembers is keyed by absolute path: tags, ratings, notes, the
 * detected tempo and key and its fit, and the waveform cache. That works only for as long as
 * two machines write the same bytes for the same name. They don't. A filesystem is free to
 * hand back a name in either Unicode normalization form, and macOS is where this shows: it
 * has decomposed (NFD) names all over it, where Windows is overwhelmingly composed (NFC).
 * `ÁNDALE.mp3` carried two tags and a rating on Windows and came back untagged on a Mac,
 * because `Á` written as one code point and `Á` written as `A` plus a combining acute are
 * different strings and a `Record` has no idea they name the same file.
 *
 * So a key is composed and a path is not. That second half is not tidiness, it is measured:
 * **NTFS is normalization-sensitive.** A file created with a decomposed name opens only via
 * its decomposed path; the composed one returns ENOENT, and `readdir` hands back the
 * decomposed form. Composing `Track.path` would therefore make such a file list in the
 * explorer and then refuse to open, play or move. macOS APFS is normalization-insensitive
 * and preserving, so either form opens there - which means composing keys costs that
 * platform nothing and composing paths would only ever hurt this one.
 *
 * The rule, then, in one line: a path handed to the filesystem is never altered, and a path
 * used as a key into a path-keyed map always goes through `pathKey` first.
 *
 * Imports nothing on purpose. It is reached from the main process, the scanner utility
 * process, the renderer and the analysis and peaks workers, and a single `node:path` import
 * would put it out of reach of the last two.
 */

/**
 * The whole of the fast path. An all-ASCII string is already NFC by definition - there is no
 * combining mark below U+0080 for anything to decompose into - so this is exact rather than
 * an approximation, and it is what nearly every path in a library actually is. `normalize`
 * on a 200-character path is not free, and the alternative is paying it 326,000 times per
 * launch to be told nothing changed.
 */
function isAscii(path: string): boolean {
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) > 127) return false
  return true
}

/**
 * A memo for the minority that survives the test above. Bounded and cleared wholesale rather
 * than evicted one at a time: the working set is the non-ASCII paths of one library, which is
 * hundreds rather than thousands, and an LRU's bookkeeping would cost more than the
 * `normalize` calls it saved.
 */
const MEMO_LIMIT = 4096
const memo = new Map<string, string>()

/** The canonical form of a path, for use as a key. Never hand the result to the filesystem. */
export function pathKey(path: string): string {
  if (isAscii(path)) return path
  const seen = memo.get(path)
  if (seen !== undefined) return seen
  const key = path.normalize('NFC')
  if (memo.size >= MEMO_LIMIT) memo.clear()
  memo.set(path, key)
  return key
}

/**
 * A whole path-keyed map rebuilt under canonical keys.
 *
 * Last write wins. Two entries that canonicalize to one key are the same file written down
 * twice, and there is no third thing to do with them: keeping both is what produced the bug.
 * Done once where a map arrives - the settings file at startup, the peaks cache, an imported
 * backup - rather than on every read, so the cost is one pass over a few thousand entries at
 * launch instead of a `normalize` per lookup.
 */
export function keyedRecord<T>(map: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [path, value] of Object.entries(map)) out[pathKey(path)] = value
  return out
}

/** Whether two paths name the same file, ignoring which form they were written in. */
export function samePathKey(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

const SEPARATOR = /[\\/]/

/**
 * Whether one path sits at or beneath another, both already canonical.
 *
 * It takes canonical strings rather than composing them itself because the callers fold
 * other things into the same comparison - `backup.ts` lowercases, since a Windows path is
 * case-insensitive - and a helper that composed on the way in would be composing a string
 * its caller had already changed.
 *
 * The reason this exists at all is the boundary check. Proving a prefix match ended on a
 * separator used to be done by reading `path.charAt(folder.length)` out of the *raw* path,
 * which is only sound while the raw strings are the ones that were compared. A decomposed
 * `á` is two code units where a composed one is one, so a canonical comparison paired with a
 * raw index reads a character from the wrong place: a real match gets rejected, or worse, a
 * path gets cut through the middle of a character.
 */
export function isUnderKey(path: string, prefix: string): boolean {
  const base = prefix.replace(/[\\/]+$/, '')
  if (path === base) return true
  return path.startsWith(base) && SEPARATOR.test(path.charAt(base.length))
}
