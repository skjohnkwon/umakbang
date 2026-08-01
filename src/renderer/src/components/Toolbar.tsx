import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CornerLeftUp,
  Dices,
  ExternalLink,
  FolderInput,
  FolderPlus,
  FolderTree,
  Download,
  FilterX,
  Layers,
  List,
  ListFilter,
  Loader2,
  MousePointerClick,
  Pin,
  Redo2,
  Repeat,
  RefreshCw,
  Star,
  Undo2,
  Wand2,
  Library
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { ColumnMenu } from '@/components/ColumnMenu'
import { NamePopover, type NamePrompt } from '@/components/NamePopover'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useAvailableTypes, type Row } from '@/hooks/useLibraryView'
import { useFolderDrop } from '@/hooks/useFolderDrop'
import { normalizeColumns } from '@/lib/columns'
import { absolutePath } from '@/lib/paths'
import { isPinned, togglePinned } from '@/lib/quick-access'
import {
  isRandomExcluded,
  isRandomExcludedByParent,
  toggleRandomExcluded
} from '@/lib/random-scope'
import { cn } from '@/lib/utils'
import { KIND_LABELS, baseName } from '@/lib/format'
import { shortcutKey, shortcutLabel } from '@shared/shortcuts'

export function Toolbar({
  rows,
  folderCount,
  fileCount
}: {
  /** What the table is showing, for the actions that work on the whole view. */
  rows: Row[]
  folderCount: number
  fileCount: number
}): React.JSX.Element {
  const view = useLibrary((s) => s.view)
  const setView = useLibrary((s) => s.setView)
  const goBack = useLibrary((s) => s.goBack)
  const goForward = useLibrary((s) => s.goForward)
  // Booleans rather than the stack itself, so navigating doesn't re-render the toolbar
  // for a history array whose contents it never reads.
  const canGoBack = useLibrary((s) => s.historyIndex > 0)
  const canGoForward = useLibrary((s) => s.historyIndex < s.history.length - 1)
  const progress = useLibrary((s) => s.progress)
  const scanning = useLibrary((s) => s.scanning)
  const selectionCount = useLibrary((s) => s.selection.size)
  const stemJob = useLibrary((s) => s.stemJob)
  // The durable way back. The menu carries it too, but a menu bar is not where a Windows
  // user looks for the thing they just did, so the button sits with Back and Forward - which
  // is the other control on this strip that means "take me to before".
  const undo = useLibrary((s) => s.undo)
  const redo = useLibrary((s) => s.redo)
  const undoRunning = useLibrary((s) => s.undoRunning)
  const undoProgress = useLibrary((s) => s.undoProgress)
  const runUndo = useLibrary((s) => s.runUndo)
  const runRedo = useLibrary((s) => s.runRedo)

  const canGoUp = view.mode === 'folder' && view.dir !== ''
  const parentDir = canGoUp && view.mode === 'folder' ? parentOf(view.dir) : ''

  // Dropping on the up button moves things one level out, which is the whole reason to
  // reach for it mid-drag. Not when "up" is the virtual root, though - that isn't a
  // folder on disk, and a drop into it can only fail.
  const upDrop = useFolderDrop(parentDir)
  const canDropUp = canGoUp && parentDir !== ''

  return (
    /* Two stages of giving way, in that order: the status texts below truncate (they carry
       `shrink`, everything after them is `shrink-0`), and only if the buttons alone still
       don't fit does the strip scroll. What it must never do is overflow silently, which
       painted "checking for changes" across the visualizer panel beside it. The scrollbar
       is hidden because there is no room for one in 30px - shift+wheel reaches the rest. */
    <div className="scroll-none flex h-[30px] shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b px-2.5">
      {/* Back and Forward retrace where you have been, which is not the same question as
          Up: Up is the tree, these are the route you took through it. */}
      <div className="flex shrink-0 items-center">
        <Hint label="Back (Alt+Left)" side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            disabled={!canGoBack}
            onClick={goBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
        </Hint>
        <Hint label="Forward (Alt+Right)" side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            disabled={!canGoForward}
            onClick={goForward}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </Hint>

        {/* Absent rather than disabled when there is nothing to reverse, which is most of
            the time: a permanently greyed button is chrome nobody reads, and its arriving is
            what says an operation was recorded. The label is main's single wording of the
            record - `title` rather than a `Hint`, because it already is the whole sentence
            and a tooltip repeating it says nothing twice. */}
        {undo !== null && (
          <>
            <Button
              variant="ghost"
              /* Grows a number when there is more than one press in it, the way Clear does.
                 Without it a stack of operations looks exactly like a single one, and the
                 whole point of the stack is that the second press does something. */
              size={undo.depth > 1 ? 'sm' : 'icon-sm'}
              className={cn(undo.depth > 1 && 'gap-1 px-1.5')}
              aria-label={undo.label}
              title={
                undo.depth > 1
                  ? `${undo.label} - ${undo.depth} operations to step back through`
                  : undo.label
              }
              disabled={undoRunning}
              onClick={() => void runUndo()}
            >
              {undoRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Undo2 className="h-3.5 w-3.5" />
              )}
              {undo.depth > 1 && !undoRunning && (
                <span className="tnum text-[11px]">{undo.depth}</span>
              )}
            </Button>
            {/* Stopping is between files, never inside one, so this is offered for as long as
                there are files left to decide about. The count is on it rather than beside
                it: 30px of strip has no room for a second status text. */}
            {undoRunning && (
              <Button
                variant="subtle"
                size="sm"
                className="tnum"
                onClick={() => void window.umakbang.cancelUndo()}
              >
                {undoProgress
                  ? `Cancel ${undoProgress.done}/${undoProgress.total}`
                  : 'Cancel'}
              </Button>
            )}
          </>
        )}

        {/* Absent until something has been undone, on the same rule as Undo beside it - and
            for redo that is nearly always, so a permanent greyed arrow would be chrome that
            never does anything. Not shown mid-run either: the reversal in flight is about to
            change what there is to redo. */}
        {redo !== null && !undoRunning && (
          <Button
            variant="ghost"
            size={redo.depth > 1 ? 'sm' : 'icon-sm'}
            className={cn(redo.depth > 1 && 'gap-1 px-1.5')}
            aria-label={redo.label}
            title={
              redo.depth > 1
                ? `${redo.label} - ${redo.depth} operations to step forward through`
                : redo.label
            }
            onClick={() => void runRedo()}
          >
            <Redo2 className="h-3.5 w-3.5" />
            {redo.depth > 1 && <span className="tnum text-[11px]">{redo.depth}</span>}
          </Button>
        )}
      </div>

      <Hint
        label={canGoUp ? 'Up one level (Backspace) - or drop here to move up' : 'Up one level'}
        side="bottom"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Up one level"
          disabled={!canGoUp}
          onClick={() => {
            if (view.mode !== 'folder') return
            setView({ mode: 'folder', dir: parentOf(view.dir) })
          }}
          {...(canDropUp ? upDrop.target : {})}
          {...(canDropUp ? upDrop.handlers : {})}
          className={cn(upDrop.over && canDropUp && 'bg-primary/25 text-foreground ring-1 ring-primary')}
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
        </Button>
      </Hint>

      {/* Left of the path, with the other controls that act on where you are standing rather
          than on the whole library: Up leaves this folder, Refresh re-reads it, New folder
          makes one inside it. The toggles after the path are about the whole library. */}
      <RefreshFolderButton />
      <NewFolderButton />

      <div className="flex min-w-0 flex-1 items-center gap-1 text-[12px]">
        {view.mode === 'rated' && (
          <StaticCrumb
            icon={<Star className="h-3.5 w-3.5 fill-current" />}
            label={
              view.min === view.max
                ? `${'\u2605'.repeat(view.min)} only`
                : view.min === 1 && view.max === 5
                  ? 'Rated'
                  : `${view.min}\u2013${view.max} stars`
            }
          />
        )}
        {view.mode === 'downloads' && (
          <StaticCrumb icon={<Download className="h-3.5 w-3.5" />} label="Downloads" />
        )}
        {view.mode === 'all' && (
          <StaticCrumb icon={<Library className="h-3.5 w-3.5" />} label="All files" />
        )}
        {view.mode === 'folder' && (
          <Breadcrumbs
            dir={view.dir}
            rootLabel="Library"
            onNavigate={(dir) => setView({ mode: 'folder', dir })}
          />
        )}
      </div>

      {/* Truncates rather than holding its width: with the panel open there is not always
          room for the count, the scan status and the buttons, and a row of counts pushed
          out over the panel is worse than a row of counts cut short. */}
      <span className="tnum min-w-0 shrink truncate text-[11.5px] text-muted-foreground">
        {[
          folderCount > 0 ? `${folderCount.toLocaleString()} ${folderCount === 1 ? 'folder' : 'folders'}` : '',
          `${fileCount.toLocaleString()} ${fileCount === 1 ? 'file' : 'files'}`
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>

      {/* Only worth saying once more than one row is in play - a single selection is
          already obvious from the highlight. */}
      {selectionCount > 1 && (
        <span className="tnum min-w-0 shrink truncate text-[11.5px] font-medium text-primary">
          {selectionCount.toLocaleString()} selected
        </span>
      )}

      {/* Splitting runs in the background, so this is the only thing that says so. */}
      {stemJob && (
        <span
          className="tnum flex min-w-0 shrink items-center gap-1.5 text-[11.5px] text-muted-foreground"
          title={`Splitting ${baseName(stemJob.path)} - ${stemJob.phase}`}
        >
          {/* The spinner is the part that carries the message; the words can go. */}
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          <span className="truncate">
            splitting
            {stemJob.total > 1 ? ` ${stemJob.done + 1}/${stemJob.total}` : ''}
            {stemJob.percent !== undefined ? ` · ${Math.round(stemJob.percent)}%` : ''}
          </span>
        </span>
      )}

      {scanning && progress && (
        <span className="tnum flex min-w-0 shrink items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          <span className="truncate">
            {progress.phase === 'walking'
              ? progress.revalidating
                ? 'checking for changes'
                : `indexing ${progress.found.toLocaleString()}`
              : `reading ${progress.probed.toLocaleString()}/${progress.total.toLocaleString()}`}
          </span>
        </span>
      )}

      <PlaybackToggles />
      <ClearFiltersButton />
      <RecalculateButton rows={rows} />
      <RandomBeatButton />
      <AudioOnlyToggle />
      <FoldersToggle />
      <CollapseRendersToggle />
      <TypeFilterMenu />
      <ColumnsButton />

    </div>
  )
}

/**
 * Makes a folder in the folder being browsed.
 *
 * The same action as the context menu's, put where it can be reached without hunting for a
 * patch of empty table to right-click - which in a full folder there is none of. It carries
 * its own `NamePopover` rather than reaching into the table's: the popover is self-contained
 * and anchored to whatever asked for it, so a second one costs a few lines and saves
 * threading a callback from here through `App` and into `FileTable`.
 *
 * Only a real folder can hold a new one. The saved views - Rated, Downloads, All files - are
 * questions about the library rather than places in it, so there is nowhere to put it.
 */
function NewFolderButton(): React.JSX.Element {
  const view = useLibrary((s) => s.view)
  const [prompt, setPrompt] = useState<NamePrompt | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)

  const here = view.mode === 'folder' ? view.dir : null

  return (
    <>
      <Hint
        label={here === null ? 'Open a folder to make one inside it' : 'New folder'}
        side="bottom"
      >
        <Button
          ref={anchor}
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          disabled={here === null}
          onClick={() => {
            if (here === null) return
            const rect = anchor.current?.getBoundingClientRect()
            setPrompt({
              title: `New folder in ${here ? baseName(here) : 'the library root'}`,
              initial: 'New folder',
              confirmLabel: 'Create',
              busyLabel: 'Creating…',
              selectStem: false,
              skipIfUnchanged: false,
              submit: (name) => useLibrary.getState().createFolder(here, name),
              x: rect?.left ?? 200,
              y: (rect?.bottom ?? 60) + 4
            })
          }}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
      </Hint>
      {prompt && <NamePopover prompt={prompt} onClose={() => setPrompt(null)} />}
    </>
  )
}

/**
 * Works the tempo and key out again for everything on screen.
 *
 * Both are cached forever once found, which is what makes browsing cheap and also means a
 * detector that has since been improved never gets a second look at a file. This throws
 * the cached answers away for the current view and queues the lot.
 *
 * Only the analysed values go. Anything the file itself declared - an ACID chunk, an ID3
 * tag - stays, since re-deriving it from the audio would replace a fact with a guess.
 */
function RecalculateButton({ rows }: { rows: Row[] }): React.JSX.Element {
  // Not disabled during a scan: analysis reads files that are already indexed and has
  // nothing to do with the walk, and on a library this size a scan is running often
  // enough that gating on it would mean the button was usually dead.
  // Memoised on the rows: the toolbar re-renders on every scan progress message and every
  // selection change, and this walk is O(view size) - 300k in the all-files view.
  const files = useMemo(
    () => rows.flatMap((row) => (row.type === 'file' && row.track.playable ? [row.track] : [])),
    [rows]
  )

  return (
    <Hint
      label={
        files.length === 0
          ? 'Nothing here to analyse'
          : `Recalculate tempo and key for ${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'}`
      }
      side="bottom"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Recalculate tempo and key"
        disabled={files.length === 0}
        onClick={() => useLibrary.getState().recalculateAnalysis(files)}
      >
        <Wand2 className="h-3.5 w-3.5" />
      </Button>
    </Hint>
  )
}

/**
 * Re-reads the folder on screen.
 *
 * The folder is watched already, so a file saved into it usually appears by itself. This
 * is for when it doesn't: a network share where the watch never fired, or a write the OS
 * reported before the file was finished. Only the folder itself, which is why it is
 * instant where a rescan of the library is not.
 */
function RefreshFolderButton(): React.JSX.Element {
  const view = useLibrary((s) => s.view)
  const roots = useLibrary((s) => s.roots)
  const [spinning, setSpinning] = useState(false)
  const dir = view.mode === 'folder' && roots.length > 0 ? absolutePath(roots, view.dir) : null

  return (
    <Hint label={dir ? 'Refresh this folder' : 'Nothing to refresh'} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh folder"
        disabled={!dir}
        className="shrink-0"
        onClick={() => {
          if (!dir) return
          setSpinning(true)
          void window.umakbang.refreshFolder(dir).finally(() => setSpinning(false))
        }}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} />
      </Button>
    </Hint>
  )
}

