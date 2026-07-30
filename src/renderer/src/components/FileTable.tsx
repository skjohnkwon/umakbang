import type React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronRight,
  FileAudio2,
  FileMusic,
  FileSliders,
  FileX2,
  Folder,
  Loader2,
  PencilLine,
  Plus,
  type LucideIcon
} from 'lucide-react'
import type { ColumnId, ColumnState, Settings, SortKey, Track, TrackKind } from '@shared/types'
import { useLibrary } from '@/state/library'
import { useContracts } from '@/state/contracts'
import { useVideos } from '@/state/videos'
import { usePlayer } from '@/state/player'
import { Badge } from '@/components/ui/badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { TagPopover } from '@/components/TagPopover'
import { NamePopover, type NamePrompt } from '@/components/NamePopover'
import { NotePopover, type NoteTarget } from '@/components/NotePopover'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  FolderMenuItems,
  SelectionMenuItems,
  type ExplorerActions,
  type MenuContext
} from '@/components/ExplorerMenu'
import { collectFiles, useSort, type Row } from '@/hooks/useLibraryView'
import { useFolderDrop } from '@/hooks/useFolderDrop'
import { beginRowDrag, consumeDragClick } from '@/lib/drag'
import { setExplorerShortcuts, type ShortcutEvent } from '@/lib/explorer-shortcuts'
import { matchesShortcut } from '@shared/shortcuts'
import { absolutePath, baseName, relativePath } from '@/lib/paths'
import {
  anchorOfRow,
  resolveSelection,
  rowId,
  selectionLabel,
  type Selected
} from '@/lib/selection'
import { fifthsPosition, relativeKeyPair } from '@shared/keys'
import { isRandomExcluded, toggleRandomExcluded } from '@/lib/random-scope'
import { addPinned, isPinned, removePinned } from '@/lib/quick-access'
import { fileIcon, requestFileIcon, useFileIcons } from '@/lib/file-icons'
import { cancelAnalysis, queuedAnalysis, requestAnalysis, useAnalysing } from '@/lib/analysis'
import {
  columnDef,
  gridTemplate,
  hasTrailingSpacer,
  normalizeColumns,
  reorderColumns,
  totalWidth,
  type ColumnDef
} from '@/lib/columns'
import { RowWaveform } from '@/components/RowWaveform'
import { usePalette } from '@/components/visualizers/palette'
import { StemDialog } from '@/components/StemDialog'
import { StarRating } from '@/components/StarRating'
import {
  formatDate,
  formatDateTime,
  formatDurationPrecise,
  formatFormat,
  formatSize,
  nameWithMetadata,
  parentLabel,
  typeIconClass,
  typeLabel
} from '@/lib/format'
import { cn } from '@/lib/utils'

const ROW_HEIGHT = 26

/**
 * Below this the key is drawn as a guess rather than as an answer.
 *
 * `analysis.ts` already refuses anything under 0.4, so this only separates the readings that
 * scraped past that gate from the ones the detector was actually sure of. Measured across
 * this library, full productions fit at 0.68 to 0.87 and drum loops - which have no key at
 * all - land between 0.36 and 0.46, so the band just above the gate is where the answers
 * nobody should rely on live.
 */
const UNSURE_KEY_FIT = 0.55

/**
 * One glyph per kind, matching what the Type column says rather than guessing at the
 * file's purpose - a sliders page for a DAW session, a note for MIDI, a waveform for
 * audio. Extensions don't get their own icons: forty of them would be forty shapes to
 * learn, and the Type column already spells the extension out.
 */
const KIND_ICONS: Record<TrackKind, LucideIcon> = {
  audio: FileAudio2,
  midi: FileMusic,
  project: FileSliders
}

/**
 * A primitive stand-in for the parts of a Track that change after its row first renders.
 *
 * Tracks are mutated in place - the index array and its objects keep their identity all
 * through a scan, by design - so a memoised row that compares `track` by reference never
 * notices the probe's duration and format arriving, nor a tempo or key worked out from the
 * audio later on. Those values were being detected and cached correctly and simply never
 * repainted. Folding them into one string gives `memo` something it can compare.
 */
function metaSignature(track: Track): string {
  return `${track.probed ? 1 : 0}|${track.duration ?? ''}|${track.sampleRate ?? ''}|${track.bitDepth ?? ''}|${track.channels ?? ''}|${track.bitrate ?? ''}|${track.bpm ?? ''}|${track.musicalKey ?? ''}`
}

/* ------------------------------------------------------- colour in the columns */

/**
 * A value's place on the visualizer ramp, as a text colour.
 *
 * The ramp is the same one the meters and the stats charts use, so a table column agrees
 * with the panel beside it. Mixed with a fifth of the foreground on the way out: the low end
 * of a ramp the user owns can be very dark, and a date is still text that has to be read -
 * this keeps the hue and puts a floor under the contrast.
 */
function rampText(wave: readonly string[], t: number): string | undefined {
  if (wave.length === 0) return undefined
  const step = wave[Math.round(Math.max(0, Math.min(1, t)) * (wave.length - 1))]
  return `color-mix(in oklab, ${step} 80%, var(--foreground))`
}

/**
 * How far through the day a timestamp is, as a hill peaking at noon.
 *
 * Not a straight 0-24 sweep, which would put 23:59 and 00:01 at opposite ends of the ramp
 * for two minutes apart. Folded, it reads as daylight: the small hours and the late evening
 * are the ramp's quiet end, the middle of the day is its hot one - so a folder of things
 * bounced at 3am looks different at a glance from one bounced over a working afternoon.
 */
function dayPosition(ms: number): number {
  const date = new Date(ms)
  const hours = date.getHours() + date.getMinutes() / 60
  return 1 - Math.abs(12 - hours) / 12
}

/** Where a tempo sits between the slowest and fastest a detector will report. */
function tempoPosition(bpm: number): number {
  return (bpm - 60) / 140
}

/** A file name without its extension - what the track is actually called. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Names the folders a message is about, without listing twenty of them. */
function describeDirs(dirs: string[]): string {
  const first = baseName(dirs[0]) || 'the library root'
  return dirs.length === 1 ? first : `${first} and ${dirs.length - 1} more`
}

/** How a count of entries reads in a message. */
function items(count: number): string {
  return count === 1 ? '1 item' : `${count.toLocaleString()} items`
}

/* --------------------------------------------------- what a delete is about to cost */

/**
 * Four stars is where a rating stops being a shrug and starts meaning "keep this".
 *
 * The delete dialog counts them because that count is the one thing the app can say that the
 * folder name cannot: 340 files is a number, and 37 of them being ones you marked worth
 * keeping is an argument.
 */
const KEEP_RATING = 4

/** Everything the delete confirmation needs, measured once when the delete is asked for. */
interface DeletePrompt {
  paths: string[]
  /** The one entry's name, or how many entries there are - what the title is about. */
  label: string
  /** Folders in the selection. Their contents go with them and are counted below. */
  folders: number
  /** Files picked out in their own right, as opposed to found beneath a folder. */
  loose: number
  /** Everything that actually goes, folder contents included. */
  files: number
  bytes: number
  /** Of those files, how many are rated at least `KEEP_RATING`, and how many carry a tag. */
  rated: number
  tagged: number
}

/**
 * Works out what a delete takes with it, from what the renderer is already holding.
 *
 * Folders are walked through the same tree the explorer is drawing (`collectFiles`), so this
 * costs no disk read and no second pass over the index - the counts are a fold over Track
 * objects that already exist. Ratings and tags are read off the store by hand rather than
 * through a subscription: this runs on a press rather than in render, and the table holds
 * every subscription itself precisely so a row never has to.
 */
function describeDeletion(selected: Selected, rows: Row[]): DeletePrompt {
  const gathered: Track[] = [...selected.tracks]
  const wanted = new Set(selected.dirs)
  for (const row of rows) {
    if (row.type === 'folder' && wanted.has(row.node.path)) collectFiles(row.node, gathered)
  }

  const { ratings, tags } = useLibrary.getState()
  // A search flattens the subtree, so a folder and something inside it can both be on screen
  // and both be selected. Counting the overlap twice would overstate the damage in the one
  // message that has to be trusted.
  const seen = new Set<string>()
  let bytes = 0
  let rated = 0
  let tagged = 0
  for (const file of gathered) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    bytes += file.size
    // Keyed by the composed spelling, which a track carries beside its own path only when
    // the two differ. Reading the raw path here under-counted what a delete was about to
    // take, in the one message that has to be trusted.
    const key = file.pathKey ?? file.path
    if ((ratings[key] ?? 0) >= KEEP_RATING) rated++
    if ((tags[key]?.length ?? 0) > 0) tagged++
  }

  return {
    paths: selected.paths,
    label: selectionLabel(selected),
    folders: selected.dirs.length,
    loose: selected.tracks.length,
    files: seen.size,
    bytes,
    rated,
    tagged
  }
}

/**
 * The sentence the dialog reads out, sized to what is going.
 *
 * A count on its own does not tell 340 loops from 340 albums, so the size comes with it. A
 * folder additionally says what is under it, since that is the part the row on screen never
 * showed. The counts under a folder are of *indexed* files and say so: umakbang knows about
 * the audio, the projects and the MIDI, and a folder can hold artwork and PDFs besides.
 */
