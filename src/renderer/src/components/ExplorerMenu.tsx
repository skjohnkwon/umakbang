import type React from 'react'
import {
  AudioLines,
  ChevronRight,
  Clapperboard,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Dices,
  ExternalLink,
  FolderInput,
  FolderPlus,
  FolderSearch,
  FolderSymlink,
  ListChecks,
  PenLine,
  Pin,
  FileSignature,
  Wand2,
  Scissors,
  Split,
  Tags,
  Trash2,
  Type
} from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import type { QuickMoveTarget } from '@shared/types'
import type { Selected } from '@/lib/selection'
import { selectionLabel } from '@/lib/selection'
import { TagEditor } from '@/components/TagEditor'
import { useLibrary } from '@/state/library'
import { shortcutKey, shortcutLabel } from '@shared/shortcuts'

/**
 * Everything the explorer can do to what's selected, in one list.
 *
 * The row menus and the empty-space menu share it because they share their actions: a
 * right-click on a row acts on the selection that row is part of, and a right-click on
 * nothing acts on the folder you're standing in.
 */
export interface ExplorerActions {
  /** Enter a folder, or play a file. */
  open: () => void
  openExternally: () => void
  goToFolder: () => void
  cut: () => void
  copy: () => void
  /** Paste into a folder, given its root-relative path. */
  paste: (relDir: string) => void
  duplicate: () => void
  rename: () => void
  remove: () => void
  newFolder: (relDir: string) => void
  /** Makes a folder in `relDir` and moves the selection into it. */
  newFolderWithSelection: (relDir: string) => void
  /** Files the selection into one of the configured folders. */
  moveTo: (destination: string) => void
  /** Asks for a folder and files the selection into that. */
  moveToChosen: () => void
  editTags: () => void
  reveal: () => void
  copyPath: () => void
  copyName: () => void
  selectAll: () => void
  /** Adds the selected folders to the random button's exclude list, or takes them off. */
  toggleRandomExclude: () => void
  /** Throws away the analysed tempo and key for the selection and works them out again. */
  reprocess: () => void
  /** Sends the selection to LALAL.AI and writes the stems it sends back. */
  splitStems: () => void
  /** Renames the selection to `name_key_bpm.ext`, from what is known about each file. */
  renameWithMetadata: () => void
  /** Pins the selected folders to the top of the sidebar, or unpins them. */
  togglePinned: () => void
  /** Opens the contract draft for the selected tracks. */
  generateContract: () => void
  /** Starts a video project for the selected track. */
  makeVideo: () => void
}

export interface MenuContext {
  /** Whether the selected folders are already off the random button's list. */
  randomExcluded?: boolean
  /** Whether the selected folders are already pinned to the sidebar. */
  pinned?: boolean
  selected: Selected
  /**
   * Where Paste and New folder land: the folder that was right-clicked, or the one being
   * browsed. Null when the view isn't a folder at all - a saved view has no "here".
   */
  targetDir: string | null
  clipboardCount: number
  /** 'Show in Explorer', 'Reveal in Finder' - whatever the platform calls it. */
  revealLabel: string
  /** The folders offered under "Move to", from settings. */
  quickMove: QuickMoveTarget[]
  actions: ExplorerActions
}

function Shortcut({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="ml-auto pl-5 text-[10.5px] tracking-wide text-muted-foreground/60">
      {children}
    </span>
  )
}

/**
 * Writes a chord the way the platform writes it.
 *
 * The table's handler has always taken `metaKey` as readily as `ctrlKey`, so these shortcuts
 * work on a Mac - the menu was simply naming a key that keyboard does not have, which is the
 * worst of both, since the hint is what a first-time user trusts. Mac chords are set closed
 * up (⌘⇧N) and Windows ones spaced (Ctrl ⇧ N), matching what each platform's own menus print.
 *
 * A subscription per open menu, not per row: this component mounts when a right-click opens
 * it and unmounts when it closes.
 */
function useIsMac(): boolean {
  return useLibrary((s) => s.platform?.isMac ?? false)
}

function useChord(): (...keys: string[]) => string {
  const isMac = useIsMac()
  return (...keys) => [isMac ? '⌘' : 'Ctrl', ...keys].join(isMac ? '' : ' ')
}

/**
 * What Rename answers to on this keyboard.
 *
 * The table binds both, so this is only which one to print. `F2` is the Windows answer and
 * stays the Windows hint; on a MacBook it needs `fn` held, and Return - what Finder renames
 * with - is already open/play here, so naming `F2` to a Mac user was naming the one key that
 * costs them two. `⌘↩` is what that keyboard can reach.
 */
function useRenameKey(): string {
  const bound = useLibrary((s) => shortcutKey(s.settings.shortcuts, 'rename'))
  // The Mac hint names the chord that keyboard can actually reach, and that one is fixed -
  // so it wins over a rebinding, which only ever moves the other key.
  if (useIsMac()) return '⌘↩'
  return shortcutLabel(bound)
}

