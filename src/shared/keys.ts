/**
 * Key spellings, shared by the metadata probe and the renderer.
 *
 * A key can arrive from an ID3 tag, from a file name, from the audio itself or from a tool
 * the user has pointed umakbang at. They have to end up spelled the same way or sorting and
 * `key:` filters see four different values for one key.
 */

const KEY_PATTERN = /^([A-G])([#b♯♭]?)\s*(maj|major|min|minor|m)?$/i

/** Normalises assorted key spellings ("f#min", "Gb Major", "Am") to a single form. */
export function normaliseKey(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined

  const match = KEY_PATTERN.exec(value)
  if (!match) return undefined

  const letter = match[1].toUpperCase()
  // Lowercased, because the pattern is case-insensitive and a tag reading "EB" or "DBM"
  // otherwise normalises to "EB" - a spelling `PITCH_OF` has never heard of, so it pairs
  // with nothing, sorts apart from "Eb" and stood on the stats page as its own key with a
  // handful of files under it.
  const accidental = match[2].replace('♯', '#').replace('♭', 'b').toLowerCase()
  const quality = (match[3] ?? '').toLowerCase()
  const isMinor = quality === 'm' || quality === 'min' || quality === 'minor'

  return `${letter}${accidental}${isMinor ? 'm' : ''}`
}


/** How each key is written, for building the relative pair. */
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

const PITCH_OF: Record<string, number> = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, 'E#': 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11
}

/**
 * A detected key written as its relative pair - "Eb/Cm".
 *
 * A major key and its relative minor contain exactly the same seven notes, and a chroma
 * detector cannot tell them apart: measured against files with known keys, the note set is
 * right far more often than the tonic is. Naming one of them asserts something the
 * analysis did not establish, so both are shown and the reader picks.
 *
 * Only for keys worked out from audio. A key that came off a tag or a file name was
 * declared rather than guessed, and gets to say exactly what it says.
 */
export function relativeKeyPair(key: string): string {
  const normalised = normaliseKey(key)
  if (!normalised) return key

  const minor = normalised.endsWith('m')
  const letter = minor ? normalised.slice(0, -1) : normalised
  const pitch = PITCH_OF[letter]
  if (pitch === undefined) return normalised

  // The relative minor sits nine semitones above its major, which is the same as three
  // below it.
  const majorPitch = minor ? (pitch + 3) % 12 : pitch
  const minorPitch = minor ? pitch : (pitch + 9) % 12
  // One pairing crosses accidental families: the standalone spellings prefer F# major
  // and Eb minor, which as a pair reads "F#/Ebm" - a sharp key beside a flat one that is
  // supposed to share all its notes. The relative minor of F# is D#m.
  const minorName = majorPitch === 6 ? 'D#m' : MINOR_NAMES[minorPitch]
  return `${MAJOR_NAMES[majorPitch]}/${minorName}`
}

/**
 * Where a key sits on the circle of fifths, 0 (C) to 1 (F), or null if it isn't a key.
 *
 * For colouring: neighbouring values are neighbouring keys, so a library that lives in one
 * corner of the circle comes out in one part of the ramp rather than scattered across it.
 * A key and its relative minor answer the same, since they are the same seven notes and the
 * app shows them as one pair everywhere else.
 */
export function fifthsPosition(key: string): number | null {
  const normalised = normaliseKey(key)
  if (!normalised) return null
  const minor = normalised.endsWith('m')
  const pitch = PITCH_OF[minor ? normalised.slice(0, -1) : normalised]
  if (pitch === undefined) return null
  // Three semitones up from a minor tonic is the major it shares its notes with.
  const major = minor ? (pitch + 3) % 12 : pitch
  // Fifths are seven semitones apart, so multiplying by 7 mod 12 walks the circle.
  const steps = (major * 7) % 12
  return steps / 11
}

/** True when two spellings name the same key - "Ebm" and "D#m", "Db" and "C#". */
export function sameKey(a: string, b: string): boolean {
  const na = normaliseKey(a)
  const nb = normaliseKey(b)
  if (!na || !nb) return false
  const minorA = na.endsWith('m')
  if (minorA !== nb.endsWith('m')) return false
  const pitchA = PITCH_OF[minorA ? na.slice(0, -1) : na]
  const pitchB = PITCH_OF[nb.endsWith('m') ? nb.slice(0, -1) : nb]
  return pitchA !== undefined && pitchA === pitchB
}