/**
 * Digs one file out of the library at random, plays it, and navigates to it.
 *
 * A library this size has a long tail nobody browses to, and the fastest way back into an
 * old beat is not to go looking for it. It lands you *in* the folder rather than only
 * playing the file, because what you usually want next is whatever else is in there.
 */
function RandomBeatButton(): React.JSX.Element {
  const empty = useLibrary((s) => s.tracks.length === 0)
  const playRandom = usePlayer((s) => s.playRandom)
  const key = useLibrary((s) => shortcutLabel(shortcutKey(s.settings.shortcuts, 'random')))

  return (
    <Hint label={`Play a random beat and go to it (${key})`} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        data-tour="random"
        aria-label="Play a random beat"
        disabled={empty}
        onClick={playRandom}
      >
        <Dices className="h-3.5 w-3.5" />
      </Button>
    </Hint>
  )
}

/** Column visibility and order. Lives here rather than in the header, which scrolls. */
function ColumnsButton(): React.JSX.Element {
  const savedColumns = useLibrary((s) => s.settings.columns)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const columns = useMemo(() => normalizeColumns(savedColumns), [savedColumns])

  return <ColumnMenu columns={columns} onChange={(next) => patchSettings({ columns: next })} />
}

/**
 * One button for "show me everything again".
 *
 * Filters stack up from three different places - the search box, the type menu, the tag
 * strip - and a view narrowed by a filter you've forgotten looks exactly like a library
 * that has lost your files. It only appears when something is actually filtering, and it
 * says how much.
 */
