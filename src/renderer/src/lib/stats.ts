import type { Track } from '@shared/types'
import { relativeKeyPair } from '@shared/keys'

/**
 * Production statistics derived from FL Studio's per-project time tracking.
 *
 * Ported from the standalone flp_dashboard.py. Two corrections matter and are kept:
 * backup copies are excluded so the same project isn't counted twice, and idle-inflated
 * sessions (a project left open overnight) are capped at an IQR fence so one forgotten
 * window doesn't dominate the totals.
 */

export interface ProjectRecord {
  path: string
  name: string
  relDir: string
  /** Top-level folder under the library root - the natural grouping. */
  category: string
  createdMs?: number
  seconds: number
  isBackup: boolean
}

export interface MonthPoint {
  /** YYYY-MM */
  ym: string
  label: string
  count: number
  hours: number
}

export interface DayPoint {
  /** Local midnight of the day - the key the day views index by. */
  dayMs: number
  count: number
  hours: number
}

export interface Stats {
  total: number
  parsed: number
  backups: number
  counted: number
  dated: number
  /**
   * Non-backup projects in the whole library, ignoring the range. Lets a view tell "nothing
   * scanned yet" apart from "nothing happened in the selected range".
   */
  libraryCounted: number
  /** The range these figures describe - local midnights, inclusive; `null` for all time. */
  rangeStartMs: number | null
  rangeEndMs: number | null

  rawHours: number
  /** Total after capping outliers - the headline figure. */
  normalizedHours: number
  capHours: number | null
  cappedCount: number

  medianMinutes: number
  meanMinutes: number
  longestHours: number
  longestName: string
  firstCreatedMs: number | null
  lastCreatedMs: number | null

  years: Array<{ year: number; count: number; hours: number }>
  /** One row per year, twelve columns - activity across the whole history at a glance. */
  yearMonths: Array<{ year: number; counts: number[]; hours: number[] }>
  /**
   * Only days that saw activity, ascending. Sparse on purpose: the day views pick a
   * range and fill their own gaps, so storing every empty day would be dead weight.
   */
  daily: DayPoint[]
  /** The single most productive day by project count. */
  bestDay: DayPoint | null
  timeline: MonthPoint[]
  /** Monday-first weekday totals. */
  weekday: number[]
  hour: number[]
  /** [weekday][hour] project counts. */
  heat: number[][]
  histogram: Array<{ label: string; count: number }>
  categories: Array<{ category: string; count: number; hours: number }>
}

/**
 * Creation dates before this are unreliable - old projects carry timestamps FL Studio
 * never wrote correctly, and they drag the charts across years that never happened. Such
 * records are treated as undated: they still count toward totals, but they're kept out of
 * anything plotted against time.
 */
export const ANALYSIS_START_YEAR = 2018
const ANALYSIS_START_MS = new Date(ANALYSIS_START_YEAR, 0, 1).getTime()

/** The time window every figure on the stats page is computed over. */
export type RangeId = 'all' | '7d' | '1m' | '3m' | '6m' | '1y' | 'ytd'

export interface StatsRange {
  /** Local midnight of the first day, inclusive. */
  startMs: number
  /** Local midnight of the last day, inclusive. */
  endMs: number
}

export const STAT_RANGES: Array<{ id: RangeId; label: string; title: string }> = [
  { id: 'all', label: 'All', title: 'all time' },
  { id: '7d', label: '7d', title: 'the last 7 days' },
  { id: '1m', label: '1m', title: 'the last month' },
  { id: '3m', label: '3m', title: 'the last 3 months' },
  { id: '6m', label: '6m', title: 'the last 6 months' },
  { id: '1y', label: '1y', title: 'the last year' },
  { id: 'ytd', label: 'YTD', title: 'the year so far' }
]

/**
 * Ranges are anchored to today and inclusive of it. "All time" has no bounds at all, which
 * is what lets it keep the undated projects that any dated window has to drop.
 */
