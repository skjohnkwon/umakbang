/**
 * Managing what FL shows you, by moving the files FL keeps about it.
 *
 * The plugin database is two trees in one folder. `Installed/` is the scan - every plugin FL
 * found, filed by kind and then by format. Everything outside it is the browser, and FL says
 * so itself: `Generators.nfo` reads *"Your favorites, drop these onto channels"*. So a
 * favourite is not a flag anywhere, it is a `.fst` existing outside `Installed/` - which
 * makes adding one a copy and removing one a delete.
 *
 * That is also why this is worth doing at all. Adding forty plugins to the favourites in FL
 * is forty trips through a menu; here it is a list with checkboxes, and the work is
 * `copyFile`.
 *
 * Everything outside `Installed/` can be rebuilt from inside it, so nothing here is one-way
 * except removing a plugin from the scan itself - which is why that one moves the file aside
 * rather than unlinking it.
 */

import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Whether FL Studio is running, because it must not be when this writes.
 *
 * FL holds the plugin database open and rewrites parts of it when it exits, so a change
 * made underneath it is a change that may simply vanish - which is the trap `reg.xml` set
 * earlier: the setting looked applied, FL quit, and the old value came back. Better to
 * refuse than to lose somebody's work silently.
 */
export async function flIsRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/fi', 'imagename eq FL64.exe', '/nh'], {
        windowsHide: true,
        timeout: 5000
      })
      return /FL64\.exe/i.test(stdout)
    }
    const { stdout } = await run('/bin/ps', ['-Ao', 'comm'], { timeout: 5000 })
    return stdout.split('\n').some((line) => /(^|\/)(OsxFL|FL Studio)/i.test(line.trim()))
  } catch {
    // If we cannot tell, say no rather than blocking the feature on a failed `ps`.
    return false
  }
}

export type PluginKind = 'generator' | 'effect'

export interface FlPlugin {
  /** The name FL shows, which is the file's own name without `.fst`. */
  name: string
  kind: PluginKind
  /**
   * Every folder the scan filed it under - `VST3`, `VST`, `AudioUnit`, `Fruity`, `New`.
   *
   * Plural because most plugins are more than one of these. FL's own manager shows OTT
   * twice, as `VST3 + VST` and as `AU`, and the scan agrees: two `OTT.fst`, one per format
   * folder. Recording only the first one found made filtering lie - ask for VST3 and OTT
   * vanished, because `readdir` happened to reach `AudioUnit/` first.
   */
  formats: string[]
  /** Whether it is in the favourites tree, which is what puts it in the picker. */
  favourite: boolean
  /** The scan copy a favourite is copied from - `installedPaths[0]`, or '' for built-ins. */
  installed: string
  /** Every scan copy, which is what removing from the scan has to move. */
  installedPaths: string[]
  /** Where the favourite's copy is, when there is one. */
  favouritePath?: string
}

export interface FlCatalog {
  plugins: FlPlugin[]
  from: string
  missing?: boolean
}

/** FL's own name for the two halves of the database. */
const KINDS: Array<{ dir: string; kind: PluginKind }> = [
  { dir: 'Generators', kind: 'generator' },
  { dir: 'Effects', kind: 'effect' }
]

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Every `.fst` under a folder, as name -> paths. Depth is small and FL's, not ours.
 *
 * A name can arrive several times because FL files the same plugin under each format it
 * found, so every path is kept. They still collapse to one entry later: the favourites tree
 * is flat and keyed by filename, so `OTT.fst` is one favourite however many formats back it.
 */
async function fstUnder(dir: string, into: Map<string, string[]>, depth = 0): Promise<void> {
  if (depth > 6) return
  for (const entry of await entries(dir)) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await fstUnder(full, into, depth + 1)
    else if (entry.name.toLowerCase().endsWith('.fst')) {
      const name = entry.name.slice(0, -4)
      const seen = into.get(name)
      if (seen) seen.push(full)
      else into.set(name, [full])
    }
  }
}

/**
 * Which copy a favourite is made from, when the scan holds several.
 *
 * Ordered so the portable formats win. This app's whole point is two machines, and a
 * favourite copied from `VST3/` names a plugin that exists on the PC too; one copied from
 * `AudioUnit/` names something Windows has never heard of.
 */
const FORMAT_PREFERENCE = ['VST3', 'VST', 'AudioUnit', 'New', 'Fruity']

function preferred(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const rank = (path: string): number => {
      const at = FORMAT_PREFERENCE.indexOf(formatOf(path))
      return at === -1 ? FORMAT_PREFERENCE.length : at
    }
    return rank(a) - rank(b) || a.localeCompare(b)
  })
}