function deletionMessage(prompt: DeletePrompt, trashLabel: string): string {
  const size = formatSize(prompt.bytes)
  const entries = prompt.folders + prompt.loose

  let scale: string
  if (prompt.folders === 0) {
    scale = `${prompt.files === 1 ? '1 file' : `${prompt.files.toLocaleString()} files`}, ${size}.`
  } else {
    const subject =
      prompt.loose === 0
        ? prompt.folders === 1
          ? 'The folder and everything in it'
          : `${prompt.folders} folders and everything in them`
        : `${prompt.folders === 1 ? '1 folder' : `${prompt.folders} folders`} and ${
            prompt.loose === 1 ? '1 file' : `${prompt.loose.toLocaleString()} files`
          }, with everything beneath`
    const beneath =
      prompt.files === 0
        ? 'nothing umakbang has indexed'
        : `${prompt.files.toLocaleString()} indexed files, ${size}`
    scale = `${subject}: ${beneath}.`
  }

  const stars = '★'.repeat(KEEP_RATING)
  let worth = ''
  if (prompt.rated > 0 && prompt.tagged > 0) {
    worth = `${prompt.rated.toLocaleString()} of them ${prompt.rated === 1 ? 'is' : 'are'} rated ${stars} or better, and ${prompt.tagged.toLocaleString()} ${prompt.tagged === 1 ? 'is' : 'are'} tagged.`
  } else if (prompt.rated > 0) {
    worth = `${prompt.rated.toLocaleString()} of them ${prompt.rated === 1 ? 'is' : 'are'} rated ${stars} or better.`
  } else if (prompt.tagged > 0) {
    worth = `${prompt.tagged.toLocaleString()} of them ${prompt.tagged === 1 ? 'is' : 'are'} tagged.`
  }

  const bin =
    entries === 1
      ? `It goes to the ${trashLabel}, so you can put it back.`
      : `They go to the ${trashLabel}, so you can put them back.`

  return [scale, worth, bin].filter((part) => part.length > 0).join(' ')
}

/**
 * Files a selection somewhere and follows it there.
 *
 * Filing something is nearly always the first half of doing something else with it, and
 * being left standing where it *was* means going after it by hand every time. Only follows
 * into the library: a quick-move target can be an archive on another drive, and there is
 * nowhere in the explorer to go for that.
 */
async function moveAndFollow(paths: string[], destination: string): Promise<void> {
  await useLibrary.getState().transferPaths(paths, destination, 'move')

  const relative = relativePath(useLibrary.getState().roots, destination)
  if (relative !== null) useLibrary.getState().setView({ mode: 'folder', dir: relative })
}

/**
 * How many characters of tag a row will give up to keep for its own name, and the hard cap
 * on chips whatever their length.
 *
 * A budget rather than a count, because "three tags" is the wrong unit: three of `bounce`,
 * `keep` and `wip` is a third of the room that three of `needs another vocal pass` would
 * take. Measured in characters so it costs nothing - the honest version is "as many as fit",
 * and finding that out means reading layout per row, which in a virtualised list is a read
 * per row per scroll frame to decide how many chips to draw.
 */
const ROW_TAG_BUDGET = 30
const ROW_TAG_MAX = 8

/**
 * The tags a row shows, most recently added first to be dropped last.
 *
 * Everything past the budget becomes the `+N`, which is a button into the full editor, so
 * nothing is unreachable - only unshown.
 */
function visibleRowTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return []
  const taken: string[] = []
  let spent = 0
  for (let i = tags.length - 1; i >= 0 && taken.length < ROW_TAG_MAX; i--) {
    // The first one always goes on: a single long tag showing as `+1` would be a row that
    // says it is tagged without saying what with.
    if (taken.length > 0 && spent + tags[i].length > ROW_TAG_BUDGET) break
    taken.unshift(tags[i])
    spent += tags[i].length
  }
  return taken
}

/**
 * The tags on a row, and the way to add one.
 *
 * As many as fit inside `ROW_TAG_BUDGET`, the most recently added kept: there is only ever a
 * sliver between a file name and the next column, and a row that has collected eight long
 * tags would otherwise push its own name out of sight. Clicking one filters the library by
 * it; the plus opens the full editor. Both are buttons, so `isRowControl` keeps the press
 * off the row - tagging a file shouldn't select it, let alone start playing it.
 */
function RowTags({
  tags,
  paths,
  label,
  handlers
}: {
  tags: string[] | undefined
  paths: string[]
  label: string
  handlers: RowHandlers
}): React.JSX.Element | null {
  const shown = useMemo(() => visibleRowTags(tags), [tags])
  const hidden = tags ? tags.length - shown.length : 0

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-0.5">
      {shown.map((tag) => (
        /* The chip carries its own menu, because a right-click on a tag is a question about
           the tag rather than about the row it happens to be sitting on - and the row's menu
           has no idea which chip was hit. `stopPropagation` keeps the row's menu shut. */
        <ContextMenu key={tag}>
          <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
            <button
              type="button"
              title={`Show only ${tag}`}
              onClick={(event) => {
                event.stopPropagation()
                handlers.toggleTagFilter(tag)
              }}
            >
              <Badge className="shrink-0 border-border/60 bg-secondary text-secondary-foreground hover:border-primary/60 hover:text-foreground">
                {tag}
              </Badge>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{tag}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => handlers.renameTag(tag)}>
              <PencilLine className="h-3.5 w-3.5" />
              Rename tag…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      {hidden > 0 && (
        // A button rather than a label: it is the only way to reach the tags it stands for
        // without opening the row's menu, and it opens the same editor the plus does.
        <button
          type="button"
          title={tags ? `Also tagged ${tags.slice(0, hidden).join(', ')}` : undefined}
          onClick={(event) => {
            event.stopPropagation()
            handlers.editTags(paths, label, event.clientX, event.clientY)
          }}
          className="shrink-0 text-[10.5px] text-muted-foreground/60 hover:text-foreground"
        >
          +{hidden}
        </button>
      )}
      {/* Quiet until the row is under the pointer: a column of plus signs down an
          untagged library is noise, and this is only ever wanted on the row you're on. */}
      <button
        type="button"
        aria-label="Add a tag"
        title="Add a tag"
        onClick={(event) => {
          event.stopPropagation()
          handlers.editTags(paths, label, event.clientX, event.clientY)
        }}
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Plus className="h-3 w-3" />
      </button>
    </span>
  )
}

/**
 * A note, written where it is read.
 *
 * The field is the cell: no double-click to edit, no pencil to find, because the whole point
 * of a note column is that writing in it costs nothing. Saving is per keystroke into the
 * store, which debounces the write to disk - there is nothing to confirm and no way to lose
 * a sentence by clicking away.
 *
 * The `…` opens the full text in a popover. It is revealed on hover rather than only when the
 * text overflows: knowing whether it overflows means reading `scrollWidth` for every visible
 * row, and in a virtualised list that is a layout read per row per scroll frame, to decide
 * whether to draw three dots.
 */
function NoteCell({
  path,
  label,
  note,
  onOpen
}: {
  path: string
  label: string
  note: string
  onOpen: (path: string, label: string, initial: string, x: number, y: number) => void
}): React.JSX.Element {
  const setNote = useLibrary((s) => s.setNote)
  const button = useRef<HTMLButtonElement>(null)

  return (
    <span className="flex h-full min-w-0 items-center gap-0.5 pr-1">
      <input
        value={note}
        spellCheck={false}
        placeholder="…"
        onChange={(event) => setNote(path, event.target.value)}
        // The table's shortcuts live on the scroll container above this. Without stopping
        // the key here, typing "3" rates the file, Delete trashes it and Space plays it.
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
        }}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-[12px] text-muted-foreground outline-none placeholder:text-muted-foreground/25 focus:text-foreground"
      />
      <button
        ref={button}
        type="button"
        aria-label={`Edit the note on ${label}`}
        title="Open the full note"
        onClick={(event) => {
          event.stopPropagation()
          const rect = button.current?.getBoundingClientRect()
          onOpen(path, label, note, rect?.right ?? 0, (rect?.bottom ?? 0) + 4)
        }}
        className="shrink-0 px-0.5 text-[12px] leading-none text-muted-foreground/50 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        …
      </button>
    </span>
  )
}

/**
 * Whether an event landed on something inside a row that handles its own clicks.
 *
 * The rating stars and the note field are the ones today, but anything interactive dropped
 * into a cell needs the row to keep its hands off the press.
 */
function isRowControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, input, [role="button"]'))
}

/** Stable callbacks shared by every row, so React.memo can actually skip re-renders. */
interface RowHandlers {
  pointerDown: (event: React.PointerEvent, index: number) => void
  click: (event: React.MouseEvent, index: number) => void
  /** Right-click: takes the selection if the row isn't already in it, as Explorer does. */
  contextMenu: (index: number) => void
  goToFolder: (dir: string) => void
  /** Narrows the library to a tag, from the chip on a row. */
  toggleTagFilter: (tag: string) => void
  /** Opens the tag editor over a row, anchored where the plus was clicked. */
  editTags: (paths: string[], label: string, x: number, y: number) => void
  /** Opens the whole of a note, anchored where the ellipsis was clicked. */
  editNote: (path: string, label: string, initial: string, x: number, y: number) => void
  /** Renames a tag everywhere it is used, from its own chip. */
  renameTag: (tag: string) => void
  openExternally: (path: string) => void
  setRating: (path: string, rating: number) => void
}

/** What the open context menu is pointed at. */
type MenuTarget = { kind: 'rows'; dir: string | null } | { kind: 'folder'; dir: string | null }

