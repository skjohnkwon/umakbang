import type { TrackKind } from './types'

/**
 * Extensions the renderer's <audio> element can play. AIFF is included because the
 * main process transparently rewraps AIFF PCM into a WAV container when serving it
 * (see src/main/aiff.ts) - Chromium has no native AIFF decoder.
 */
export const PLAYABLE_EXTENSIONS = new Set([
  'wav',
  'wave',
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'mp4',
  'aif',
  'aiff',
  'aifc',
  'webm'
])

/** Audio files we index but cannot decode. Listed, greyed out, still revealable. */
export const UNPLAYABLE_AUDIO_EXTENSIONS = new Set(['wma', 'ape', 'wv', 'rex', 'rx2'])

export const MIDI_EXTENSIONS = new Set(['mid', 'midi'])

/** DAW session/project files. Indexed so the library shows where the work actually lives. */
export const PROJECT_EXTENSIONS = new Set([
  'als',
  'alp',
  'flp',
  'logicx',
  'ptx',
  'ptf',
  'cpr',
  'npr',
  'rpp',
  'song',
  'band',
  'mmp',
  'mmpz',
  'sesx',
  'reason',
  'rns',
  'dawproject',
  'bwproject',
  'omg',
  'ssnd'
])

/** Directories that are never worth walking into. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$recycle.bin',
  'system volume information',
  '.trashes',
  '.trash',
  '.spotlight-v100',
  '.fseventsd',
  '.documentrevisions-v100',
  '.temporaryitems',
  '__macosx',
  'ableton project info',
  'freeze files'
])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function isIndexable(ext: string): boolean {
  return (
    PLAYABLE_EXTENSIONS.has(ext) ||
    UNPLAYABLE_AUDIO_EXTENSIONS.has(ext) ||
    MIDI_EXTENSIONS.has(ext) ||
    PROJECT_EXTENSIONS.has(ext)
  )
}

/**
 * What sort of file this is, from its extension alone.
 *
 * Deliberately not a guess at what the file is *for* - folder and file names are far too
 * inconsistent to infer "sample" vs "stem" vs "demo" reliably, and a wrong badge on every
 * row is worse than no badge. Purpose is what tags are for.
 */
export function classifyKind(ext: string): TrackKind {
  if (PROJECT_EXTENSIONS.has(ext)) return 'project'
  if (MIDI_EXTENSIONS.has(ext)) return 'midi'
  return 'audio'
}
