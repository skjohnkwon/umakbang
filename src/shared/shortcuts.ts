/**
 * The keys umakbang invented, and which of them the user may move.
 *
 * **Only the non-traditional ones are here, and that line is the whole design.** Ctrl/⌘+C,
 * X, V, A, Z, Y and the rest are not umakbang's to hand out: they are decades of muscle
 * memory that arrive with the operating system, every other application agrees about them,
 * and half of them are claimed by the application menu before the page ever sees the key
 * (see `buildMenu` in `src/main/index.ts`). Offering to rebind those would be offering to
 * break the shortcuts people did not have to learn, and to do it in a way the menu would
 * then describe wrongly.
 *
 * What is left is the set this app made up on its own - a letter for the dice, a letter for
 * tagging, a key to play - and those are exactly the ones worth moving, because they are
 * the ones that collide with whatever the user already has in their fingers from a DAW.
 *
 * A binding is a bare `KeyboardEvent.key` with no modifier, deliberately. Everything with a
 * modifier is either traditional or the menu's, so allowing a chord here would let a
 * customised key shadow something this file does not own.
 */

export type ShortcutId =
  | 'playPause'
  | 'random'
  | 'tag'
  | 'rename'
  | 'up'
  | 'trash'
  | 'clearSelection'

export interface ShortcutAction {
  id: ShortcutId
  label: string
  hint: string
  /** As `KeyboardEvent.key`. Letters are stored lower-case and matched case-insensitively. */
  defaultKey: string
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  {
    id: 'playPause',
    label: 'Play / pause',
    hint: 'Bound app-wide, so it works wherever you are.',
    defaultKey: ' '
  },
  {
    id: 'random',
    label: 'Play a random beat',
    hint: 'Picks from your own work, plays it and goes to its folder.',
    defaultKey: 'r'
  },
  { id: 'tag', label: 'Tag the selection', hint: 'Opens the tag editor on the row.', defaultKey: 't' },
  { id: 'rename', label: 'Rename', hint: 'Ctrl/⌘+Enter always works too.', defaultKey: 'F2' },
  { id: 'up', label: 'Up one level', hint: 'Leaves the folder you are in.', defaultKey: 'Backspace' },
  {
    id: 'trash',
    label: 'Delete',
    hint: 'To the Recycle Bin or Trash, never straight out.',
    defaultKey: 'Delete'
  },
  {
    id: 'clearSelection',
    label: 'Clear the selection',
    hint: 'Also closes whatever popover is open.',
    defaultKey: 'Escape'
  }
]

/**
 * Keys that cannot be taken, whatever else is free.
 *
 * The digits are the star ratings and the arrows are the transport and the list - both are
 * whole families rather than single keys, so handing one of them to something else leaves a
 * gap in the middle of a row of keys that otherwise all do the same kind of thing. `Enter`
 * opens, which is the one binding a file explorer may not surprise anybody about.
 */
const RESERVED = new Set([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'pageup',
  'pagedown',
  'home',
  'end',
  'enter',
  'tab'
])

/**
 * The parts of a press this needs.
 *
 * Stated structurally rather than as `Pick<KeyboardEvent, …>` because this file is compiled
 * by `tsconfig.node.json` as well, where there is no DOM library and `KeyboardEvent` is not
 * a name. A real event satisfies it either way.
 */
export interface ShortcutPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** One spelling of a key, so `T`, `t` and a stored `t` all compare equal. */
export function normaliseKeyName(key: string): string {
  return key.toLowerCase()
}

/** What the user actually has bound for an action, falling back to the default. */
export function shortcutKey(
  overrides: Record<string, string> | undefined,
  id: ShortcutId
): string {
  const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === id)
  if (!action) return ''
  const chosen = overrides?.[id]
  return chosen && chosen.length > 0 ? chosen : action.defaultKey
}

/**
 * Whether a press is the key bound to `id`.
 *
 * Modifiers must be clear. A user who has bound the dice to `R` still expects Ctrl+R to
 * rescan, and without this check the letter would answer to both.
 */
export function matchesShortcut(
  event: ShortcutPress,
  overrides: Record<string, string> | undefined,
  id: ShortcutId
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  return normaliseKeyName(event.key) === normaliseKeyName(shortcutKey(overrides, id))
}

/** How a key is written in a menu, a tooltip or the settings row. */
export function shortcutLabel(key: string): string {
  if (key === ' ') return 'Space'
  if (key === 'Escape') return 'Esc'
  if (key === 'Backspace') return 'Backspace'
  if (key.length === 1) return key.toUpperCase()
  return key
}

/**
 * Why a key cannot be bound, or null if it can.
 *
 * Taking a key from another action is refused rather than silently swapped: a swap leaves
 * the user with two changes when they asked for one, and the one they did not ask for is
 * the one they will not notice until it surprises them.
 */
export function shortcutConflict(
  overrides: Record<string, string> | undefined,
  id: ShortcutId,
  key: string
): string | null {
  const name = normaliseKeyName(key)
  if (!key) return 'No key pressed.'
  if (RESERVED.has(name)) {
    return `${shortcutLabel(key)} is used for ratings and moving around the list.`
  }
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === id) continue
    if (normaliseKeyName(shortcutKey(overrides, action.id)) === name) {
      return `${shortcutLabel(key)} is already ${action.label.toLowerCase()}.`
    }
  }
  return null
}
