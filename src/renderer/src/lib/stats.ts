import type { Track } from '@shared/types'
import { relativeKeyPair } from '@shared/keys'
import { isUnderAnyDir } from '@/lib/paths'

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

  /**
   * Both measured over capped time, like every other figure here. A project left open for
   * three days is not three days of work, and letting one of them into the mean - or into
   * the tail of the histogram - describes the forgotten window rather than the habit.
   */
  medianMinutes: number
  meanMinutes: number
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

    records.push({
      path: track.path,
      name: track.name,
      relDir: track.relDir,
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
    const minutes = cap(seconds) / 60
    for (let i = 0; i < HIST_BOUNDS.length - 1; i++) {
      if (minutes >= HIST_BOUNDS[i] && minutes < HIST_BOUNDS[i + 1]) {
        histogram[i].count++
        break
      }
    }
  }

  const nonZero = sorted.filter((value) => value > 0).map(cap)
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
    histogram
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
  /** Distinct works in range - not files - and how many of them have a key. */
  audio: number
  withKey: number
  /**
   * Projects in range carrying a tempo. Not audio files: see `computeMusicStats`.
   */
  withTempo: number
  /**
   * The same two counts over the whole library, ignoring the range. Lets the page keep the
   * panels on screen for a window that happens to be empty, instead of the section
   * vanishing and reading as though the range control had broken it.
   */
  libraryWithKey: number
  libraryWithTempo: number
  /** Keys by how often you write in them, commonest first. */
  keys: Array<{ label: string; count: number }>
  /**
   * The relative pairs in circle-of-fifths order, empty ones left out. Ranked bars answer
   * "which key most", which is one number; laid out around the wheel the same bars also
   * show whether a preference is a neighbourhood or a scattering. A key with no files in
   * the window is dropped rather than drawn as a flat bar with a label under it - over the
   * whole library all twelve are occupied, but a short range fills three of them.
   */
  keyWheel: Array<{ label: string; count: number }>
  /** Tempos to the nearest whole BPM, commonest first. */
  tempos: Array<{ bpm: number; count: number }>
  /**
   * One bin per BPM across the range actually in use.
   *
   * This is the ranking and the spread in one chart, which is what they always were: a
   * producer works at exact tempos, so the commonest ones stand up as spikes and the shape
   * between them is the spread. Two panels split that into a list with no shape and a shape
   * with no names, and neither of them said 140 twice as often as 150.
   */
  histogram: Array<{ bpm: number; count: number }>
  medianBpm: number | null
}

/**
 * The twelve relative pairs, fifths apart. Spelled by `relativeKeyPair` rather than by hand
 * so the labels are the same strings the counting produced - one table that disagreed about
 * F#/D#m would silently plot a zero beside a key with fifty files in it.
 */
const FIFTHS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F']

/**
 * The renders one piece of music leaves behind: `REFLECT_Master.wav`, `REFLECT.mp3` and
 * `REFLECT_notag.wav` are one track, not three. Only words that name a *render* are
 * stripped - not `(1)`, which in a sample pack is the difference between one hi-hat and
 * the next.
 */
const RENDER_SUFFIX =
  /(?:[_\s-]*(?:master(?:ed)?|notag|no[_\s-]?tag|final|mixdown|mixed|mix|render|export|v\d+|copy))+$/i

/**
 * The work a file is a render of: its folder plus its name with the render words off.
 *
 * Exported because the explorer folds rows by the same rule (`Settings.collapseRenders`).
 * Two definitions of "one track" that disagreed would be a bug nobody could see: the panels
 * would count 40 songs where the list showed 41 rows and neither would look wrong.
 */
export function workOf(track: Track): string {
  const stem = track.name.replace(/\.[^.]+$/, '')
  return `${track.relDir}/${stem.replace(RENDER_SUFFIX, '').trim()}`.toLowerCase()
}

/**
 * What you write, as opposed to how long you spend writing it.
 *
 * **Tempo comes from the projects, key comes from the audio**, and the split is not an
 * inconsistency. An `.flp` states its tempo exactly (`fillTemposFromProjects` puts it on the
 * project's own row), so counting projects replaces a detector that is right two thirds of
 * the time with a fact - and one project is one piece of music, where its master, its MP3 and
 * its notag render are three files that were only ever one. An FLP says nothing about key, so
 * that half still reads the audio, folded per work.
 *
 * Each is dated by what it has: a project by when FL Studio recorded it as created, an audio
 * file by its own mtime, since an export is the only date it carries. Both answer the range
 * control.
 *
 * Keys are counted as relative pairs - Eb and Cm are one entry - because that is how a
 * detected key is displayed, and because the two share every note. Counting them apart
 * would split one preference across two rows and make neither of them look like a habit.
 *
 * Two rules keep this a description of the music *you* made, and both are load-bearing.
 * Measured on this library, without them the panels counted 55,993 audio files and
 * announced 19,092 keys:
 *
 *   - `excludeDirs` (`Settings.randomExcludeDirs`) is a list the user already curates for
 *     the random button, and it names the sample packs. 45,775 of the 49,213 works here
 *     live under `Sauce Ingredients` - other people's drum kits and loop libraries, whose
 *     file names are where nearly all of those keys came from. A statistic titled "keys you
 *     write in" that is 93% somebody else's loop pack is not a fact about the user at all.
 *   - Renders are folded, because a track exported as both a master and an MP3 voted twice.
 *
 * Together they take 55,993 files down to the ~1,500 pieces of music behind them.
 */