export function FileTable({
  rows,
  empty
}: {
  rows: Row[]
  /** Shown in place of the rows when there are none, inside the table's own frame. */
  empty: React.ReactNode
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Subscriptions live here rather than in every row: with ~40 rows on screen, each
  // resubscribing as you scroll, per-row store subscriptions were the bulk of the scroll
  // cost. Rows are now pure props and memoised.
  const selectedPath = useLibrary((s) => s.selectedPath)
  const selection = useLibrary((s) => s.selection)
  const clipboard = useLibrary((s) => s.clipboard)
  const tags = useLibrary((s) => s.tags)
  const roots = useLibrary((s) => s.roots)
  const revealLabel = useLibrary((s) => s.platform?.revealLabel ?? 'Show in folder')
  const trashLabel = useLibrary((s) => (s.platform?.isMac ? 'Trash' : 'Recycle Bin'))
  const view = useLibrary((s) => s.view)
  const query = useLibrary((s) => s.query)
  const recursive = useLibrary((s) => s.recursive)
  const savedColumns = useLibrary((s) => s.settings.columns)
  const quickMove = useLibrary((s) => s.settings.quickMove)
  const randomExcludeDirs = useLibrary((s) => s.settings.randomExcludeDirs)
  // Subscribed once here and read by the key handler, like every other setting the rows
  // need - a `useLibrary` per row is the subscription this table exists to avoid.
  const shortcuts = useLibrary((s) => s.settings.shortcuts)
  const { key: sortKey, dir: sortDir } = useSort()
  const revealNonce = useLibrary((s) => s.revealNonce)
  const setView = useLibrary((s) => s.setView)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const ratings = useLibrary((s) => s.ratings)
  // Which keys were guessed rather than read, so the cell can show the relative pair.
  const detectedKey = useLibrary((s) => s.detectedKey)
  // And how well each of those fitted, so a close call can say so. Subscribed once here like
  // every other shared value; rows are handed a boolean.
  const detectedKeyFit = useLibrary((s) => s.detectedKeyFit)
  // One subscription for the notes column, resolved per row into a plain string.
  const notes = useLibrary((s) => s.notes)
  const stemJob = useLibrary((s) => s.stemJob)
  const waveformTint = useLibrary((s) => s.settings.waveformTint)
  // One subscription for the whole table, so a changed ramp repaints every row waveform.
  const wave = usePalette().wave
  // One subscription for the whole table: rows are handed the icon already resolved.
  useFileIcons()
  // Same shape for "which files are being analysed" - the set is read here and each row is
  // told only whether it is in it, so a row never subscribes to anything itself.
  const analysing = useAnalysing()
  // And the same again for the files that have gone from under us. One subscription, a
  // boolean per row.
  const unreachable = useLibrary((s) => s.unreachable)
  const currentPath = usePlayer((s) => s.current?.path ?? null)
  const playing = usePlayer((s) => s.playing)
  const play = usePlayer((s) => s.play)

  const [tagTarget, setTagTarget] = useState<{
    paths: string[]
    label: string
    x: number
    y: number
  } | null>(null)
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null)
  const [prompt, setPrompt] = useState<NamePrompt | null>(null)
  // Only the deletes big enough to ask about ever fill this in. See `remove` below.
  const [confirmDelete, setConfirmDelete] = useState<DeletePrompt | null>(null)
  const [menuTarget, setMenuTarget] = useState<MenuTarget>({ kind: 'folder', dir: null })
  /** Files waiting on a yes before anything is uploaded. */
  const [stemPrompt, setStemPrompt] = useState<Track[] | null>(null)

  /* ---------------------------------------------------------------- columns */

  const columns = useMemo(() => normalizeColumns(savedColumns), [savedColumns])

  // Widths applied while a drag is in flight; committing on release keeps us from
  // writing settings to disk on every pointermove.
  const [draggingColumn, setDraggingColumn] = useState<ColumnId | null>(null)
  const [draftWidths, setDraftWidths] = useState<Partial<Record<ColumnId, number>>>({})
  const draftRef = useRef(draftWidths)
  draftRef.current = draftWidths

  const visible = useMemo(
    () =>
      columns
        .filter((column) => column.visible)
        .map((column) => ({ ...column, width: draftWidths[column.id] ?? column.width })),
    [columns, draftWidths]
  )

  const template = useMemo(() => gridTemplate(visible), [visible])
  const spacer = useMemo(() => hasTrailingSpacer(visible), [visible])
  const minRowWidth = useMemo(() => totalWidth(visible), [visible])

  const commitColumns = useCallback(
    (next: ColumnState[]) => {
      patchSettings({ columns: next })
    },
    [patchSettings]
  )

  const beginResize = useCallback(
    (event: React.PointerEvent, id: ColumnId) => {
      event.preventDefault()
      event.stopPropagation()
      const def = columnDef(id)
      const startX = event.clientX
      const startWidth = visible.find((column) => column.id === id)?.width ?? def.defaultWidth

      const onMove = (move: PointerEvent): void => {
        const width = Math.max(def.minWidth, Math.round(startWidth + (move.clientX - startX)))
        setDraftWidths((current) => ({ ...current, [id]: width }))
      }

      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''

        const drafts = draftRef.current
        if (Object.keys(drafts).length > 0) {
          commitColumns(
            columns.map((column) =>
              drafts[column.id] !== undefined ? { ...column, width: drafts[column.id]! } : column
            )
          )
          setDraftWidths({})
        }
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [visible, columns, commitColumns]
  )

  const resetWidth = useCallback(
    (id: ColumnId) => {
      const def = columnDef(id)
      commitColumns(
        columns.map((column) =>
          column.id === id ? { ...column, width: def.defaultWidth } : column
        )
      )
    },
    [columns, commitColumns]
  )

  /* ---------------------------------------------------------------- rows */

  // A file's folder is only worth showing when the list spans more than one.
  const showFolder = view.mode !== 'folder' || recursive || query.trim().length > 0

  // Playback context is files only - a folder row can't be queued.
  const files = useMemo(
    () => rows.flatMap((row) => (row.type === 'file' ? [row.track] : [])),
    [rows]
  )

  // Where Paste and New folder land. A saved view has no "here" to put things in.
  const currentDir = view.mode === 'folder' ? view.dir : null

  const selected = useMemo(
    () => resolveSelection(rows, selection, roots),
    [rows, selection, roots]
  )

  // Cut entries are shown faded, the way they are in a file manager, so it's clear what
  // is about to move rather than what has already gone.
  const cutPaths = useMemo(
    () => (clipboard?.mode === 'move' ? new Set(clipboard.paths) : null),
    [clipboard]
  )

  // Held in refs so the handlers below can stay referentially stable.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const filesRef = useRef(files)
  filesRef.current = files
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const currentDirRef = useRef(currentDir)
  currentDirRef.current = currentDir

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14
  })

  const selectedIndex = useMemo(
    () => (selectedPath ? rows.findIndex((row) => rowId(row) === selectedPath) : -1),
    [rows, selectedPath]
  )

  /** What the selection looked like when the current press started. See `click`. */
  const pressRef = useRef<{ id: string; wasSole: boolean } | null>(null)

  /** Where keyboard extension runs to. The anchor stays put while shift is held. */
  const cursorRef = useRef(-1)
  const anchorIndexRef = useRef(selectedIndex)
  anchorIndexRef.current = selectedIndex

  const openRow = useCallback(
    (row: Row) => {
      if (row.type === 'folder') {
        // Opening a folder from a set of search results means "go here", not "keep
        // filtering". Leaving the query on would flatten the folder you just walked into
        // and hide the subfolders that are the reason for walking into it.
        const store = useLibrary.getState()
        if (store.query) store.setQuery('')
        setView({ mode: 'folder', dir: row.node.path })
      } else {
        // A dimmed row is a dead end, and it has to say so out loud: without this the click
        // is answered by silence, which is exactly what a broken app looks like. The re-read
        // goes out with the sentence, so a file that has come back - a share that
        // reconnected, a bounce re-exported over the same name - undims itself rather than
        // waiting for somebody to find the toolbar's refresh button first.
        const store = useLibrary.getState()
        if (store.unreachable.has(row.track.path)) {
          store.notify(`${row.track.name} is not where umakbang left it.`, 'error')
          store.recheckPaths([row.track.path])
          return
        }
        if (row.track.playable) play(row.track, files)
      }
    },
    // Read off the store rather than subscribed to: this callback is rebuilt on every
    // change to `files` as it is, and one file going missing should not be another.
    [setView, play, files]
  )
  const openRowRef = useRef(openRow)
  openRowRef.current = openRow

  /** Selects every row between the anchor and `index`, inclusive. */
  const selectRange = useCallback((index: number) => {
    const rows = rowsRef.current
    const anchor = anchorIndexRef.current === -1 ? index : anchorIndexRef.current
    const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor]
    useLibrary.getState().setSelection(rows.slice(lo, hi + 1).map(rowId))
    cursorRef.current = index
  }, [])

  /**
   * Arms a row drag from the press that may become one.
   *
   * Called after the selection has settled, so dragging a row that is part of a
   * multi-selection takes the whole selection with it.
   */
  const armRowDrag = useCallback(
    (event: React.PointerEvent, index: number, wasSelected: boolean) => {
      const row = rowsRef.current[index]
      if (!row) return
      const { roots } = useLibrary.getState()
      const own =
        row.type === 'file'
          ? row.track.path
          : roots.length > 0
            ? absolutePath(roots, row.node.path)
            : row.node.path
      // `wasSelected` is the state *before* this press: the press has already selected
      // the row in the store, but `selectedRef` is only refreshed on render, so asking
      // the store here made a fresh press drag whatever was selected previously.
      beginRowDrag(event, wasSelected ? selectedRef.current.paths : [own])
    },
    []
  )

  const handlers: RowHandlers = useMemo(
    () => ({
      pointerDown: (event, index) => {
        // A press that lands on a control inside the row belongs to that control, not to
        // the row. Without this the row arms a drag and takes pointer capture, and the
        // click that follows is retargeted from the star to the row - so setting a rating
        // did nothing, while the row underneath quietly selected itself.
        if (isRowControl(event.target)) return

        const row = rowsRef.current[index]
        if (!row) return
        const id = rowId(row)
        const store = useLibrary.getState()

        if (event.button !== 0) return
        if (event.shiftKey) {
          // Stops the range from also painting a text selection across the rows.
          event.preventDefault()
          selectRange(index)
          return
        }
        if (event.ctrlKey || event.metaKey) {
          store.toggleSelection(id)
          cursorRef.current = index
          return
        }
        // What the click handler needs to know, captured before this press changes it:
        // clicking a row that was already the whole selection is what opens it.
        pressRef.current = {
          id,
          wasSole: store.selection.size === 1 && store.selection.has(id)
        }

        // Pressing on a row that's already part of a multi-selection must not collapse it
        // yet - that would make the selection undraggable. The click handler collapses it
        // instead, and a drag suppresses the click.
        const wasSelected = store.selection.has(id)
        if (!wasSelected) {
          store.setSelected(id)
          cursorRef.current = index
        }

        // Arm the drag. It stays a click until the pointer has moved far enough to mean
        // otherwise.
        armRowDrag(event, index, wasSelected)
      },

      /**
       * One click selects; clicking what is already selected opens it.
       *
       * A single click used to both select and open, which made stepping through a folder
       * to look at names impossible without navigating into things. Now the first click
       * lands the selection and the second acts on it - except that an audio file plays as
       * it is selected, since hearing it is nearly always the reason for the click.
       */
      click: (event, index) => {
        // Same as the press: a click on the stars is not a click on the row.
        if (isRowControl(event.target)) return
        // The pointer sequence was a drag, so the click closing it isn't one.
        if (consumeDragClick()) return
        if (event.shiftKey || event.ctrlKey || event.metaKey) return
        const row = rowsRef.current[index]
        if (!row) return
        const id = rowId(row)
        const press = pressRef.current
        pressRef.current = null

        const store = useLibrary.getState()
        store.setSelected(id)
        cursorRef.current = index

        // Second click on the row that was already the sole selection: open the folder,
        // play the file.
        if (press && press.id === id && press.wasSole) {
          openRowRef.current(row)
          return
        }

        if (
          row.type === 'file' &&
          row.track.playable &&
          store.settings.playOnSelect
        ) {
          play(row.track, filesRef.current)
        }
      },

      contextMenu: (index) => {
        const row = rowsRef.current[index]
        if (!row) return
        const id = rowId(row)
        const store = useLibrary.getState()
        if (!store.selection.has(id)) {
          store.setSelected(id)
          cursorRef.current = index
        }
      },

      goToFolder: (dir) => useLibrary.getState().setView({ mode: 'folder', dir }),
      toggleTagFilter: (tag) => useLibrary.getState().toggleTagFilter(tag),
      editTags: (paths, label, x, y) => setTagTarget({ paths, label, x, y }),
      editNote: (path, label, initial, x, y) => setNoteTarget({ path, label, initial, x, y }),
      renameTag: (tag) => {
        const rect = scrollRef.current?.getBoundingClientRect()
        setPrompt({
          title: `Rename "${tag}" everywhere it is used`,
          initial: tag,
          confirmLabel: 'Rename',
          busyLabel: 'Renaming…',
          selectStem: false,
          // The tag's own name is the suggestion, so leaving it alone means "never mind".
          skipIfUnchanged: true,
          submit: async (name) => useLibrary.getState().renameTag(tag, name),
          x: (rect?.left ?? 200) + 16,
          y: (rect?.top ?? 120) + 28
        })
      },
      openExternally: (path) => void window.umakbang.openExternally(path),
      setRating: (path, rating) => useLibrary.getState().setRating(path, rating)
    }),
    [selectRange, play, armRowDrag]
  )

  /* ---------------------------------------------------------------- actions */

  const promptRename = useCallback(() => {
    const target = selectedRef.current
    const only = target.only
    if (!only) return
    const { x, y } = anchorOfRow(target.ids[0])
    setPrompt({
      title: only.directory ? 'Rename folder' : 'Rename file',
      initial: only.name,
      confirmLabel: 'Rename',
      busyLabel: 'Renaming…',
      selectStem: !only.directory,
      skipIfUnchanged: true,
      submit: (name) => useLibrary.getState().renameEntry(only.path, name, only.directory),
      x,
      y
    })
  }, [])

  const promptNewFolder = useCallback((relDir: string) => {
    const rect = scrollRef.current?.getBoundingClientRect()
    setPrompt({
      title: `New folder in ${relDir ? baseName(relDir) : 'the library root'}`,
      initial: 'New folder',
      confirmLabel: 'Create',
      busyLabel: 'Creating…',
      selectStem: false,
      skipIfUnchanged: false,
      submit: (name) => useLibrary.getState().createFolder(relDir, name),
      x: (rect?.left ?? 200) + 16,
      y: (rect?.top ?? 120) + 28
    })
  }, [])

  /**
   * A folder made around what is already selected.
   *
   * The name is suggested from the selection rather than left as "New folder": gathering
   * three takes of one beat almost always wants that beat's name, and typing it again is the
   * step that makes people not bother. A single file gives its own stem; several give the
   * folder they came from, which is the only thing they are all known to have in common.
   */
  const promptNewFolderWithSelection = useCallback((relDir: string) => {
    const { paths, only } = selectedRef.current
    if (paths.length === 0) return
    const rect = scrollRef.current?.getBoundingClientRect()
    const suggestion = only
      ? stemOf(only.name)
      : relDir
        ? baseName(relDir)
        : 'New folder'

    setPrompt({
      title:
        paths.length === 1
          ? 'New folder with 1 item'
          : `New folder with ${paths.length.toLocaleString()} items`,
      initial: suggestion,
      confirmLabel: 'Create',
      busyLabel: 'Creating…',
      selectStem: false,
      skipIfUnchanged: false,
      submit: (name) => useLibrary.getState().createFolderWithSelection(relDir, name, paths),
      x: (rect?.left ?? 200) + 16,
      y: (rect?.top ?? 120) + 28
    })
  }, [])

  const actions: ExplorerActions = useMemo(
    () => ({
      open: () => {
        const [id] = selectedRef.current.ids
        const row = rowsRef.current.find((candidate) => rowId(candidate) === id)
        if (row) openRowRef.current(row)
      },
      openExternally: () => {
        const [path] = selectedRef.current.paths
        if (path) void window.umakbang.openExternally(path)
      },
      goToFolder: () => {
        const track = selectedRef.current.tracks[0]
        if (track) useLibrary.getState().setView({ mode: 'folder', dir: track.relDir })
      },
      cut: () => {
        const { paths } = selectedRef.current
        if (paths.length === 0) return
        useLibrary.getState().setClipboard(paths, 'move')
      },
      copy: () => {
        const { paths } = selectedRef.current
        if (paths.length === 0) return
        const store = useLibrary.getState()
        // `setClipboard` puts the files themselves on the system clipboard, so this pastes
        // into Discord or a folder the way a copy from Explorer does.
        //
        // It used to write the paths here as *text* instead, and the two cannot both be
        // true: whichever call lands last owns the clipboard, and one of them spawns a
        // process. The text form is not lost - Ctrl+Shift+C is `copyPath`, and the menu has
        // "Copy full path" - so the ambiguous one gives way to the shortcut that says which
        // it means.
        store.setClipboard(paths, 'copy')
        store.notify(`Copied ${items(paths.length)}.`)
      },
      paste: (relDir) => void useLibrary.getState().pasteInto(relDir),
      duplicate: () => {
        const { paths } = selectedRef.current
        if (paths.length > 0) void useLibrary.getState().duplicatePaths(paths)
      },
      rename: promptRename,
      remove: () => {
        const target = selectedRef.current
        if (target.paths.length === 0) return

        // One file and no folders goes straight to the trash with nothing asked, and that
        // is deliberate - do not put the prompt back. It is reversible, it is the most
        // common thing anyone does in this app, and a dialog on it is the dialog people
        // learn to dismiss without reading, which is what would disarm the one below for
        // the deletes that are actually expensive. The trash and undo are the safety net
        // here; confirmation is for scale and for what cannot be undone.
        if (target.dirs.length === 0 && target.tracks.length === 1) {
          void useLibrary.getState().trashPaths(target.paths)
          return
        }

        setConfirmDelete(describeDeletion(target, rowsRef.current))
      },
      newFolder: promptNewFolder,
      newFolderWithSelection: promptNewFolderWithSelection,
      moveTo: (destination) => {
        const { paths } = selectedRef.current
        if (paths.length > 0) void moveAndFollow(paths, destination)
      },
      moveToChosen: () => {
        const { paths } = selectedRef.current
        if (paths.length === 0) return
        void window.umakbang.pickDirectory('Move to folder').then((destination) => {
          if (destination) void moveAndFollow(paths, destination)
        })
      },
      // Folders are tagged with the same editor as files: a folder tag is what nominates
      // part of the library for tempo and key analysis, so it has to be as easy to apply.
      editTags: () => {
        const target = selectedRef.current
        if (target.paths.length === 0) return
        // Anchored to wherever the first selected row currently sits on screen. A folder
        // row is keyed by its `dir:` id rather than its absolute path.
        const [first] = target.ids
        const { x, y } = anchorOfRow(first)
        setTagTarget({ paths: target.paths, label: selectionLabel(target), x, y })
      },
      reveal: () => {
        const [path] = selectedRef.current.paths
        if (path) void window.umakbang.reveal(path)
      },
      copyPath: () => {
        const { paths } = selectedRef.current
        if (paths.length === 0) return
        void window.umakbang.copyText(paths.join('\n'))
        useLibrary.getState().notify(`Copied ${paths.length === 1 ? 'the path' : 'the paths'}.`)
      },
      copyName: () => {
        const { paths } = selectedRef.current
        if (paths.length === 0) return
        void window.umakbang.copyText(paths.map(baseName).join('\n'))
        useLibrary.getState().notify(`Copied ${paths.length === 1 ? 'the name' : 'the names'}.`)
      },
      selectAll: () => useLibrary.getState().setSelection(rowsRef.current.map(rowId)),
      splitStems: () => {
        const tracks = selectedRef.current.tracks.filter((track) => track.playable)
        if (tracks.length === 0) return
        setStemPrompt(tracks)
      },
      /**
       * Renames the selection to carry its key and tempo.
       *
       * Only the files that have something to say get renamed, and the detected key goes
       * in as the single key that won rather than the relative pair the column shows - a
       * file name with a slash in it is not a file name.
       */
      renameWithMetadata: () => {
        const tracks = selectedRef.current.tracks
        if (tracks.length === 0) return
        void (async () => {
          const store = useLibrary.getState()
          let renamed = 0
          let failure: string | null = null

          for (const track of tracks) {
            const next = nameWithMetadata(track.name, track.bpm, track.musicalKey)
            if (!next) continue
            const error = await store.renameEntry(track.path, next, false)
            if (error) {
              failure = error
              break
            }
            renamed++
          }

          if (failure) store.notify(failure, 'error')
          else if (renamed === 0) store.notify('Nothing here has a key or tempo to add yet.')
          // Undoable, though only the last rename is: main keeps one record, and each call
          // above replaced the one before it. The label says "(1 file)" for that reason, so
          // the button never claims more than it can put back.
          else store.notify(`Renamed ${items(renamed)}.`, 'info', true)
        })()
      },

      reprocess: () => {
        const tracks = selectedRef.current.tracks.filter((track) => track.playable)
        if (tracks.length === 0) return
        useLibrary.getState().recalculateAnalysis(tracks)
      },
      generateContract: () => {
        const tracks = selectedRef.current.tracks
        if (tracks.length === 0) return
        // The file name without its extension is the beat's name, which is what a contract
        // calls a Master - nobody sells "kansai jazz.wav".
        useContracts.getState().draft(tracks.map((track) => stemOf(track.name)))
      },
      makeVideo: () => {
        const track = selectedRef.current.tracks.find((entry) => entry.playable)
        if (!track) return
        // The name without its extension, for the same reason the contract uses it: the
        // caption on a reel is the beat's name, not "kansai jazz.wav".
        useVideos.getState().startFor(track.path, stemOf(track.name))
      },
      togglePinned: () => {
        const dirs = selectedRef.current.dirs
        if (dirs.length === 0) return
        const store = useLibrary.getState()
        // Stored as absolute paths, the same way filing destinations are: one list serves
        // both the sidebar and "Move to", and a destination can live outside the library.
        const paths = dirs.map((dir) => absolutePath(store.roots, dir))
        const current = store.settings.quickMove
        const adding = paths.filter((path) => !isPinned(current, path))
        const next = adding.length > 0 ? addPinned(current, paths) : removePinned(current, paths)
        store.patchSettings({ quickMove: next })
        store.notify(
          adding.length > 0
            ? `Pinned ${describeDirs(dirs)} to quick access.`
            : `Unpinned ${describeDirs(dirs)}.`
        )
      },
      toggleRandomExclude: () => {
        const dirs = selectedRef.current.dirs
        if (dirs.length === 0) return
        const store = useLibrary.getState()
        const next = toggleRandomExcluded(store.settings, dirs)
        const removing = next.length < store.settings.randomExcludeDirs.length
        store.patchSettings({ randomExcludeDirs: next })
        store.notify(
          removing
            ? `The dice can land in ${describeDirs(dirs)} again.`
            : `The dice will skip ${describeDirs(dirs)} and everything beneath.`
        )
      }
    }),
    [promptRename, promptNewFolder, promptNewFolderWithSelection]
  )

  /* ---------------------------------------------------------------- keyboard */

  const moveSelection = useCallback(
    (delta: number, audition = false, extend = false) => {
      const rows = rowsRef.current
      if (rows.length === 0) return
      const from = extend
        ? cursorRef.current === -1
          ? anchorIndexRef.current
          : cursorRef.current
        : anchorIndexRef.current
      const base = from === -1 ? (delta > 0 ? -1 : rows.length) : from
      const next = Math.max(0, Math.min(rows.length - 1, base + delta))
      const row = rows[next]

      if (extend) {
        selectRange(next)
      } else {
        useLibrary.getState().setSelected(rowId(row))
        cursorRef.current = next
      }
      virtualizer.scrollToIndex(next, { align: 'auto' })

      // Arrow keys can play as they go, the way a sample browser does - off unless asked
      // for, since it also means every keypress interrupts what you were listening to.
      // Folder rows never audition: there is nothing to hear.
      if (
        audition &&
        !extend &&
        row.type === 'file' &&
        row.track.playable &&
        useLibrary.getState().settings.auditionOnArrow
      ) {
        play(row.track, filesRef.current)
      }
    },
    [selectRange, virtualizer, play]
  )

  /**
   * The clipboard and selection keys, which the whole window shares.
   *
   * Lifted out of `onKeyDown` and published through `lib/explorer-shortcuts.ts` so `App` can
   * run the same code for a press that landed anywhere else - see that file for why they
   * were dead outside this table. The table keeps calling it first, so nothing about having
   * focus here changed.
   */
  /**
   * Rating from the number row: 1-5 stars, 0 to clear.
   *
   * It rates **what is playing**, not what is selected. Rating is a judgement about a sound,
   * and by the time you have one the selection has usually moved on - the dice lands you
   * somewhere new, arrowing through a folder walks past the thing you were still listening
   * to, and a click to look at something else takes the selection with it. Rating the row
   * your eyes are on meant the stars landed on a file you had not heard.
   *
   * The selection is the fallback, and only when nothing is playing at all: the keys would
   * otherwise be dead in a fresh window, and marking up a folder you already know without
   * auditioning it is a real thing to want.
   *
   * Either way it says what it rated. The target is no longer necessarily on screen, so a
   * silent star is a star you cannot check.
   */
  const rateFromKey = useCallback((event: ShortcutEvent, rating: number): boolean => {
    const store = useLibrary.getState()
    const playing = usePlayer.getState().current

    if (playing) {
      event.preventDefault()
      store.setRating(playing.path, rating)
      store.notify(
        rating === 0
          ? `Cleared the rating on ${playing.name}.`
          : `${playing.name} ${'★'.repeat(rating)}`
      )
      return true
    }

    const { tracks } = selectedRef.current
    if (tracks.length === 0) return false
    event.preventDefault()
    for (const track of tracks) store.setRating(track.path, rating)
    store.notify(
      rating === 0
        ? `Cleared the rating on ${items(tracks.length)}.`
        : `Rated ${items(tracks.length)} ${'★'.repeat(rating)}`
    )
    return true
  }, [])

  const clipboardKeys = useCallback(
    (event: ShortcutEvent): boolean => {
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.altKey) return false

        if (event.key >= '0' && event.key <= '5') {
          return rateFromKey(event, Number(event.key))
        }

        /**
         * The rebindable keys - see `shared/shortcuts.ts`.
         *
         * Here rather than in the table's own handler, which is where they started and where
         * they were dead the moment anything else had focus: pressing the dice moves focus
         * off the table, and `T` then did nothing with a row plainly selected and playing.
         * Every one of these acts on the selection or the view, both of which live in the
         * store, so none of them has any business needing the table to be focused.
         *
         * The list-movement keys and Enter are deliberately *not* here. Those only mean
         * anything against a list that is on screen and under the pointer, and binding them
         * to the window would have them fighting whatever else is showing.
         */
        if (matchesShortcut(event, shortcuts, 'rename')) {
          event.preventDefault()
          actions.rename()
          return true
        }
        if (matchesShortcut(event, shortcuts, 'tag')) {
          // Tagging is the other thing you do while walking a folder, so it gets a key
          // rather than a trip through the menu.
          event.preventDefault()
          actions.editTags()
          return true
        }
        if (matchesShortcut(event, shortcuts, 'trash')) {
          event.preventDefault()
          actions.remove()
          return true
        }
        if (matchesShortcut(event, shortcuts, 'clearSelection')) {
          event.preventDefault()
          useLibrary.getState().clearSelection()
          return true
        }
        if (matchesShortcut(event, shortcuts, 'up')) {
          // Up one level, the way Backspace works in a file manager. Left/right are the
          // transport's - they scrub the playing track from anywhere in the app.
          const here = useLibrary.getState().view
          if (here.mode !== 'folder' || !here.dir) return false
          event.preventDefault()
          setView({ mode: 'folder', dir: here.dir.split('/').slice(0, -1).join('/') })
          return true
        }
        return false
      }

      /**
       * Rename, for a keyboard that has no usable F2.
       *
       * `F2` stays exactly where it was and is still what the Windows menu names. It is the
       * Mac side that had nothing: renaming on a MacBook costs `fn+F2`, and Return - which is
       * what Finder renames with - is already open/play here, so a Mac friend's first two
       * instincts both miss. `⌘↩` reads as "Enter, but the other thing you do to a row", and
       * it was free: the fall-through has always refused every modifier combination it does
       * not know. Bound on both platforms rather than behind an `isMac` check, because a
       * shortcut that exists on one machine and not the other is one nobody can be told
       * about; only the menu's hint differs.
       */
      if (event.key === 'Enter') {
        event.preventDefault()
        actions.rename()
        return true
      }

      switch (event.key.toLowerCase()) {
        case 'a':
          event.preventDefault()
          actions.selectAll()
          return true
        case 'c':
          event.preventDefault()
          if (event.shiftKey) actions.copyPath()
          else actions.copy()
          return true
        case 'x':
          event.preventDefault()
          actions.cut()
          return true
        case 'v': {
          event.preventDefault()
          const dir = currentDirRef.current
          if (dir !== null) actions.paste(dir)
          return true
        }
        case 'd':
          event.preventDefault()
          actions.duplicate()
          return true
        case 'n': {
          // Ctrl+N on its own is not ours; only Shift makes it New Folder.
          if (!event.shiftKey) return false
          event.preventDefault()
          const dir = currentDirRef.current
          if (dir !== null) actions.newFolder(dir)
          return true
        }
        default:
          return false
      }
    },
    [actions, rateFromKey, shortcuts, setView]
  )

  // Only ever one explorer table on screen, and it deregisters on the way out so the
  // settings and stats pages - which have no selection to act on - answer nothing.
  useEffect(() => {
    setExplorerShortcuts(clipboardKeys)
    return () => setExplorerShortcuts(null)
  }, [clipboardKeys])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key

      // The clipboard chords and the rating digits, both of which `App` also runs from the
      // window - one implementation, called from whichever side saw the key first.
      if (clipboardKeys(event)) return

      // Any other combination with the modifier down is not one of ours - falling through
      // handed Ctrl+T the tag editor and Ctrl+Delete a delete. Navigation keys still pass,
      // Ctrl+Home being an ordinary way to jump to the top.
      if (mod && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(key)) {
        return
      }

      switch (key) {
        case 'ArrowDown':
          event.preventDefault()
          moveSelection(1, true, event.shiftKey)
          break
        case 'ArrowUp':
          event.preventDefault()
          moveSelection(-1, true, event.shiftKey)
          break
        case 'PageDown':
          event.preventDefault()
          moveSelection(20, false, event.shiftKey)
          break
        case 'PageUp':
          event.preventDefault()
          moveSelection(-20, false, event.shiftKey)
          break
        case 'Home':
          event.preventDefault()
          moveSelection(-rowsRef.current.length, false, event.shiftKey)
          break
        case 'End':
          event.preventDefault()
          moveSelection(rowsRef.current.length, false, event.shiftKey)
          break
        case 'Enter':
          event.preventDefault()
          actions.open()
          break
        default:
          break
      }
    },
    // Everything except the list movement and Enter now lives in `clipboardKeys` above, so
    // it works whether or not this table has focus. Space and the dice are `App.tsx`'s, on
    // the window - binding one in two places fires it twice for a single press.
    [actions, clipboardKeys, moveSelection]
  )

  /* ---------------------------------------------------------------- menu */

  // Set by a row on its way past, and read by the trigger below. Row handlers run first,
  // so an empty ref means the right-click landed on nothing.
  const pendingMenu = useRef<MenuTarget | null>(null)

  const onContextMenu = useCallback(() => {
    setMenuTarget(pendingMenu.current ?? { kind: 'folder', dir: currentDirRef.current })
    pendingMenu.current = null
  }, [])

  const menuContext: MenuContext = {
    selected,
    randomExcluded:
      selected.dirs.length > 0 &&
      selected.dirs.every((dir) => isRandomExcluded(dir, randomExcludeDirs)),
    pinned:
      selected.dirs.length > 0 &&
      selected.dirs.every((dir) => isPinned(quickMove, absolutePath(roots, dir))),
    // A folder row pastes into itself; anything else pastes into the folder on screen.
    targetDir: menuTarget.dir ?? currentDir,
    clipboardCount: clipboard?.paths.length ?? 0,
    revealLabel,
    quickMove,
    actions
  }

  /** The empty-space menu points at the folder being browsed, not at any row. */
  const folderContext: MenuContext = {
    ...menuContext,
    targetDir: currentDir,
    actions: {
      ...actions,
      reveal: () => {
        if (roots.length > 0 && currentDir !== null) {
          void window.umakbang.reveal(absolutePath(roots, currentDir))
        }
      },
      copyPath: () => {
        if (roots.length === 0 || currentDir === null) return
        void window.umakbang.copyText(absolutePath(roots, currentDir))
        useLibrary.getState().notify('Copied the path.')
      }
    }
  }

  /* ---------------------------------------------------------------- effects */

  // Ask the OS for the icons of whatever is on screen. Only the visible rows, and only
  // once per extension, so scrolling a large library doesn't turn into a shell storm.
  // Folders keep the drawn glyph: Windows' own folder icon is built for 16px and up, and
  // it turns to mush at the size these rows use.
  // Tempo and key are asked for here rather than in the waveform cell, so hiding the
  // Waveform column doesn't quietly switch the analysis off with it. Everything already
  // known, already queued or out of scope falls straight back out.
  useEffect(() => {
    const onScreen = new Set<string>()
    for (const item of virtualizer.getVirtualItems()) {
      const row = rows[item.index]
      if (row?.type !== 'file') continue
      requestFileIcon(row.track.ext, row.track.path)
      onScreen.add(row.track.path)
      // Nothing to decode: the file is the thing that has gone. Queuing it would fill the
      // analysis lane with certain failures and spin the row's BPM cell while they fail.
      if (unreachable.has(row.track.path)) continue
      requestAnalysis(row.track)
    }
    // Anything scrolled past that hasn't started yet is dropped, the way queued peaks are.
    return () => {
      for (const path of queuedAnalysis()) {
        if (!onScreen.has(path)) cancelAnalysis(path)
      }
    }
  })

  // A fresh view should start at the top rather than keeping the previous scroll depth.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [view, query])

  // "Show playing track" lands here: the folder has just changed, so wait until the row
  // actually exists in `rows` before scrolling to it. Declared after the reset above so
  // it wins on the commit where both run.
  const handledReveal = useRef(0)
  useEffect(() => {
    if (revealNonce === handledReveal.current) return
    const index = rows.findIndex((row) => rowId(row) === selectedPath)
    if (index < 0) return
    handledReveal.current = revealNonce
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [revealNonce, rows, selectedPath, virtualizer])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header and body share one scroll container so they stay aligned horizontally
          when the columns are wider than the window. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onContextMenu={onContextMenu}
            // Rows are selected, not their text: a drag across them should extend the
            // selection rather than highlight file names.
            className="scroll-thin flex min-h-0 flex-1 select-none flex-col overflow-auto outline-none"
          >
            {/* Deliberately NOT `flex-1 min-h-0`. A sticky element can only stay stuck
                within its own parent's box, and `flex-1 min-h-0` capped this wrapper at the
                viewport height while the virtualised list inside it is thousands of pixels
                tall. The header then unstuck the moment you scrolled past that first
                screenful, which looked like `sticky top-0` simply not working. Letting the
                wrapper size to its content makes its box as tall as the scroll range, so
                the header sticks for all of it. It exists only to carry `minWidth`, so the
                header and the rows agree on how wide a row is. */}
            <div className="flex flex-col" style={{ minWidth: minRowWidth }}>
              <div
                className="sticky top-0 z-10 grid h-[24px] shrink-0 items-center border-b bg-card pl-2 pr-3 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground"
                style={{ gridTemplateColumns: template }}
              >
                {visible.map((column) => (
                  <HeaderCell
                    key={column.id}
                    def={columnDef(column.id)}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onResizeStart={beginResize}
                    onResetWidth={resetWidth}
                    onReorder={(from, to) => commitColumns(reorderColumns(columns, from, to))}
                    dragging={draggingColumn}
                    setDragging={setDraggingColumn}
                  />
                ))}
              </div>

              {rows.length === 0 && <div className="flex min-h-0 flex-1 flex-col">{empty}</div>}

              {/* shrink-0 is load-bearing: this is a flex item in a column, so without it
                  flexbox squashes the list down to whatever is left in the viewport
                  instead of letting it overflow and scroll. The height below then means
                  nothing, the scrollbar is sized against the squashed height rather than
                  the real one, and every row that arrives mid-scan re-squashes it - which
                  reads as a thumb that shrinks as you drag and barely moves. */}
              <div
                className="relative w-full shrink-0"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index]
                  if (row.type === 'folder') {
                    const absolute =
                      roots.length > 0 ? absolutePath(roots, row.node.path) : row.node.path
                    return (
                      <FolderRow
                        key={`dir:${row.node.path}`}
                        path={row.node.path}
                        name={row.node.name}
                        /* Tree nodes are mutated in place as the scan progresses, so the
                           changing values are passed as primitives - otherwise memo would
                           hold a stale count. */
                        totalCount={row.node.totalCount}
                        latestMtime={row.node.latestMtime}
                        tags={tags[absolute]}
                        absolute={absolute}
                        columns={visible}
                        template={template}
                        spacer={spacer}
                        selected={selection.has(`dir:${row.node.path}`)}
                        cut={cutPaths?.has(absolute) ?? false}
                        index={item.index}
                        top={item.start}
                        wave={wave}
                        handlers={handlers}
                        pendingMenu={pendingMenu}
                      />
                    )
                  }
                  const isCurrent = currentPath === row.track.path
                  // Tags, ratings, notes and the detected values are keyed by the composed
                  // path. It is a field read rather than a `pathKey` call because this runs
                  // per visible row per scroll frame.
                  const key = row.track.pathKey ?? row.track.path
                  return (
                    <FileRow
                      key={row.track.path}
                      track={row.track}
                      meta={metaSignature(row.track)}
                      analysing={analysing.has(row.track.path)}
                      unreachable={unreachable.has(row.track.path)}
                      splitting={stemJob?.path === row.track.path}
                      keyDetected={detectedKey[key] !== undefined}
                      keyUnsure={(detectedKeyFit[key] ?? 1) < UNSURE_KEY_FIT}
                      note={notes[key] ?? ''}
                      waveformTint={waveformTint}
                      wave={wave}
                      columns={visible}
                      template={template}
                      spacer={spacer}
                      icon={fileIcon(row.track.ext) ?? null}
                      renders={row.renders}
                      selected={selection.has(row.track.path)}
                      cut={cutPaths?.has(row.track.path) ?? false}
                      tags={tags[key]}
                      rating={ratings[key] ?? 0}
                      isCurrent={isCurrent}
                      isPlaying={playing && isCurrent}
                      showFolder={showFolder}
                      index={item.index}
                      top={item.start}
                      handlers={handlers}
                      pendingMenu={pendingMenu}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent
          className="min-w-[13rem]"
          onContextMenu={(event) => event.preventDefault()}
          // Several of these actions open an editor of their own. Radix would otherwise
          // hand focus back to the table as it closes, which lands outside that editor
          // and dismisses it before it has been on screen a frame.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {menuTarget.kind === 'rows' && selected.count > 0 ? (
            <SelectionMenuItems context={menuContext} />
          ) : (
            <FolderMenuItems
              context={folderContext}
              label={currentDir === null ? 'This view' : baseName(currentDir) || 'Library root'}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>

      {stemPrompt && (
        <StemDialog tracks={stemPrompt} onClose={() => setStemPrompt(null)} />
      )}

      {tagTarget && (
        <TagPopover
          paths={tagTarget.paths}
          label={tagTarget.label}
          x={tagTarget.x}
          y={tagTarget.y}
          onClose={() => setTagTarget(null)}
        />
      )}

      {noteTarget && (
        <NotePopover
          target={noteTarget}
          onChange={(note) => useLibrary.getState().setNote(noteTarget.path, note)}
          onClose={() => setNoteTarget(null)}
        />
      )}

      {prompt && <NamePopover prompt={prompt} onClose={() => setPrompt(null)} />}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.label}?`}
          description={deletionMessage(confirmDelete, trashLabel)}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            void useLibrary.getState().trashPaths(confirmDelete.paths)
            setConfirmDelete(null)
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

function HeaderCell({
  def,
  sortKey,
  sortDir,
  onResizeStart,
  onResetWidth,
  onReorder,
  dragging,
  setDragging
}: {
  def: ColumnDef
  /** The sort in force here - per folder, so it can't come from settings directly. */
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onResizeStart: (event: React.PointerEvent, id: ColumnId) => void
  onResetWidth: (id: ColumnId) => void
  onReorder: (from: ColumnId, to: ColumnId) => void
  dragging: ColumnId | null
  setDragging: (id: ColumnId | null) => void
}): React.JSX.Element {
  const setSort = useLibrary((s) => s.setSort)
  const [over, setOver] = useState(false)

  const active = def.sortKey !== undefined && sortKey === def.sortKey

  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 items-center',
        dragging === def.id && 'opacity-40',
        over && dragging && dragging !== def.id && 'bg-primary/15'
      )}
      // HTML5 drag is the right tool here: it gives a drag image and drop targets for
      // free, and headers are few enough that the event cost is irrelevant.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/umakbang-column', def.id)
        setDragging(def.id)
      }}
      onDragEnd={() => {
        setDragging(null)
        setOver(false)
      }}
      onDragOver={(event) => {
        if (!dragging || dragging === def.id) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const from = event.dataTransfer.getData('text/umakbang-column') as ColumnId
        if (from && from !== def.id) onReorder(from, def.id)
        setDragging(null)
      }}
    >
      <button
        type="button"
        title={def.title ?? (def.sortKey ? `Sort by ${def.label}` : def.label)}
        disabled={!def.sortKey}
        onClick={() => def.sortKey && setSort(def.sortKey as SortKey)}
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-0.5 truncate transition-colors',
          def.sortKey ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
          def.align === 'right' ? 'justify-end pr-1' : 'justify-start',
          active && 'text-foreground'
        )}
      >
        <span className="truncate">{def.label}</span>
        {active &&
          (sortDir === 'asc' ? (
            <ArrowUp className="h-2.5 w-2.5 shrink-0" />
          ) : (
            <ArrowDown className="h-2.5 w-2.5 shrink-0" />
          ))}
      </button>

      {/* Sits over the column boundary; the wide hit area is what makes it grabbable. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${def.label}`}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => onResizeStart(event, def.id)}
        onDoubleClick={() => onResetWidth(def.id)}
        className="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
      >
        <span className="pointer-events-none absolute left-1/2 top-1 h-[14px] w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
      </div>
    </div>
  )
}

