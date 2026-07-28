import type React from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { staggerItem } from '@/lib/motion'
import { usePalette } from '@/components/visualizers/palette'
import { cn } from '@/lib/utils'

/**
 * Hand-rolled SVG charts, sized to their container.
 *
 * Every chart here plots a single series, so colour never carries identity - it carries
 * *magnitude*, off the same ramp the level meter and the spectrogram use. Quiet → loud
 * becomes few → many, and a tall bar ends in the same colour a loud signal does, so the
 * page reads as part of the app rather than as a report printed beside it.
 *
 * The ramp is taken from `palette.heat`, the rasterised strip the visualizers index per
 * pixel, so these are the same bytes rather than a second interpretation of the user's
 * stops. Grid and axes stay recessive; hover carries the exact values so the marks don't
 * need a number on every point.
 */

const GRID = 'color-mix(in oklab, var(--muted-foreground) 18%, transparent)'
const INK_MUTED = 'var(--muted-foreground)'

/** How many stops an SVG gradient gets. Enough that the ramp reads as continuous. */
const RAMP_STOPS = 12

/** The ramp at `t`, 0 → 1, as the visualizers' own bytes. */
function rampColor(heat: Uint8ClampedArray, t: number, fallback: string): string {
  const at = Math.round(Math.max(0, Math.min(1, t)) * 255) * 4
  // A canvas-less environment leaves the strip empty; better the accent than black.
  if (heat.length <= at || heat[3] === 0) return fallback
  return `rgb(${heat[at]}, ${heat[at + 1]}, ${heat[at + 2]})`
}

/**
 * The ramp as gradient stops, in *user* space rather than per-element - so a bar is
 * coloured by where its top reaches on the plot, not by its own height. Scaled to the
 * element, every bar would end in the same hot colour and the ramp would say nothing.
 */
