import { useSyncExternalStore } from 'react'
import type { UpdateStatus } from '@shared/types'

/**
 * What the updater is doing, published straight from this module.
 *
 * Deliberately not in the zustand store, for the same reason `subscribeReprocess` is not:
 * a download reports progress several times a second, and routing that through the store
 * would repaint the library for each tick. Nothing outside the settings row and one
 * notice needs to know.
 *
 * The status arrives two ways. `connectUpdates` asks for the current one on mount and
 * then subscribes - both, because the first check fires half a minute after launch and a
 * renderer that reloads after it would otherwise sit on `idle` for twelve hours.
 */

let status: UpdateStatus = { state: 'idle', version: '' }
const listeners = new Set<() => void>()

function publish(next: UpdateStatus): void {
  status = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(subscribe, () => status)
}

/**
 * Wires the main process's updater events in.
 *
 * `onReady` is called once per downloaded version rather than on every event, since
 * `update-downloaded` can arrive again on a later check and one notice per version is the
 * whole of what "notify, install on quit" means.
 */
export function connectUpdates(onReady: (version: string) => void): () => void {
  let announced: string | null = null

  const take = (next: UpdateStatus): void => {
    publish(next)
    if (next.state === 'ready' && next.available && next.available !== announced) {
      announced = next.available
      onReady(next.available)
    }
  }

  void window.umakbang.updateStatus().then(take)
  return window.umakbang.onUpdateStatus(take)
}

/** Checks now. The button in Settings; everything else is on a timer in the main process. */
export async function checkForUpdates(): Promise<void> {
  publish({ ...status, state: 'checking' })
  publish(await window.umakbang.checkForUpdates())
}