/**
 * Shown where a tempo or key will be, while the file is being analysed.
 *
 * A blank cell means "this file hasn't got one"; a turning one means "not yet". Without
 * the difference, a folder mid-analysis is indistinguishable from one where the detector
 * found nothing, and the only way to tell would be to keep looking back at it.
 */
function Working(): React.JSX.Element {
  return <Loader2 className="h-2.5 w-2.5 animate-spin opacity-50" aria-label="Analysing" />
}

/* ------------------------------------------------------------------ cells */

interface FileCellContext {
  track: Track
  tags: string[] | undefined
  rating: number
  isCurrent: boolean
  isPlaying: boolean
  showFolder: boolean
  /** Tempo and key are being worked out for this file right now. */
  analysing: boolean
  /** Stems are being separated for this file right now. */
  splitting: boolean
  /**
   * The file is not where umakbang left it - moved or deleted outside the app, or on
   * something that stopped answering. The row stays and dims; see `applyFolder`.
   */
  unreachable: boolean
  /** The key was worked out from the audio rather than read off the file. */
  keyDetected: boolean
  /** That reading was a close call. Resolved by the table so a row holds a boolean. */
  keyUnsure: boolean
  /** Whatever the user wrote about this file, resolved by the table. '' when there is none. */
  note: string
  /** The OS's icon for this file type, once it has arrived. */
  icon: string | null
  /**
   * How many renders this row stands for, itself included, or undefined when it stands for
   * one file. Only ever set while `Settings.collapseRenders` is on.
   */
  renders: number | undefined
  /** How waveforms are coloured. Subscribed to once by the table, never by a row. */
  waveformTint: Settings['waveformTint']
  /** The ramp they are coloured with, likewise. */
  wave: readonly string[]
  handlers: RowHandlers
}

