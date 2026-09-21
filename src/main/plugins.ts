/**
 * Which plugins a machine has, read from FL Studio's own record of them.
 *
 * FL keeps one `.fst` per plugin under `Presets/Plugin database`, sorted into `Generators`
 * and `Effects` and then by category - it is what the browser draws, and it is written when
 * FL scans for plugins. Reading it means never asking the user to list anything, and never
 * guessing from what is installed on disk: what matters is what *FL* has found, which is a
 * different and stricter question.
 *
 * The file name is the plugin's name as FL shows it, which is also the name a project
 * records for a wrapped plugin - so the two lists compare directly without a mapping table.
 */

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where FL keeps its user data, unless told otherwise. Same shape on both platforms. */
export function defaultFlUserData(): string {
  return join(homedir(), 'Documents', 'Image-Line', 'FL Studio')
}

export interface PluginInventory {
  /** Plugin names, as FL shows them. Sorted, deduplicated. */
  names: string[]
  /** Where they were read from, so the UI can say when it is looking in the wrong place. */
  from: string
  /** Set when the database is not there at all - FL not installed, or never scanned. */
  missing?: boolean
}

/** Walks a directory tree collecting `.fst` names. Depth is FL's, not ours: two or three. */
async function collectFst(dir: string, into: Set<string>, depth = 0): Promise<void> {
  if (depth > 4) return
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectFst(join(dir, entry.name), into, depth + 1)
    } else if (entry.name.toLowerCase().endsWith('.fst')) {
      into.add(entry.name.slice(0, -4))
    }
  }
}

export async function readPluginInventory(userData: string): Promise<PluginInventory> {
  const database = join(userData, 'Presets', 'Plugin database')
  try {
    await stat(database)
  } catch {
    return { names: [], from: database, missing: true }
  }
  const names = new Set<string>()
  await collectFst(database, names)
  return { names: [...names].sort((a, b) => a.localeCompare(b)), from: database }
}
