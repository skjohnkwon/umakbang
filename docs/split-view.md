# Two folders at once

Scope for the split explorer, written against 0.3.2. **Built**, all four phases. Where the
build parted from this scope, and why:

- **The store's own fields are the active pane, not the main pane.** The other pane is
  parked in `parked`, and `activatePane` swaps the two. This turned out to be the cheaper
  version of "keep today's fields": no action needed to become pane-aware, because the pane
  you are working in *is* the store's fields, and every window-level key (Delete, Alt+Left,
  the clipboard chords) follows `activePane` for free. Rendering reads through
  `usePaneValue` (`state/pane.ts`). Pages (Stats, Settings, Videos...) always activate the
  main pane first, so a page can never land in the second half's history.
- **Activation is a capture-phase handler on the pane container** (pointer, key, focus,
  context menu), so it runs before any row or button underneath reads the store. The pane
  you work in is marked with a line across the top of its strip.
- **Dragging is not HTML5 any more.** Row drags are pointer-tracked (`lib/drag.ts`) and find
  targets by `data-drop-dir`, so the pane-level target is that attribute on the pane, with
  `data-pane` beside it. `closest()` finds a folder row before the pane, so the two are never
  lit together, and the pane the drag started in is refused outright. Only while split.
- **Undo and redo went up into the title bar** with the rest of the global cluster: it is
  one stack, and two buttons for it would look like two.
- **Decisions taken:** the split is not restored at launch (a mode you step into, like
  visualizers-only), the divider ratio is remembered for the session only, search stays
  centred, and the split is held, not closed, while a page is up.

## What it is

Right-click a folder and pick **Open in second window**. The explorer splits in two, each
half a real explorer: its own folder, its own back and forward, its own up and refresh and
new folder, its own selection. Drag a file from one into the other to move it there. The
divider between them is draggable and starts at half.

## What it is not

- **Not a second OS window.** One `BrowserWindow`, split down the middle. A second window
  would need its own renderer, its own copy of a 326,000-row index and its own 187MB of it,
  and the two would have to agree about tags and selection over IPC. The split is a layout.
- **Not two libraries.** Both panes read the same `tracks` array, the same tags, the same
  ratings. Only *where each one is standing* differs.
- **Not a second search.** Search, the type filter and the tag filter stay global, which is
  what moving them into the title bar says out loud. See the toolbar split below.

## What is per pane, and what is not

Traced rather than assumed. `FileTable` subscribes to the store 28 times, and only six of
those are about where this pane is standing:

| Per pane | Shared |
| --- | --- |
| `view`, `history`, `historyIndex` | `tracks`, `revision`, `tags`, `ratings`, `notes` |
| `selection`, `selectedPath`, the shift anchor | `query`, `typeFilter`, `tagFilter`, `recursive` |
| `revealNonce` | `settings`, `roots`, `clipboard`, `platform`, `unreachable` |

Sort comes free. `useSort` already answers per folder through `Settings.folderSort`, keyed by
root-relative path, so two panes in two folders sort differently the moment `useSort` reads
the right pane's `view` instead of the store's.

`lastFolderDir`, and the `patchSettings({ lastDir, lastViewMode })` inside `showView`, belong
to the **main pane only**. The second pane must not write them, or closing the app in a split
reopens the main pane standing where the second one was.

## The shape

```ts
export interface PaneState {
  view: ViewMode
  history: HistoryEntry[]
  historyIndex: number
  selection: Set<string>
  selectedPath: string | null
  revealNonce: number
}
```

The store keeps today's fields as the main pane rather than moving them into a `panes` array.
That is deliberate: there are hundreds of call sites reading `s.view` and `s.selection`, and
a rename touches every one of them for no change in behaviour. What is added is
`second: PaneState | null`, `activePane: 'main' | 'second'`, and pane-aware actions that the
existing ones delegate to with `'main'`. A closed second pane is `null` rather than an empty
pane, so nothing has to ask whether it is showing.

**`PaneContext`, not a prop.** `FileTable` is 2,485 lines and its pane-specific reads are
scattered through it. A context with `usePaneView()`, `usePaneSelection()` and the rest means
about ten edited sites rather than threading a prop through every component in between. It
also lets `useVisibleRows` and `useSort` resolve the right pane without a new argument, which
matters because `App` is not their only caller.