export function rangeBounds(range: RangeId, todayMs: number): StatsRange | null {
  const endMs = startOfDayMs(todayMs)
  const today = new Date(endMs)
  const year = today.getFullYear()
  const month = today.getMonth()
  const date = today.getDate()
  switch (range) {
    case 'all':
      return null
    case '7d':
      return { startMs: addDays(endMs, -6), endMs }
    case '1m':
      return { startMs: new Date(year, month - 1, date + 1).getTime(), endMs }
    case '3m':
      return { startMs: new Date(year, month - 3, date + 1).getTime(), endMs }
    case '6m':
      return { startMs: new Date(year, month - 6, date + 1).getTime(), endMs }
    case 'ytd':
      return { startMs: new Date(year, 0, 1).getTime(), endMs }
    default:
      return { startMs: new Date(year - 1, month, date + 1).getTime(), endMs }
  }
}

const HIST_BOUNDS = [0, 15, 30, 45, 60, 90, 120, 180, 240, 330, Infinity]
const HIST_LABELS = [
  '0–15m',
  '15–30m',
  '30–45m',
  '45–60m',
  '1–1.5h',
  '1.5–2h',
  '2–3h',
  '3–4h',
  '4–5.5h',
  '5.5h+'
]

function isBackupPath(rel: string): boolean {
  return rel
    .toLowerCase()
    .split('/')
    .some((segment) => segment === 'backup' || segment === 'backups')
}

/** Local midnight. Days are calendar days in the user's zone, not UTC slices. */
export function startOfDayMs(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Steps by calendar date rather than adding 86.4e6ms, which drifts across DST. */
export function addDays(ms: number, days: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[base + 1]
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base]
}

export function collectProjects(tracks: Track[]): ProjectRecord[] {
  const records: ProjectRecord[] = []
  for (const track of tracks) {
    if (track.ext !== 'flp') continue
    // Unprobed, or an .flp with no time record at all.
    if (track.projectSeconds === undefined) continue

    const segments = track.rel.split('/')
    records.push({
      path: track.path,
      name: track.name,
      relDir: track.relDir,
      category: segments.length > 1 ? segments[0] : 'Library root',
      createdMs:
        track.projectCreatedMs !== undefined && track.projectCreatedMs >= ANALYSIS_START_MS
          ? track.projectCreatedMs
          : undefined,
      seconds: track.projectSeconds,
      isBackup: isBackupPath(track.rel)
    })
  }
  return records
}

/**
 * `range` governs every figure returned, so the whole page can describe one window without
 * each panel re-filtering (and disagreeing) on its own. Undated records - creation dates
 * FL Studio never wrote correctly, see ANALYSIS_START_YEAR - survive only when the range is
 * unbounded: any dated window has nowhere to put them.
 */