function RampStops({
  heat,
  fallback,
  opacityAt
}: {
  heat: Uint8ClampedArray
  fallback: string
  opacityAt?: (t: number) => number
}): React.JSX.Element {
  return (
    <>
      {Array.from({ length: RAMP_STOPS }, (_, i) => {
        const t = i / (RAMP_STOPS - 1)
        return (
          <stop
            key={i}
            offset={t}
            stopColor={rampColor(heat, t, fallback)}
            stopOpacity={opacityAt ? opacityAt(t) : 1}
          />
        )
      })}
    </>
  )
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setWidth(Math.floor(element.getBoundingClientRect().width))
    })
    observer.observe(element)
    setWidth(Math.floor(element.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** Bar with only its top corners rounded, so the mark stays anchored to the baseline. */
function topRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, w / 2, h))
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h}`,
    'Z'
  ].join(' ')
}

interface Tip {
  x: number
  y: number
  title: string
  value: string
}

function Tooltip({ tip, containerWidth }: { tip: Tip; containerWidth: number }): React.JSX.Element {
  // Flip before the tooltip can run past the right edge of the chart.
  const flip = tip.x > containerWidth - 120
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-lg"
      style={{
        left: flip ? undefined : tip.x + 10,
        right: flip ? containerWidth - tip.x + 10 : undefined,
        top: Math.max(0, tip.y - 30)
      }}
    >
      <div className="font-medium">{tip.title}</div>
      <div className="text-muted-foreground">{tip.value}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ stat tile */

export function StatTile({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <motion.div variants={staggerItem} className="rounded-lg border bg-card/40 px-3 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="tnum mt-0.5 truncate text-[19px] font-semibold leading-tight" title={value}>
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{hint}</div>}
    </motion.div>
  )
}

export function Panel({
  title,
  subtitle,
  children,
  className,
  /** Controls that belong to this panel - a metric toggle sits with its own chart. */
  actions
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  className?: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <motion.section
      variants={staggerItem}
      className={cn('rounded-lg border bg-card/40 p-3', className)}
    >
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[12.5px] font-medium">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground/70">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      {children}
    </motion.section>
  )
}

/* ------------------------------------------------------------------ timeline */

export function TimelineChart({
  points,
  valueLabel,
  format,
  height = 150
}: {
  points: Array<{ label: string; value: number }>
  valueLabel: string
  format: (value: number) => string
  height?: number
}): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<Tip | null>(null)
  const palette = usePalette()
  const gradientId = useId()

  const padLeft = 34
  const padRight = 8
  const padTop = 8
  const padBottom = 18
  const plotWidth = Math.max(1, width - padLeft - padRight)
  const plotHeight = height - padTop - padBottom

  const max = Math.max(1, ...points.map((p) => p.value))
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth
  const xAt = (index: number): number => padLeft + index * stepX
  const yAt = (value: number): number => padTop + plotHeight - (value / max) * plotHeight

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(p.value)}`).join(' ')
  const area =
    points.length > 0
      ? `${line} L${xAt(points.length - 1)},${padTop + plotHeight} L${xAt(0)},${padTop + plotHeight} Z`
      : ''

  const ticks = [0, max / 2, max]
  // Roughly one label per 90px, so years don't collide on a narrow window.
  const labelStep = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotWidth / 90))))

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (points.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const index = Math.max(0, Math.min(points.length - 1, Math.round((x - padLeft) / stepX)))
    const point = points[index]
    setTip({
      x: xAt(index),
      y: yAt(point.value),
      title: point.label,
      value: `${format(point.value)} ${valueLabel}`
    })
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          onMouseMove={onMove}
          onMouseLeave={() => setTip(null)}
          role="img"
          aria-label={`${valueLabel} over time`}
        >
          {ticks.map((tick, i) => (
            <g key={i}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={yAt(tick)}
                y2={yAt(tick)}
                stroke={GRID}
                strokeWidth={1}
              />
              <text
                x={padLeft - 6}
                y={yAt(tick) + 3}
                textAnchor="end"
                fontSize={9}
                fill={INK_MUTED}
                opacity={0.7}
              >
                {format(tick)}
              </text>
            </g>
          ))}

          <defs>
            {/* Both run baseline → top of the plot, in user space, so a month's colour is
                how big that month was. `useId` rather than a fixed name: two charts on one
                page sharing a gradient id is one chart drawn with the other's colours. */}
            <linearGradient
              id={`${gradientId}-line`}
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={padTop + plotHeight}
              x2={0}
              y2={padTop}
            >
              <RampStops heat={palette.heat} fallback={palette.primary} />
            </linearGradient>
            <linearGradient
              id={`${gradientId}-area`}
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={padTop + plotHeight}
              x2={0}
              y2={padTop}
            >
              {/* Fades out downwards so the fill never competes with the line on top of it. */}
              <RampStops
                heat={palette.heat}
                fallback={palette.primary}
                opacityAt={(t) => 0.04 + t * 0.3}
              />
            </linearGradient>
          </defs>

          {area && <path d={area} fill={`url(#${gradientId}-area)`} />}
          <path
            d={line}
            fill="none"
            stroke={`url(#${gradientId}-line)`}
            strokeWidth={2}
            strokeLinejoin="round"
          />

          {points.map((point, i) =>
            i % labelStep === 0 ? (
              <text
                key={point.label}
                x={xAt(i)}
                y={height - 5}
                textAnchor="middle"
                fontSize={9}
                fill={INK_MUTED}
                opacity={0.7}
              >
                {point.label}
              </text>
            ) : null
          )}

          {tip && (
            <>
              <line
                x1={tip.x}
                x2={tip.x}
                y1={padTop}
                y2={padTop + plotHeight}
                stroke={palette.hot}
                strokeWidth={1}
                opacity={0.5}
              />
              {/* Marked in the colour the ramp gives that value, so the dot agrees with the
                  line it sits on. 2px surface ring keeps it legible over the area fill. */}
              <circle
                cx={tip.x}
                cy={tip.y}
                r={4}
                fill={rampColor(palette.heat, 1 - (tip.y - padTop) / plotHeight, palette.primary)}
                stroke="var(--card)"
                strokeWidth={2}
              />
            </>
          )}
        </svg>
      )}
      {tip && <Tooltip tip={tip} containerWidth={width} />}
    </div>
  )
}

