import type { SortKey, Track, TrackKind } from '@shared/types'
import { relativeKeyPair } from '@shared/keys'

/**
 * Query language for the search box.
 *
 * Bare words match the file name and its path. Prefixed terms narrow by field, e.g.
 *   `vox stem: bpm>120 key:Am ext:wav tag:keeper fav:`
 * Everything is ANDed, which is what you want when you're digging for one file.
 */
export interface ParsedQuery {
  terms: string[]
  kinds: TrackKind[]
  extensions: string[]
  tags: string[]
  keys: string[]
  /** Inclusive star range, when the query narrows by rating. */
  minStars?: number
  maxStars?: number
  bpmMin?: number
  bpmMax?: number
  bpmExact?: number
  minDuration?: number
  maxDuration?: number
}

const KIND_VALUES: TrackKind[] = ['audio', 'midi', 'project']

const EMPTY: ParsedQuery = {
  terms: [],
  kinds: [],
  extensions: [],
  tags: [],
  keys: [],
}

export function parseQuery(raw: string): ParsedQuery {
  const query = raw.trim()
  if (!query) return EMPTY

  const result: ParsedQuery = {
    terms: [],
    kinds: [],
    extensions: [],
    tags: [],
    keys: [],
  }

  // Quoted phrases stay together; everything else splits on whitespace.
  const tokens = query.match(/"[^"]*"|\S+/g) ?? []

  for (const rawToken of tokens) {
    const token = rawToken.replace(/^"|"$/g, '')
    if (!token) continue

    const comparison = /^(bpm|dur|duration|len|length|stars|rating)([<>]=?|=)(\d+(?:\.\d+)?)$/i.exec(token)
    if (comparison) {
      const [, field, operator, valueText] = comparison
      const value = Number.parseFloat(valueText)
      const lower = field.toLowerCase()
      const isBpm = lower === 'bpm'
      const isStars = lower === 'stars' || lower === 'rating'
      if (operator.startsWith('>')) {
        if (isStars) result.minStars = Math.min(5, value + 1)
        else if (isBpm) result.bpmMin = value
        else result.minDuration = value
      } else if (operator.startsWith('<')) {
        if (isStars) result.maxStars = Math.max(0, value - 1)
        else if (isBpm) result.bpmMax = value
        else result.maxDuration = value
      } else if (isStars) {
        result.minStars = value
        result.maxStars = value
      } else if (isBpm) {
        result.bpmExact = value
      }
      continue
    }

    const colon = token.indexOf(':')
    if (colon > 0) {
      const field = token.slice(0, colon).toLowerCase()
      const value = token.slice(colon + 1).toLowerCase()

      if (field === 'stars' || field === 'rating' || field === 'rated') {
        // `stars:3` is an exact rating; `stars:3-5` a range; bare `rated:` means any.
        const range = /^(\d)(?:-(\d))?$/.exec(value)
        if (range) {
          result.minStars = Number(range[1])
          result.maxStars = range[2] ? Number(range[2]) : Number(range[1])
        } else {
          result.minStars = 1
          result.maxStars = 5
        }
        continue
      }
      if (field === 'kind' || field === 'type') {
        if ((KIND_VALUES as string[]).includes(value)) result.kinds.push(value as TrackKind)
        continue
      }
      if (field === 'ext' || field === 'format') {
        if (value) result.extensions.push(value.replace(/^\./, ''))
        continue
      }
      if (field === 'tag') {
        if (value) result.tags.push(value)
        continue
      }
      if (field === 'key') {
        if (value) result.keys.push(value)
        continue
      }
      if (field === 'bpm' && value) {
        const bpm = Number.parseFloat(value)
        if (Number.isFinite(bpm)) result.bpmExact = bpm
        continue
      }
    }

    // `stem:` with nothing after it is a natural way to type a kind filter.
    const bareKind = token.replace(/:$/, '').toLowerCase()
    if (token.endsWith(':') && (KIND_VALUES as string[]).includes(bareKind)) {
      result.kinds.push(bareKind as TrackKind)
      continue
    }

    result.terms.push(token.toLowerCase())
  }

  return result
}

export function isEmptyQuery(query: ParsedQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.kinds.length === 0 &&
    query.extensions.length === 0 &&
    query.tags.length === 0 &&
    query.keys.length === 0 &&
    query.minStars === undefined &&
    query.maxStars === undefined &&
    query.bpmMin === undefined &&
    query.bpmMax === undefined &&
    query.bpmExact === undefined &&
    query.minDuration === undefined &&
    query.maxDuration === undefined
  )
}

export interface MatchContext {
  ratings: Record<string, number>
  tags: Record<string, string[]>
}