/**
 * The row's icon: whatever the OS shows for the file, falling back to a glyph for its
 * kind until that arrives - or for good, on a system with no association for it.
 */
function RowIcon({
  icon,
  fallback: Fallback,
  className
}: {
  icon: string | null
  fallback: LucideIcon
  className?: string
}): React.JSX.Element {
  if (!icon) return <Fallback className={cn('h-3.5 w-3.5 shrink-0', className)} />
  return (
    // Not draggable: without this the browser drags the image instead of the row.
    <img src={icon} alt="" draggable={false} className="h-3.5 w-3.5 shrink-0 object-contain" />
  )
}

function fileCell(id: ColumnId, ctx: FileCellContext): React.ReactNode {
  const { track } = ctx
  switch (id) {
    case 'rating':
      return (
        <StarRating
          value={ctx.rating}
          onChange={(rating) => ctx.handlers.setRating(track.path, rating)}
          wave={ctx.wave}
          className="pr-1"
        />
      )
    case 'waveform':
      // No bytes to draw from, and asking for them is a `fetch` per row that can only 404.
      if (ctx.unreachable) return <span />
      return track.playable ? (
        <RowWaveform
          path={track.path}
          size={track.size}
          playable={track.playable}
          isCurrent={ctx.isCurrent}
          duration={track.duration}
          tint={ctx.waveformTint}
          wave={ctx.wave}
        />
      ) : (
        <span />
      )
    case 'name':
      return (
        <div
          className="flex min-w-0 items-center gap-1.5 pr-2"
          /* The whole explanation, on the row it is about. The dim says something is
             wrong; only this says what, and where else to look for the file. */
          title={
            ctx.unreachable
              ? `${track.name} is not where umakbang left it. It was moved or deleted outside the app, or whatever it lives on has stopped answering. Click it to look again.`
              : undefined
          }
        >
          {/* The playing track takes over the same slot rather than adding a second
              glyph, so names stay on one vertical line whatever is playing. */}
          {ctx.unreachable ? (
            // Ahead of every other state: a file that has gone is not splitting, and it is
            // not what is playing either, whatever the transport still thinks.
            <FileX2 className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
          ) : ctx.splitting ? (
            // The row says so too: the toolbar spinner is easy to miss when the thing you
            // are watching is the file itself.
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : ctx.isCurrent ? (
            <AudioLines
              className={cn('h-3.5 w-3.5 shrink-0 text-primary', ctx.isPlaying && 'animate-pulse')}
            />
          ) : (
            <RowIcon
              icon={ctx.icon}
              fallback={KIND_ICONS[track.kind]}
              className={typeIconClass(track)}
            />
          )}
          <span
            className={cn(
              'truncate',
              ctx.isCurrent && 'font-medium text-foreground',
              // Struck through on the name alone rather than across the row: the size, the
              // tempo and the date are all still true of the file, and striking them says
              // the app has forgotten them - which is the opposite of the point. It is the
              // name, as a way of reaching the thing, that no longer leads anywhere.
              ctx.unreachable && 'line-through decoration-destructive/60'
            )}
          >
            {track.name}
          </span>
          {/* The renders this row is standing in for, in the folder count's muted style: it
              is a footnote about the row, not a value to compare rows by, so it stays out
              of the columns. */}
          {ctx.renders !== undefined && (
            <span
              className="tnum shrink-0 text-[11px] text-muted-foreground/60"
              title={`${ctx.renders} renders of this track, folded into one row`}
            >
              {'×'}
              {ctx.renders}
            </span>
          )}
          <RowTags
            tags={ctx.tags}
            paths={[track.path]}
            label={track.name}
            handlers={ctx.handlers}
          />
          {ctx.showFolder && (
            <button
              type="button"
              title={track.relDir || 'Library root'}
              onClick={(event) => {
                event.stopPropagation()
                ctx.handlers.goToFolder(track.relDir)
              }}
              className="ml-auto shrink-0 truncate pl-2 text-[11px] text-muted-foreground/60 hover:text-foreground hover:underline"
            >
              {parentLabel(track.relDir)}
            </button>
          )}
        </div>
      )
    case 'type':
      // Plain text rather than a badge: a badge on every row of a quarter-million-file
      // list is a lot of decoration for what is only the extension spelled out.
      return (
        <span className={cn('block truncate pr-2 text-right text-[11px]', typeIconClass(track))}>
          {typeLabel(track)}
        </span>
      )
    case 'bpm':
      // Slow at the quiet end of the ramp, fast at the hot one - the column reads as a
      // tempo before it is read as a number.
      return (
        <span
          className="tnum flex items-center justify-end truncate pr-1 text-right text-muted-foreground"
          style={track.bpm ? { color: rampText(ctx.wave, tempoPosition(track.bpm)) } : undefined}
        >
          {track.bpm ? Math.round(track.bpm) : ctx.analysing ? <Working /> : ''}
        </span>
      )
    case 'key': {
      // Around the circle of fifths, so keys that sound related look related and a library
      // that lives in one corner of the circle comes out in one part of the ramp.
      const position = track.musicalKey ? fifthsPosition(track.musicalKey) : null
      return (
        <span
          className={cn(
            'flex items-center truncate text-muted-foreground',
            // A reading the detector barely believes should not look like one it is sure of.
            // Dimmed and italic rather than hidden: it is still the best answer there is, and
            // the threshold is a judgement call, not a line between right and wrong.
            ctx.keyUnsure && 'italic opacity-55'
          )}
          title={ctx.keyUnsure ? 'The detector was not confident about this key' : undefined}
          style={position === null ? undefined : { color: rampText(ctx.wave, position) }}
        >
          {track.musicalKey
            ? ctx.keyDetected
              ? relativeKeyPair(track.musicalKey)
              : track.musicalKey
            : ctx.analysing
              ? <Working />
              : ''}
        </span>
      )
    }
    case 'time':
      return (
        <span className="tnum block truncate pr-1 text-right text-muted-foreground">
          {track.kind === 'audio' ? formatDurationPrecise(track.duration) : ''}
        </span>
      )
    case 'format':
      return (
        <span className="tnum block truncate pr-1 text-right text-muted-foreground/80">
          {track.kind === 'audio' ? formatFormat(track) : ''}
        </span>
      )
    case 'size':
      return (
        <span className="tnum block truncate pr-1 text-right text-muted-foreground/80">
          {formatSize(track.size)}
        </span>
      )
    case 'modified':
      return (
        <span
          className="tnum block truncate pr-1 text-right text-muted-foreground/80"
          style={{ color: rampText(ctx.wave, dayPosition(track.mtimeMs)) }}
        >
          {formatDateTime(track.mtimeMs)}
        </span>
      )
    case 'notes':
      return (
        <NoteCell
          path={track.path}
          label={track.name}
          note={ctx.note}
          onOpen={ctx.handlers.editNote}
        />
      )
    default:
      return <span />
  }
}

function folderCell(
  id: ColumnId,
  folder: {
    name: string
    totalCount: number
    latestMtime: number
    tags: string[] | undefined
    absolute: string
    /** The same ramp the file rows use, so one column doesn't disagree with itself. */
    wave: readonly string[]
    handlers: RowHandlers
  }
): React.ReactNode {
  switch (id) {
    case 'name':
      return (
        <div className="flex min-w-0 items-center gap-1.5 pr-2">
          <Folder className="h-3.5 w-3.5 shrink-0 fill-muted-foreground/20 text-muted-foreground" />
          <span className="block truncate font-medium">{folder.name}</span>
          {/* Folders carry tags the same as files, and a folder tag is what nominates a
              part of the library for analysis - so it has to be visible without opening
              the tag editor to find out. */}
          <RowTags
            tags={folder.tags}
            paths={[folder.absolute]}
            label={folder.name}
            handlers={folder.handlers}
          />
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 group-hover:opacity-100" />
          <span className="tnum ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/60">
            {folder.totalCount.toLocaleString()}
          </span>
        </div>
      )
    case 'type':
      // Plain text, like the file rows beside it.
      return (
        <span className="block truncate pr-2 text-right text-[11px] text-muted-foreground">Folder</span>
      )
    case 'modified':
      return (
        <span
          className="tnum block truncate pr-1 text-right text-muted-foreground/80"
          style={{ color: rampText(folder.wave, dayPosition(folder.latestMtime)) }}
        >
          {formatDate(folder.latestMtime)}
        </span>
      )
    default:
      return <span />
  }
}

/* ------------------------------------------------------------------ rows */

const FolderRow = memo(function FolderRow({
  path,
  name,
  totalCount,
  latestMtime,
  tags,
  absolute,
  columns,
  template,
  spacer,
  selected,
  cut,
  index,
  top,
  wave,
  handlers,
  pendingMenu
}: {
  path: string
  name: string
  totalCount: number
  latestMtime: number
  /** Tags applied to the folder itself, resolved by the table from its absolute path. */
  tags: string[] | undefined
  /** The folder's absolute path - what tags are keyed by. */
  absolute: string
  columns: ColumnState[]
  template: string
  spacer: boolean
  selected: boolean
  cut: boolean
  index: number
  top: number
  /** The visualizer ramp, subscribed to once by the table like every other shared value. */
  wave: readonly string[]
  handlers: RowHandlers
  pendingMenu: React.MutableRefObject<MenuTarget | null>
}): React.JSX.Element {
  const folder = { name, totalCount, latestMtime, tags, absolute, wave, handlers }
  const drop = useFolderDrop(path)

  return (
    <div
      role="row"
      aria-selected={selected}
      data-row-id={`dir:${path}`}
      onPointerDown={(event) => handlers.pointerDown(event, index)}
      onClick={(event) => handlers.click(event, index)}
      onContextMenu={() => {
        handlers.contextMenu(index)
        // Pasting from a folder's own menu puts things inside it, not beside it.
        pendingMenu.current = { kind: 'rows', dir: path }
      }}
      // Not `draggable`: the drag is tracked with pointer events instead, so no Blink
      // drag loop exists for the native hand-off to re-enter. See lib/drag.ts.
      draggable={false}
      {...drop.target}
      {...drop.handlers}
      className={cn(
        'group absolute inset-x-0 grid cursor-pointer items-center border-b border-border/40 pl-2 pr-3 text-[12.5px]',
        selected ? 'bg-accent' : 'hover:bg-accent/50',
        cut && 'opacity-45',
        // Dropping onto a folder moves files into it, so the target says so plainly.
        drop.over && 'bg-primary/25 ring-1 ring-inset ring-primary'
      )}
      style={{
        height: ROW_HEIGHT,
        transform: `translateY(${top}px)`,
        gridTemplateColumns: template
      }}
    >
      {/* `overflow-hidden` as well as `min-w-0`: a column narrower than its own text
          would otherwise spill that text across the next column, which is how dates ended
          up drawn over waveforms. The wrapper is a grid item and therefore blockified, so
          unlike the inline spans inside it, it genuinely clips. */}
      {columns.map((column) => (
        <span key={column.id} className="min-w-0 overflow-hidden">
          {folderCell(column.id, folder)}
        </span>
      ))}
      {spacer && <span />}
    </div>
  )
})

const FileRow = memo(function FileRow({
  track,
  analysing,
  splitting,
  unreachable,
  keyDetected,
  keyUnsure,
  note,
  waveformTint,
  wave,
  columns,
  template,
  spacer,
  icon,
  renders,
  selected,
  cut,
  tags,
  rating,
  isCurrent,
  isPlaying,
  showFolder,
  index,
  top,
  handlers,
  pendingMenu
}: {
  track: Track
  /**
   * Signature of the mutable metadata. Never read in the body - the values come off
   * `track` - but memo compares it, which is the whole point.
   */
  meta: string
  /** Tempo and key are being worked out for this file right now. */
  analysing: boolean
  /** Stems are being separated for this file right now. */
  splitting: boolean
  /**
   * The file is no longer where umakbang left it. A plain boolean resolved by the table from
   * one subscription, so `memo` compares it the way it compares everything else - a mutable
   * field on `track` would need folding into `meta` above before a row noticed at all.
   */
  unreachable: boolean
  /** The key was worked out from the audio rather than read off the file. */
  keyDetected: boolean
  /** That reading was a close call. Resolved by the table so a row holds a boolean. */
  keyUnsure: boolean
  /** Whatever the user wrote about this file, resolved by the table. '' when there is none. */
  note: string
  waveformTint: Settings['waveformTint']
  wave: readonly string[]
  columns: ColumnState[]
  template: string
  spacer: boolean
  icon: string | null
  /** How many renders this row stands for, when they were folded. A primitive, so memo
      compares it the same way it compares everything else the row draws. */
  renders: number | undefined
  selected: boolean
  cut: boolean
  tags: string[] | undefined
  rating: number
  isCurrent: boolean
  isPlaying: boolean
  showFolder: boolean
  index: number
  top: number
  handlers: RowHandlers
  pendingMenu: React.MutableRefObject<MenuTarget | null>
}): React.JSX.Element {
  const cellContext: FileCellContext = {
    track,
    tags,
    rating,
    isCurrent,
    isPlaying,
    showFolder,
    analysing,
    splitting,
    unreachable,
    keyDetected,
    keyUnsure,
    note,
    icon,
    renders,
    waveformTint,
    wave,
    handlers
  }

  return (
    <div
      role="row"
      aria-selected={selected}
      data-row-id={track.path}
      onPointerDown={(event) => handlers.pointerDown(event, index)}
      onClick={(event) => handlers.click(event, index)}
      onContextMenu={() => {
        handlers.contextMenu(index)
        // A file row has no folder of its own to paste into; the current one takes it.
        pendingMenu.current = { kind: 'rows', dir: null }
      }}
      onDoubleClick={() => {
        if (!track.playable) handlers.openExternally(track.path)
      }}
      // Not `draggable`: dragging is pointer-driven, so the drag can leave the window
      // without a Blink drag loop for the native hand-off to re-enter. See lib/drag.ts.
      draggable={false}
      className={cn(
        'group absolute inset-x-0 grid items-center border-b border-border/40 pl-2 pr-3 text-[12.5px]',
        isCurrent ? 'bg-primary/12' : selected ? 'bg-accent' : 'hover:bg-accent/50',
        cut && 'opacity-45',
        // Dimmed rather than removed - the reasoning is in `applyFolder`. The same 45% a cut
        // row uses, deliberately: both mean "this is not somewhere to act right now", and a
        // second faded value would be a shade the user has to learn to tell from the first.
        // What separates them is the struck name and the icon in the Name column.
        unreachable && 'opacity-45',
        !track.playable && 'text-muted-foreground'
      )}
      style={{
        height: ROW_HEIGHT,
        transform: `translateY(${top}px)`,
        gridTemplateColumns: template
      }}
    >
      {/* `overflow-hidden` as well as `min-w-0`: a column narrower than its own text
          would otherwise spill that text across the next column, which is how dates ended
          up drawn over waveforms. The wrapper is a grid item and therefore blockified, so
          unlike the inline spans inside it, it genuinely clips. */}
      {columns.map((column) => (
        <span key={column.id} className="min-w-0 overflow-hidden">
          {fileCell(column.id, cellContext)}
        </span>
      ))}
      {spacer && <span />}
    </div>
  )
})