/* ------------------------------------------------------------------ bars */

export function BarChart({
  bars,
  format,
  height = 140,
  /**
   * Smallest label spacing the caller will accept - BPM bins start on a ten, so labelling
   * every tenth bar is what keeps the axis reading 120, 130, 140 rather than 123, 133.
   * Widened below when the measured width can't letter that many.
   */
  labelEvery = 1
}: {
  bars: Array<{ label: string; value: number; caption?: string }>
  format: (value: number) => string
  height?: number
  labelEvery?: number
}): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<Tip | null>(null)
  const palette = usePalette()
  const gradientId = useId()

  const padBottom = 18
  const padTop = 6
  const plotHeight = height - padBottom - padTop
  const max = Math.max(1, ...bars.map((b) => b.value))
  const slot = bars.length > 0 ? width / bars.length : width
  // 2px of surface between adjacent fills.
  const barWidth = Math.max(3, Math.min(38, slot - 4))

  // A caller cannot know how much room its chart got: the same panel is 1000px wide with
  // the visualizers closed and 250px with them open, and a fixed step that reads cleanly at
  // one width prints the axis over itself at the other. Measured here instead, and always
  // as a multiple of what the caller asked for, so the labelled bars stay the meaningful
  // ones. 5.6px per character at fontSize 9, plus a gap so neighbours don't touch.
  const longestLabel = bars.reduce((longest, bar) => Math.max(longest, bar.label.length), 0)
  const labelFit = Math.max(1, Math.floor(width / (longestLabel * 5.6 + 10)))
  const labelStep =
    bars.length > 0 && width > 0
      ? Math.max(labelEvery, Math.ceil(bars.length / labelFit / labelEvery) * labelEvery)
      : labelEvery

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} onMouseLeave={() => setTip(null)} role="img">
          <defs>
            {/* One ramp across the whole plot, in user space: a bar reaches as far up the
                ramp as its value reaches up the axis, which is the level meter's reading
                turned on its side. Per-element units would give every bar the full ramp and
                make them all the same. */}
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={padTop + plotHeight}
              x2={0}
              y2={padTop}
            >
              <RampStops heat={palette.heat} fallback={palette.primary} />
            </linearGradient>
          </defs>
          <line
            x1={0}
            x2={width}
            y1={padTop + plotHeight}
            y2={padTop + plotHeight}
            stroke={GRID}
            strokeWidth={1}
          />
          {bars.map((bar, i) => {
            const barHeight = Math.max(bar.value > 0 ? 2 : 0, (bar.value / max) * plotHeight)
            const x = i * slot + (slot - barWidth) / 2
            const y = padTop + plotHeight - barHeight
            return (
              <g key={i}>
                <path
                  d={topRoundedPath(x, y, barWidth, barHeight, 4)}
                  fill={`url(#${gradientId})`}
                  opacity={0.92}
                />
                {/* Hit target spans the whole slot, not just the bar. */}
                <rect
                  x={i * slot}
                  y={0}
                  width={slot}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() =>
                    setTip({
                      x: x + barWidth / 2,
                      y,
                      title: bar.caption ?? bar.label,
                      value: format(bar.value)
                    })
                  }
                />
                {i % labelStep === 0 &&
                  (() => {
                    // The end labels are anchored to the edge rather than to their own bar:
                    // centred on a 3px bar at x=0 they hang half outside the svg and the
                    // first tick renders as its own second digit.
                    const centre = i * slot + slot / 2
                    const half = (bar.label.length * 5.6) / 2
                    const anchor =
                      centre - half < 0 ? 'start' : centre + half > width ? 'end' : 'middle'
                    return (
                      <text
                        x={anchor === 'start' ? 0 : anchor === 'end' ? width : centre}
                        y={height - 5}
                        textAnchor={anchor}
                        fontSize={9}
                        fill={INK_MUTED}
                        opacity={0.7}
                      >
                        {bar.label}
                      </text>
                    )
                  })()}
              </g>
            )
          })}
        </svg>
      )}
      {tip && <Tooltip tip={tip} containerWidth={width} />}
    </div>
  )
}

