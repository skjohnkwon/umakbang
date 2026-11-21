/**
 * umakbang with no window: started with the computer, kept in the tray, serving.
 *
 * The server already ran in a process of its own (`remote-process.ts`), so "a separate
 * background server" was never a question of process boundaries. It was one of lifetime: the
 * server lived exactly as long as the window did, because closing the window quit the app.
 * A machine you want to browse from your phone is one nobody is sitting at, so a server that
 * needs the app open is a server that is down when it is wanted.
 *
 * So the *app* is what stays, not a second program beside it. Everything the server leans on
 * is in the browser process already - the settings document it forwards ratings and tags to,
 * the Tailscale lookup it binds by, the scanner it asks for a re-read - and a standalone
 * server would have needed its own copy of each, plus a way to keep two writers off one
 * settings file. What goes when the window closes is the renderer, which is the expensive
 * part: the whole index held as objects, a few hundred megabytes on a real library. The
 * scanner follows it once it has nothing left to save (`releaseScannerIfIdle`).
 *
 * The tray icon is the app's presence while it is like this: it is the only thing on screen
 * saying a process is running and answering on the network, and the only way to quit it.
 */

import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'
// Copied into the build by electron-vite and resolved to its path inside the app, since
// `build/` itself is not packed. See `trayImage` for why the exe's own icon is not used.
import appIconPath from '../../build/icon.ico?asset'
import type { RemoteServerState } from '../shared/types'
import { isPortable } from './portable'

/** The argument a login item launches with, so the launch knows not to open a window. */
const BACKGROUND_FLAG = '--background'

/** The registry value 0.4.0 wrote its login item under. Never to change; see `syncLoginItem`. */
const LOGIN_ITEM_NAME = 'electron.app.umakbang'

/** How often the tray re-reads the server's state, for a status line that is not stale. */
const REFRESH_MS = 15_000

export interface BackgroundHooks {
  openWindow: () => void
  /** True when the window exists, so the menu can offer to open or to focus it. */
  windowOpen: () => boolean
  server: () => RemoteServerState
  /** The version staged by the updater and waiting for a restart, if there is one. */
  updateReady: () => string | null
  installUpdate: () => void
  setRunInBackground: (on: boolean) => void
  quit: () => void
}

let tray: Tray | null = null
let hooks: BackgroundHooks | null = null
let refreshTimer: NodeJS.Timeout | null = null

/**
 * True when this launch was the computer starting rather than somebody opening the app.
 *
 * Windows passes the login item's arguments, so the flag is there. macOS has no arguments
 * for a login item and says so through `wasOpenedAtLogin` instead.
 */
export function launchedInBackground(): boolean {
  if (process.argv.includes(BACKGROUND_FLAG)) return true
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin === true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Registers umakbang to start with the computer, or stops it, to match the setting.
 *
 * Re-applied on every launch rather than only when the switch moves: the registration names
 * the executable's path, and an install that has moved since - a reinstall somewhere else,
 * an unpacked copy rebuilt - would otherwise go on starting whatever used to be there.
 *
 * Never for a development run, whose executable is Electron's own binary under `node_modules`
 * and would start an empty Electron at every login. Never for a portable copy either: one run
 * off a stick on somebody else's computer would leave it trying to start from a drive that
 * has gone home with its owner.
 */
export function syncLoginItem(enabled: boolean): void {
  if (!app.isPackaged || isPortable()) return
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Windows only; macOS reports the same thing through `wasOpenedAtLogin`.
      args: [BACKGROUND_FLAG],
      // Pinned, because the default is the AppUserModelID, and that changed after 0.4.0
      // shipped (see `setAppUserModelId` in index.ts). Following it would have left 0.4.0's
      // entry in the registry beside the new one, and umakbang starting twice at every login.
      name: LOGIN_ITEM_NAME
    })
  } catch (error) {
    console.log(`umakbang: could not ${enabled ? 'add' : 'remove'} the login item (${String(error)})`)
  }
}

/** Puts the icon in the tray, or the menu bar, and keeps its menu current. */
export function showTray(next: BackgroundHooks): void {
  hooks = next
  if (tray) {
    refreshTray()
    return
  }
  void trayImage().then((image) => {
    // Hidden again while the icon was being read.
    if (!hooks || tray) return
    tray = new Tray(image)
    tray.setToolTip('umakbang')
    // Windows convention: a click on a tray icon opens its app, and the menu is a right-click.
    // On a Mac a menu bar item opens its menu on the click itself, which `setContextMenu`
    // already does - binding `click` there too would open the window on every glance at it.
    if (process.platform !== 'darwin') tray.on('click', () => hooks?.openWindow())
    refreshTray()
    refreshTimer = setInterval(refreshTray, REFRESH_MS)
    refreshTimer.unref?.()
  })
}

let toldStillRunning = false

/**
 * Says, once a session, that closing the window did not quit.
 *
 * Windows only. Closing a window has meant quitting on Windows for as long as there have been
 * windows, so the first close that leaves a process answering on the network has to say so -
 * otherwise "I closed it" and "it is serving my library" are both true and only one of them
 * is known. A Mac app staying in the menu bar is what Mac apps do, and needs no announcing.
 */
export function noteStillRunning(): void {
  if (toldStillRunning || process.platform !== 'win32' || !tray) return
  toldStillRunning = true
  tray.displayBalloon({
    title: 'umakbang is still running',
    content: 'It keeps serving your library from here. Right-click the icon to quit.',
    iconType: 'info'
  })
}

export function hideTray(): void {
  hooks = null
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  tray?.destroy()
  tray = null
}

export function trayShown(): boolean {
  return hooks !== null
}

