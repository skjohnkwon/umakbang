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
  const accidental = match[2].replace('♯', '#').replace('♭', 'b')
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
  return `${MAJOR_NAMES[majorPitch]}/${MINOR_NAMES[minorPitch]}`
}
