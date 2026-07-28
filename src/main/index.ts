import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  crashReporter,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
  nativeTheme,
  nativeImage,
  screen,
  utilityProcess
} from 'electron'
import { dirname, join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { PLAYABLE_EXTENSIONS, classifyKind, extensionOf, isIndexable } from '../shared/files'
import { registerFileProtocol, registerFileSchemePrivileges } from './protocol'
import { probeFile } from './probe'
import {
  deleteContractPreset,
  deleteContractRecord,
  generateContract,
  getContractData,
  initContracts,
  saveContractPreset,
  saveContractProfile,
  saveContractTemplate,
  previewContract,
  setContractOutputDir
} from './contracts'
import {
  createFolder,
  describeDir,
  nameError,
  renameEntry,
  transfer,
  trashEntries
} from './fs-ops'
import {
  flushStore,
  getDataDir,
  getPeaks,
  getUserData,
  importBackup,
  initStore,
  forgetPeaks,
  putPeaks,
  addRoot,
  removeRoot,
  clearDetected,
  setDetectedBpm,
  setDetectedKey,
  setNote,
  setRating,
  setTags,
  updateSettings
} from './store'
import { appendIndexPatch, clearIndex, initIndexStore } from './index-store'
import {
  fitFor,
  looksLikeBundle,
  offerRestart,
  readBundleHeader,
  restoreBundle,
  writeBundle
} from './bundle'
import { BUNDLE_EXTENSION, type BundleHeader } from '../shared/bundle'
import { checkForUpdatesNow, initUpdater, updateStatus } from './updater'
import { backupsDir, usePortableDataDir } from './portable'
import { initAutoBackup } from './auto-backup'
import { minutesLeft, splitOne, type StemOptions, type StemOutcome, type StemProgress } from './stems'
import { watch, type FSWatcher } from 'node:fs'
import type { ScannerCommand, ScannerEvent } from './scanner-process'
import type {
  LibraryRoot,
  PlatformInfo,
  Settings,
  Track,
  UserData,
  TransferMode,
  TransferResult,
  TrashResult,
  UpdateStatus
} from '../shared/types'
import { rootFor } from '../shared/roots'
import {
  lastSegment,
  remapBackup,
  summariseBackup,
  type BackupSummary,
  type FolderMapping,
  type RemapResult,
  type SettingsBackup
} from '../shared/backup'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

let mainWindow: BrowserWindow | null = null
let scanner: Electron.UtilityProcess | null = null
let scannerReady = false
/** Full-size bounds held while the window is in compact visualizer mode. */
let restoreBounds: Electron.Rectangle | null = null
let boundsTimer: ReturnType<typeof setTimeout> | null = null
/** A scan requested before the child reported ready, replayed once it does. */
let pendingScanRoots: { roots: LibraryRoot[]; full: boolean } | null = null
/**
 * True between a scan starting and its `done` progress report.
 *
 * Only the daily backup asks. It reads the index files the scanner rewrites, and the two
 * must not overlap - see the `progress` case in `ensureScanner`.
 */
let scanning = false
/** True while a native file drag is running, so a second one can't be started inside it. */
let dragInFlight = false

/**
 * The folder the explorer is standing in, watched for changes.
 *
 * Only one, and only the folder itself rather than its subtree: the whole point is that a
 * DAW re-exporting into the folder you are looking at shows up without asking, and a
 * recursive watch on a 300,000-file library is a different proposition entirely. The scan
 * still owns everything else.
 */
let folderWatcher: FSWatcher | null = null
let watchedDir: string | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null

/** Distinguishes overlapping clipboard list files; see `clipboard:writeFiles`. */
let clipboardSerial = 0

// The custom scheme has to be declared before the app becomes ready.
registerFileSchemePrivileges()

/* ------------------------------------------------------------------ window */

const TITLE_BAR_HEIGHT = 38

/**
 * The native caption buttons drawn over the web contents. Matches the --background /
 * --muted-foreground tokens in the renderer's stylesheet - umakbang is a dark app, so
 * there's one of these rather than a pair.
 */
const CAPTION_OVERLAY = { color: '#0d0f13', symbolColor: '#8b94a5' } as const

/**
 * The mini player's window: square, including the caption strip. Small enough to sit
 * over a DAW without being in the way, big enough for a waveform you can aim at.
 */
const MINI_SIZE = 300
const MINI_TOP_MARGIN = 12

/**
 * Keeps the saved window geometry current.
 *
 * Debounced because resize and move fire continuously while dragging, and only the
 * normal (non-maximised) bounds are stored - restoring a maximised window to its
 * maximised bounds would leave it un-maximisable.
 */
function rememberBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed() || restoreBounds) return
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    boundsTimer = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    const maximized = mainWindow.isMaximized()
    updateSettings({
      windowMaximized: maximized,
      ...(maximized ? {} : { windowBounds: mainWindow.getNormalBounds() })
    })
  }, 500)
  boundsTimer.unref?.()
}

/**
 * Lets the visualizers listen to whatever the machine is playing.
 *
 * `getDisplayMedia()` is rejected outright unless the session answers it, and Chromium
 * won't hand back an audio-only display capture - so a screen source is named purely to
 * make the request legal and the renderer drops the video track before it draws a frame.
 * Electron only implements loopback on Windows; elsewhere the request is refused so the
 * UI can say so rather than quietly opening a microphone instead.
 */
function enableSystemAudioCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!isWindows) {
        callback({})
        return
      }
      // Thumbnails are the expensive part of getSources and nothing here shows one.
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then(([display]) => callback(display ? { video: display, audio: 'loopback' } : {}))
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}