/** Horizontal bars with the value direct-labelled - better for long category names. */
export function RankedBars({
  items,
  format,
  max: maxItems = 10
}: {
  items: Array<{ label: string; value: number; caption?: string }>
  format: (value: number) => string
  max?: number
}): React.JSX.Element {
  const palette = usePalette()
  const shown = items.slice(0, maxItems)
  const max = Math.max(1, ...shown.map((i) => i.value))

  return (
    <div className="flex flex-col gap-1">
      {shown.map((item) => (
        <div key={item.label} className="flex items-center gap-2">
          <span className="w-[38%] shrink-0 truncate text-[11.5px]" title={item.label}>
            {item.label}
          </span>
          <div className="relative h-[14px] flex-1 overflow-hidden rounded-sm bg-muted/50">
            {/* The ramp runs the full track, and the bar reveals as much of it as its
                value earns - the level meter's own trick. */}
            <div
              className="h-full rounded-sm"
              style={{
                width: `${Math.max(1.5, (item.value / max) * 100)}%`,
                backgroundImage: `linear-gradient(to right, ${rampColor(palette.heat, 0, palette.primary)}, ${rampColor(palette.heat, 1, palette.hot)})`,
                backgroundSize: `${Math.max(1, (max / Math.max(item.value, 1)) * 100)}% 100%`,
                opacity: 0.92
              }}
            />
          </div>
          <span className="tnum w-[64px] shrink-0 text-right text-[11px] text-muted-foreground">
            {format(item.value)}
          </span>
          {item.caption && (
            <span className="tnum w-[52px] shrink-0 text-right text-[10.5px] text-muted-foreground/50">
              {item.caption}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ heatmap */

export function Heatmap({
  rows,
  rowLabels,
  columnLabels,
  format,
  /** Show every Nth column label - 24 hourly labels won't fit, 12 monthly ones will. */
  labelEvery = 3,
  rowLabelWidth = 26,
  cellHeight = 13,
  /** Caps cell width so a calendar's cells stay square instead of stretching. */
  maxCellWidth,
  /** Overrides the "row · column" tooltip title - a calendar cell is one date. */
  cellTitle,
  columnLabelAlign = 'center',
  /** Derives the cell size from the measured width so a year's 53 columns stay square. */
  squareCells = false,
  /** Column count to size cells against - stacked grids share one basis so weeks line up. */
  sizeColumns,
  /** Pins the colour scale, so stacked grids stay comparable instead of each self-scaling. */
  scaleMax,
  /**
   * How a value maps onto the ramp. `sqrt` for a long thin tail: the calendar's busiest day
   * holds thirteen projects and a typical one holds a single project, so linearly that day
   * is 0.08 of the way up the ramp and a whole year is painted in the one colour that sits
   * there. The hour grid is spread evenly enough to want the plain scale.
   */
  curve = 'linear',
  legend = true
}: {
  /** `null` marks a cell outside the data's range: rendered blank, not as a zero. */
  rows: Array<Array<number | null>>
  rowLabels: string[]
  columnLabels: string[]
  format: (value: number, row: string, column: string) => string
  labelEvery?: number
  rowLabelWidth?: number
  cellHeight?: number
  maxCellWidth?: number
  cellTitle?: (rowIndex: number, columnIndex: number) => string
  columnLabelAlign?: 'center' | 'left'
  squareCells?: boolean
  sizeColumns?: number
  scaleMax?: number
  curve?: 'linear' | 'sqrt'
  legend?: boolean
}): React.JSX.Element {
  const [tip, setTip] = useState<Tip | null>(null)
  const [ref, width] = useWidth<HTMLDivElement>()
  const palette = usePalette()
  const max = Math.max(1, scaleMax ?? Math.max(0, ...rows.flat().map((value) => value ?? 0)))

  /**
   * A cell is the ramp read at its own intensity, which is what the spectrogram does per
   * pixel. It used to be one hue at varying alpha, so a busy day and a quiet one differed
   * only in how much of the panel showed through - the ramp gives them different colours,
   * which is the difference the grid exists to show.
   */
  const shaped = (intensity: number): number =>
    curve === 'sqrt' ? Math.sqrt(Math.max(0, intensity)) : intensity
  const cellColor = (intensity: number): string => {
    const t = shaped(intensity)
    // Alpha still climbs with the value, but from a floor: the ramp's quiet end is a dark
    // colour on a dark panel, and one project has to be visibly more than none.
    return `color-mix(in oklab, ${rampColor(palette.heat, t, palette.primary)} ${Math.round(
      38 + t * 62
    )}%, transparent)`
  }
  const EMPTY = 'color-mix(in oklab, var(--muted-foreground) 8%, transparent)'

  // Each column costs its own width plus the 2px gap that precedes it; the label gutter is
  // charged once. Before the first measurement, fall back to the caller's fixed height.
  const columns = Math.max(1, sizeColumns ?? rows[0]?.length ?? columnLabels.length)
  const fitted = Math.floor((width - rowLabelWidth) / columns) - 2
  const size =
    squareCells && width > 0
      ? Math.max(4, Math.min(maxCellWidth ?? Infinity, fitted))
      : cellHeight
  const cellStyle = { maxWidth: squareCells ? size : maxCellWidth }

  return (
    <div ref={ref} className="relative">
      <div className="flex flex-col gap-[2px]">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="flex items-center gap-[2px]">
            <span
              className="shrink-0 text-[10px] text-muted-foreground/70"
              style={{ width: rowLabelWidth }}
            >
              {rowLabels[rowIndex]}
            </span>
            {row.map((value, columnIndex) => {
              if (value === null) {
                return <div key={columnIndex} className="flex-1" style={{ ...cellStyle, height: size }} />
              }
              const intensity = value / max
              return (
                <div
                  key={columnIndex}
                  className="flex-1 rounded-[2px]"
                  style={{
                    ...cellStyle,
                    height: size,
                    background: value === 0 ? EMPTY : cellColor(intensity)
                  }}
                  onMouseEnter={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    const host = event.currentTarget.closest('div.relative')?.getBoundingClientRect()
                    setTip({
                      x: rect.left - (host?.left ?? 0) + rect.width / 2,
                      y: rect.top - (host?.top ?? 0),
                      title:
                        cellTitle?.(rowIndex, columnIndex) ??
                        `${rowLabels[rowIndex]} · ${columnLabels[columnIndex]}`,
                      value: format(value, rowLabels[rowIndex], columnLabels[columnIndex])
                    })
                  }}
                  onMouseLeave={() => setTip(null)}
                />
              )
            })}
          </div>
        ))}

        <div className="mt-0.5 flex items-center gap-[2px]" style={{ paddingLeft: rowLabelWidth + 2 }}>
          {columnLabels.map((label, index) => (
            <span
              key={index}
              className={cn(
                'flex-1 overflow-visible whitespace-nowrap text-[9px] text-muted-foreground/50',
                columnLabelAlign === 'center' ? 'text-center' : 'text-left'
              )}
              style={{ ...cellStyle, visibility: index % labelEvery === 0 ? 'visible' : 'hidden' }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* One key per stack of grids: repeating it under every year is pure noise. */}
      {legend && (
        <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground/60">
          <span>less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((step) => (
            <span
              key={step}
              className="h-[9px] w-[14px] rounded-[2px]"
              style={{ background: step === 0 ? EMPTY : cellColor(step) }}
            />
          ))}
          <span>more</span>
        </div>
      )}

      {tip && <Tooltip tip={tip} containerWidth={width} />}
    </div>
  )
}