function ClearFiltersButton(): React.JSX.Element | null {
  const query = useLibrary((s) => s.query)
  const typeFilter = useLibrary((s) => s.typeFilter)
  const tagFilter = useLibrary((s) => s.tagFilter)
  const clearAllFilters = useLibrary((s) => s.clearAllFilters)

  const active =
    (query.trim() ? 1 : 0) +
    typeFilter.kinds.length +
    typeFilter.exts.length +
    tagFilter.length
  if (active === 0) return null

  return (
    <Hint label="Clear the search, type filters and tags" side="bottom">
      <Button
        variant="ghost"
        size="sm"
        onClick={clearAllFilters}
        className="gap-1 px-1.5 text-primary"
      >
        <FilterX className="h-3.5 w-3.5" />
        <span className="tnum text-[11px]">Clear {active}</span>
      </Button>
    </Hint>
  )
}

/**
 * The two switches that decide how browsing and playback interact.
 *
 * They belong here rather than only in Settings because they are changed *while*
 * browsing - auditioning a folder wants both on, hunting for one file by name wants both
 * off - and a trip through a settings page to flip them is a trip you stop taking.
 */
function PlaybackToggles(): React.JSX.Element {
  const playOnSelect = useLibrary((s) => s.settings.playOnSelect)
  const autoAdvance = useLibrary((s) => s.settings.autoAdvance)
  const patchSettings = useLibrary((s) => s.patchSettings)

  return (
    <>
      <Hint
        label={playOnSelect ? 'Playing on select' : 'Play a file when it is selected'}
        side="bottom"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={playOnSelect}
          aria-label="Play on select"
          onClick={() => patchSettings({ playOnSelect: !playOnSelect })}
          className={cn(playOnSelect && 'bg-primary/15 text-primary')}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
        </Button>
      </Hint>
      <Hint
        label={autoAdvance ? 'Continuing to the next file' : 'Stop at the end of each file'}
        side="bottom"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={autoAdvance}
          aria-label="Auto advance"
          onClick={() => patchSettings({ autoAdvance: !autoAdvance })}
          className={cn(autoAdvance && 'bg-primary/15 text-primary')}
        >
          <Repeat className="h-3.5 w-3.5" />
        </Button>
      </Hint>
    </>
  )
}

