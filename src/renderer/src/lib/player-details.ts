/**
 * The detail line under the track name in the transport strip.
 *
 * Which fields appear is the user's choice, so the list of what's available and the code
 * that renders it live here rather than inside the bar: the settings page shows a live
 * preview of the same line, and two implementations would drift apart the first time one
 * of them gained a field.
 */

import type { Track } from '@shared/types'
import { relativeKeyPair } from '@shared/keys'
import {
  formatChannels,
  formatDateTime,
  formatDurationPrecise,
  formatFormat,
  formatSize,
  parentLabel
} from '@/lib/format'

export type DetailField =
  | 'bpm'
  | 'key'
  | 'format'
  | 'channels'
  | 'size'
  | 'modified'
  | 'duration'
  | 'folder'
  | 'extension'
  | 'projectTime'

export interface DetailFieldDef {
  id: DetailField
  label: string
  /** What it looks like, for the settings list. */
  hint: string
}

/** Every field the line can carry, in the order the settings page lists them. */
export const DETAIL_FIELDS: readonly DetailFieldDef[] = [
  { id: 'bpm', label: 'Tempo', hint: '128 BPM' },
  { id: 'key', label: 'Key', hint: 'F#m' },
  { id: 'format', label: 'Format', hint: '44.1k · 24' },
  { id: 'channels', label: 'Channels', hint: 'stereo' },
  { id: 'duration', label: 'Length', hint: '3:24' },
  { id: 'size', label: 'Size', hint: '12.4 MB' },
  { id: 'modified', label: 'Modified', hint: '07 Feb 2021 03:45 PM' },
  { id: 'extension', label: 'Extension', hint: 'WAV' },
  { id: 'folder', label: 'Folder', hint: '…/Beats/2024' },
  {
    id: 'projectTime',
    label: 'Time on project',
    hint: 'How long the matching FL Studio project has been open'
  }
] as const

/**
 * What the line shows out of the box: what the file *is* musically, then how it was
 * recorded. The housekeeping fields are available but off, because they are the ones you
 * look up about a file rather than read while listening to it.
 */
export const DEFAULT_DETAIL_FIELDS: DetailField[] = ['bpm', 'key', 'format', 'channels']

function valueOf(track: Track, field: DetailField, keyDetected: boolean): string {
  switch (field) {
    case 'bpm':
      return track.bpm === undefined ? '' : `${Math.round(track.bpm)} BPM`
    case 'key':
      if (!track.musicalKey) return ''
      // A guessed key is shown as its relative pair, since that is what the analysis
      // actually established. A declared one says what it says.
      return keyDetected ? relativeKeyPair(track.musicalKey) : track.musicalKey
    case 'format':
      return formatFormat(track)
    case 'channels':
      return formatChannels(track.channels)
    case 'duration':
      return formatDurationPrecise(track.duration)
    case 'size':
      return formatSize(track.size)
    case 'modified':
      return formatDateTime(track.mtimeMs)
    case 'extension':
      return track.ext ? track.ext.toUpperCase() : ''
    case 'folder':
      return parentLabel(track.relDir)
    // Rendered as a clock rather than text, so it has no string form here.
    case 'projectTime':
      return ''
    default:
      return ''
  }
}

/**
 * Renders the chosen fields for a track, in the order they were chosen.
 *
 * The table's formatters fall back to a placeholder dash, which a column needs and a
 * run-on line does not, so a missing value is left out rather than shown as a gap.
 */
export function formatDetails(
  track: Track,
  fields: readonly string[],
  keyDetected = false
): string {
  return fields
    .map((field) => valueOf(track, field as DetailField, keyDetected))
    .filter((part) => part && part !== '—')
    .join(' · ')
}

/** Drops anything unrecognised, so a stale saved list can't blank the line. */
export function normalizeDetailFields(saved: string[] | undefined): DetailField[] {
  if (!saved) return [...DEFAULT_DETAIL_FIELDS]
  const known = new Set(DETAIL_FIELDS.map((f) => f.id as string))
  return saved.filter((field): field is DetailField => known.has(field))
}
