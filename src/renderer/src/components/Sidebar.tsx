import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  BarChart3,
  ChevronRight,
  Download,
  FileSignature,
  Folder,
  FolderOpen,
  Library,
  LocateFixed,
  Pin,
  Plus,
  Star,
  X
} from 'lucide-react'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { Hint } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { TagBar } from '@/components/TagBar'
import { useFolderTree, type FolderNode } from '@/hooks/useLibraryView'
import { useFolderDrop, type FolderDrop } from '@/hooks/useFolderDrop'
import { collapseVariants } from '@/lib/motion'
import { relativePath, samePath } from '@/lib/paths'
import { removePinned } from '@/lib/quick-access'
import { maxPanelWidth, useWindowWidth } from '@/lib/layout'
import { cn } from '@/lib/utils'

const MIN_WIDTH = 150
const DEFAULT_WIDTH = 220

export function Sidebar(): React.JSX.Element {
  const { root: tree } = useFolderTree()
  const view = useLibrary((s) => s.view)
  const setView = useLibrary((s) => s.setView)
  const ratings = useLibrary((s) => s.ratings)
  const totalCount = useLibrary((s) => s.tracks.length)
  const lastFolderDir = useLibrary((s) => s.lastFolderDir)
  const downloads = useLibrary((s) => s.downloads)
  const refreshDownloads = useLibrary((s) => s.refreshDownloads)
  const playing = usePlayer((s) => s.current)

  // Counts per star, so the sidebar shows how much sits at each level.
  const { ratingCounts, ratedTotal } = useMemo(() => {
    const counts: Record<number, number> = {}
    let total = 0
    for (const value of Object.values(ratings)) {
      counts[value] = (counts[value] ?? 0) + 1
      total++
    }
    return { ratingCounts: counts, ratedTotal: total }
  }, [ratings])
  const savedWidth = useLibrary((s) => s.settings.sidebarWidth)
  const panelOpen = useLibrary((s) => s.settings.panelOpen)
  const panelWidth = useLibrary((s) => s.settings.panelWidth)
  const patchSettings = useLibrary((s) => s.patchSettings)

  // Everything the visualizer dock and the table need is what the sidebar can't have.
  const maxWidth = maxPanelWidth(MIN_WIDTH, useWindowWidth(), panelOpen ? panelWidth : 0)
  const maxRef = useRef(maxWidth)
  maxRef.current = maxWidth

  // Width tracks the pointer locally and is only persisted on release, so a drag doesn't
  // fire an IPC round-trip per frame.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragWidthRef = useRef<number | null>(null)
  dragWidthRef.current = dragWidth
  const savedWidthRef = useRef(savedWidth)
  savedWidthRef.current = savedWidth
  // Clamped on the way out too: a width that was legal when it was dragged has to give
  // way when the window shrinks under it, or the handle below ends up off-screen with
  // nothing able to reach it.
  const width = Math.min(dragWidth ?? savedWidth, maxWidth)
  const dragging = dragWidth !== null

  const beginResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = Math.min(savedWidthRef.current, maxRef.current)

      const onMove = (move: PointerEvent): void => {
        setDragWidth(
          Math.max(
            MIN_WIDTH,
            Math.min(maxRef.current, Math.round(startWidth + (move.clientX - startX)))
          )
        )
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        const settled = dragWidthRef.current
        setDragWidth(null)
        if (settled !== null) patchSettings({ sidebarWidth: settled })
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [patchSettings]
  )

  // Top-level folders start open so the library isn't a single collapsed row.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))

  /**
   * Opens the tree at the folder the playing track is in.
   *
   * The transport's own locate button goes to the *file* - it selects the row and scrolls
   * the explorer to it. This one is about the tree: every ancestor is unfolded so you can
   * see where the track sits in the library, which a jump to the file alone never shows.
   */
  const revealPlayingFolder = useCallback(() => {
    const track = usePlayer.getState().current
    if (!track) return
    setExpanded((current) => {
      const next = new Set(current)
      next.add('')
      let accumulated = ''
      for (const segment of track.relDir.split('/')) {
        if (!segment) continue
        accumulated = accumulated ? `${accumulated}/${segment}` : segment
        next.add(accumulated)
      }
      return next
    })
    setView({ mode: 'folder', dir: track.relDir })
  }, [setView])

  const toggle = (path: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="relative flex shrink-0 flex-col border-r" style={{ width }}>
      {/* Every row below carries its own height, so each one needs `shrink-0`: a flex
          column squashes its children to fit before it will let them overflow, and a
          squashed tree is one that silently refuses to scroll. */}
      <nav className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto bg-card/40 py-1.5">
      {/* Above the library rather than inside it: it is a page about the work, not another
          way of listing files, and sitting under the saved views it read as one. */}
      <SidebarRow
        icon={<BarChart3 className="h-3.5 w-3.5" />}
        label="Stats"
        count={0}
        active={view.mode === 'stats'}
        depth={0}
        onClick={() => setView({ mode: 'stats' })}
      />
      <SidebarRow
        icon={<FileSignature className="h-3.5 w-3.5" />}
        label="Contracts"
        count={0}
        active={view.mode === 'contracts'}
        depth={0}
        onClick={() => setView({ mode: 'contracts' })}
      />

      <SectionLabel>Library</SectionLabel>

      {/* Returns to browsing at the folder you left, rather than dumping every file in
          one flat list. */}
      <SidebarRow
        icon={<Library className="h-3.5 w-3.5" />}
        label="Files"
        count={totalCount}
        active={view.mode === 'folder'}
        depth={0}
        onClick={() => setView({ mode: 'folder', dir: lastFolderDir })}
      />
      <SidebarRow
        icon={<Star className={cn('h-3.5 w-3.5', ratedTotal > 0 && 'fill-current')} />}
        label="Rated"
        count={ratedTotal}
        active={view.mode === 'rated' && view.min === 1 && view.max === 5}
        depth={0}
        onClick={() => setView({ mode: 'rated', min: 1, max: 5 })}
      />
      {/* One row per star, so a single rating is one click; the toolbar covers ranges. */}
      {[5, 4, 3, 2, 1].map((stars) => (
        <SidebarRow
          key={stars}
          icon={<Star className="h-3.5 w-3.5 fill-current text-amber-400" />}
          label={'\u2605'.repeat(stars)}
          count={ratingCounts[stars] ?? 0}
          active={view.mode === 'rated' && view.min === stars && view.max === stars}
          depth={1}
          onClick={() => setView({ mode: 'rated', min: stars, max: stars })}
        />
      ))}

      <SidebarRow
        icon={<Download className="h-3.5 w-3.5" />}
        label="Downloads"
        count={downloads.length}
        active={view.mode === 'downloads'}
        depth={0}
        onClick={() => {
          void refreshDownloads()
          setView({ mode: 'downloads' })
        }}
      />


      {/* Under the saved views and above the tree: the folders you actually work in,
          reachable without scrolling a tree that runs to thousands of rows. Absent
          entirely when nothing is pinned, so it costs nothing until it's used. */}
      <QuickAccess />

      {/* Between the saved views and the tree: tags narrow whatever you're already
          looking at, so they belong with the other ways of choosing what to look at
          rather than stranded under a folder list that can run for thousands of rows. */}
      <TagBar />

      <SectionLabel
        className="mt-3"
        action={
          <span className="flex items-center gap-0.5">
            <LocatePlayingButton onLocate={revealPlayingFolder} enabled={playing !== null} />
            <AddFolderButton />
          </span>
        }
      >
        Folders
      </SectionLabel>
      <FolderRows
        node={tree}
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        isRoot
      />

      </nav>


      {/* Straddles the border; double-click restores the default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={beginResize}
        onDoubleClick={() => patchSettings({ sidebarWidth: DEFAULT_WIDTH })}
        className="group absolute -right-[5px] top-0 z-30 flex h-full w-[11px] cursor-col-resize items-center justify-center"
      >
        <span
          className={cn(
            'absolute top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full transition-colors',
            dragging ? 'bg-primary' : 'bg-border group-hover:bg-primary'
          )}
        />
      </div>
    </div>
  )
}

function SectionLabel({
  children,
  className,
  action
}: {
  children: React.ReactNode
  className?: string
  /** Something small on the right of the heading - an add button, a clear button. */
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70',
        className
      )}
    >
      <span className="truncate">{children}</span>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  )
}

