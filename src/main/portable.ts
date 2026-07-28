/**
 * Running umakbang out of one folder - off a USB stick, or anywhere else it should leave
 * nothing behind on the machine it is plugged into.
 *
 * Everything umakbang remembers lives under `app.getPath('userData')`, which on Windows is
 * `%APPDATA%\umakbang` - on the *host*, not beside the app. So copying the app folder to a
 * stick and running it elsewhere gets you the app with none of its settings, tags, ratings,
 * detected keys or index caches, and it silently seeds a fresh set on every machine it
 * touches. Redirecting `userData` is the whole of portable mode; nothing else in the app
 * needs to know, because everything already asks for the path rather than assuming it.
 *
 * **The switch is a folder called `data` beside the executable.** Make one and the app is
 * portable; delete it and the app is normal again. It is deliberately something the user
 * creates rather than something a build ships, because the two builds are the same bytes -
 * a marker packed into the installer would make an *installed* copy portable too, which is
 * how you end up with somebody's library index inside Program Files.
 *
 * Called before `app.whenReady()`, and before `crashReporter.start()`, since crash dumps
 * default to a directory under `userData` and would otherwise be resolved against the old
 * one.
 */

import { app } from 'electron'
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The folder beside the executable that turns this on. */
const MARKER = 'data'

/** Where bundles are written: the Export button's default, and the daily backup's home. */
const BACKUPS = 'backups'

let portable = false

/** Set once a read-only install folder has been reported, so it is said once and not hourly. */
let backupsFallbackReported = false

/**
 * Whether umakbang is running out of its own folder.
 *
 * The updater asks: a portable copy must never be updated in place. electron-updater's
 * Windows path downloads an NSIS installer and runs it, which would install to the host
 * machine rather than replace the folder - the one outcome portable mode exists to avoid.
 */
export function isPortable(): boolean {
  return portable
}

/**
 * Creates a folder and proves it can be written to, or throws.
 *
 * Deliberately not `accessSync(W_OK)`: on Windows that only consults the read-only
 * attribute, which means nothing for a directory, so a write-protected stick passed the
 * check and every write after it failed silently. Writing a real file is the only honest
 * probe there is.
 */
function makeWritable(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const probe = join(dir, '.umakbang-write-probe')
  writeFileSync(probe, '')
  rmSync(probe, { force: true })
}

/**
 * Where bundles go: a `backups` folder beside the executable.
 *
 * Beside the executable rather than under `userData` so a copy of the app carries its own
 * backups, and so they can be found without knowing what `%APPDATA%` means.
 *
 * In development `process.execPath` is Electron's own binary under `node_modules`, and
 * writing 22MB a day inside a dependency is nobody's intent - so an unpackaged run keeps
 * them under `userData` instead. Same `app.isPackaged` guard, same reasoning, as the marker
 * check above.
 *
 * An NSIS install lands under Program Files, which is read-only for a normal user. Falling
 * back to `userData` beats not backing up at all, but as with the marker it is said out
 * loud, because a backup folder that is not where the user was told to look is its own kind
 * of failure. Said once rather than on every hourly check.
 */
export function backupsDir(): string {
  const fallback = join(app.getPath('userData'), BACKUPS)
  if (!app.isPackaged) return fallback

  const beside = join(dirname(process.execPath), BACKUPS)
  try {
    makeWritable(beside)
    return beside
  } catch {
    if (!backupsFallbackReported) {
      backupsFallbackReported = true
      console.log(`umakbang: ${beside} is not writable, backups go to ${fallback} instead`)
    }
    return fallback
  }
}

/**
 * Points `userData` at the folder beside the executable, if the marker folder is there.
 *
 * Returns what it decided, for the log line at startup. Safe to call in development, where
 * it never triggers: `process.execPath` is Electron's own binary under `node_modules`, so
 * the marker would have to be created inside a dependency to be found.
 */
export function usePortableDataDir(): { portable: boolean; dir: string; reason?: string } {
  if (!app.isPackaged) {
    return { portable: false, dir: app.getPath('userData'), reason: 'development build' }
  }

  const candidate = join(dirname(process.execPath), MARKER)
  try {
    // The marker has to already exist - this call does not create it. Creating it would
    // make every copy portable on first run, which is the opposite of the default wanted.
    accessSync(candidate, constants.F_OK)
  } catch {
    return { portable: false, dir: app.getPath('userData') }
  }

  // A stick can be read-only, and an app folder under Program Files certainly is. Falling
  // back to the normal location beats failing to start, but it must be said out loud:
  // silently writing somewhere other than the folder the user pointed at is exactly the
  // confusion portable mode is meant to end.
  try {
    makeWritable(candidate)
  } catch {
    return {
      portable: false,
      dir: app.getPath('userData'),
      reason: `${candidate} is not writable`
    }
  }

  app.setPath('userData', candidate)
  portable = true
  return { portable: true, dir: candidate }
}
