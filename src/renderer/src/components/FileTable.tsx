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
  Folder,
  Loader2,
  Plus,
  type LucideIcon
} from 'lucide-react'
import type { ColumnId, ColumnState, Settings, SortKey, Track, TrackKind } from '@shared/types'
import { useLibrary } from '@/state/library'
import { useContracts } from '@/state/contracts'
import { usePlayer } from '@/state/player'
import { Badge } from '@/components/ui/badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { TagPopover } from '@/components/TagPopover'
import { NamePopover, type NamePrompt } from '@/components/NamePopover'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  FolderMenuItems,
  SelectionMenuItems,
  type ExplorerActions,
  type MenuContext
} from '@/components/ExplorerMenu'
import { useSort, type Row } from '@/hooks/useLibraryView'
import { useFolderDrop } from '@/hooks/useFolderDrop'
import { beginRowDrag, consumeDragClick } from '@/lib/drag'
import { absolutePath, baseName, relativePath } from '@/lib/paths'
import { anchorOfRow, resolveSelection, rowId, selectionLabel } from '@/lib/selection'
import { relativeKeyPair } from '@shared/keys'
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
 * The tags on a row, and the way to add one.
 *
 * Three at most, the most recently added: there is only ever a sliver between a file name
 * and the next column, and a row that has collected eight tags would otherwise push its
 * own name out of sight. Clicking one filters the library by it; the plus opens the full
 * editor. Both are buttons, so `isRowControl` keeps the press off the row - tagging a file
 * shouldn't select it, let alone start playing it.
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
  const shown = tags && tags.length > 0 ? tags.slice(-3) : []
  const hidden = tags ? tags.length - shown.length : 0

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-0.5">
      {shown.map((tag) => (
        <button
          key={tag}
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
      ))}
      {hidden > 0 && (
        <span className="shrink-0 text-[10.5px] text-muted-foreground/60">+{hidden}</span>
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
 * Whether an event landed on something inside a row that handles its own clicks.
 *
 * The rating stars are the only ones today, but anything interactive dropped into a cell
 * needs the row to keep its hands off the press.
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
  const { key: sortKey, dir: sortDir } = useSort()
  const revealNonce = useLibrary((s) => s.revealNonce)
  const setView = useLibrary((s) => s.setView)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const ratings = useLibrary((s) => s.ratings)
  // Which keys were guessed rather than read, so the cell can show the relative pair.
  const detectedKey = useLibrary((s) => s.detectedKey)
  const stemJob = useLibrary((s) => s.stemJob)
  const waveformTint = useLibrary((s) => s.settings.waveformTint)
  // One subscription for the whole table, so a changed ramp repaints every row waveform.
  const wave = usePalette().wave
  // One subscription for the whole table: rows are handed the icon already resolved.
  useFileIcons()
  // Same shape for "which files are being analysed" - the set is read here and each row is
  // told only whether it is in it, so a row never subscribes to anything itself.
  const analysing = useAnalysing()
  const currentPath = usePlayer((s) => s.current?.path ?? null)
  const playing = usePlayer((s) => s.playing)
  const play = usePlayer((s) => s.play)

  const [tagTarget, setTagTarget] = useState<{
    paths: string[]
    label: string
    x: number
    y: number
  } | null>(null)
  const [prompt, setPrompt] = useState<NamePrompt | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ paths: string[]; label: string } | null>(
    null
  )
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
      } else if (row.track.playable) {
        play(row.track, files)
      }
    },
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
  const armRowDrag = useCallback((event: React.PointerEvent, index: number) => {
    const row = rowsRef.current[index]
    if (!row) return
    const id = rowId(row)
    const { selection, roots } = useLibrary.getState()
    const own =
      row.type === 'file'
        ? row.track.path
        : roots.length > 0
          ? absolutePath(roots, row.node.path)
          : row.node.path
    beginRowDrag(event, selection.has(id) ? selectedRef.current.paths : [own])
  }, [])

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
        if (!store.selection.has(id)) {
          store.setSelected(id)
          cursorRef.current = index
        }

        // Arm the drag with whatever is selected now. It stays a click until the pointer
        // has moved far enough to mean otherwise.
        armRowDrag(event, index)
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
        store.setClipboard(paths, 'copy')
        // The paths go to the system clipboard too, so a Ctrl+V lands somewhere useful
        // outside umakbang - a DAW's file dialog, a terminal, a message.
        void window.umakbang.copyText(paths.join('\n'))
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
        setConfirmDelete({ paths: target.paths, label: selectionLabel(target) })
      },
      newFolder: promptNewFolder,
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
          else store.notify(`Renamed ${items(renamed)}.`)
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
    [promptRename, promptNewFolder]
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

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key

      if (mod) {
        switch (key.toLowerCase()) {
          case 'a':
            event.preventDefault()
            actions.selectAll()
            return
          case 'c':
            event.preventDefault()
            if (event.shiftKey) actions.copyPath()
            else actions.copy()
            return
          case 'x':
            event.preventDefault()
            actions.cut()
            return
          case 'v': {
            event.preventDefault()
            const dir = currentDirRef.current
            if (dir !== null) actions.paste(dir)
            return
          }
          case 'd':
            event.preventDefault()
            actions.duplicate()
            return
          case 'n': {
            if (!event.shiftKey) break
            event.preventDefault()
            const dir = currentDirRef.current
            if (dir !== null) actions.newFolder(dir)
            return
          }
          default:
            break
        }
      }

      // Rating from the number row: 1-5 stars, 0 to clear. Digging through a folder and
      // marking the keepers as you go is the whole point of the ratings, and reaching for
      // the mouse for each one breaks the rhythm.
      if (!mod && !event.altKey && key >= '0' && key <= '5') {
        const { tracks } = selectedRef.current
        if (tracks.length === 0) return
        event.preventDefault()
        const rating = Number(key)
        const store = useLibrary.getState()
        for (const track of tracks) store.setRating(track.path, rating)
        // One row shows its own stars; a batch may be half off-screen, so it gets a word.
        if (tracks.length > 1) {
          store.notify(
            rating === 0
              ? `Cleared the rating on ${items(tracks.length)}.`
              : `Rated ${items(tracks.length)} ${'★'.repeat(rating)}`
          )
        }
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
        case 'F2':
          event.preventDefault()
          actions.rename()
          break
        case 't':
        case 'T':
          // Tagging is the other thing you do while walking a folder, so it gets a key
          // next to the ratings rather than a trip through the menu.
          event.preventDefault()
          actions.editTags()
          break
        case 'Delete':
          event.preventDefault()
          actions.remove()
          break
        case 'Escape':
          event.preventDefault()
          useLibrary.getState().clearSelection()
          break
        case 'Backspace': {
          // Up one level, the way Backspace works in a file manager. Left/right are the
          // transport's - they scrub the playing track from anywhere in the app.
          if (view.mode !== 'folder' || !view.dir) break
          event.preventDefault()
          setView({ mode: 'folder', dir: view.dir.split('/').slice(0, -1).join('/') })
          break
        }
        default:
          break
      }
    },
    // Space is not bound here: the app-level transport shortcut already sees it, and
    // binding it in both places toggled playback twice for one keypress.
    [actions, moveSelection, view, setView]
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
                        handlers={handlers}
                        pendingMenu={pendingMenu}
                      />
                    )
                  }
                  const isCurrent = currentPath === row.track.path
                  return (
                    <FileRow
                      key={row.track.path}
                      track={row.track}
                      meta={metaSignature(row.track)}
                      analysing={analysing.has(row.track.path)}
                      splitting={stemJob?.path === row.track.path}
                      keyDetected={detectedKey[row.track.path] !== undefined}
                      waveformTint={waveformTint}
                      wave={wave}
                      columns={visible}
                      template={template}
                      spacer={spacer}
                      icon={fileIcon(row.track.ext) ?? null}
                      selected={selection.has(row.track.path)}
                      cut={cutPaths?.has(row.track.path) ?? false}
                      tags={tags[row.track.path]}
                      rating={ratings[row.track.path] ?? 0}
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

      {prompt && <NamePopover prompt={prompt} onClose={() => setPrompt(null)} />}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.paths.length === 1 ? confirmDelete.label : items(confirmDelete.paths.length)}?`}
          description={`${confirmDelete.paths.length === 1 ? 'It goes' : 'They go'} to the ${trashLabel}, so you can put ${confirmDelete.paths.length === 1 ? 'it' : 'them'} back.`}
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
  /** The key was worked out from the audio rather than read off the file. */
  keyDetected: boolean
  /** The OS's icon for this file type, once it has arrived. */
  icon: string | null
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
          className="pr-1"
        />
      )
    case 'waveform':
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
        <div className="flex min-w-0 items-center gap-1.5 pr-2">
          {/* The playing track takes over the same slot rather than adding a second
              glyph, so names stay on one vertical line whatever is playing. */}
          {ctx.splitting ? (
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
          <span className={cn('truncate', ctx.isCurrent && 'font-medium text-foreground')}>
            {track.name}
          </span>
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
      return (
        <span className="tnum flex items-center justify-end truncate pr-1 text-right text-muted-foreground">
          {track.bpm ? Math.round(track.bpm) : ctx.analysing ? <Working /> : ''}
        </span>
      )
    case 'key':
      return (
        <span className="flex items-center truncate text-muted-foreground">
          {track.musicalKey
            ? ctx.keyDetected
              ? relativeKeyPair(track.musicalKey)
              : track.musicalKey
            : ctx.analysing
              ? <Working />
              : ''}
        </span>
      )
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
        <span className="tnum block truncate pr-1 text-right text-muted-foreground/80">
          {formatDateTime(track.mtimeMs)}
        </span>
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
        <span className="tnum block truncate pr-1 text-right text-muted-foreground/80">
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
  handlers: RowHandlers
  pendingMenu: React.MutableRefObject<MenuTarget | null>
}): React.JSX.Element {
  const folder = { name, totalCount, latestMtime, tags, absolute, handlers }
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
  keyDetected,
  waveformTint,
  wave,
  columns,
  template,
  spacer,
  icon,
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
  /** The key was worked out from the audio rather than read off the file. */
  keyDetected: boolean
  waveformTint: Settings['waveformTint']
  wave: readonly string[]
  columns: ColumnState[]
  template: string
  spacer: boolean
  icon: string | null
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
    keyDetected,
    icon,
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