/** Rebuilds the menu from the current state. Cheap, and called whenever that state moves. */
export function refreshTray(): void {
  if (!tray || !hooks) return
  const current = hooks
  const server = current.server()
  const status = server.listening
    ? `Serving on ${server.address ?? 'the tailnet'}`
    : `Not serving${server.reason ? `: ${server.reason}` : ''}`
  const update = current.updateReady()

  tray.setToolTip(`umakbang - ${status}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: current.windowOpen() ? 'Show umakbang' : 'Open umakbang', click: current.openWindow },
      { type: 'separator' },
      { label: status, enabled: false },
      {
        // Spelled out in the label, since `sublabel` only draws on a Mac. Always checked: the
        // icon only exists while this is on, so the item is only ever the way to turn it off.
        label: `Run in the background (starts with ${process.platform === 'darwin' ? 'your Mac' : 'Windows'})`,
        type: 'checkbox',
        checked: true,
        click: () => current.setRunInBackground(false)
      },
      ...(update
        ? ([
            { type: 'separator' },
            { label: `Restart to update to ${update}`, click: current.installUpdate }
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { label: 'Quit umakbang', click: current.quit }
    ])
  )
}

/**
 * The tray picture.
 *
 * Windows gets the app's own `icon.ico`, bundled into the build by the `?asset` import above.
 * It used to read the icon back off the executable with `app.getFileIcon`, on the grounds that
 * a packaged exe already carries it - and on the machine it shipped to, Windows answered with
 * the generic application icon instead, so the tray showed a stock window frame that looked
 * like somebody else's program. The shell's icon cache is what answers that call, and it is
 * the same cache that keeps showing an old icon after the exe is replaced (see Updates in
 * CLAUDE.md), so nothing about the answer was ever guaranteed to be ours.
 *
 * Each tray size is resized from the icon separately rather than letting Windows shrink the
 * 256px frame: the tray is 16px at 100% scaling, 24px at 150% and 32px at 200%, and Windows
 * picks the representation that matches the display.
 *
 * A Mac menu bar wants something else: a *template* image, black on transparent, which the
 * system tints for a light or dark bar and for the highlighted state. A coloured app icon
 * there is the one thing in the bar that does not follow the theme. So the logo's own shapes -
 * three keys over a plus - are drawn here.
 */
async function trayImage(): Promise<NativeImage> {
  if (process.platform === 'darwin') {
    const image = nativeImage.createEmpty()
    image.addRepresentation({ scaleFactor: 1, ...glyph(18) })
    image.addRepresentation({ scaleFactor: 2, ...glyph(36) })
    image.setTemplateImage(true)
    return image
  }
  const source = nativeImage.createFromPath(appIconPath)
  if (!source.isEmpty()) {
    const image = nativeImage.createEmpty()
    for (const [scaleFactor, size] of [
      [1, 16],
      [1.25, 20],
      [1.5, 24],
      [2, 32]
    ] as const) {
      const sized = source.resize({ width: size, height: size, quality: 'best' })
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer: sized.toBitmap() })
    }
    return image
  }
  // Only if the bundled file is somehow missing. Legible, if not as pretty.
  const fallback = nativeImage.createEmpty()
  fallback.addRepresentation({ scaleFactor: 1, ...glyph(16, [255, 255, 255]) })
  return fallback
}

/**
 * The logo as rounded rectangles, in the icon's own 1024-unit coordinates, cropped to the
 * shapes so the glyph fills the menu bar's height rather than the icon's padded square.
 */
const LOGO: Array<[number, number, number, number]> = [
  [148, 283, 305, 440], // left key
  [418, 105, 588, 300], // top key
  [707, 283, 865, 440], // right key
  [418, 398, 588, 910], // plus, upright
  [258, 568, 755, 740] // plus, across
]

/** Rasterises `LOGO` at `size` pixels square, 4x4 supersampled for clean edges. */
function glyph(
  size: number,
  rgb: [number, number, number] = [0, 0, 0]
): { width: number; height: number; buffer: Buffer } {
  const minX = 148
  const minY = 105
  const span = Math.max(865 - minX, 910 - minY)
  // A pixel of air on each side, or the shapes touch the bar's edges and read as cropped.
  const inner = size - 2
  const scale = inner / span
  const offsetX = (size - (865 - minX) * scale) / 2
  const offsetY = (size - (910 - minY) * scale) / 2
  const radius = 34 * scale

  const inside = (x: number, y: number): boolean =>
    LOGO.some(([x0, y0, x1, y1]) => {
      const left = offsetX + (x0 - minX) * scale
      const top = offsetY + (y0 - minY) * scale
      const right = offsetX + (x1 - minX) * scale
      const bottom = offsetY + (y1 - minY) * scale
      if (x < left || x > right || y < top || y > bottom) return false
      // Rounded corners: outside the inset rectangle, measure to the nearest corner centre.
      const cx = Math.max(left + radius, Math.min(x, right - radius))
      const cy = Math.max(top + radius, Math.min(y, bottom - radius))
      return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
    })

  // BGRA, which is what `addRepresentation` takes for a raw buffer.
  const buffer = Buffer.alloc(size * size * 4)
  const samples = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) hits++
        }
      }
      const at = (y * size + x) * 4
      const coverage = hits / (samples * samples)
      // Premultiplied, which is what a raw bitmap is read as: a white edge pixel left at full
      // value over partial alpha comes out as a bright halo round every shape.
      buffer[at] = Math.round(rgb[2] * coverage)
      buffer[at + 1] = Math.round(rgb[1] * coverage)
      buffer[at + 2] = Math.round(rgb[0] * coverage)
      buffer[at + 3] = Math.round(coverage * 255)
    }
  }
  return { width: size, height: size, buffer }
}