## The toolbar has to be cut in two first

This is what the request is really about, and the cut is not where the current layout
suggests. Everything lives in one flat row today, and **position does not predict ownership**:
New folder and Refresh folder sit among the global buttons and are per-pane actions.

- **Per pane, duplicated into each half:** back, forward, up, refresh, new folder, the
  breadcrumb, and the `2 folders - 0 files` count.
- **Global, moved up into the title bar:** the dice, auto-advance, play-on-select, audio-only,
  show-every-file, recalculate tempo and key, the type filter and the column picker.

The job indicators (a stem split, a YT2MP3 download, a copy from a peer) are global and belong
beside the global cluster, not duplicated into both halves where one download would draw two
spinners.

The title bar currently holds the logo, search, the About mark and the window actions, so the
cluster has to fit beside a search field that is already centred. Worth deciding whether
search stays centred or moves left.

## Dragging between the panes

`lib/drag.ts` decides at `dragstart` which kind of drag this is, and that decision must not be
revisited: a plain drag is HTML5, and an Alt-drag calls `preventDefault()` and hands off to
`webContents.startDrag`. Starting the second kind mid-drag crashed the browser process, with a
minidump naming the nested `DoDragDrop` message loop. A cross-pane drag is the HTML5 kind,
which umakbang's own folder rows already accept, so nothing new starts there.

Two drop targets with two different answers, which is what the request asks for:

- **Over a folder row:** the row highlights, and dropping moves into that folder. This is the
  existing folder-row drop target, and the second pane gets it for nothing.
- **Over the pane's empty space or its background:** the pane dims under a translucent sheet
  with a move cursor, and dropping moves into *that pane's current folder*. This is the new
  one, and it is the one the feature exists for: the point of a split is to drop into the
  folder the other half is already standing in without having to aim at a row.

The two must never both be lit. The row target wins while the pointer is over a row, so the
pane-level target listens on the pane container and the row handler stops propagation, the
same way `isRowControl` already stops a press on a tag chip reaching the row.

A drop into the pane's own folder is a no-op and should be refused rather than performed, or
dragging within one pane quietly rewrites every selected file's mtime for nothing.

## The folder watch is one folder today

`watchFolder(dir)` in `src/main/index.ts` holds a single `folderWatcher` and a single
`watchedDir`, and `App.tsx` tells it where the explorer is standing. With two panes there are
two folders worth watching, and a pane whose folder is not watched is a pane where a bounce
never appears.

Smallest honest change: `watchFolder(dirs: string[])` holding a small map, with the same 600ms
debounce per folder and the same `refreshFolder(dir, false, 'new')` per fire. Two is the cap
in practice, and the note about never watching a subtree still stands for both.

## What each phase is worth on its own

1. **The split, read-only.** `PaneState`, `PaneContext`, the pane-aware hooks, the layout with
   a draggable divider, and the second pane rendering a `FileTable` it can navigate. No
   dragging between them yet. This is already the useful half: two folders on screen at once.
2. **The toolbar cut.** Per-pane nav strip, global cluster into the title bar. Phase 1 can
   ship with the second pane carrying a breadcrumb and nothing else, so this is separable.
3. **Dragging across.** The pane-level drop target, the two hover affordances, and the refusal
   of a drop into the pane's own folder.
4. **The second watch**, so the second pane updates when something writes into its folder.

Roughly a day for 1, half a day for 2, half for 3, an hour for 4.

## Decisions worth taking before any of it

- **Which pane do the keyboard shortcuts act on?** Space, the arrows and the dice are bound
  once in `App.tsx`; ratings and Delete are bound on the table's scroll container. The table
  bindings follow focus already. The `App` ones need `activePane`, set on pointer-down
  anywhere in a pane. Getting this wrong means Delete acting on the half you are not looking
  at, which is the worst outcome available here.
- **Does the split survive a restart?** `Settings.lastDir` restores the main pane, and a
  `secondDir` beside it with a `splitRatio` would restore the pair. Against: a split is
  arguably something you step into for a task, the way visualizers-only is, and that one is
  deliberately forgotten at launch for exactly that reason.
- **What happens when the view leaves the explorer?** Stats, Settings and Videos replace the
  whole `<main>`. Simplest is that the split belongs to the folder view and is still there
  when you come back, which costs nothing because the pane state is only being held.