function createWindow(): void {
  const { windowBounds, windowMaximized } = getUserData().settings

  // Only reuse saved bounds that still land on a connected display - a monitor that has
  // since been unplugged would otherwise open the window off-screen.
  const usable =
    windowBounds &&
    screen.getAllDisplays().some((display) => {
      const { x, y, width, height } = display.workArea
      return (
        windowBounds.x < x + width &&
        windowBounds.x + windowBounds.width > x &&
        windowBounds.y < y + height &&
        windowBounds.y + windowBounds.height > y
      )
    })

  mainWindow = new BrowserWindow({
    ...(usable && windowBounds
      ? { x: windowBounds.x, y: windowBounds.y, width: windowBounds.width, height: windowBounds.height }
      : { width: 1360, height: 860 }),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: CAPTION_OVERLAY.color,
    // Both platforms get a custom title bar; macOS keeps its traffic lights, Windows
    // gets native caption buttons drawn over the web content.
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    ...(isWindows || process.platform === 'linux'
      ? { titleBarOverlay: { ...CAPTION_OVERLAY, height: TITLE_BAR_HEIGHT } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (windowMaximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)
  mainWindow.on('maximize', rememberBounds)
  mainWindow.on('unmaximize', rememberBounds)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Nothing in this app should open a second window; send links to the real browser.
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Resume the library automatically once the renderer is listening. On every load, not
  // just the first: a reload throws away the renderer's index, and without this the
  // window would come back to an empty library until the next manual rescan. Subscribed
  // per window rather than once at startup, or a window recreated from the macOS dock
  // (`activate`) opens onto an empty library.
  mainWindow.webContents.on('did-finish-load', () => {
    beginScan(getUserData().settings.roots)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    if (process.env['UMAKBANG_DEVTOOLS']) mainWindow.webContents.openDevTools({ mode: 'bottom' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const notifyMaximised = (): void =>
    mainWindow?.webContents.send('window:maximized', mainWindow.isMaximized()) ?? undefined
  mainWindow.on('maximize', notifyMaximised)
  mainWindow.on('unmaximize', notifyMaximised)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/* ------------------------------------------------------------------ menu */

function buildMenu(): void {
  // macOS needs a real menu for the standard shortcuts (⌘Q, ⌘C, ⌘W) to work at all.
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Library Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickAndOpenFolder()
        },
        {
          label: 'Rescan Library',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('menu:rescan')
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Focus Search',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('menu:focusSearch')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ scanning */

/**
 * Scanning runs in a utility process. Walking a large tree and parsing metadata is
 * sustained CPU and I/O work; on the browser process it starves the window's message
 * pump badly enough that Windows closes the app as unresponsive.
 */
function ensureScanner(): Electron.UtilityProcess {
  if (scanner) return scanner

  const child = utilityProcess.fork(join(__dirname, 'scanner.js'), [], {
    serviceName: 'umakbang-scanner'
  })

  child.on('message', (event: ScannerEvent) => {
    if (event.type === 'ready') {
      scannerReady = true
      // Run whatever was requested before the child finished initialising.
      const queued = pendingScanRoots
      pendingScanRoots = null
      if (queued) {
        send({
          type: 'scan',
          roots: queued.roots,
          replace: true,
          firstDir: openingDir(),
          full: queued.full
        })
      }
      return
    }

    const target = mainWindow
    if (!target || target.isDestroyed()) return
    switch (event.type) {
      case 'tracks':
        target.webContents.send('library:tracks', event.tracks)
        break
      case 'progress':
        // Also kept here, not only forwarded. The daily backup copies the index file
        // straight through, and the scanner replaces that file with a rename when a scan
        // ends - which on Windows fails outright against an open read handle, and
        // `saveIndex` swallows the failure, so a whole scan's index would be lost to a
        // backup that happened to overlap it.
        scanning = event.progress.phase !== 'done'
        target.webContents.send('library:progress', event.progress)
        break
      case 'metadata':
        target.webContents.send('library:metadata', event.patches)
        break
      case 'removed':
        target.webContents.send('library:removed', event.paths)
        break
      case 'error':
        target.webContents.send('library:error', { stage: event.stage, message: event.message })
        break
      default:
        break
    }
  })

  child.on('exit', (code) => {
    scanner = null
    scannerReady = false
    // Cleared here too, or a scanner that died mid-scan leaves this latched and the daily
    // backup defers for the rest of the session waiting for a `done` that cannot arrive.
    scanning = false
    mainWindow?.webContents.send('library:error', {
      stage: 'scanner-exit',
      message: `The scanner stopped unexpectedly (code ${code}).`
    })
  })

  scanner = child
  send({ type: 'init', dataDir: getDataDir() })
  return child
}

function send(command: ScannerCommand): void {
  scanner?.postMessage(command)
}

/**
 * Scans every open folder, from scratch.
 *
 * One reset for the whole set rather than one per folder: the renderer's index is a single
 * list, and clearing it between folders would empty the library halfway through.
 */
function beginScan(roots: LibraryRoot[], full = false): void {
  const target = mainWindow
  if (!target) return
  if (roots.length === 0) {
    target.webContents.send('library:reset', { roots })
    return
  }

  ensureScanner()
  target.webContents.send('library:reset', { roots })
  // Set here rather than waiting for the first `progress`, so the gap between asking for a
  // scan and hearing about it is not a window the daily backup can start in.
  scanning = true

  // Starting before the cache is initialised would probe every file and cache nothing.
  if (scannerReady) send({ type: 'scan', roots, replace: true, firstDir: openingDir(), full })
  else pendingScanRoots = { roots, full }
}

/**
 * The folder the window will be standing in once it has hydrated, so the scanner can send
 * that folder's rows before it parses the rest of the index. The renderer restores
 * `lastViewMode`, so this is the same answer it is about to reach on its own - main just
 * knows it a second earlier, which is the whole point.
 */
function openingDir(): string {
  const { lastViewMode, lastDir } = getUserData().settings
  // Any other view - Stats, a rating filter - draws from the whole index rather than one
  // folder, so there is no folder worth putting first and the early rows are just the
  // cheapest ones to reach.
  return lastViewMode === 'folder' ? lastDir : ''
}

/**
 * Scans one more folder into the library that is already loaded.
 *
 * No reset: the renderer's index is additive and keyed by path, so the new folder's rows
 * simply arrive. Resetting instead would empty a 300,000-file library and refill it from
 * disk for the sake of one folder - and any scan already running would be thrown away
 * with it.
 */
function scanAdditional(added: LibraryRoot, all: LibraryRoot[]): void {
  const target = mainWindow
  if (!target) return
  ensureScanner()
  // The renderer needs the full list before any of the new folder's tracks arrive, or the
  // first row through resolves its label against a set that doesn't contain it yet.
  target.webContents.send('library:roots', { roots: all })
  scanning = true
  if (scannerReady) send({ type: 'scan', roots: [added], replace: false })
  else pendingScanRoots = { roots: all, full: false }
}

/**
 * Opens the library folders an import was told the whereabouts of.
 *
 * Without this an import on a fresh machine finished on the same empty welcome screen it
 * started from. It had done its job - every tag and rating was rewritten onto this
 * machine's paths - but a library keyed to folders that aren't open is invisible, and the
 * user has just said where each of those folders lives. Asking again, in a second dialog,
 * for a path they typed into the first one is not a question worth putting to anybody.
 *
 * Only folders the backup names as *its* library folders are opened. A tagged folder deeper
 * in the tree, or a quick-access target that was never a root, is mapped so its entries
 * survive - it is not somewhere to point the library at.
 *
 * The exporting machine's label is carried across rather than re-derived: `folderSort`,
 * `pinnedDirs` and `randomExcludeDirs` are all keyed by it, and they have just been
 * imported. See `addRoot`.
 */
function adoptExportedRoots(backup: SettingsBackup, mapping: FolderMapping): LibraryRoot[] {
  // Version 1 files have only the one root and no label for it, so its own folder name is
  // the best that can be done - which is what `labelForRoot` would have said anyway.
  const exported: LibraryRoot[] =
    backup.exportedRoots ??
    (backup.exportedRoot
      ? [{ path: backup.exportedRoot, label: lastSegment(backup.exportedRoot) }]
      : [])

  const adopted: LibraryRoot[] = []
  for (const root of exported) {
    // Keyed by the path exactly as the backup spells it: `summariseBackup` remembers the
    // library folders first and verbatim, so this is the same string the wizard offered.
    const target = mapping[root.path]
    if (!target) continue
    // Skipped when it is already open, or nested in something that is - `addRoot` decides,
    // and a folder the user already has is not a failure worth reporting mid-import.
    const { settings, added } = addRoot(target, root.label)
    if (!added) continue
    adopted.push(added)
    scanAdditional(added, settings.roots)
  }
  return adopted
}

/**
 * Watches one folder, and re-reads it a moment after anything in it changes.
 *
 * Debounced because a save is never one event: a DAW writes, renames and touches the file
 * several times on the way to a finished export, and re-reading on each of those would
 * describe a half-written file.
 */
function watchFolder(dir: string | null): void {
  if (dir === watchedDir) return
  watchedDir = dir
  folderWatcher?.close()
  folderWatcher = null
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  if (!dir) return

  try {
    folderWatcher = watch(dir, { persistent: false }, () => {
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        watchTimer = null
        void refreshFolder(dir)
      }, 600)
    })
    // The try/catch only covers creation. A watcher whose folder is deleted under it, or
    // whose network share drops, emits 'error' - and an unhandled 'error' event is an
    // uncaught exception in the main process.
    folderWatcher.on('error', () => {
      folderWatcher?.close()
      folderWatcher = null
    })
  } catch {
    // A folder that can't be watched - a disconnected network share, a permission - is
    // simply not watched. The manual refresh still works.
  }
}

/** Re-reads a folder and tells the renderer what is in it now. */
async function refreshFolder(dir: string): Promise<void> {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  const tracks = await describeDir(dir, getUserData().settings.roots)
  if (target.isDestroyed()) return
  target.webContents.send('library:folder', { dir, tracks })
}

async function pickAndOpenFolder(): Promise<string | null> {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your music folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open Library'
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const { settings, added, reason } = addRoot(result.filePaths[0])
  if (!added) {
    mainWindow?.webContents.send('library:notice', {
      message: `That folder is ${reason ?? 'already open'}.`
    })
    return null
  }
  scanAdditional(added, settings.roots)
  return added.path
}

/**
 * The image Windows drags under the cursor.
 *
 * Deliberately drawn rather than decoded from a transparent placeholder. `startDrag` hands
 * this to the OS as a drag bitmap, and a fully transparent one gives Chromium's Windows
 * drag code an image with nothing in it to composite. Drop targets that render the drag
 * image - a browser does, most DAWs don't - are the ones that then take the app down with
 * them, which is exactly the shape of "it crashes onto a browser tab but not into the DAW".
 *
 * A small, solid, mostly-opaque square is enough: the receiving application supplies
 * whatever it wants to show once the drag is over its own window.
 */
const DRAG_ICON_SIZE = 32

let cachedDragIcon: Electron.NativeImage | null = null
function dragIcon(): Electron.NativeImage {
  if (cachedDragIcon && !cachedDragIcon.isEmpty()) return cachedDragIcon

  // BGRA, which is the byte order createFromBitmap expects.
  const pixels = Buffer.alloc(DRAG_ICON_SIZE * DRAG_ICON_SIZE * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0x9a
    pixels[i + 1] = 0x86
    pixels[i + 2] = 0x5e
    pixels[i + 3] = 0xcc
  }

  cachedDragIcon = nativeImage.createFromBitmap(pixels, {
    width: DRAG_ICON_SIZE,
    height: DRAG_ICON_SIZE
  })
  return cachedDragIcon
}

/* ------------------------------------------------------------------ ipc */

function registerIpc(): void {
  ipcMain.handle('app:platform', (): PlatformInfo => {
    let musicDir = join(homedir(), 'Music')
    try {
      musicDir = app.getPath('music')
    } catch {
      // Not every Linux setup defines a music directory.
    }
    return {
      platform: process.platform,
      isMac,
      isWindows,
      revealLabel: isMac ? 'Reveal in Finder' : isWindows ? 'Show in Explorer' : 'Show in Files',
      homeDir: homedir(),
      musicDir
    }
  })

  /** What the updater last did. Asked for on mount, since events predate the listener. */
  ipcMain.handle('update:status', (): UpdateStatus => updateStatus())
  /** Checks now, for the button in Settings. */
  ipcMain.handle('update:check', (): Promise<UpdateStatus> => checkForUpdatesNow())

  ipcMain.handle('store:userData', () => getUserData())

  ipcMain.handle('store:updateSettings', (_event, patch: Partial<Settings>) =>
    updateSettings(patch)
  )

  /*
   * There is no settings-only `.json` export any more, only the bundle. Two export buttons
   * asked the user a question they had no way to weigh - both carry everything that cannot
   * be reproduced, and the only difference is whether the receiving machine spends a minute
   * rebuilding caches - and the bigger file is always the better answer. `exportBackup()`
   * lives on because it is the bundle's settings section, and `.json` files already written
   * still import below.
   */

  /**
   * Step one of an import: read the file and say what is in it.
   *
   * Nothing is applied here. Most of what a backup carries is keyed by absolute path, and
   * on a machine where those paths mean nothing - a Mac reading a Windows export - folding
   * it in would fill the store with entries that can never match a file. So the renderer
   * gets a summary, asks where each folder lives now, and sends the answer back.
   */
  ipcMain.handle(
    'store:readBackup',
    async (): Promise<{
      backup?: SettingsBackup
      summary?: BackupSummary
      here?: 'windows' | 'posix'
      path?: string
      /** Set when the chosen file is a `.umak` bundle, which the renderer restores instead. */
      bundle?: BundleHeader
      error?: string
    }> => {
      if (!mainWindow) return { error: 'No window.' }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import umakbang settings',
        properties: ['openFile'],
        // One dialog for both, because from the user's side there is one thing here: the
        // file umakbang wrote. Which of the two it is, is the file's business.
        filters: [
          { name: 'umakbang settings or bundle', extensions: ['json', BUNDLE_EXTENSION] },
          { name: 'umakbang settings', extensions: ['json'] },
          { name: 'umakbang bundle', extensions: [BUNDLE_EXTENSION] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return {}

      // Sniffed rather than taken from the extension: a bundle renamed to .json would
      // otherwise be read as text and reported as corrupt.
      if (await looksLikeBundle(result.filePaths[0])) {
        const header = await readBundleHeader(result.filePaths[0])
        if (!header) return { error: "That doesn't look like a umakbang bundle." }
        return { bundle: header, path: result.filePaths[0] }
      }

      try {
        const parsed = JSON.parse(await readFile(result.filePaths[0], 'utf8')) as SettingsBackup
        if (parsed?.kind !== 'umakbang-settings' || typeof parsed.settings !== 'object') {
          return { error: "That doesn't look like a umakbang settings file." }
        }
        return {
          backup: parsed,
          summary: summariseBackup(parsed),
          here: isWindows ? 'windows' : 'posix',
          path: result.filePaths[0]
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /** Step two: apply it, with every path translated through the folders the user picked. */
  ipcMain.handle(
    'store:applyBackup',
    (
      _event,
      backup: SettingsBackup,
      mapping: FolderMapping
    ): {
      data: UserData
      kept: RemapResult['kept']
      dropped: RemapResult['dropped']
      adopted: LibraryRoot[]
    } => {
      const remapped = remapBackup(backup, mapping)
      importBackup(remapped.backup)
      return {
        data: getUserData(),
        kept: remapped.kept,
        dropped: remapped.dropped,
        adopted: adoptExportedRoots(backup, mapping)
      }
    }
  )

  /**
   * The whole profile in one file: settings plus the index, probe cache and waveforms.
   *
   * A separate action from the `.json` export rather than a checkbox on it, because the two
   * are for different things. The JSON is small, readable and portable between machines,
   * and it is what the folder-mapping wizard was built for. This is a restore of *this*
   * machine - or of a stick that carries the library with it - and it trades all of that
   * for not spending a minute rebuilding caches that already exist.
   */
  /*
   * Deliberately two calls rather than one.
   *
   * Compressing 300MB takes the better part of half a minute, and with the dialog and the
   * write behind a single `await` the renderer cannot tell "waiting for the user to choose a
   * name" from "working" - so it can say nothing at all, and what the user sees instead is a
   * `.part` file appearing beside the name they just typed. Picking first lets the renderer
   * say what is happening for the part that takes the time.
   */
  /** `umakbang-2026-07-27.umak`, in local time - a backup is stamped with the user's day. */
  const bundleName = (): string => {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    return `umakbang-${stamp}.${BUNDLE_EXTENSION}`
  }

  /**
   * Where Export writes without asking.
   *
   * The dialog is still there behind "Export to…", but it should not be the price of the
   * ordinary case: the folder has been chosen once, in Settings, and every export after that
   * is one button. The folder is created here rather than inside `writeBundle`, so a folder
   * that cannot be made is reported before the renderer says it is writing anything.
   */
  ipcMain.handle('store:defaultBundlePath', (): { path?: string; error?: string } => {
    const dir = getUserData().settings.bundleExportDir || backupsDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      return { error: `Could not create ${dir}: ${error instanceof Error ? error.message : error}` }
    }
    return { path: join(dir, bundleName()) }
  })

  ipcMain.handle('store:pickBundlePath', async (): Promise<{ path?: string; error?: string }> => {
    if (!mainWindow) return { error: 'No window.' }
    const dir = getUserData().settings.bundleExportDir || backupsDir()
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export umakbang library bundle',
      // Opened in the configured folder rather than wherever the last save dialog was, since
      // that is where every other bundle on this machine already is.
      defaultPath: join(dir, bundleName()),
      filters: [{ name: 'umakbang bundle', extensions: [BUNDLE_EXTENSION] }]
    })
    if (result.canceled || !result.filePath) return {}
    return { path: result.filePath }
  })

  ipcMain.handle(
    'store:writeBundle',
    async (_event, file: string): Promise<{ path?: string; error?: string }> => {
      try {
        await writeBundle(file)
        return { path: file }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * Unpacks a bundle, then applies its settings the same way an import always did.
   *
   * The caches land only for library folders that are on this machine at the same absolute
   * path (`fitFor`). The settings go in whole when every folder is present, and through the
   * mapping wizard when they are not - which is why this can hand a backup back to the
   * renderer rather than always finishing the job itself.
   */
  ipcMain.handle(
    'store:restoreBundle',
    async (
      _event,
      file: string
    ): Promise<{
      applied?: boolean
      backup?: SettingsBackup
      summary?: BackupSummary
      here?: 'windows' | 'posix'
      restored?: string[]
      skipped?: string[]
      peaks?: number
      metadataLines?: number
      data?: UserData
      error?: string
    }> => {
      try {
        const header = await readBundleHeader(file)
        if (!header) return { error: "That doesn't look like a umakbang bundle." }

        const fit = fitFor(header.exportedRoots)
        const restore = await restoreBundle(file)
        const backup = restore.settings

        // Every folder is here, so there is nothing to map and nothing to ask: fold the
        // settings straight in, the way a restore onto the machine that wrote it should.
        if (backup && fit.missing.length === 0) {
          importBackup(backup)
          // `roots` is LOCAL_ONLY, so the import above never opens the bundle's library
          // folders - on a machine with fresh settings (a reinstall, the main reason
          // bundles exist) that ended on the welcome screen with a fully restored index
          // nothing was pointed at. Every folder is here at its own path, so the mapping
          // the wizard would have asked for is the identity.
          const identity: FolderMapping = {}
          for (const root of backup.exportedRoots ?? []) identity[root.path] = root.path
          if (backup.exportedRoot) identity[backup.exportedRoot] ??= backup.exportedRoot
          adoptExportedRoots(backup, identity)
          void offerRestart(mainWindow)
          return {
            applied: true,
            data: getUserData(),
            restored: restore.restored,
            skipped: restore.skipped,
            peaks: restore.peaks,
            metadataLines: restore.metadataLines
          }
        }

        // Some folder moved. The caches for it were skipped above; the settings still have
        // to be translated, so hand them to the wizard exactly as `store:readBackup` does.
        if (!backup) return { error: 'That bundle has no settings in it.' }
        return {
          applied: false,
          backup,
          summary: summariseBackup(backup),
          here: isWindows ? 'windows' : 'posix',
          restored: restore.restored,
          skipped: restore.skipped,
          peaks: restore.peaks,
          metadataLines: restore.metadataLines
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('store:setTags', (_event, path: string, tags: string[]) => setTags(path, tags))

  ipcMain.handle('store:setRating', (_event, path: string, rating: number) =>
    setRating(path, rating)
  )
  ipcMain.handle('store:setDetectedBpm', (_event, path: string, bpm: number) => {
    setDetectedBpm(path, bpm)
  })
  ipcMain.handle('store:setNote', (_event, path: string, note: string) => {
    setNote(path, note)
  })

  ipcMain.handle('store:setDetectedKey', (_event, path: string, key: string, fit?: number) => {
    setDetectedKey(path, key, fit)
  })
  ipcMain.handle('store:clearDetected', (_event, paths: string[]) => {
    clearDetected(paths)
  })

  /**
   * Starts a native file drag so tracks can be dropped straight into a DAW. `on` rather
   * than `handle`: startDrag takes over the mouse and never resolves a reply.
   */
  // Temporary: every drag gesture reports itself, so a drag that does nothing still
  // leaves a trace of what the renderer saw.
  ipcMain.on('drag:diag', (_event, message: string) => {
    try {
      appendFileSync(
        join(getDataDir(), 'umakbang-drag.log'),
        `[${new Date().toISOString()}] renderer: ${message}
`,
        'utf8'
      )
    } catch {
      /* diagnostics only */
    }
  })

  ipcMain.on('drag:start', (event, paths: string[]) => {
    // Temporary diagnostics: a native drag that silently does nothing leaves no other
    // trace, and every step below can fail without raising anything.
    const note = (message: string): void => {
      try {
        appendFileSync(
          join(getDataDir(), 'umakbang-drag.log'),
          `[${new Date().toISOString()}] ${message}
`,
          'utf8'
        )
      } catch {
        // Diagnostics must never be the thing that breaks the drag.
      }
    }

    if (!Array.isArray(paths) || paths.length === 0) return note('ignored: no paths')
    if (event.sender.isDestroyed()) return note('ignored: sender destroyed')

    const present = paths.filter((path) => typeof path === 'string' && existsSync(path))
    if (present.length === 0) return note(`ignored: none of ${paths.length} paths exist`)

    if (dragInFlight) return note('ignored: a drag is already running')
    dragInFlight = true

    const icon = dragIcon()
    if (icon.isEmpty()) {
      dragInFlight = false
      return note('ignored: drag icon is empty')
    }

    const startedAt = Date.now()
    note(`startDrag: ${present.length} file(s), first=${present[0]}`)
    try {
      event.sender.startDrag({ file: present[0], files: present, icon })
      note(`startDrag returned after ${Date.now() - startedAt}ms`)
    } catch (error) {
      note(`startDrag threw: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      dragInFlight = false
    }
  })

  ipcMain.handle('library:pickFolder', () => pickAndOpenFolder())
  ipcMain.handle('library:open', (_event, path: string) => {
    const { settings, added } = addRoot(path)
    if (added) scanAdditional(added, settings.roots)
    return added?.path ?? null
  })
  ipcMain.handle('library:addFolder', () => pickAndOpenFolder())
  ipcMain.handle('library:removeFolder', (_event, label: string) => {
    const dropped = getUserData().settings.roots.find((root) => root.label === label)
    const settings = removeRoot(label)
    // Removing the folder from the library is the moment its saved index stops being
    // worth anything - left behind it is a 200MB file nothing will ever read again, or
    // worse, replay stale rows if the same folder is re-added someday.
    if (dropped) clearIndex(dropped.path)
    // A full reset: the renderer's index is one flat list with no idea which folder each
    // row came from, so the only way to drop one folder's rows is to rebuild from what's
    // left. The saved indexes make that a second, not a rescan.
    beginScan(settings.roots)
    return settings.roots
  })
  /** The explorer moved: watch where it is now, and stop watching where it was. */
  ipcMain.handle('library:watchFolder', (_event, dir: string | null) => {
    watchFolder(dir)
    return dir
  })

  /**
   * Reads the headers of a handful of files, for the ones a folder refresh found new or
   * changed.
   *
   * The scanner owns this during a scan, and it stays there - this is the same parser
   * called directly for the two or three files a save touched, which is not worth waking
   * a whole pass for.
   */
  ipcMain.handle('library:probeFiles', async (_event, paths: string[]) => {
    const patches: Array<{ path: string; meta: Awaited<ReturnType<typeof probeFile>> }> = []
    for (const path of paths.slice(0, 64)) {
      try {
        patches.push({ path, meta: await probeFile(path, extensionOf(path)) })
      } catch {
        // A file mid-write reads as nothing; the next change event will catch it.
      }
    }
    return patches
  })

  /* --- contracts --- */

  ipcMain.handle('contracts:get', () => getContractData())
  ipcMain.handle('contracts:saveProfile', (_event, profile) => saveContractProfile(profile))
  ipcMain.handle('contracts:saveTemplate', (_event, template: string) =>
    saveContractTemplate(template)
  )
  ipcMain.handle('contracts:savePreset', (_event, preset) => saveContractPreset(preset))
  ipcMain.handle('contracts:deletePreset', (_event, key: string) => deleteContractPreset(key))
  ipcMain.handle('contracts:deleteRecord', (_event, id: string) => deleteContractRecord(id))
  ipcMain.handle('contracts:setOutputDir', (_event, dir: string) => setContractOutputDir(dir))

  /** The contract as it would print, for the live preview. Writes nothing. */
  ipcMain.handle('contracts:preview', (_event, input): string => previewContract(input))
  ipcMain.handle('contracts:generate', async (_event, input) => {
    const result = await generateContract(input, '')
    return { ...result, data: getContractData() }
  })

  /** The refresh button - the same re-read the watcher does, asked for by hand. */
  ipcMain.handle('library:refreshFolder', async (_event, dir: string) => {
    await refreshFolder(dir)
    return dir
  })

  ipcMain.handle('library:rescan', () => {
    const roots = getUserData().settings.roots
    // The only pass that visits every folder for real. A launch replays the index and then
    // skips folders whose mtime has not moved, which cannot see a file overwritten in place -
    // and "rescan" is precisely the button for when you believe the library is wrong.
    beginScan(roots, true)
    return roots
  })

  /**
   * Runs the user's own key-detection tool over one file.
   *
   * `{file}` in the template becomes the path. The command's stdout is the answer; the
   * renderer decides whether what came back is a key it recognises.
   */
  ipcMain.handle(
    'analysis:externalKey',
    (_event, template: string, path: string): Promise<string | null> => {
      if (!template.trim() || !existsSync(path)) return Promise.resolve(null)
      const command = template.replaceAll('{file}', path)

      return new Promise((resolve) => {
        execFile(
          process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
          // Generous, because these tools decode the file; bounded, because one that hangs
          // must not stall the queue behind it.
          { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 64 },
          (error, stdout) => resolve(error ? null : stdout.trim())
        )
      })
    }
  )

  /**
   * Separates stems through LALAL.AI. One file at a time: the service bills by the audio
   * minute and the upload is the user's own material, so this is never speculative work.
   */
  ipcMain.handle(
    'stems:split',
    async (event, paths: string[], options: StemOptions): Promise<StemOutcome[]> => {
      if (!Array.isArray(paths) || paths.length === 0) return []
      if (!options?.licenseKey) {
        return paths.map((path) => ({ path, written: [], error: 'No LALAL.AI key is set.' }))
      }

      const report = (progress: StemProgress): void => {
        if (!event.sender.isDestroyed()) event.sender.send('stems:progress', progress)
      }

      const outcomes: StemOutcome[] = []
      for (const path of paths) {
        outcomes.push(await splitOne(path, options, report))
      }
      return outcomes
    }
  )

  /** How much processing the account has left, so a batch can be judged before it starts. */
  ipcMain.handle('stems:minutesLeft', (_event, licenseKey: string) => minutesLeft(licenseKey))

  ipcMain.handle('peaks:get', (_event, path: string) => getPeaks(path))
  ipcMain.handle('peaks:forget', (_event, paths: string[]) => {
    forgetPeaks(paths)
  })

  ipcMain.handle('peaks:put', (_event, path: string, data: string) => {
    putPeaks(path, data)
  })

  /**
   * The index on disk still has the old paths until a full scan runs, and replaying it
   * would resurrect rows for files that have moved. Every operation that touches the
   * filesystem records what it did, here, in one place.
   */
  function journal(result: TransferResult | TrashResult): void {
    const roots = getUserData().settings.roots
    if (roots.length === 0) return
    const added = 'items' in result ? result.items.map((item) => item.track) : []
    // Each folder keeps its own index, so a move between two of them has to be written to
    // both: removed from one, added to the other.
    for (const root of roots) {
      const mine = added.filter((track) => rootFor(roots, track.path)?.label === root.label)
      const gone = result.removed.filter((path) => rootFor(roots, path)?.label === root.label)
      if (mine.length === 0 && gone.length === 0) continue
      appendIndexPatch(root.path, { removed: gone, added: mine })
    }
  }

  ipcMain.handle(
    'fs:transfer',
    async (
      _event,
      paths: string[],
      destination: string,
      mode: TransferMode
    ): Promise<TransferResult> => {
      const result = await transfer(paths, destination, mode, getUserData().settings.roots)
      journal(result)
      return result
    }
  )

  ipcMain.handle('fs:rename', async (_event, path: string, newName: string) => {
    const result = await renameEntry(path, newName, getUserData().settings.roots)
    journal(result)
    return result
  })

  ipcMain.handle('fs:trash', async (_event, paths: string[]): Promise<TrashResult> => {
    const result = await trashEntries(paths, getUserData().settings.roots)
    journal(result)
    return result
  })

  ipcMain.handle('fs:createFolder', (_event, parent: string, name: string) =>
    createFolder(parent, name)
  )

  /**
   * Writes a piece the user cut out of a track, beside the track it came from.
   *
   * This is the second thing in the app that produces an audio file rather than moving one,
   * so it is held to the same rule as the rest: it can only ever create. The `wx` flag is
   * what actually enforces that - the `existsSync` above it is there to give a sentence the
   * user can read, but it is a check with a gap after it, and a trim is minutes of decoding
   * and encoding away from the moment that check ran. An exclusive create is the part that
   * cannot lose a take.
   *
   * Nothing is written to the index journal. A new file moves its folder's mtime, which is
   * precisely what the scan's revalidation skip looks at, so the next launch reads the
   * folder for real; the renderer's own list is caught up by `library:refreshFolder`.
   */
  ipcMain.handle(
    'fs:saveTrim',
    async (
      _event,
      source: string,
      name: string,
      bytes: Uint8Array
    ): Promise<{ path?: string; error?: string }> => {
      const invalid = nameError(name)
      if (invalid) return { error: invalid }
      if (!bytes || bytes.byteLength === 0) return { error: 'There was nothing to write.' }
      if (!existsSync(source)) return { error: 'The file this came from is no longer there.' }

      const target = join(dirname(source), name.trim())
      if (existsSync(target)) return { error: 'Something with that name is already there.' }
      try {
        await writeFile(target, bytes, { flag: 'wx' })
        return { path: target }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return { error: 'Something with that name is already there.' }
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )


  /**
   * Picks a folder without opening it as a library - for choosing where things get filed.
   */
  ipcMain.handle(
    'fs:pickDirectory',
    async (_event, title?: string, startIn?: string): Promise<string | null> => {
      if (!mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, {
        title: title ?? 'Choose a folder',
        ...(startIn ? { defaultPath: startIn } : {}),
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Choose'
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  )

  /**
   * Which of these paths are folders that exist. The import wizard guesses where a
   * backup's folders went and asks this before believing any of it, so a guess that is
   * wrong simply doesn't fire rather than filling the mapping with places that aren't
   * there. Capped because it is driven by a list the wizard generates.
   */
  ipcMain.handle('fs:directoriesExist', async (_event, paths: string[]): Promise<string[]> => {
    const wanted = (paths ?? []).slice(0, 2000)
    const checked = await Promise.all(
      wanted.map(async (path) => {
        try {
          return (await stat(path)).isDirectory() ? path : null
        } catch {
          // Not there, or not readable - either way it is not somewhere to map onto.
          return null
        }
      })
    )
    return checked.filter((path): path is string => path !== null)
  })

  /**
   * The Downloads folder, listed on demand rather than indexed. It sits outside the
   * library root and churns constantly, so folding it into the scan would be wrong -
   * it's a staging area you file things *out* of.
   */
  ipcMain.handle('fs:listDownloads', async (): Promise<Track[]> => {
    const root = app.getPath('downloads')
    const tracks: Track[] = []
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const ext = extensionOf(entry.name)
        if (!isIndexable(ext)) continue
        const full = join(root, entry.name)
        try {
          const info = await stat(full)
          tracks.push({
            path: full,
            rel: entry.name,
            dir: root,
            relDir: '',
            name: entry.name,
            ext,
            size: info.size,
            mtimeMs: info.mtimeMs,
            kind: classifyKind(ext),
            playable: PLAYABLE_EXTENSIONS.has(ext)
          })
        } catch {
          // Skip anything that vanished between listing and stat.
        }
      }
    } catch {
      return []
    }
    // Newest first: what you just downloaded is what you came for.
    return tracks.sort((a, b) => b.mtimeMs - a.mtimeMs)
  })

  /**
   * The icon the OS itself shows for a file - the real FL Studio logo for a `.flp`,
   * whatever is registered for `.wav`. Asked for once per extension by the renderer, which
   * is why this can afford to be a shell call.
   *
   * Size 'normal' is 32px: it downsamples to the row's 14px cleanly, where the 16px
   * 'small' icon lands between pixels on a scaled display.
   */
  ipcMain.handle('shell:fileIcon', async (_event, path: string): Promise<string | null> => {
    try {
      const icon = await app.getFileIcon(path, { size: 'normal' })
      return icon.isEmpty() ? null : icon.toDataURL()
    } catch {
      // No association, or the file went away - the renderer falls back to its own glyph.
      return null
    }
  })

  ipcMain.handle('shell:reveal', (_event, path: string) => {
    shell.showItemInFolder(path)
  })
  ipcMain.handle('shell:open', async (_event, path: string) => {
    const error = await shell.openPath(path)
    return error || null
  })
  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    clipboard.writeText(text)
  })

  /**
   * Puts the actual files on the system clipboard, so a paste in Explorer copies them
   * rather than writing their paths into a text box.
   *
   * Electron's clipboard has no file-list API, and the Windows format for it (CF_HDROP) is
   * a predefined one that `writeBuffer` can't name. A native module would do it, at the
   * cost of a rebuild per Electron version and per platform, which is exactly the trade
   * this app avoids everywhere else. So PowerShell sets it: `SetDataObject` with the copy
   * flag hands ownership to the system, so the data outlives the process.
   *
   * The text flavour goes on at the same time, because a path pasted into a DAW's file
   * dialog or a terminal is the other half of what people use this for.
   *
   * Resolves false where this isn't available, and the caller keeps the text-only
   * behaviour rather than reporting a failure nobody can act on.
   */
  ipcMain.handle('clipboard:writeFiles', async (_event, paths: string[]): Promise<boolean> => {
    if (!isWindows || !Array.isArray(paths) || paths.length === 0) return false

    // The list goes through a file: a command line is capped near 32k characters and a
    // multi-select in a sample library runs past that easily. Serial-numbered as well as
    // pid-keyed, because two copies in quick succession overlap - the PowerShell run takes
    // up to 10s, and the second copy would otherwise overwrite the list the first one is
    // about to read, then have its own list deleted by the first one's cleanup.
    const listFile = join(
      app.getPath('temp'),
      `umakbang-clipboard-${process.pid}-${++clipboardSerial}.txt`
    )
    try {
      await writeFile(listFile, paths.join('\n'), 'utf8')
    } catch {
      return false
    }

    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$lines = [System.IO.File]::ReadAllLines('${listFile.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)`,
      '$files = New-Object System.Collections.Specialized.StringCollection',
      'foreach ($p in $lines) { if ($p) { [void]$files.Add($p) } }',
      '$data = New-Object System.Windows.Forms.DataObject',
      '$data.SetFileDropList($files)',
      '$data.SetText([String]::Join([Environment]::NewLine, $lines))',
      '[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)'
    ].join('; ')

    return new Promise<boolean>((resolve) => {
      // -STA because the Windows clipboard is single-threaded-apartment only.
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { windowsHide: true, timeout: 10_000 },
        (error) => {
          void rm(listFile, { force: true }).catch(() => undefined)
          resolve(!error)
        }
      )
    })
  })

  /**
   * Visualizers-only shrinks the window to a wide, short strip. The full-size bounds and
   * the normal minimums are stashed so leaving the mode puts everything back - the
   * 560px minimum height would otherwise refuse the compact size outright.
   */
  ipcMain.handle('window:setCompact', (_event, compact: boolean) => {
    if (!mainWindow) return
    if (compact) {
      if (!restoreBounds) restoreBounds = mainWindow.getBounds()
      mainWindow.setMinimumSize(360, 120)
      const { x, y, width } = mainWindow.getBounds()
      const height = 210
      mainWindow.setBounds({ x, y, width: Math.min(width, 1100), height }, true)
    } else {
      mainWindow.setMinimumSize(900, 560)
      if (restoreBounds) mainWindow.setBounds(restoreBounds, true)
      restoreBounds = null
    }
  })

  /**
   * The mini player: a small square parked at the top of the display, over everything
   * else. Always-on-top is part of the mode rather than a separate switch - a mini player
   * you have to hunt for behind a DAW is no use - so leaving it restores whatever the
   * pin toggle was set to.
   */
  ipcMain.handle('window:setMini', (_event, mini: boolean) => {
    if (!mainWindow) return
    if (mini) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      if (!restoreBounds) restoreBounds = mainWindow.getBounds()
      mainWindow.setMinimumSize(MINI_SIZE, MINI_SIZE)
      const { workArea } = screen.getDisplayMatching(restoreBounds)
      // Content bounds, not window bounds: on Windows the window rectangle takes in the
      // invisible resize border, so sizing that leaves a square that doesn't look it.
      mainWindow.setContentBounds(
        {
          x: Math.round(workArea.x + (workArea.width - MINI_SIZE) / 2),
          y: workArea.y + MINI_TOP_MARGIN,
          width: MINI_SIZE,
          height: MINI_SIZE
        },
        true
      )
      mainWindow.setAlwaysOnTop(true, 'floating')
      return
    }

    mainWindow.setMinimumSize(900, 560)
    if (restoreBounds) mainWindow.setBounds(restoreBounds, true)
    restoreBounds = null
    mainWindow.setAlwaysOnTop(getUserData().settings.alwaysOnTop, 'floating')
  })

  ipcMain.handle('window:setAlwaysOnTop', (_event, pinned: boolean) => {
    // 'floating' keeps it above ordinary windows without fighting the taskbar or
    // full-screen apps for the very top of the stack.
    mainWindow?.setAlwaysOnTop(pinned, 'floating')
    return pinned
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)
}

/* ------------------------------------------------------------------ lifecycle */

// First, before anything at all resolves a path.
//
// `requestSingleInstanceLock` writes its lock file into `userData`, and `crashReporter`
// puts dumps in a folder under it - so both have to come after the redirect or a portable
// copy still writes to the host it is plugged into. The lock is the one that bites twice:
// resolved against the default location, a portable copy shares a lock with an installed
// one, so running umakbang off a stick on a machine that already has it just focuses the
// installed copy and quits.
const portableChoice = usePortableDataDir()

// A second instance would fight over the same JSON store, so hand focus back instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  // Local crash dumps. Nothing is uploaded anywhere; this only means that when the app
  // does go down there is a minidump in `app.getPath('crashDumps')` to look at, instead of
  // the silent disappearance a native crash otherwise leaves behind.
  crashReporter.start({ uploadToServer: false })

  void app.whenReady().then(() => {
    // Said out loud because the failure it guards against is silent: a marker folder that
    // could not be written to falls back to the usual location, and a portable copy quietly
    // keeping its settings on the host machine looks exactly like one that worked.
    if (portableChoice.portable) {
      console.log(`umakbang: portable, data in ${portableChoice.dir}`)
    } else if (portableChoice.reason && portableChoice.reason !== 'development build') {
      console.log(`umakbang: not portable (${portableChoice.reason}), data in ${portableChoice.dir}`)
    }
    initStore()
    initContracts(getDataDir(), app.getPath('documents'))
    // The scanner owns the index, but moves and renames happen here, and they have to be
    // recorded or the next launch replays a file at a path it no longer has.
    initIndexStore(getDataDir())
    // umakbang is a dark app; telling Chromium so keeps native bits - scrollbars, form
    // controls, the caption buttons - from rendering light against it.
    nativeTheme.themeSource = 'dark'
    registerFileProtocol()
    enableSystemAudioCapture()
    registerIpc()
    buildMenu()
    createWindow()
    // Reads the release feed and stages anything newer; it installs on quit rather than
    // interrupting. Deliberately after the window exists, since it reports to it.
    initUpdater(() => mainWindow)
    // One bundle a day into `backups`, with no button to press and nothing to switch on.
    // Its first check is minutes away, deliberately: the scan starting now is the busiest
    // this process ever is, and it defers again if that scan is still going.
    initAutoBackup(() => scanning)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Standard macOS behaviour is to stay resident until the user quits explicitly.
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    send({ type: 'cancel' })
    scanner?.kill()
    flushStore()
  })
}