/**
 * Keeps only the audio file types - the common case when you're digging for a sound and
 * the folder is full of `.flp` projects and MIDI. Shares the type filter's state, so it
 * stays in sync with the Audio entry in the menu next to it.
 *
 * It is a question about *file types*, and deliberately nothing else: folder rows are the
 * business of the toggle beside it, so "audio files, no folders, everything beneath here"
 * is the two of them pressed rather than one button quietly doing both.
 */
function AudioOnlyToggle(): React.JSX.Element {
  const typeFilter = useLibrary((s) => s.typeFilter)
  const toggleKindFilter = useLibrary((s) => s.toggleKindFilter)
  const active = typeFilter.kinds.includes('audio')

  return (
    <Hint
      label={active ? 'Showing audio file types only' : 'Show audio file types only'}
      side="bottom"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-pressed={active}
        aria-label="Audio files only"
        onClick={() => toggleKindFilter('audio')}
        className={cn(active && 'bg-primary/15 text-primary')}
      >
        <AudioLines className="h-3.5 w-3.5" />
      </Button>
    </Hint>
  )
}

/**
 * Folders, or no folders at all.
 *
 * With folders off the explorer stops being a file manager and becomes one flat list of
 * every file at or beneath where you are standing, whatever its path - so at the top level
 * that is the whole library. The store has always been able to do this (`recursive`, which
 * is also what a search switches on) and nothing has ever been wired to it: the only way to
 * see a folder's whole subtree was to type something into the search box, which then also
 * filtered it.
 *
 * The icon changes rather than only lighting up, unlike the toggles beside it. Those switch
 * a behaviour on or off; this one picks between two shapes for the list, and a tree against
 * a flat list is that difference drawn.
 *
 * Off in the saved views, which are already flat - there is no folder structure in "Rated"
 * to fold away.
 */
