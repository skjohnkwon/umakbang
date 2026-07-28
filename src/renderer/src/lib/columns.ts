import type { ColumnId, ColumnState, SortKey } from '@shared/types'

export interface ColumnDef {
  id: ColumnId
  label: string
  /** Which sort a header click applies. Absent means the column isn't sortable. */
  sortKey?: SortKey
  /** Everything except the name reads as a value, so it aligns right. */
  align?: 'right'
  defaultWidth: number
  minWidth: number
  title?: string
  /** Name is the row's identity; hiding it would leave nothing to read. */
  fixed?: boolean
  /**
   * Off until asked for. These are values you check for one file rather than scan down a
   * list of, and the now-playing bar shows all of them for the track you're on - so a
   * column each is width taken from the name for something you weren't reading. The
   * columns menu turns any of them back on.
   */
  hiddenByDefault?: boolean
}

export const COLUMN_DEFS: readonly ColumnDef[] = [
  { id: 'name', label: 'Name', sortKey: 'name', defaultWidth: 210, minWidth: 120, fixed: true },
  {
    id: 'rating',
    label: 'Rating',
    sortKey: 'rating',
    align: 'right',
    defaultWidth: 76,
    minWidth: 72
  },
  {
    id: 'type',
    label: 'Type',
    sortKey: 'kind',
    align: 'right',
    defaultWidth: 66,
    minWidth: 48,
    title: 'File type'
  },
  { id: 'bpm', label: 'BPM', sortKey: 'bpm', align: 'right', defaultWidth: 48, minWidth: 40 },
  { id: 'key', label: 'Key', sortKey: 'musicalKey', align: 'right', defaultWidth: 44, minWidth: 36 },
  { id: 'time', label: 'Time', sortKey: 'duration', align: 'right', defaultWidth: 58, minWidth: 44 },
  {
    id: 'format',
    label: 'Format',
    sortKey: 'sampleRate',
    align: 'right',
    defaultWidth: 76,
    minWidth: 52,
    title: 'Sample rate · bit depth',
    hiddenByDefault: true
  },
  {
    id: 'size',
    label: 'Size',
    sortKey: 'size',
    align: 'right',
    defaultWidth: 64,
    minWidth: 48,
    hiddenByDefault: true
  },
  {
    id: 'modified',
    label: 'Modified',
    sortKey: 'mtimeMs',
    align: 'right',
    /**
     * Wide enough for the date and the clock time together, measured rather than guessed:
     * the longest string this renders is "Nov 22, 2025 10:25 AM", which is 129px at the
     * row's 12.5px font, plus 4px of right padding.
     *
     * The old 132/76 pair was a pixel short at its own default and less than two thirds of
     * the way there at its minimum, so the column could be dragged - or restored from
     * settings - narrower than the only thing it ever contains. `normalizeColumns` clamps
     * to `minWidth` on every load, so raising it here also widens a column that was already
     * saved too narrow. There is no width below this worth offering: a date cut in half
     * tells you less than no date column at all.
     */
    defaultWidth: 140,
    minWidth: 134,
    hiddenByDefault: true
  },
  /**
   * Not sortable: it is prose, and ordering a folder by the alphabet of what you happened to
   * write about it answers nothing. Wide by default because a note that shows four words is
   * a note you stop writing.
   */
  { id: 'notes', label: 'Notes', defaultWidth: 200, minWidth: 90 },
  // Not sortable - it's a picture of the audio, not a value.
  { id: 'waveform', label: 'Waveform', defaultWidth: 120, minWidth: 60 }
] as const

const DEF_BY_ID = new Map(COLUMN_DEFS.map((def) => [def.id, def]))

export function columnDef(id: ColumnId): ColumnDef {
  // Every id in ColumnId has a definition; the fallback keeps this total.
  return DEF_BY_ID.get(id) ?? COLUMN_DEFS[0]
}

export function defaultColumns(): ColumnState[] {
  return COLUMN_DEFS.map((def) => ({
    id: def.id,
    width: def.defaultWidth,
    visible: !def.hiddenByDefault
  }))
}

/**
 * Reconciles a persisted layout with the current column definitions: unknown ids are
 * dropped, columns added in a later version are appended, and widths are clamped. Saved
 * order is preserved, since that's the user's arrangement.
 */
export function normalizeColumns(saved: ColumnState[] | undefined): ColumnState[] {
  if (!saved || saved.length === 0) return defaultColumns()

  const seen = new Set<ColumnId>()
  const result: ColumnState[] = []

  for (const entry of saved) {
    const def = DEF_BY_ID.get(entry.id)
    if (!def || seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push({
      id: def.id,
      width: Math.max(def.minWidth, Math.round(entry.width) || def.defaultWidth),
      visible: def.fixed ? true : entry.visible !== false
    })
  }

  for (const def of COLUMN_DEFS) {
    if (seen.has(def.id)) continue
    result.push({ id: def.id, width: def.defaultWidth, visible: !def.hiddenByDefault })
  }

  return result
}

/**
 * True when the template ends in a filler track that rows must render a cell for.
 *
 * The waveform, when it's last, stretches to take the leftover space itself - a wider
 * picture of the audio beats a dead gap - so no filler is added in that case.
 */
export function hasTrailingSpacer(visible: ColumnState[]): boolean {
  return visible[visible.length - 1]?.id !== 'waveform'
}

/**
 * Builds the CSS grid template. Rows must render exactly one cell per track: a mismatch
 * creates an implicit column and shunts every cell out of its heading.
 */
export function gridTemplate(visible: ColumnState[]): string {
  const spacer = hasTrailingSpacer(visible)

  const tracks = visible
    .map((column, index) =>
      !spacer && index === visible.length - 1
        ? `minmax(${column.width}px, 1fr)`
        : `${column.width}px`
    )
    .join(' ')

  return spacer ? `${tracks} minmax(0, 1fr)` : tracks
}

export function totalWidth(visible: ColumnState[]): number {
  return visible.reduce((sum, column) => sum + column.width, 0)
}

/** Moves a column to a new position, used by header drag-and-drop. */
export function reorderColumns(
  columns: ColumnState[],
  fromId: ColumnId,
  toId: ColumnId
): ColumnState[] {
  if (fromId === toId) return columns
  const from = columns.findIndex((column) => column.id === fromId)
  const to = columns.findIndex((column) => column.id === toId)
  if (from === -1 || to === -1) return columns
  const next = columns.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