/**
 * A right-click menu, but only for the library's own folders.
 *
 * Every other row in the tree is an ordinary folder and already answers to the menu in the
 * explorer. These are the only ones that can be *removed*, and offering that on a
 * subfolder would read as "delete", which it emphatically is not.
 */
function MaybeMenu({
  label,
  children
}: {
  label: string | null
  children: React.ReactNode
}): React.JSX.Element {
  if (!label) return <>{children}</>
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="truncate">{label}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => void window.umakbang.removeLibraryFolder(label)}>
          <X className="h-3.5 w-3.5" />
          Remove from library
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Jumps the tree to wherever the playing track lives. */
function LocatePlayingButton({
  onLocate,
  enabled
}: {
  onLocate: () => void
  enabled: boolean
}): React.JSX.Element {
  return (
    <Hint label={enabled ? "Go to the playing track's folder" : 'Nothing playing'} side="right">
      <button
        type="button"
        aria-label="Go to the playing folder"
        disabled={!enabled}
        onClick={onLocate}
        className="flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <LocateFixed className="h-3 w-3" />
      </button>
    </Hint>
  )
}

/**
 * Adds another folder to the library.
 *
 * The library is any number of folders rather than one, which is what a sample collection
 * actually looks like: kits on one drive, bounces on another, a project folder somewhere
 * else again. Each one becomes a top-level entry in the tree and keeps its own saved
 * index, so adding one doesn't cost a rescan of the others.
 */