/** Whatever the user has Delete bound to, so the menu cannot name a key that does nothing. */
function useTrashKey(): string {
  return shortcutLabel(useLibrary((s) => shortcutKey(s.settings.shortcuts, 'trash')))
}

/** The full menu for a row, acting on the whole selection it belongs to. */
export function SelectionMenuItems({ context }: { context: MenuContext }): React.JSX.Element {
  const { selected, targetDir, clipboardCount, revealLabel, quickMove, actions } = context
  const chord = useChord()
  const renameKey = useRenameKey()
  const trashKey = useTrashKey()
  const randomExcluded = context.randomExcluded ?? false
  const pinned = context.pinned ?? false
  const playableCount = selected.tracks.filter((track) => track.playable).length
  // Only files that have something to put in the name.
  const taggableCount = selected.tracks.filter(
    (track) => track.bpm !== undefined || track.musicalKey !== undefined
  ).length
  const only = selected.only
  const single = only !== null
  const file = selected.tracks[0]
  const singleFile = single && !only.directory && selected.tracks.length === 1
  const playable = singleFile && file?.playable === true

  return (
    <>
      <ContextMenuLabel>{selectionLabel(selected)}</ContextMenuLabel>
      <ContextMenuSeparator />

      {single && only.directory ? (
        <ContextMenuItem onSelect={actions.open}>
          <FolderInput className="h-3.5 w-3.5" />
          Open folder
        </ContextMenuItem>
      ) : (
        <ContextMenuItem disabled={!playable} onSelect={actions.open}>
          <AudioLines className="h-3.5 w-3.5" />
          Play
        </ContextMenuItem>
      )}
      {singleFile && (
        <ContextMenuItem onSelect={actions.openExternally}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open in default app
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />
      <ContextMenuItem onSelect={actions.cut}>
        <Scissors className="h-3.5 w-3.5" />
        Cut
        <Shortcut>{chord('X')}</Shortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.copy}>
        <Copy className="h-3.5 w-3.5" />
        Copy
        <Shortcut>{chord('C')}</Shortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={clipboardCount === 0 || targetDir === null}
        onSelect={() => targetDir !== null && actions.paste(targetDir)}
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        {/* Says where it lands, because a right-click on a folder pastes *into* it. */}
        {single && only.directory ? 'Paste into folder' : 'Paste'}
        <Shortcut>{chord('V')}</Shortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.duplicate}>
        <CopyPlus className="h-3.5 w-3.5" />
        Duplicate
        <Shortcut>{chord('D')}</Shortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem disabled={!single} onSelect={actions.rename}>
        <PenLine className="h-3.5 w-3.5" />
        Rename…
        <Shortcut>{renameKey}</Shortcut>
      </ContextMenuItem>
      {taggableCount > 0 && (
        <ContextMenuItem onSelect={actions.renameWithMetadata}>
          <Type className="h-3.5 w-3.5" />
          {taggableCount === 1 ? 'Rename with key and BPM' : `Rename ${taggableCount} with key and BPM`}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={actions.remove}>
        <Trash2 className="h-3.5 w-3.5" />
        Delete
        <Shortcut>{trashKey}</Shortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={targetDir === null}
        onSelect={() => targetDir !== null && actions.newFolder(targetDir)}
      >
        <FolderPlus className="h-3.5 w-3.5" />
        New folder…
      </ContextMenuItem>
      {/* Gathering what is already selected, which is the way a folder usually comes to be
          wanted: you find the three takes of one beat and then need somewhere to put them.
          Doing it by hand is make the folder, lose the selection, find the files again. */}
      <ContextMenuItem
        disabled={targetDir === null}
        onSelect={() => targetDir !== null && actions.newFolderWithSelection(targetDir)}
      >
        <FolderSymlink className="h-3.5 w-3.5" />
        {selected.paths.length === 1
          ? 'New folder with this item…'
          : `New folder with ${selected.paths.length.toLocaleString()} items…`}
      </ContextMenuItem>
      {/* The folders you file into most, from settings - the common case is two clicks
          rather than a drag across the whole tree. */}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <FolderInput className="h-3.5 w-3.5" />
          Move to
          <ChevronRight className="ml-auto h-3.5 w-3.5 pl-1 text-muted-foreground" />
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-h-[60vh] max-w-[22rem] overflow-y-auto">
          {quickMove.length === 0 ? (
            <ContextMenuItem disabled>No folders set up yet - see Settings</ContextMenuItem>
          ) : (
            quickMove.map((target) => (
              <ContextMenuItem
                key={target.path}
                title={target.path}
                onSelect={() => actions.moveTo(target.path)}
              >
                <FolderInput className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{target.label}</span>
              </ContextMenuItem>
            ))
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={actions.moveToChosen}>
            <FolderSearch className="h-3.5 w-3.5" />
            Choose folder…
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {/* The one action that sends a file off the machine, and it costs money per audio
          minute - so it asks before it goes. */}
      {playableCount > 0 && (
        <ContextMenuItem onSelect={actions.splitStems}>
          <Split className="h-3.5 w-3.5" />
          {playableCount === 1 ? 'Split vocals…' : `Split vocals from ${playableCount} files…`}
        </ContextMenuItem>
      )}

      {/* Per file, rather than the toolbar button's whole-view sweep: most of the time it
          is one track whose reading you doubt. */}
      {playableCount > 0 && (
        <ContextMenuItem onSelect={actions.reprocess}>
          <Wand2 className="h-3.5 w-3.5" />
          {playableCount === 1 ? 'Reprocess tempo and key' : `Reprocess ${playableCount} files`}
        </ContextMenuItem>
      )}

      {/* Same reasoning as the contract below it: a reel is something you make *of* a
          finished beat, so it starts where the beat is rather than on a page you have to
          go and find the file from again. One track, because a video is of one thing. */}
      {playable && (
        <ContextMenuItem onSelect={actions.makeVideo}>
          <Clapperboard className="h-3.5 w-3.5" />
          Make video…
        </ContextMenuItem>
      )}

      {/* A track is something you sell, so the paperwork starts where the track is. */}
      {selected.tracks.length > 0 && (
        <ContextMenuItem onSelect={actions.generateContract}>
          <FileSignature className="h-3.5 w-3.5" />
          {selected.tracks.length === 1
            ? 'Generate contract'
            : `Generate contract for ${selected.tracks.length} tracks`}
        </ContextMenuItem>
      )}

      {selected.dirs.length > 0 && (
        <ContextMenuItem onSelect={actions.togglePinned}>
          <Pin className="h-3.5 w-3.5" />
          {pinned ? 'Unpin from quick access' : 'Pin to quick access'}
        </ContextMenuItem>
      )}

      {/* Only for folders: the exclusion is a folder and everything beneath it. */}
      {selected.dirs.length > 0 && (
        <ContextMenuItem onSelect={actions.toggleRandomExclude}>
          <Dices className="h-3.5 w-3.5" />
          {randomExcluded ? 'Include in random again' : 'Never pick at random'}
        </ContextMenuItem>
      )}

      {/* Folders take tags too, and the tag on a folder is what decides whether the
          files under it get their tempo and key analysed. */}
      {/* Tags open as a panel beside the menu rather than a popover somewhere else on
          screen: they are a property of what you right-clicked, so they belong next to it. */}
      {selected.count > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Tags className="h-3.5 w-3.5" />
            {selected.count === 1
              ? 'Tags'
              : `Tag ${selected.count} ${selected.tracks.length === 0 ? 'folders' : 'items'}`}
            <ChevronRight className="ml-auto h-3.5 w-3.5 pl-1 text-muted-foreground" />
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-72 p-2">
            <TagEditor
              paths={selected.paths}
              label={selectionLabel(selected)}
              onClose={() => undefined}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      <ContextMenuSeparator />
      {singleFile && (
        <ContextMenuItem onSelect={actions.goToFolder}>
          <FolderInput className="h-3.5 w-3.5" />
          Go to folder
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={actions.reveal}>
        <ExternalLink className="h-3.5 w-3.5" />
        {revealLabel}
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.copyPath}>
        <Copy className="h-3.5 w-3.5" />
        {single ? 'Copy full path' : 'Copy full paths'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.copyName}>
        <Type className="h-3.5 w-3.5" />
        {single ? 'Copy name' : 'Copy names'}
      </ContextMenuItem>
    </>
  )
}

/** The shorter menu for empty space, which acts on the folder rather than on rows. */
export function FolderMenuItems({
  context,
  label
}: {
  context: MenuContext
  label: string
}): React.JSX.Element {
  const { targetDir, clipboardCount, revealLabel, actions } = context
  const chord = useChord()

  return (
    <>
      <ContextMenuLabel>{label}</ContextMenuLabel>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={clipboardCount === 0 || targetDir === null}
        onSelect={() => targetDir !== null && actions.paste(targetDir)}
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        Paste
        <Shortcut>{chord('V')}</Shortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={targetDir === null}
        onSelect={() => targetDir !== null && actions.newFolder(targetDir)}
      >
        <FolderPlus className="h-3.5 w-3.5" />
        New folder…
        <Shortcut>{chord('⇧', 'N')}</Shortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem onSelect={actions.selectAll}>
        <ListChecks className="h-3.5 w-3.5" />
        Select all
        <Shortcut>{chord('A')}</Shortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem disabled={targetDir === null} onSelect={actions.reveal}>
        <ExternalLink className="h-3.5 w-3.5" />
        {revealLabel}
      </ContextMenuItem>
      <ContextMenuItem disabled={targetDir === null} onSelect={actions.copyPath}>
        <Copy className="h-3.5 w-3.5" />
        Copy full path
      </ContextMenuItem>
    </>
  )
}
