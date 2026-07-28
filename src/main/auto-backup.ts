/**
 * The daily backup nobody asks for.
 *
 * A bundle is the only copy of things that cannot be reproduced - tags, ratings, detected
 * keys, months of them - and the manual Export button only helps the user who remembers to
 * press it. So one runs on its own, once a day. There is nothing to switch on and no UI of
 * its own: a backup that has to be enabled is a backup that isn't there when it is wanted.
 *
 * It lands wherever Export lands (`bundleExportDir`, seeded to `backups` beside the
 * executable) rather than in a folder of its own. Two backup folders would be two places to
 * look, and moving the one the button uses without moving the one that runs by itself is a
 * setting doing half its job.
 *
 * **The clock is the file's own mtime.** No timestamp is stored anywhere - the single
 * `umakbang-auto.umak` is either missing, or older than a day, or not due yet, and `statSync`
 * answers that in one call. That keeps the whole feature out of the settings file, out of
 * settings exports and out of the import wizard's folder mapping, and it is self-repairing:
 * delete the backup and the next check writes a new one.
 *
 * One file, overwritten. `writeBundle` writes `<name>.part` and renames at the end, so the
 * previous good backup is still on disk for the whole of the run that replaces it.
 */

import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeBundle, isWritingBundle } from './bundle'
import { backupsDir } from './portable'
import { getUserData } from './store'

const AUTO_FILE = 'umakbang-auto.umak'
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Five minutes, because the first minutes after launch are the busiest the app ever is: the
 * scanner is walking the whole library and probing it, and gzipping 300MB alongside that is
 * the one moment this would be felt.
 */
const FIRST_CHECK_MS = 5 * 60 * 1000
const CHECK_EVERY_MS = 60 * 60 * 1000

/** How old the existing backup is, or `Infinity` when there isn't one. */
function ageOfBackup(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Infinity
  }
}

/** Set by `initAutoBackup`, since main owns the scanner and this module must not import it. */
let scanning: () => boolean = () => false

async function runIfDue(): Promise<void> {
  const settings = getUserData().settings

  // Nothing to back up on a fresh install, and a bundle of no library is a couple of
  // kilobytes that looks for all the world like a backup.
  if (settings.roots.length === 0) return

  // A manual export is already compressing. Both would be reading the same index and
  // writing the same size of file; this one has another hour to wait and can afford to.
  if (isWritingBundle()) return

  // Never over a running scan. The bundle copies the index files straight through, and the
  // scanner replaces those files with a rename when the scan ends - which on Windows fails
  // against an open read handle, and `saveIndex` swallows the failure, so an overlapping
  // backup would silently cost a whole scan's index. Waiting an hour costs nothing; the
  // index is also more worth copying once the scan that rewrote it has finished.
  if (scanning()) return

  const dir = settings.bundleExportDir || backupsDir()
  const file = join(dir, AUTO_FILE)
  if (ageOfBackup(file) < DAY_MS) return

  try {
    mkdirSync(dir, { recursive: true })
    const started = Date.now()
    await writeBundle(file)
    console.log(`umakbang: daily backup written to ${file} in ${Date.now() - started}ms`)
  } catch (error) {
    // Logged and swallowed. A backup that cannot be written is a thing to fix, never a
    // reason to take the app down with it - and the hourly check will try again.
    console.log(`umakbang: daily backup failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * Starts the daily check.
 *
 * The check is hourly and the *backup* is daily, which is what makes an app that is opened
 * and closed all day behave: the deadline is only ever passed while umakbang is running, so
 * one that was closed when a backup came due gets it five minutes into the next launch.
 *
 * `isScanning` is passed in rather than imported, because it lives in `index.ts` and
 * `index.ts` starts this - the same shape as `initUpdater(() => mainWindow)` beside it.
 *
 * Neither timer holds the process open (`unref`), so a quit during the wait is a quit.
 */
export function initAutoBackup(isScanning: () => boolean): void {
  scanning = isScanning

  // Otherwise finding out whether any of this works costs five minutes a run. Both timers
  // are shortened, not just the first: the first check almost always lands on a running
  // scan and defers, so an hour's retry would be no better than the five minutes. Same
  // shape as UMAKBANG_DEVTOOLS - a development affordance, not a setting, and nothing in
  // the app ever writes it.
  const hurry = Boolean(process.env.UMAKBANG_BACKUP_NOW)

  const first = setTimeout(() => void runIfDue(), hurry ? 0 : FIRST_CHECK_MS)
  first.unref?.()
  const every = setInterval(() => void runIfDue(), hurry ? 2000 : CHECK_EVERY_MS)
  every.unref?.()
}
