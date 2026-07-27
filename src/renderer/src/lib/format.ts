import type { Track, TrackKind } from '@shared/types'
import { relativeKeyPair } from '@shared/keys'

/** m:ss, or h:mm:ss once a file runs past an hour. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/** Short duration with a decimal, for one-shots where 0:00 would be useless. */
export function formatDurationPrecise(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—'
  if (seconds < 10) return `${seconds.toFixed(2)}s`
  return formatDuration(seconds)
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** "48k · 24" for PCM, "320k" for compressed, "—" when unprobed. */
export function formatFormat(track: Track): string {
  if (track.sampleRate) {
    const rate = track.sampleRate >= 1000 ? `${(track.sampleRate / 1000).toFixed(track.sampleRate % 1000 === 0 ? 0 : 1)}k` : `${track.sampleRate}`
    if (track.bitDepth) return `${rate} · ${track.bitDepth}`
    if (track.bitrate) return `${rate} · ${Math.round(track.bitrate / 1000)}k`
    return rate
  }
  if (track.bitrate) return `${Math.round(track.bitrate / 1000)}k`
  return '—'
}

export function formatChannels(channels: number | undefined): string {
  if (!channels) return ''
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels}ch`
}

const CURRENT_YEAR = new Date().getFullYear()
const SAME_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' })
const OTHER_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  year: 'numeric'
})
const dateCache = new Map<number, string>()

/**
 * Formatting is memoised per calendar day. `toLocaleDateString` builds a fresh
 * Intl.DateTimeFormat on every call, which is far too slow to run once per visible row
 * on every render - and a library's worth of files only spans a few thousand days.
 */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
})
const dateTimeCache = new Map<number, string>()

/**
 * Date and clock time, for the Modified column.
 *
 * Bounces from the same session land on the same day, so the date alone doesn't order
 * them by eye - which is most of what that column is read for. Memoised per minute, since
 * formatting is far too slow to run per visible row per render.
 */
export function formatDateTime(mtimeMs: number): string {
  if (!mtimeMs) return '—'
  const key = Math.floor(mtimeMs / 60_000)
  const cached = dateTimeCache.get(key)
  if (cached !== undefined) return cached

  const value = `${formatDate(mtimeMs)} ${TIME_FORMAT.format(new Date(mtimeMs))}`
  // A library spans a lot of distinct minutes; keep the cache from growing without bound.
  if (dateTimeCache.size > 20_000) dateTimeCache.clear()
  dateTimeCache.set(key, value)
  return value
}

export function formatDate(mtimeMs: number): string {
  if (!mtimeMs) return '—'
  const date = new Date(mtimeMs)
  const key = date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate()
  const cached = dateCache.get(key)
  if (cached !== undefined) return cached

  const value = (date.getFullYear() === CURRENT_YEAR ? SAME_YEAR_FORMAT : OTHER_YEAR_FORMAT).format(
    date
  )
  dateCache.set(key, value)
  return value
}

export function formatTime(seconds: number): string {
  return formatDuration(Number.isFinite(seconds) ? seconds : 0)
}

export const KIND_LABELS: Record<TrackKind, string> = {
  audio: 'Audio',
  midi: 'MIDI',
  project: 'Project'
}

/** Tailwind classes per kind, driven by the --kind-* tokens in index.css. */
export const KIND_CLASSES: Record<TrackKind, string> = {
  audio: 'text-kind-audio bg-kind-audio/12 border-kind-audio/25',
  midi: 'text-kind-midi bg-kind-midi/12 border-kind-midi/25',
  project: 'text-kind-project bg-kind-project/12 border-kind-project/25'
}

/**
 * The Type column shows the concrete file extension - the same thing an explorer's Type
 * column shows - while the badge colour carries the broader audio / MIDI / project split.
 * Files we can't decode are muted so the distinction is visible at a glance.
 */
export function typeBadgeClass(track: Track): string {
  if (!track.playable && track.kind === 'audio') {
    return 'text-muted-foreground/70 bg-muted border-border/60'
  }
  return KIND_CLASSES[track.kind]
}

export function typeLabel(track: Track): string {
  return track.ext.toUpperCase()
}

/**
 * The colour half of the kind palette, for glyphs rather than badges - the row icon uses
 * it so a row's icon and its Type badge always agree about what the file is.
 */
export function typeIconClass(track: Track): string {
  if (!track.playable && track.kind === 'audio') return 'text-muted-foreground/60'
  if (track.kind === 'midi') return 'text-kind-midi'
  if (track.kind === 'project') return 'text-kind-project'
  return 'text-kind-audio'
}

/** Trailing path segment(s), for showing where a search result actually lives. */
export function parentLabel(relDir: string): string {
  if (!relDir) return 'Library root'
  const parts = relDir.split('/')
  return parts.length <= 2 ? relDir : `…/${parts.slice(-2).join('/')}`
}

export function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * A file name carrying what is known about the track: `beat_Eb-Cm_140.wav`.
 *
 * The key goes in as its relative pair, because that is what the analysis actually
 * establishes - a major key and its relative minor share all seven notes and a chroma
 * detector cannot separate them, so committing a file name to one of them claims more than
 * is known. Hyphenated rather than slashed, since a slash in a file name is a directory.
 *
 * Skips whatever is missing rather than leaving a gap, so a file with a tempo and no key
 * comes out as `beat_140.wav`. Returns null when there is nothing to add, or when the name
 * already ends in exactly this - renaming twice must not give `beat_Eb-Cm_140_Eb-Cm_140`.
 */
export function nameWithMetadata(
  name: string,
  bpm: number | undefined,
  key: string | undefined
): string | null {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  const keyPart = key ? relativeKeyPair(key).replace('/', '-') : undefined
  const parts = [keyPart, bpm === undefined ? undefined : String(Math.round(bpm))].filter(
    (part): part is string => Boolean(part)
  )
  if (parts.length === 0) return null

  const suffix = parts.map((part) => part.replace(/[\/:*?"<>|]/g, '')).join('_')
  if (stem.endsWith(`_${suffix}`)) return null

  return `${stem}_${suffix}${ext}`
}
