import type { QuickMoveTarget } from '@shared/types'
import { baseName, samePath } from '@/lib/paths'

/**
 * The folders you keep coming back to - one list, two jobs.
 *
 * They are the "Move to" destinations in the row menu and the Quick access section in the
 * sidebar. Keeping them apart meant adding the same four folders twice and having them
 * drift, when a folder you file things into is nearly always one you also want to go to.
 *
 * Absolute paths, because a filing destination can sit outside the library - an archive on
 * another drive. Those still work as somewhere to move things; only the ones inside the
 * library can be browsed.
 */
export function isPinned(targets: QuickMoveTarget[], absolute: string): boolean {
  return targets.some((target) => samePath(target.path, absolute))
}

/** Adds a folder to the list, or removes it if it is already there. */
export function togglePinned(targets: QuickMoveTarget[], absolute: string): QuickMoveTarget[] {
  if (isPinned(targets, absolute)) {
    return targets.filter((target) => !samePath(target.path, absolute))
  }
  return [...targets, { label: baseName(absolute) || absolute, path: absolute }]
}

/** Adds several at once, leaving any that are already listed alone. */
export function addPinned(targets: QuickMoveTarget[], absolutes: string[]): QuickMoveTarget[] {
  const next = [...targets]
  for (const absolute of absolutes) {
    if (!isPinned(next, absolute)) next.push({ label: baseName(absolute) || absolute, path: absolute })
  }
  return next
}

/** Removes several at once. */
export function removePinned(targets: QuickMoveTarget[], absolutes: string[]): QuickMoveTarget[] {
  return targets.filter((target) => !absolutes.some((absolute) => samePath(target.path, absolute)))
}
