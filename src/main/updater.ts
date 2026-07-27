/**
 * Checking GitHub for a newer umakbang, and installing it when you quit.
 *
 * The feed is the project's own GitHub releases, which are public, so nothing here holds a
 * credential. It used to: the repository was private, the feed needed a read token, and an
 * app with no server in front of it had nowhere to keep one but its own bundle - where
 * anyone holding the app could read it out. Worse, `npm run release` publishes with the
 * same `GH_TOKEN` it compiled in, and publishing needs *write*, so the extractable token
 * could push releases to everybody. Going public deleted the problem rather than shrinking
 * it. If this repository is ever made private again, that whole trade comes back; a server
 * in front of the feed is the answer, not a token in the binary.
 *
 * Which repository to ask is not decided here either. `electron-builder.yml`'s `publish`
 * block is baked into `app-update.yml` beside the packaged app, and electron-updater reads
 * that - so a fork checks the fork's own releases as soon as its owner edits one file,
 * rather than silently checking this one because a constant here said so.
 *
 * Nothing here interrupts. A download runs in the background and the new version is
 * staged; it replaces the app on the next quit, because the alternative is offering to
 * restart in the middle of a scan or a track. `quitAndInstall` is deliberately not called.
 */

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { isPortable } from './portable'

/** How often to look, once the first check has run. Twelve hours. */
const CHECK_INTERVAL = 12 * 60 * 60 * 1000

/**
 * How long to wait before the first check.
 *
 * Launch is the busiest moment umakbang has: the window is painting, the scanner is
 * forking and replaying an index of a few hundred thousand files. A release check is the
 * least urgent thing in the process, so it waits for that to pass.
 */
const FIRST_CHECK_DELAY = 30_000

let timer: NodeJS.Timeout | null = null
let latest: UpdateStatus = { state: 'idle', version: app.getVersion() }

/** The last thing the updater did, for a window that connects after it happened. */
export function updateStatus(): UpdateStatus {
  return latest
}

/**
 * Starts the updater and reports what it finds to the window.
 *
 * `getWindow` rather than a window, because a check outlives any particular one: the
 * renderer can reload, and the download that started before it should still be able to
 * say so afterwards.
 */
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  // In development there is no `app-update.yml` beside the app and no installer to hand
  // over to, so electron-updater throws rather than no-ops. There is also nothing to
  // update: the thing running is the working tree.
  if (!app.isPackaged) {
    latest = { state: 'disabled', version: app.getVersion(), reason: 'development build' }
    return
  }
  // A portable copy must never update itself. electron-updater's Windows path downloads the
  // NSIS installer and runs it on quit, and that installs to the host machine - so a stick
  // plugged into somebody else's PC would leave umakbang installed on it and still be
  // running the old version itself. Updating a folder means replacing the folder.
  if (isPortable()) {
    latest = { state: 'disabled', version: app.getVersion(), reason: 'portable copy' }
    return
  }

  const publish = (status: UpdateStatus): void => {
    latest = status
    getWindow()?.webContents.send('update:status', status)
  }

  // No `setFeedURL`. The feed comes from the `app-update.yml` electron-builder writes from
  // its own `publish` block, which is what makes a fork point at the fork - see the note at
  // the top of this file.
  // Download without asking, install on quit. Both are electron-updater's defaults; they
  // are written out because they are the whole of the chosen behaviour and a later reader
  // should not have to know the defaults to see it.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Its own logging is noisy and goes nowhere useful in a packaged app.
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', version: app.getVersion() }))
  autoUpdater.on('update-not-available', () => publish({ state: 'current', version: app.getVersion() }))
  autoUpdater.on('update-available', (info) =>
    publish({ state: 'downloading', version: app.getVersion(), available: info.version })
  )
  autoUpdater.on('download-progress', (progress) =>
    publish({
      state: 'downloading',
      version: app.getVersion(),
      available: latest.available,
      percent: Math.round(progress.percent)
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    publish({ state: 'ready', version: app.getVersion(), available: info.version })
  )
  // A failed check is not worth a dialog. It is usually the machine being offline, and
  // the next check is twelve hours away at most.
  autoUpdater.on('error', (error) =>
    publish({ state: 'error', version: app.getVersion(), reason: error.message })
  )

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => {
      // Already reported through the 'error' event above.
    })
  }

  const first = setTimeout(check, FIRST_CHECK_DELAY)
  first.unref?.()
  timer = setInterval(check, CHECK_INTERVAL)
  timer.unref?.()
}

/**
 * Checks now, because somebody pressed the button in Settings.
 *
 * Returns the status rather than nothing, so the button can report "you are up to date"
 * without the caller having to catch the event that says so.
 */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (latest.state === 'disabled') return latest
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // Reported through the 'error' event.
  }
  return latest
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