/**
 * Everything FL has found, and which of it is a favourite.
 *
 * `database` is the `Plugin database` folder itself - `readPluginInventory` already works
 * out where that is from whatever the user pointed at.
 */
export async function readFlCatalog(database: string): Promise<FlCatalog> {
  const plugins: FlPlugin[] = []
  for (const { dir, kind } of KINDS) {
    const installed = new Map<string, string[]>()
    const favourites = new Map<string, string[]>()
    await fstUnder(join(database, 'Installed', dir), installed)
    await fstUnder(join(database, dir), favourites)

    for (const [name, paths] of installed) {
      const ordered = preferred(paths)
      const favouritePath = favourites.get(name)?.[0]
      plugins.push({
        name,
        kind,
        formats: [...new Set(ordered.map(formatOf))],
        favourite: favouritePath !== undefined,
        installed: ordered[0],
        installedPaths: ordered,
        favouritePath
      })
    }

    /*
     * Favourites with nothing in the scan behind them.
     *
     * FL's own stock plugins live only in the favourites tree - they are not scanned,
     * because they are not plugins anybody installed. Leaving them out would make the list
     * disagree with the browser, and un-favouriting one has to stay possible.
     */
    for (const [name, paths] of favourites) {
      if (installed.has(name)) continue
      plugins.push({
        name,
        kind,
        formats: ['Built in'],
        favourite: true,
        installed: '',
        installedPaths: [],
        favouritePath: paths[0]
      })
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return { plugins, from: database }
}

/** The folder the scan filed it under, which is the closest thing to a plugin's format. */
function formatOf(installedPath: string): string {
  const parts = installedPath.split(/[\\/]/)
  return parts[parts.length - 2] ?? ''
}

export interface ChangeResult {
  changed: number
  failures: string[]
}

/**
 * Adds or removes favourites, in bulk.
 *
 * Copied to the top of the favourites tree rather than into one of FL's categories. A
 * category is a judgement about what a plugin *is*, and guessing wrong files somebody's
 * synth under Drum forever; the top level is where FL itself puts one when it has no
 * opinion, and `ZENOLOGY.fst` is already sitting there proving it works.
 */
export async function setFavourites(
  database: string,
  plugins: FlPlugin[],
  wanted: boolean
): Promise<ChangeResult> {
  let changed = 0
  const failures: string[] = []

  for (const plugin of plugins) {
    try {
      if (wanted) {
        if (plugin.favourite) continue
        if (!plugin.installed) {
          failures.push(`${plugin.name}: nothing in the scan to copy from.`)
          continue
        }
        const dir = join(database, plugin.kind === 'generator' ? 'Generators' : 'Effects')
        await mkdir(dir, { recursive: true })
        await copyFile(plugin.installed, join(dir, `${plugin.name}.fst`))
      } else {
        if (!plugin.favouritePath) continue
        await unlink(plugin.favouritePath)
      }
      changed++
    } catch (error) {
      failures.push(`${plugin.name}: ${(error as Error).message}`)
    }
  }

  return { changed, failures }
}

/**
 * Takes a plugin out of FL's scan.
 *
 * Moved rather than deleted. The scan is the only record FL has that a plugin exists, and
 * getting one back means re-scanning every plugin on the machine - minutes, and a dialog per
 * plugin that misbehaves. A folder beside the database costs nothing and makes this a
 * mistake somebody can walk back.
 */
export async function removeFromScan(
  database: string,
  plugins: FlPlugin[]
): Promise<ChangeResult> {
  const aside = join(database, 'Removed by umakbang')
  let changed = 0
  const failures: string[] = []

  for (const plugin of plugins) {
    if (plugin.installedPaths.length === 0) {
      failures.push(`${plugin.name} is built into FL and cannot be removed.`)
      continue
    }
    try {
      await mkdir(aside, { recursive: true })
      // Every format, or the ones left behind put the plugin straight back in FL's list.
      for (const path of plugin.installedPaths) {
        let target = join(aside, `${formatOf(path)}-${plugin.name}.fst`)
        try {
          await stat(target)
          target = join(aside, `${formatOf(path)}-${plugin.name}-${Date.now()}.fst`)
        } catch {
          // Nothing there, which is the ordinary case.
        }
        await rename(path, target)
      }
      // A favourite pointing at a plugin FL no longer knows about is a dead menu entry.
      if (plugin.favouritePath) await unlink(plugin.favouritePath).catch(() => undefined)
      changed++
    } catch (error) {
      failures.push(`${plugin.name}: ${(error as Error).message}`)
    }
  }

  return { changed, failures }
}