function FoldersToggle(): React.JSX.Element {
  const recursive = useLibrary((s) => s.recursive)
  const setRecursive = useLibrary((s) => s.setRecursive)
  const view = useLibrary((s) => s.view)
  const inFolder = view.mode === 'folder'
  const atRoot = inFolder && view.dir === ''

  return (
    <Hint
      label={
        !inFolder
          ? 'This view is already a flat list of files'
          : recursive
            ? `Showing every file beneath ${atRoot ? 'the library' : 'this folder'}, no folder rows`
            : `Drop the folders - show every file beneath ${atRoot ? 'the library' : 'this folder'}`
      }
      side="bottom"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-pressed={recursive}
        aria-label="Show every file, no folders"
        disabled={!inFolder}
        onClick={() => setRecursive(!recursive)}
        className={cn(recursive && 'bg-primary/15 text-primary')}
      >
        {recursive ? <List className="h-3.5 w-3.5" /> : <FolderTree className="h-3.5 w-3.5" />}
      </Button>
    </Hint>
  )
}

/**
 * Folds a track's renders into one row.
 *
 * A finished piece of music leaves several files behind - `REFLECT_Master.wav`,
 * `REFLECT.mp3`, `REFLECT_notag.wav` - and in a folder of finished work that is the rule
 * rather than the exception: 40 songs read as 120 files. The largest render stands for the
 * rest and says how many it stands for.
 *
 * It sits here beside the other view toggles rather than only in Settings because it is a
 * question about the folder you are looking at now: browsing your own bounces wants it on,
 * and going to find the exact MP3 you sent somebody wants it off.
 */
