import type React from 'react'
import { useMemo, useState } from 'react'
import { Info, Loader2 } from 'lucide-react'
import { motion } from 'motion/react'
import { staggerContainer, staggerItem } from '@/lib/motion'
import { useLibrary } from '@/state/library'
import type { RangeId } from '@/lib/stats'
import {
  ANALYSIS_START_YEAR,
  buildCalendar,
  computeStats,
  computeMusicStats,
  daysInRange,
  formatHours,
  formatMinutes,
  rangeBounds,
  splitDaysByYear,
  STAT_RANGES,
  startOfDayMs,
  WEEKDAY_NAMES
} from '@/lib/stats'
import { BarChart, Heatmap, Panel, StatTile, TimelineChart } from './Charts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) =>
  hour === 0 ? '12a' : hour === 12 ? '12p' : hour < 12 ? `${hour}a` : `${hour - 12}p`
)

function formatDay(ms: number, options: { year?: boolean; weekday?: boolean } = {}): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: options.weekday ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: options.year ? 'numeric' : undefined
  })
}

/** Shared toggle styling: the selected option is the only coloured thing in the row. */
function ToggleButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-5 px-1.5 text-[11px]',
        active ? 'bg-secondary text-primary' : 'text-muted-foreground'
      )}
    >
      {children}
    </Button>
  )
}

/** Holds a panel's shape while its window happens to be empty. */
function EmptyRange({
  what,
  range,
  noun = 'tracks'
}: {
  what: string
  range: string
  noun?: string
}): React.JSX.Element {
  return (
    <div className="flex h-[170px] items-center justify-center text-[11.5px] text-muted-foreground/60">
      No {noun} with a {what} in {range}.
    </div>
  )
}