export function matchesQuery(track: Track, query: ParsedQuery, context: MatchContext): boolean {
  if (query.minStars !== undefined || query.maxStars !== undefined) {
    const rating = context.ratings[track.path] ?? 0
    if (rating < (query.minStars ?? 1) || rating > (query.maxStars ?? 5)) return false
  }

  if (query.kinds.length > 0 && !query.kinds.includes(track.kind)) return false
  if (query.extensions.length > 0 && !query.extensions.includes(track.ext)) return false

  if (query.keys.length > 0) {
    const key = track.musicalKey?.toLowerCase()
    if (!key) return false
    // A detected key is displayed as its relative pair ("Eb/Cm"), so either half is a fair
    // thing to search for even though only one of them is stored.
    const parts = [key, ...relativeKeyPair(key).toLowerCase().split('/')]
    if (!query.keys.some((k) => parts.some((part) => part === k || part.startsWith(k)))) {
      return false
    }
  }

  if (query.tags.length > 0) {
    const trackTags = context.tags[track.path]
    if (!trackTags) return false
    const lowered = trackTags.map((t) => t.toLowerCase())
    if (!query.tags.every((t) => lowered.some((existing) => existing.includes(t)))) return false
  }

  if (query.bpmExact !== undefined) {
    // Tempo detection and tags disagree by a hair often enough that an exact match
    // should tolerate rounding.
    if (track.bpm === undefined || Math.abs(track.bpm - query.bpmExact) > 0.5) return false
  }
  if (query.bpmMin !== undefined && (track.bpm === undefined || track.bpm <= query.bpmMin)) {
    return false
  }
  if (query.bpmMax !== undefined && (track.bpm === undefined || track.bpm >= query.bpmMax)) {
    return false
  }

  if (query.minDuration !== undefined) {
    if (track.duration === undefined || track.duration <= query.minDuration) return false
  }
  if (query.maxDuration !== undefined) {
    if (track.duration === undefined || track.duration >= query.maxDuration) return false
  }

  if (query.terms.length > 0) {
    const haystack = track.rel.toLowerCase()
    for (const term of query.terms) {
      if (!haystack.includes(term)) return false
    }
  }

  return true
}

/**
 * Ranks matches so the most likely target floats up: name hits beat path hits, and an
 * earlier hit beats a later one.
 */
export function scoreMatch(track: Track, query: ParsedQuery): number {
  if (query.terms.length === 0) return 0
  let score = 0
  const name = track.name.toLowerCase()
  const path = track.rel.toLowerCase()

  for (const term of query.terms) {
    const nameIndex = name.indexOf(term)
    if (nameIndex === 0) score += 100
    else if (nameIndex > 0) score += 60 - Math.min(nameIndex, 40)
    else {
      const pathIndex = path.indexOf(term)
      score += pathIndex >= 0 ? 20 : 0
    }
  }
  // Shorter names containing the term are usually the better match.
  score -= Math.min(name.length, 60) / 20
  return score
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareTracks(a: Track, b: Track, key: SortKey, dir: 'asc' | 'desc'): number {
  const sign = dir === 'asc' ? 1 : -1
  switch (key) {
    case 'name':
      return sign * COLLATOR.compare(a.name, b.name)
    case 'kind':
      // The Type column shows the extension, so that's what it should sort by.
      return sign * (COLLATOR.compare(a.ext, b.ext) || COLLATOR.compare(a.name, b.name))
    case 'musicalKey':
      return sign * compareOptionalText(a.musicalKey, b.musicalKey, a, b)
    case 'duration':
      return sign * compareOptionalNumber(a.duration, b.duration, a, b)
    case 'bpm':
      return sign * compareOptionalNumber(a.bpm, b.bpm, a, b)
    case 'sampleRate':
      return sign * compareOptionalNumber(a.sampleRate, b.sampleRate, a, b)
    case 'size':
      return sign * (a.size - b.size || COLLATOR.compare(a.name, b.name))
    case 'mtimeMs':
      return sign * (a.mtimeMs - b.mtimeMs || COLLATOR.compare(a.name, b.name))
    default:
      return 0
  }
}

/** Unprobed/absent values always sink to the bottom, whichever way the column sorts. */
function compareOptionalNumber(
  a: number | undefined,
  b: number | undefined,
  trackA: Track,
  trackB: Track
): number {
  if (a === undefined && b === undefined) return COLLATOR.compare(trackA.name, trackB.name)
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a - b || COLLATOR.compare(trackA.name, trackB.name)
}

function compareOptionalText(
  a: string | undefined,
  b: string | undefined,
  trackA: Track,
  trackB: Track
): number {
  if (!a && !b) return COLLATOR.compare(trackA.name, trackB.name)
  if (!a) return 1
  if (!b) return -1
  return COLLATOR.compare(a, b) || COLLATOR.compare(trackA.name, trackB.name)
}
