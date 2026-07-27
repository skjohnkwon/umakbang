import type React from 'react'
import { useMemo, useState } from 'react'
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
  Download,
  FilterX,
  ListFilter,
  Loader2,
  MousePointerClick,
  Pin,
  Repeat,
  RefreshCw,
  Star,
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

  const canGoUp = view.mode === 'folder' && view.dir !== ''
  const parentDir = canGoUp && view.mode === 'folder' ? parentOf(view.dir) : ''

  // Dropping on the up button moves things one level out, which is the whole reason to
  // reach for it mid-drag.
  const upDrop = useFolderDrop(parentDir)

  return (
    <div className="flex h-[30px] shrink-0 items-center gap-2 border-b px-2.5">
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
          {...(canGoUp ? upDrop.target : {})}
          {...(canGoUp ? upDrop.handlers : {})}
          className={cn(upDrop.over && canGoUp && 'bg-primary/25 text-foreground ring-1 ring-primary')}
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
        </Button>
      </Hint>

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

      <span className="tnum shrink-0 text-[11.5px] text-muted-foreground">
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
        <span className="tnum shrink-0 text-[11.5px] font-medium text-primary">
          {selectionCount.toLocaleString()} selected
        </span>
      )}

      {/* Splitting runs in the background, so this is the only thing that says so. */}
      {stemJob && (
        <span
          className="tnum flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground"
          title={`Splitting ${baseName(stemJob.path)} - ${stemJob.phase}`}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          splitting
          {stemJob.total > 1 ? ` ${stemJob.done + 1}/${stemJob.total}` : ''}
          {stemJob.percent !== undefined ? ` · ${Math.round(stemJob.percent)}%` : ''}
        </span>
      )}

      {scanning && progress && (
        <span className="tnum flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {progress.phase === 'walking'
            ? progress.revalidating
              ? 'checking for changes'
              : `indexing ${progress.found.toLocaleString()}`
            : `reading ${progress.probed.toLocaleString()}/${progress.total.toLocaleString()}`}
        </span>
      )}

      <PlaybackToggles />
      <ClearFiltersButton />
      <RefreshFolderButton />
      <RecalculateButton rows={rows} />
      <RandomBeatButton />
      <AudioOnlyToggle />
      <TypeFilterMenu />
      <ColumnsButton />

    </div>
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
  const files = rows.flatMap((row) => (row.type === 'file' && row.track.playable ? [row.track] : []))

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

  return (
    <Hint label="Play a random beat and go to it" side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
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
 * Hide everything that isn't audio - the common case when you're digging for a sound and
 * the library is full of project files. Shares the type filter's state, so it stays in
 * sync with the Audio entry in the menu next to it.
 */
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

function AudioOnlyToggle(): React.JSX.Element {
  const typeFilter = useLibrary((s) => s.typeFilter)
  const toggleKindFilter = useLibrary((s) => s.toggleKindFilter)
  const active = typeFilter.kinds.includes('audio')

  return (
    <Hint label={active ? 'Showing audio only' : 'Show audio files only'} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-pressed={active}
        onClick={() => toggleKindFilter('audio')}
        className={cn(active && 'bg-primary/15 text-primary')}
      >
        <AudioLines className="h-3.5 w-3.5" />
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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          title={label}
          {...drop.target}
          {...drop.handlers}
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
          disabled={!clipboard || clipboard.paths.length === 0}
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