export function StatsPage(): React.JSX.Element {
  const tracks = useLibrary((s) => s.tracks)
  const revision = useLibrary((s) => s.revision)
  const scanning = useLibrary((s) => s.scanning)
  const excludeDirs = useLibrary((s) => s.settings.randomExcludeDirs)
  const [timelineMetric, setTimelineMetric] = useState<'hours' | 'count'>('hours')
  const [activityMetric, setActivityMetric] = useState<'count' | 'hours'>('count')
  // All time by default: the point of the page is seeing every year at once.
  const [rangeId, setRangeId] = useState<RangeId>('all')

  // Pinned at mount so the memo below isn't invalidated by the clock on every render.
  const [todayMs] = useState(() => startOfDayMs(Date.now()))
  const bounds = useMemo(() => rangeBounds(rangeId, todayMs), [rangeId, todayMs])

  // Filtering happens inside computeStats so every tile, chart and caption below describes
  // the same window - no panel gets to re-filter and disagree.
  const stats = useMemo(
    () => computeStats(tracks, bounds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, revision, bounds]
  )

  // Key and tempo come off the audio rather than the projects, and answer to the same
  // window. The excluded folders are the ones the random button already skips: they are
  // where the sample packs live, and counting other people's loop kits as "keys you write
  // in" was the whole of what made that panel wrong.
  const music = useMemo(
    () => computeMusicStats(tracks, bounds, excludeDirs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, revision, bounds, excludeDirs]
  )

  const range = STAT_RANGES.find((option) => option.id === rangeId) ?? STAT_RANGES[0]

  if (stats.libraryCounted === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        {scanning ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
            <p className="text-[12.5px] text-muted-foreground">
              Reading project files - stats appear as they're parsed.
            </p>
          </>
        ) : (
          <>
            <Info className="h-5 w-5 text-muted-foreground/50" />
            <p className="text-[12.5px] text-muted-foreground">No FL Studio projects found.</p>
            <p className="max-w-[380px] text-[11.5px] leading-relaxed text-muted-foreground/60">
              These stats come from the time-tracking record FL Studio writes into every
              <code className="mx-1 rounded bg-secondary px-1 py-px">.flp</code>. Point umakbang at a
              folder containing your projects to see them.
            </p>
          </>
        )}
      </div>
    )
  }

  const timelinePoints = stats.timeline.map((month) => ({
    label: month.label,
    value: timelineMetric === 'hours' ? month.hours : month.count
  }))

  const firstDate = stats.firstCreatedMs ? new Date(stats.firstCreatedMs) : null
  const busiestMonth = stats.timeline.reduce(
    (best, month) => (best === null || month.count > best.count ? month : best),
    null as (typeof stats.timeline)[number] | null
  )
  const peakHour = stats.hour.indexOf(Math.max(...stats.hour))
  const peakDay = stats.weekday.indexOf(Math.max(...stats.weekday))

  // The two rankings that used to be panels of their own, folded into the captions of the
  // charts that already show the same thing as a shape.
  const topTempos = music.tempos.length
    ? `${music.tempos
        .slice(0, 3)
        .map((tempo) => tempo.bpm)
        .join(', ')} BPM`
    : ''
  const topKey = music.keys[0]?.label ?? ''

  // A bounded range spans exactly its own days; all time spans what actually happened.
  const dayBounds =
    stats.rangeStartMs !== null && stats.rangeEndMs !== null
      ? { startMs: stats.rangeStartMs, endMs: stats.rangeEndMs }
      : stats.firstCreatedMs !== null && stats.lastCreatedMs !== null
        ? { startMs: startOfDayMs(stats.firstCreatedMs), endMs: startOfDayMs(stats.lastCreatedMs) }
        : null
  const activityDays = dayBounds ? daysInRange(stats.daily, dayBounds.startMs, dayBounds.endMs) : []
  const activityTotal = activityDays.reduce(
    (sum, day) => ({ count: sum.count + day.count, hours: sum.hours + day.hours }),
    { count: 0, hours: 0 }
  )
  // Under a month, a bar per day reads far better than a grid two columns wide.
  const asCalendar = rangeId !== '7d' && rangeId !== '1m'
  const yearBlocks = asCalendar
    ? splitDaysByYear(activityDays).map((block) => ({
        year: block.year,
        calendar: buildCalendar(block.days, activityMetric)
      }))
    : []
  // Widest year sets the cell size for all of them, so a partial year isn't drawn chunkier
  // than a full one and the week columns line up down the stack.
  const calendarColumns = Math.max(1, ...yearBlocks.map((b) => b.calendar.columnLabels.length))
  // One scale across every year block, or a quiet year would read as busy as a loud one.
  const activityMax = Math.max(
    ...activityDays.map((day) => (activityMetric === 'count' ? day.count : day.hours)),
    1
  )
  const formatActivity = (value: number): string =>
    activityMetric === 'count'
      ? `${Math.round(value)} ${value === 1 ? 'project' : 'projects'}`
      : formatHours(value)

  const metricToggle = (
    <>
      {(['count', 'hours'] as const).map((metric) => (
        <ToggleButton
          key={metric}
          active={activityMetric === metric}
          onClick={() => setActivityMetric(metric)}
        >
          {metric === 'count' ? 'Projects' : 'Hours'}
        </ToggleButton>
      ))}
    </>
  )

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="mx-auto flex max-w-[1100px] flex-col gap-3 p-4"
      >
        <motion.header
          variants={staggerItem}
          className="flex flex-wrap items-baseline justify-between gap-2"
        >
          <div>
            <h2 className="text-[15px] font-medium">Production stats</h2>
            <p className="text-[11.5px] text-muted-foreground/70">
              From FL Studio's per-project time tracking - {stats.counted.toLocaleString()} projects
              across {range.title}
              {stats.backups > 0 && ` (${stats.backups.toLocaleString()} backups excluded)`}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {scanning && (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                still scanning
              </span>
            )}
            {/* One selector for the whole page: every figure below answers to it. */}
            <div className="flex shrink-0 gap-0.5 rounded-md border bg-card/40 p-0.5">
              {STAT_RANGES.map((option) => (
                <ToggleButton
                  key={option.id}
                  active={rangeId === option.id}
                  onClick={() => setRangeId(option.id)}
                >
                  {option.label}
                </ToggleButton>
              ))}
            </div>
          </div>
        </motion.header>

        {stats.counted === 0 ? (
          <motion.div
            variants={staggerItem}
            className="flex flex-col items-center gap-1.5 rounded-lg border bg-card/40 px-4 py-10 text-center"
          >
            <Info className="h-4 w-4 text-muted-foreground/50" />
            <p className="text-[12.5px] text-muted-foreground">
              No projects created in {range.title}.
            </p>
            <p className="text-[11.5px] text-muted-foreground/60">
              Pick a wider range - “All” covers everything Umakbang has scanned.
            </p>
          </motion.div>
        ) : (
          <>
            {/* Auto-fit, not viewport breakpoints: the stats pane is only part of the
                window, so `lg:` lies about how much room these tiles actually have. */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
              <StatTile
                label="Time producing"
                value={formatHours(stats.normalizedHours)}
                hint={`${formatHours(stats.rawHours)} before capping`}
              />
              <StatTile
                label="Projects"
                value={stats.counted.toLocaleString()}
                hint={
                  rangeId === 'all'
                    ? `${stats.dated.toLocaleString()} with a date`
                    : `across ${range.title}`
                }
              />
              <StatTile
                label="Most in a day"
                value={stats.bestDay ? stats.bestDay.count.toLocaleString() : '—'}
                hint={
                  stats.bestDay
                    ? `${formatDay(stats.bestDay.dayMs, { year: true })} · ${formatHours(
                        stats.bestDay.hours
                      )}`
                    : undefined
                }
              />
              <StatTile
                label="Median project"
                value={formatMinutes(stats.medianMinutes)}
                hint={`mean ${formatMinutes(stats.meanMinutes)}`}
              />
              <StatTile
                label={rangeId === 'all' ? 'Started' : 'First in range'}
                value={
                  firstDate
                    ? rangeId === 'all'
                      ? String(firstDate.getFullYear())
                      : formatDay(firstDate.getTime())
                    : '—'
                }
                hint={
                  firstDate
                    ? firstDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
                    : undefined
                }
              />
            </div>

            <Panel
              title="Over time"
              subtitle={
                busiestMonth
                  ? `Busiest month: ${busiestMonth.label} - ${busiestMonth.count} projects`
                  : undefined
              }
              actions={(['hours', 'count'] as const).map((metric) => (
                <ToggleButton
                  key={metric}
                  active={timelineMetric === metric}
                  onClick={() => setTimelineMetric(metric)}
                >
                  {metric === 'hours' ? 'Hours' : 'Projects'}
                </ToggleButton>
              ))}
            >
              <TimelineChart
                points={timelinePoints}
                valueLabel={timelineMetric === 'hours' ? 'hours' : 'projects'}
                format={(value) =>
                  timelineMetric === 'hours'
                    ? value >= 10
                      ? String(Math.round(value))
                      : value.toFixed(1)
                    : String(Math.round(value))
                }
              />
            </Panel>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
              <Panel title="Projects per year">
                <BarChart
                  bars={stats.years.map((year) => ({
                    label: String(year.year).slice(2),
                    caption: String(year.year),
                    value: year.count
                  }))}
                  format={(value) => `${Math.round(value)} projects`}
                />
              </Panel>

              <Panel title="Hours per year">
                <BarChart
                  bars={stats.years.map((year) => ({
                    label: String(year.year).slice(2),
                    caption: String(year.year),
                    value: year.hours
                  }))}
                  format={(value) => formatHours(value)}
                />
              </Panel>
            </div>

            <Panel
              title="Day by day"
              subtitle={`${activityTotal.count.toLocaleString()} ${
                activityTotal.count === 1 ? 'project' : 'projects'
              } · ${formatHours(activityTotal.hours)} across ${range.title}`}
              actions={metricToggle}
            >
              {asCalendar ? (
                // A calendar per year, newest first - one continuous strip across years is
                // hundreds of columns wide and impossible to read.
                <div className="flex flex-col gap-4">
                  {yearBlocks.map((block, index) => (
                    <div key={block.year} className="flex flex-col gap-1">
                      <div className="tnum text-[11px] font-medium text-muted-foreground">
                        {block.year}
                      </div>
                      <Heatmap
                        rows={block.calendar.rows}
                        // Every other weekday is enough to orient; seven labels crowd the gutter.
                        rowLabels={WEEKDAY_NAMES.map((name, i) => (i % 2 === 0 ? name : ''))}
                        columnLabels={block.calendar.columnLabels}
                        labelEvery={1}
                        rowLabelWidth={24}
                        cellHeight={13}
                        maxCellWidth={22}
                        squareCells
                        sizeColumns={calendarColumns}
                        scaleMax={activityMax}
                        // A day with one project in it against a best day of thirteen.
                        curve="sqrt"
                        legend={index === 0}
                        columnLabelAlign="left"
                        cellTitle={(row, column) => {
                          const dayMs = block.calendar.cells[row][column]
                          if (dayMs === null) return ''
                          return formatDay(dayMs, { weekday: true, year: true })
                        }}
                        format={(value) => formatActivity(value)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <BarChart
                  bars={activityDays.map((day) => ({
                    label:
                      rangeId === '7d'
                        ? WEEKDAY_NAMES[(new Date(day.dayMs).getDay() + 6) % 7]
                        : String(new Date(day.dayMs).getDate()),
                    caption: formatDay(day.dayMs, { weekday: true }),
                    value: activityMetric === 'count' ? day.count : day.hours
                  }))}
                  format={formatActivity}
                  height={160}
                  labelEvery={activityDays.length > 16 ? 2 : 1}
                />
              )}
            </Panel>

            <Panel
              title="When you start projects"
              subtitle={
                // With no dated project in range every bucket is zero and indexOf(max)
                // lands on Monday 12a - a confident peak asserted from no data at all.
                stats.dated > 0
                  ? `Peak: ${WEEKDAY_NAMES[peakDay]} around ${HOUR_LABELS[peakHour]}`
                  : 'No dated projects in this range'
              }
            >
              <Heatmap
                rows={stats.heat}
                rowLabels={WEEKDAY_NAMES}
                columnLabels={HOUR_LABELS}
                format={(value) => `${value} ${value === 1 ? 'project' : 'projects'}`}
              />
            </Panel>

            <Panel
              title="Time per project"
              subtitle="How long a single project stays open, in total"
            >
              <BarChart
                bars={stats.histogram.map((bucket) => ({
                  label: bucket.label.replace('–', '-'),
                  caption: bucket.label,
                  value: bucket.count
                }))}
                format={(value) => `${Math.round(value)} projects`}
                height={150}
              />
            </Panel>
          </>
        )}

        {/* What you write, rather than how long you spend writing it. Audio files dated by
            their own timestamp, so the range control above governs this too - and the panels
            stay put through a window that holds nothing, since a section that disappears
            when you narrow the range reads as the range control having broken it. */}
        {music.libraryWithKey + music.libraryWithTempo > 0 && (
          <>
            <Panel
              title="Tempos you write at"
              subtitle={
                music.withTempo > 0
                  ? `${music.withTempo.toLocaleString()} projects across ${range.title}${
                      music.medianBpm !== null ? ` · median ${Math.round(music.medianBpm)} BPM` : ''
                    }${topTempos ? ` · most often ${topTempos}` : ''}`
                  : `Projects per BPM, across ${range.title}`
              }
            >
              {music.histogram.length > 1 ? (
                <BarChart
                  bars={music.histogram.map((bin) => ({
                    label: String(bin.bpm),
                    caption: `${bin.bpm} BPM`,
                    value: bin.count
                  }))}
                  format={(value) => `${Math.round(value)} ${value === 1 ? 'file' : 'files'}`}
                  height={170}
                  // The bins start on a ten, so every tenth bar is the labelled one.
                  labelEvery={10}
                />
              ) : (
                <EmptyRange what="tempo" range={range.title} noun="projects" />
              )}
            </Panel>

            <Panel
              title="Keys you write in"
              subtitle={
                music.withKey > 0
                  ? `${music.withKey.toLocaleString()} of ${music.audio.toLocaleString()} tracks across ${
                      range.title
                    }, counted as relative pairs${topKey ? ` · most often ${topKey}` : ''}`
                  : `Counted as relative pairs, across ${range.title}`
              }
            >
              {music.withKey > 0 ? (
                // Fifths order rather than commonest-first: neighbouring bars are
                // neighbouring keys, so a run of them is a habit rather than a coincidence.
                <BarChart
                  bars={music.keyWheel.map((key) => ({
                    label: key.label,
                    caption: key.label,
                    value: key.count
                  }))}
                  format={(value) => `${Math.round(value)} ${value === 1 ? 'file' : 'files'}`}
                  height={170}
                />
              ) : (
                <EmptyRange what="key" range={range.title} />
              )}
            </Panel>

            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Tempo is read from the FL Studio projects themselves, one entry per project,
                where an <code className="rounded bg-secondary px-1 py-px">.flp</code> states
                the number exactly and a detector only estimates it. Keys come from the audio,
                counted per track rather than per file, so a piece exported as a master and an
                MP3 votes once. Both leave out the folders excluded from the random button
                (Settings → Not your own work), since a sample pack's file names would
                otherwise decide what you write.
              </span>
            </p>
          </>
        )}

        <p className="flex items-start gap-1.5 pb-2 text-[11px] leading-relaxed text-muted-foreground/60">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            FL Studio counts a project as "open", not as "actively worked on", so a session left
            running overnight inflates its total. Outliers are normalised the way the original
            script did it - an IQR fence - capping anything over{' '}
            {stats.capHours ? formatHours(stats.capHours) : 'the threshold'} ({stats.cappedCount} of{' '}
            {stats.counted} projects); the uncapped figure sits under the headline. Every
            per-project figure here is the capped one, so a window left open for days lands in
            the same bucket as a long session rather than setting a record. Backups are
            excluded so nothing is counted twice, and creation dates before {ANALYSIS_START_YEAR}{' '}
            are treated as unreliable.{' '}
            {rangeId === 'all'
              ? `Those ${(stats.counted - stats.dated).toLocaleString()} undated projects still count toward the totals here, but are left out of anything plotted against time.`
              : `A date range can only hold projects with a usable date, so undated ones are excluded from these figures entirely - switch to All to count them.`}
          </span>
        </p>
      </motion.div>
    </div>
  )
}
