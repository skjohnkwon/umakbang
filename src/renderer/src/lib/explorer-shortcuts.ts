/**
 * The explorer's clipboard and rating keys, reachable from outside the table.
 *
 * Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+A and Ctrl+D were bound on `FileTable`'s scroll container,
 * which is the only element that knows what is selected - and so they were also the only
 * keys in the app that stopped working the moment anything else had focus. Measured with a
 * real keystroke rather than a synthetic one: with focus on `<body>`, Ctrl+C did nothing at
 * all, where the same key with the table focused copied. `<body>` is not an unusual place
 * for focus to be - it is where it sits after a click on the toolbar, the sidebar, a
 * breadcrumb or a visualizer panel, and where it starts on every launch until a row is
 * clicked.
 *
 * Ctrl+Z never had the problem because `App` binds it on `window`, which is the shape this
 * restores for the rest of them.
 *
 * The rating digits are here for the same reason and it bit harder, because rating does not
 * need the table at all: `1`-`5` rate **what is playing**, and what is playing has nothing to
 * do with what has focus. Reported as "the number keys only work when a row is selected",
 * which is the symptom of needing to click into the table first - selection was never the
 * condition, focus was.
 *
 * The handler is registered here rather than reimplemented in `App`, because "which files
 * does Ctrl+C mean" is a question only the table can answer - it holds the selection, the
 * folder being browsed and the actions the context menu shares. Two copies of that would
 * disagree the first time either was touched. The table still calls it first from its own
 * `onKeyDown`, so nothing changes while the table has focus; `App` calls it for every other
 * case, and `defaultPrevented` keeps the two from both firing on one press.
 */

/**
 * The parts of a key press this needs, so one handler serves both a React
 * `KeyboardEvent` from the table and a native one from `window`.
 */
export interface ShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  preventDefault: () => void
}

/** True when the press was one of ours and has been dealt with. */
export type ShortcutHandler = (event: ShortcutEvent) => boolean

let handler: ShortcutHandler | null = null

/**
 * Published by the mounted explorer table. Null while there is none - the settings page and
 * the stats page are both whole-window views with no selection to act on.
 */
export function setExplorerShortcuts(next: ShortcutHandler | null): void {
  handler = next
}

/** Runs the explorer's keys for a press that reached the window. */
export function runExplorerShortcut(event: ShortcutEvent): boolean {
  return handler ? handler(event) : false
}