function AddFolderButton(): React.JSX.Element {
  return (
    <Hint label="Add a folder to the library" side="right">
      <button
        type="button"
        aria-label="Add a folder to the library"
        onClick={() => void window.umakbang.addLibraryFolder()}
        className="flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
      </button>
    </Hint>
  )
}

function FolderRows({
  node,
  depth,
  expanded,
  onToggle,
  isRoot = false
}: {
  node: FolderNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  isRoot?: boolean
}): React.JSX.Element {
  const view = useLibrary((s) => s.view)
  const setView = useLibrary((s) => s.setView)
  const isOpen = expanded.has(node.path)
  const isActive = view.mode === 'folder' && view.dir === node.path
  // The virtual root above every library folder has no name of its own.
  const label = isRoot ? 'Library' : node.name
  const drop = useFolderDrop(node.path)

  // A top-level node is one of the library's own folders: one segment, and not the
  // virtual root above them all. Only those can be removed from the library.
  const isLibraryFolder = node.path !== '' && !node.path.includes('/')

  return (
    <>
      <MaybeMenu label={isLibraryFolder ? node.name : null}>
      <SidebarRow
        drop={drop}
        icon={
          isOpen ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />
        }
        label={label}
        count={node.totalCount}
        depth={depth}
        active={isActive}
        chevron={
          node.children.length > 0 ? (
            <ChevronRight
              className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')}
            />
          ) : null
        }
        onChevronClick={() => onToggle(node.path)}
        onClick={() => {
          // Clicking a folder always browses it, and works the disclosure the way the
          // chevron would: open one you're stepping into, fold away one you're done with.
          // Clicking the folder you're already in is how you collapse it.
          if (node.children.length > 0 && (!isOpen || isActive)) onToggle(node.path)
          setView({ mode: 'folder', dir: node.path })
        }}
      />
      </MaybeMenu>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="children"
            variants={collapseVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="shrink-0 overflow-hidden"
          >
            {node.children.map((child) => (
              <FolderRows
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/**
 * The folders you keep coming back to.
 *
 * The same list the row menu files things into - see `lib/quick-access.ts`. Deliberately
 * not a second tree: these are destinations, not a structure to explore, and the point of
 * them is that one click gets you there. Library ones accept drops like any folder row,
 * which is most of why they earn the space.
 */
function QuickAccess(): React.JSX.Element | null {
  const pinned = useLibrary((s) => s.settings.quickMove)
  const roots = useLibrary((s) => s.roots)
  const view = useLibrary((s) => s.view)
  const setView = useLibrary((s) => s.setView)
  const patchSettings = useLibrary((s) => s.patchSettings)

  if (pinned.length === 0) return null

  return (
    <>
      <SectionLabel className="mt-3">Quick access</SectionLabel>
      {pinned.map((target) => {
        // Null for a folder outside the library - a filing destination on another drive.
        // It still belongs in the list; it just can't be browsed to.
        const rel = relativePath(roots, target.path)
        return (
          <PinnedRow
            key={target.path}
            label={target.label}
            path={target.path}
            dir={rel}
            active={rel !== null && view.mode === 'folder' && samePath(view.dir, rel)}
            onOpen={() => {
              if (rel !== null) setView({ mode: 'folder', dir: rel })
              else void window.umakbang.reveal(target.path)
            }}
            onUnpin={() =>
              patchSettings({ quickMove: removePinned(pinned, [target.path]) })
            }
          />
        )
      })}
    </>
  )
}

function PinnedRow({
  label,
  path,
  dir,
  active,
  onOpen,
  onUnpin
}: {
  label: string
  /** Absolute path, for the tooltip and for opening one that sits outside the library. */
  path: string
  /** Its library-relative path, or null when it lives outside the library. */
  dir: string | null
  active: boolean
  onOpen: () => void
  onUnpin: () => void
}): React.JSX.Element {
  const drop = useFolderDrop(dir ?? '')

  return (
    <div
      {...(dir === null ? {} : drop.target)}
      {...(dir === null ? {} : drop.handlers)}
      className={cn(
        'group flex h-[24px] w-full shrink-0 items-center gap-1 pl-[6px] pr-1 text-[12.5px] transition-colors',
        active
          ? 'bg-primary/12 text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        drop.over && 'bg-primary/25 text-foreground ring-1 ring-inset ring-primary'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        title={path}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        <span className="w-3 shrink-0" />
        <Pin
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            active ? 'text-primary' : 'text-muted-foreground/80'
          )}
        />
        <span className="truncate">{label}</span>
      </button>
      {/* Unpinning from the row it undoes, rather than making you find the folder in the
          tree again to reach its menu. Hidden until the row is under the pointer so the
          list stays quiet. */}
      <button
        type="button"
        title="Unpin"
        onClick={onUnpin}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

function SidebarRow({
  icon,
  label,
  count,
  active,
  depth,
  chevron,
  onClick,
  onChevronClick,
  drop
}: {
  icon: React.ReactNode
  label: string
  count: number
  active?: boolean
  depth: number
  chevron?: React.ReactNode
  onClick: () => void
  onChevronClick?: () => void
  /** Folder rows accept files dropped onto them; the shortcuts above don't. */
  drop?: FolderDrop
}): React.JSX.Element {
  // Cap the indent so deeply nested sample packs don't push labels off the edge.
  const indent = useMemo(() => 6 + Math.min(depth, 6) * 11, [depth])

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      {...drop?.target}
      {...drop?.handlers}
      className={cn(
        'group flex h-[24px] w-full shrink-0 items-center gap-1 pr-2 text-left text-[12.5px] transition-colors',
        active
          ? 'bg-primary/12 text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        drop?.over && 'bg-primary/25 text-foreground ring-1 ring-inset ring-primary'
      )}
      style={{ paddingLeft: indent }}
    >
      <span
        className="flex h-3.5 w-3 shrink-0 items-center justify-center text-muted-foreground/70"
        onClick={(event) => {
          if (!onChevronClick) return
          event.stopPropagation()
          onChevronClick()
        }}
      >
        {chevron}
      </span>
      <span className={cn('shrink-0', active ? 'text-primary' : 'text-muted-foreground/80')}>
        {icon}
      </span>
      <span className="truncate">{label}</span>
      <span className="tnum ml-auto shrink-0 pl-1 text-[10.5px] text-muted-foreground/60">
        {count > 0 ? count : ''}
      </span>
    </button>
  )
}
