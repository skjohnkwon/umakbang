import type { Settings } from '@shared/types'
import { isUnderAnyDir } from '@/lib/paths'

/**
 * The folders the random button never draws from.
 *
 * A library is mostly not finished music: sample packs and one-shot folders outnumber beats
 * by a wide margin, so without this the dice lands on a kick sample nearly every time.
 * Excluding a folder covers everything beneath it, which is what makes one entry for a
 * whole sample-pack folder enough.
 */
export function isRandomExcluded(relDir: string, excluded: readonly string[]): boolean {
  return excluded.some((dir) => dir.toLowerCase() === relDir.toLowerCase())
}

/** True when some ancestor already excludes it, so excluding it again would do nothing. */
export function isRandomExcludedByParent(relDir: string, excluded: readonly string[]): boolean {
  return !isRandomExcluded(relDir, excluded) && isUnderAnyDir(relDir, excluded as string[])
}

/** Adds or removes folders, dropping any now covered by a newly added ancestor. */
export function toggleRandomExcluded(
  settings: Settings,
  dirs: readonly string[]
): string[] {
  const current = settings.randomExcludeDirs
  const adding = dirs.filter((dir) => !isRandomExcluded(dir, current))

  if (adding.length === 0) {
    const removing = new Set(dirs.map((dir) => dir.toLowerCase()))
    return current.filter((dir) => !removing.has(dir.toLowerCase()))
  }

  // Anything already covered by a folder being added is redundant once it lands.
  const kept = current.filter((dir) => !isUnderAnyDir(dir, adding as string[]))
  return [...kept, ...adding]
}