export function computeStats(tracks: Track[], range?: StatsRange | null): Stats {
  const all = collectProjects(tracks)
  // End is an inclusive local midnight, so the last day counts in full.
  const endExclusiveMs = range ? addDays(range.endMs, 1) : 0
  const records = range
    ? all.filter(
        (r) =>
          r.createdMs !== undefined && r.createdMs >= range.startMs && r.createdMs < endExclusiveMs
      )
    : all
  const counted = records.filter((r) => !r.isBackup)
  const times = counted.map((r) => r.seconds)

  // Outlier fence: a project left open overnight would otherwise swamp the total.
  const sorted = times.slice().sort((a, b) => a - b)
  let fence = Infinity
  if (sorted.length >= 4) {
    const q1 = quantile(sorted, 0.25)
    const q3 = quantile(sorted, 0.75)
    fence = q3 + 1.5 * (q3 - q1)
  }
  const cap = (seconds: number): number => Math.min(seconds, fence)

  const rawTotal = times.reduce((sum, value) => sum + value, 0)
  const normalizedTotal = times.reduce((sum, value) => sum + cap(value), 0)

  const dated = counted.filter((r) => r.createdMs !== undefined)

  const perYear = new Map<number, { count: number; seconds: number }>()
  const perMonth = new Map<string, { count: number; seconds: number }>()
  const perYearMonth = new Map<number, { counts: number[]; seconds: number[] }>()
  const perDay = new Map<number, { count: number; seconds: number }>()
  const weekday = new Array<number>(7).fill(0)
  const hour = new Array<number>(24).fill(0)
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))

  for (const record of dated) {
    const date = new Date(record.createdMs as number)
    const year = date.getFullYear()
    const ym = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`
    // JS weeks start Sunday; shift so Monday is index 0, as in the original report.
    const dow = (date.getDay() + 6) % 7

    const yearEntry = perYear.get(year) ?? { count: 0, seconds: 0 }
    yearEntry.count++
    yearEntry.seconds += cap(record.seconds)
    perYear.set(year, yearEntry)

    const monthEntry = perMonth.get(ym) ?? { count: 0, seconds: 0 }
    monthEntry.count++
    monthEntry.seconds += cap(record.seconds)
    perMonth.set(ym, monthEntry)

    const grid =
      perYearMonth.get(year) ??
      { counts: new Array<number>(12).fill(0), seconds: new Array<number>(12).fill(0) }
    grid.counts[date.getMonth()]++
    grid.seconds[date.getMonth()] += cap(record.seconds)
    perYearMonth.set(year, grid)

    const dayMs = startOfDayMs(record.createdMs as number)
    const dayEntry = perDay.get(dayMs) ?? { count: 0, seconds: 0 }
    dayEntry.count++
    dayEntry.seconds += cap(record.seconds)
    perDay.set(dayMs, dayEntry)

    weekday[dow]++
    hour[date.getHours()]++
    heat[dow][date.getHours()]++
  }

  // Fill month gaps so the timeline reads as continuous time, not as ordinal categories.
  const monthKeys = [...perMonth.keys()].sort()
  const timeline: MonthPoint[] = []
  if (monthKeys.length > 0) {
    const [startYear, startMonth] = monthKeys[0].split('-').map(Number)
    const [endYear, endMonth] = monthKeys[monthKeys.length - 1].split('-').map(Number)
    let year = startYear
    let month = startMonth
    while (year < endYear || (year === endYear && month <= endMonth)) {
      const ym = `${year}-${String(month).padStart(2, '0')}`
      const entry = perMonth.get(ym) ?? { count: 0, seconds: 0 }
      timeline.push({
        ym,
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        count: entry.count,
        hours: entry.seconds / 3600
      })
      month++
      if (month > 12) {
        month = 1
        year++
      }
    }
  }

  const daily: DayPoint[] = [...perDay.entries()]
    .map(([dayMs, entry]) => ({ dayMs, count: entry.count, hours: entry.seconds / 3600 }))
    .sort((a, b) => a.dayMs - b.dayMs)
  // Ties go to the earlier day, so the record stands until it's actually beaten.
  const bestDay = daily.reduce<DayPoint | null>(
    (best, day) => (best === null || day.count > best.count ? day : best),
    null
  )

  const histogram = HIST_LABELS.map((label) => ({ label, count: 0 }))
  for (const seconds of times) {
    const minutes = seconds / 60
    for (let i = 0; i < HIST_BOUNDS.length - 1; i++) {
      if (minutes >= HIST_BOUNDS[i] && minutes < HIST_BOUNDS[i + 1]) {
        histogram[i].count++
        break
      }
    }
  }

  const categoryMap = new Map<string, { count: number; seconds: number }>()
  for (const record of counted) {
    const entry = categoryMap.get(record.category) ?? { count: 0, seconds: 0 }
    entry.count++
    entry.seconds += cap(record.seconds)
    categoryMap.set(record.category, entry)
  }

  const nonZero = sorted.filter((value) => value > 0)
  const longest = counted.reduce<ProjectRecord | null>(
    (best, record) => (best === null || record.seconds > best.seconds ? record : best),
    null
  )
  // Reduced rather than spread into Math.min/max, which blows the stack on large inputs.
  let firstCreatedMs: number | null = null
  let lastCreatedMs: number | null = null
  for (const record of dated) {
    const ms = record.createdMs as number
    if (firstCreatedMs === null || ms < firstCreatedMs) firstCreatedMs = ms
    if (lastCreatedMs === null || ms > lastCreatedMs) lastCreatedMs = ms
  }

  return {
    total: records.length,
    parsed: records.length,
    backups: records.length - counted.length,
    counted: counted.length,
    dated: dated.length,
    libraryCounted: all.reduce((sum, record) => (record.isBackup ? sum : sum + 1), 0),
    rangeStartMs: range ? range.startMs : null,
    rangeEndMs: range ? range.endMs : null,

    rawHours: rawTotal / 3600,
    normalizedHours: normalizedTotal / 3600,
    capHours: Number.isFinite(fence) ? fence / 3600 : null,
    cappedCount: times.filter((value) => value > fence).length,

    medianMinutes: nonZero.length ? quantile(nonZero, 0.5) / 60 : 0,
    meanMinutes: nonZero.length
      ? nonZero.reduce((sum, value) => sum + value, 0) / nonZero.length / 60
      : 0,
    longestHours: longest ? longest.seconds / 3600 : 0,
    longestName: longest?.name ?? '',
    firstCreatedMs,
    lastCreatedMs,

    years: [...perYear.entries()]
      .map(([year, entry]) => ({ year, count: entry.count, hours: entry.seconds / 3600 }))
      .sort((a, b) => a.year - b.year),
    // Gap years are filled in so a quiet stretch reads as a gap rather than being skipped.
    yearMonths: fillYearGaps(perYearMonth),
    daily,
    bestDay,
    timeline,
    weekday,
    hour,
    heat,
    histogram,
    categories: [...categoryMap.entries()]
      .map(([category, entry]) => ({
        category,
        count: entry.count,
        hours: entry.seconds / 3600
      }))
      .sort((a, b) => b.hours - a.hours)
  }
}

/**
 * Turns the per-year map into a dense run of years. A quiet year should show as an empty
 * row, not vanish and make the axis lie about the passage of time.
 */
function fillYearGaps(
  perYearMonth: Map<number, { counts: number[]; seconds: number[] }>
): Array<{ year: number; counts: number[]; hours: number[] }> {
  const years = [...perYearMonth.keys()].sort((a, b) => a - b)
  if (years.length === 0) return []

  const result: Array<{ year: number; counts: number[]; hours: number[] }> = []
  for (let year = years[0]; year <= years[years.length - 1]; year++) {
    const entry = perYearMonth.get(year)
    result.push({
      year,
      counts: entry ? entry.counts : new Array<number>(12).fill(0),
      hours: entry
        ? entry.seconds.map((seconds) => seconds / 3600)
        : new Array<number>(12).fill(0)
    })
  }
  return result
}

/* ------------------------------------------------------------------ day grids */

/** Dense run of days, so a quiet stretch reads as a gap instead of being skipped. */
export function daysInRange(daily: DayPoint[], startMs: number, endMs: number): DayPoint[] {
  const index = new Map(daily.map((day) => [day.dayMs, day]))
  const days: DayPoint[] = []
  for (let ms = startMs; ms <= endMs; ms = addDays(ms, 1)) {
    days.push(index.get(ms) ?? { dayMs: ms, count: 0, hours: 0 })
  }
  return days
}

/**
 * Splits a dense run of days into calendar years. One continuous strip spanning years is
 * hundreds of columns wide and unreadable; a year is the block people actually compare.
 * Newest first, because that's the year the eye should land on.
 */
export function splitDaysByYear(days: DayPoint[]): Array<{ year: number; days: DayPoint[] }> {
  const blocks: Array<{ year: number; days: DayPoint[] }> = []
  for (const day of days) {
    const year = new Date(day.dayMs).getFullYear()
    const last = blocks[blocks.length - 1]
    // Input is ascending and dense, so a year is never revisited once it's closed.
    if (last && last.year === year) last.days.push(day)
    else blocks.push({ year, days: [day] })
  }
  return blocks.reverse()
}

export interface Calendar {
  /** [weekday][week] values, `null` where the padded week falls outside the range. */
  rows: Array<Array<number | null>>
  /** [weekday][week] day keys, parallel to `rows`, for labelling a cell with its date. */
  cells: Array<Array<number | null>>
  columnLabels: string[]
}

/** Contribution-graph layout: a column per week, a row per weekday, Monday on top. */
export function buildCalendar(days: DayPoint[], metric: 'count' | 'hours'): Calendar {
  const rows: Array<Array<number | null>> = Array.from({ length: 7 }, () => [])
  const cells: Array<Array<number | null>> = Array.from({ length: 7 }, () => [])
  const columnLabels: string[] = []
  if (days.length === 0) return { rows, cells, columnLabels }

  // JS weeks start Sunday; shift so Monday is index 0, then pad the first column back to it.
  const lead = (new Date(days[0].dayMs).getDay() + 6) % 7
  const weeks = Math.ceil((lead + days.length) / 7)
  let labelledMonth = -1

  for (let week = 0; week < weeks; week++) {
    let label = ''
    for (let dow = 0; dow < 7; dow++) {
      const index = week * 7 + dow - lead
      const day = index >= 0 && index < days.length ? days[index] : null
      rows[dow][week] = day ? (metric === 'count' ? day.count : day.hours) : null
      cells[dow][week] = day ? day.dayMs : null
      if (day && label === '') {
        const month = new Date(day.dayMs).getMonth()
        if (month !== labelledMonth) {
          label = MONTH_NAMES[month]
          labelledMonth = month
        }
      }
    }
    columnLabels.push(label)
  }

  return { rows, cells, columnLabels }
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "12h 30m" / "45m" - compact enough for a stat tile. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0h'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
  if (whole >= 100) return `${Math.round(hours).toLocaleString()}h`
  return minutes > 0 ? `${whole}h ${minutes}m` : `${whole}h`
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—'
  if (minutes < 60) return `${Math.round(minutes)}m`
  return formatHours(minutes / 60)
}


/* ------------------------------------------------------------------ key and tempo */

export interface MusicStats {
  /** Audio files in range, and how many of them have each figure. */
  audio: number
  withKey: number
  withTempo: number
  /** Keys by how often you write in them, commonest first. */
  keys: Array<{ label: string; count: number }>
  /** Tempos to the nearest whole BPM, commonest first. */
  tempos: Array<{ bpm: number; count: number }>
  /** Ten-BPM bins across the range actually used, for a shape rather than a ranking. */
  histogram: Array<{ label: string; count: number }>
  medianBpm: number | null
}

/**
 * What you write, as opposed to how long you spend writing it.
 *
 * Audio files rather than projects, dated by the file's own timestamp: an export is the
 * moment a piece of music existed at that tempo in that key, and it is the only date an
 * audio file carries. That means the range control governs this the same way it governs
 * everything else on the page.
 *
 * Keys are counted as relative pairs - Eb and Cm are one entry - because that is how a
 * detected key is displayed, and because the two share every note. Counting them apart
 * would split one preference across two rows and make neither of them look like a habit.
 */
export function computeMusicStats(tracks: Track[], range?: StatsRange | null): MusicStats {
  const endExclusiveMs = range ? addDays(range.endMs, 1) : 0
  const keyCounts = new Map<string, number>()
  const tempoCounts = new Map<number, number>()
  const bpms: number[] = []
  let audio = 0
  let withKey = 0
  let withTempo = 0

  for (const track of tracks) {
    if (track.kind !== 'audio') continue
    if (range && (track.mtimeMs < range.startMs || track.mtimeMs >= endExclusiveMs)) continue
    audio++

    if (track.musicalKey) {
      withKey++
      const label = relativeKeyPair(track.musicalKey)
      keyCounts.set(label, (keyCounts.get(label) ?? 0) + 1)
    }
    if (track.bpm !== undefined && track.bpm > 0) {
      withTempo++
      const rounded = Math.round(track.bpm)
      tempoCounts.set(rounded, (tempoCounts.get(rounded) ?? 0) + 1)
      bpms.push(rounded)
    }
  }

  const keys = [...keyCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const tempos = [...tempoCounts.entries()]
    .map(([bpm, count]) => ({ bpm, count }))
    .sort((a, b) => b.count - a.count || a.bpm - b.bpm)

  // Bins over the range that is actually in use, so a library that lives between 120 and
  // 160 doesn't spend nine tenths of its chart on empty bars.
  const histogram: MusicStats['histogram'] = []
  if (bpms.length > 0) {
    const low = Math.floor(Math.min(...bpms) / 10) * 10
    const high = Math.ceil((Math.max(...bpms) + 1) / 10) * 10
    for (let start = low; start < high; start += 10) {
      histogram.push({
        label: `${start}`,
        count: bpms.filter((bpm) => bpm >= start && bpm < start + 10).length
      })
    }
  }

  const sorted = bpms.slice().sort((a, b) => a - b)
  const medianBpm = sorted.length > 0 ? quantile(sorted, 0.5) : null

  return { audio, withKey, withTempo, keys, tempos, histogram, medianBpm }
}