function CollapseRendersToggle(): React.JSX.Element {
  const active = useLibrary((s) => s.settings.collapseRenders)
  const patchSettings = useLibrary((s) => s.patchSettings)

  return (
    <Hint
      label={
        active
          ? 'One row per track - the biggest render stands for the rest'
          : "Fold a track's renders (Master, MP3, notag) into one row"
      }
      side="bottom"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-pressed={active}
        aria-label="Collapse renders"
        onClick={() => patchSettings({ collapseRenders: !active })}
        className={cn(active && 'bg-primary/15 text-primary')}
      >
        <Layers className="h-3.5 w-3.5" />
      </Button>
    </Hint>
  )
}

/**
 * One-click filtering by file type: the broad audio / MIDI / project split, and every
 * extension actually present in the library. Faster than typing `ext:wav`, and it shows
 * you what's in there in the first place.
 */
function TypeFilterMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Counting types is a full pass over the index, so it only runs while the menu is open.
  const { kinds, exts } = useAvailableTypes(open)
  const typeFilter = useLibrary((s) => s.typeFilter)
  const toggleKindFilter = useLibrary((s) => s.toggleKindFilter)
  const toggleExtFilter = useLibrary((s) => s.toggleExtFilter)
  const clearTypeFilter = useLibrary((s) => s.clearTypeFilter)
  const setSort = useLibrary((s) => s.setSort)

  const activeCount = typeFilter.kinds.length + typeFilter.exts.length

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Hint label="Filter and sort by type" side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('gap-1 px-1.5', activeCount > 0 && 'text-primary')}
          >
            <ListFilter className="h-3.5 w-3.5" />
            {activeCount > 0 && <span className="tnum text-[11px]">{activeCount}</span>}
          </Button>
        </DropdownMenuTrigger>
      </Hint>

      <DropdownMenuContent align="end" className="max-h-[70vh] min-w-[13rem] overflow-y-auto">
        <DropdownMenuItem onSelect={() => setSort('kind')}>
          Sort by type
        </DropdownMenuItem>
        {activeCount > 0 && (
          <DropdownMenuItem onSelect={clearTypeFilter}>Clear filters</DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Kind</DropdownMenuLabel>
        {kinds.map(({ kind, count }) => (
          <DropdownMenuCheckboxItem
            key={kind}
            checked={typeFilter.kinds.includes(kind)}
            // Radix closes the menu on select by default; keep it open for multi-select.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggleKindFilter(kind)}
          >
            <span className="flex-1">{KIND_LABELS[kind]}</span>
            <span className="tnum pl-3 text-[10.5px] text-muted-foreground/60">
              {count.toLocaleString()}
            </span>
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Extension</DropdownMenuLabel>
        {exts.map(({ ext, count }) => (
          <DropdownMenuCheckboxItem
            key={ext}
            checked={typeFilter.exts.includes(ext)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggleExtFilter(ext)}
          >
            <span className="flex-1 uppercase">{ext}</span>
            <span className="tnum pl-3 text-[10.5px] text-muted-foreground/60">
              {count.toLocaleString()}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function StaticCrumb({
  icon,
  label
}: {
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 font-medium">
      <span className="text-primary">{icon}</span>
      {label}
    </span>
  )
}

function Breadcrumbs({
  dir,
  rootLabel,
  onNavigate
}: {
  dir: string
  rootLabel: string
  onNavigate: (dir: string) => void
}): React.JSX.Element {
  const segments = dir ? dir.split('/') : []

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
      <Crumb
        label={rootLabel}
        dir=""
        active={segments.length === 0}
        onClick={() => onNavigate('')}
      />
      {segments.map((segment, index) => {
        const path = segments.slice(0, index + 1).join('/')
        return (
          <span key={path} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <Crumb
              label={segment}
              dir={path}
              active={index === segments.length - 1}
              onClick={() => onNavigate(path)}
            />
          </span>
        )
      })}
    </div>
  )
}

/**
 * One step of the path - and a drop target for it.
 *
 * Moving something *out* of where you are otherwise means navigating away first, losing
 * sight of what you were moving. The trail you walked in on is already on screen, so it
 * doubles as the list of places you can drop into.
 */
function Crumb({
  label,
  dir,
  active,
  onClick
}: {
  label: string
  /** Root-relative path this crumb stands for. '' is the library root. */
  dir: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const drop = useFolderDrop(dir)
  const roots = useLibrary((s) => s.roots)
  const clipboard = useLibrary((s) => s.clipboard)
  const excluded = useLibrary((s) => s.settings.randomExcludeDirs)
  const revealLabel = useLibrary((s) => s.platform?.revealLabel ?? 'Show in folder')
  const quickMove = useLibrary((s) => s.settings.quickMove)
  const isExcluded = isRandomExcluded(dir, excluded)
  const coveredByParent = isRandomExcludedByParent(dir, excluded)

  const absolute = roots.length > 0 ? absolutePath(roots, dir) : null
  const pinned = absolute !== null && isPinned(quickMove, absolute)
  // '' is the virtual root above every library folder: there is no folder on disk behind
  // it, so a drop or a paste aimed at it can only come back with an error.
  const virtualRoot = dir === ''

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          title={label}
          {...(virtualRoot ? {} : drop.target)}
          {...(virtualRoot ? {} : drop.handlers)}
          className={cn(
            'truncate rounded px-1 py-0.5 transition-colors',
            active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            drop.over && 'bg-primary/25 text-foreground ring-1 ring-inset ring-primary'
          )}
        >
          {label}
        </button>
      </ContextMenuTrigger>

      {/* The path bar is a list of folders, so it answers to the same questions a folder
          row does - minus the ones that need a selection. */}
      <ContextMenuContent className="w-60">
        <ContextMenuLabel className="truncate">{label}</ContextMenuLabel>
        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onClick}>
          <FolderInput className="h-3.5 w-3.5" />
          Go here
        </ContextMenuItem>
        <ContextMenuItem
          disabled={virtualRoot || !clipboard || clipboard.paths.length === 0}
          onSelect={() => void useLibrary.getState().pasteInto(dir)}
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          Paste here
        </ContextMenuItem>

        <ContextMenuSeparator />
        {/* Pinning from here matters more than from a row: this is the folder you are
            standing in, and it is usually the one you've just decided you keep coming
            back to. */}
        <ContextMenuItem
          disabled={!absolute}
          onSelect={() => {
            if (!absolute) return
            const store = useLibrary.getState()
            store.patchSettings({ quickMove: togglePinned(store.settings.quickMove, absolute) })
            store.notify(pinned ? `Unpinned ${label}.` : `Pinned ${label} to quick access.`)
          }}
        >
          <Pin className="h-3.5 w-3.5" />
          {pinned ? 'Unpin from quick access' : 'Pin to quick access'}
        </ContextMenuItem>

        <ContextMenuItem
          disabled={coveredByParent}
          onSelect={() => {
            const store = useLibrary.getState()
            store.patchSettings({
              randomExcludeDirs: toggleRandomExcluded(store.settings, [dir])
            })
            store.notify(
              isExcluded
                ? `The dice can land in ${label} again.`
                : `The dice will skip ${label} and everything beneath.`
            )
          }}
        >
          <Dices className="h-3.5 w-3.5" />
          {coveredByParent
            ? 'Already excluded by a parent'
            : isExcluded
              ? 'Include in random again'
              : 'Never pick at random'}
        </ContextMenuItem>

        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!absolute}
          onSelect={() => absolute && void window.umakbang.reveal(absolute)}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {revealLabel}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!absolute}
          onSelect={() => {
            if (!absolute) return
            void window.umakbang.copyText(absolute)
            useLibrary.getState().notify('Copied the path.')
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy full path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The folder holding a root-relative path. '' when it's already a top-level folder. */
function parentOf(dir: string): string {
  return dir.split('/').slice(0, -1).join('/')
}
