/**
 * The icons the operating system itself shows for these files - FL Studio's logo on a
 * `.flp`, whatever is registered for `.wav` - cached per extension.
 *
 * Asking the shell is a real call, so it happens once per extension rather than once per
 * file: Windows resolves the icon from the association, and a library has a few dozen
 * extensions against a few hundred thousand files.
 *
 * Deliberately not a store. Rows are pure props by design - per-row subscriptions were
 * once the bulk of the scroll cost - so the table subscribes once and hands each row the
 * icon it resolved.
 */

import { useSyncExternalStore } from 'react'

/** Extension -> data URL, or null when the OS offered nothing. */
const icons = new Map<string, string | null>()
const asked = new Set<string>()
const listeners = new Set<() => void>()
let revision = 0

function publish(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** The icon for a key: a data URL, null if there isn't one, undefined if not asked yet. */
export function fileIcon(key: string): string | null | undefined {
  return icons.get(key)
}

/**
 * Fetches the icon for a key, once. `path` is any real file with that extension - the
 * association is what's being looked up, not that particular file.
 */
export function requestFileIcon(key: string, path: string): void {
  if (asked.has(key) || !key) return
  asked.add(key)
  void window.umakbang.fileIcon(path).then(
    (icon) => {
      icons.set(key, icon)
      publish()
    },
    () => {
      icons.set(key, null)
      publish()
    }
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): number => revision

/** Re-renders the caller whenever another icon arrives. */
export function useFileIcons(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