export function computeMusicStats(
  tracks: Track[],
  range?: StatsRange | null,
  excludeDirs: string[] = []
): MusicStats {
  const endExclusiveMs = range ? addDays(range.endMs, 1) : 0
  const keyCounts = new Map<string, number>()
  const tempoCounts = new Map<number, number>()
  const bpms: number[] = []
  let audio = 0
  let withKey = 0
  let withTempo = 0
  let libraryWithKey = 0
  let libraryWithTempo = 0

  /**
   * One entry per work. The largest render represents it - the master rather than the MP3
   * beside it - and a value it happens to lack is taken from a sibling, so folding can only
   * ever lose a duplicate and never a reading.
   */
  const works = new Map<string, { track: Track; key?: string }>()
  for (const track of tracks) {
    // Projects carry the tempo half, below. A backup copy is the same project counted twice,
    // which is why `collectProjects` drops them and why this does too.
    if (track.ext === 'flp' && !isBackupPath(track.rel) && !isUnderAnyDir(track.relDir, excludeDirs)) {
      if (track.bpm !== undefined && track.bpm > 0) {
        libraryWithTempo++
        const created = track.projectCreatedMs
        // A project FL Studio never dated cannot answer a dated window, the same rule the
        // rest of the page applies to them.
        if (range && (created === undefined || created < range.startMs || created >= endExclusiveMs)) {
          continue
        }
        withTempo++
        const rounded = Math.round(track.bpm)
        tempoCounts.set(rounded, (tempoCounts.get(rounded) ?? 0) + 1)
        bpms.push(rounded)
      }
      continue
    }
    if (track.kind !== 'audio') continue
    if (isUnderAnyDir(track.relDir, excludeDirs)) continue

    const id = workOf(track)
    const existing = works.get(id)
    if (!existing) {
      works.set(id, { track, key: track.musicalKey })
      continue
    }
    if (track.size > existing.track.size) {
      existing.track = track
      if (track.musicalKey) existing.key = track.musicalKey
    } else {
      existing.key ??= track.musicalKey
    }
  }

  for (const work of works.values()) {
    // Counted before the range test, so an empty window can still be told apart from a
    // library that has never been analysed.
    if (work.key) libraryWithKey++
    const { mtimeMs } = work.track
    if (range && (mtimeMs < range.startMs || mtimeMs >= endExclusiveMs)) continue
    audio++

    if (work.key) {
      withKey++
      const label = relativeKeyPair(work.key)
      keyCounts.set(label, (keyCounts.get(label) ?? 0) + 1)
    }
  }

  const keys = [...keyCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const tempos = [...tempoCounts.entries()]
    .map(([bpm, count]) => ({ bpm, count }))
    .sort((a, b) => b.count - a.count || a.bpm - b.bpm)

  const keyWheel = FIFTHS.map((major) => relativeKeyPair(major))
    .map((label) => ({ label, count: keyCounts.get(label) ?? 0 }))
    .filter((entry) => entry.count > 0)

  // Bins over the range that is actually in use, so a library that lives between 120 and
  // 160 doesn't spend nine tenths of its chart on empty bars. Whole BPM: the spikes at the
  // tempos actually worked at are the point, and a ten-wide bin flattens them into a slab.
  const histogram: MusicStats['histogram'] = []
  if (bpms.length > 0) {
    // Reduced rather than spread into Math.min/max, which blows the stack on large
    // inputs - same trap `computeStats` already dodges.
    let min = Infinity
    let max = -Infinity
    for (const bpm of bpms) {
      if (bpm < min) min = bpm
      if (bpm > max) max = bpm
    }
    // Rounded out to tens so the axis can be labelled at every tenth bar.
    const low = Math.floor(min / 10) * 10
    const high = Math.ceil((max + 1) / 10) * 10
    for (let bpm = low; bpm < high; bpm++) {
      histogram.push({ bpm, count: tempoCounts.get(bpm) ?? 0 })
    }
  }

  const sorted = bpms.slice().sort((a, b) => a - b)
  const medianBpm = sorted.length > 0 ? quantile(sorted, 0.5) : null

  return {
    audio,
    withKey,
    withTempo,
    libraryWithKey,
    libraryWithTempo,
    keys,
    keyWheel,
    tempos,
    histogram,
    medianBpm
  }
}
