import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { toUmakbangFileUrl } from '../shared/url'
import type { BackupSummary, FolderMapping, SettingsBackup } from '../shared/backup'
import type { BundleHeader } from '../shared/bundle'
import type {
  ContractData,
  ContractInput,
  ContractPreset,
  ContractProfile,
  ContractRecord
} from '../shared/contracts'
import type {
  CaptureSettings,
  CaptureSource,
  Recording,
  VideoData,
  VideoProject
} from '../shared/video'
import type {
  LibraryRoot,
  MetadataPatch,
  PlatformInfo,
  ScanProgress,
  Settings,
  Track,
  TransferMode,
  TransferResult,
  TrashResult,
  UndoOutcome,
  UndoProgress,
  UndoSummary,
  UserData,
  StemOptions as StemSplitOptions,
  StemOutcome,
  StemProgress,
  UpdateStatus
} from '../shared/types'

/** Wraps an ipcRenderer subscription so callers get a plain unsubscribe function. */
function subscribe<T extends unknown[]>(
  channel: string,
  handler: (...args: T) => void
): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    handler(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /* --- environment --- */
  getPlatform: (): Promise<PlatformInfo> => ipcRenderer.invoke('app:platform'),
  /** Builds the URL used to stream a local file into an <audio> element. */
  fileUrl: (path: string): string => toUmakbangFileUrl(path),

  /* --- persisted state --- */
  getUserData: (): Promise<UserData> => ipcRenderer.invoke('store:userData'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('store:updateSettings', patch),
  setTags: (path: string, tags: string[]): Promise<Record<string, string[]>> =>
    ipcRenderer.invoke('store:setTags', path, tags),
  setRating: (path: string, rating: number): Promise<Record<string, number>> =>
    ipcRenderer.invoke('store:setRating', path, rating),
  setDetectedBpm: (path: string, bpm: number): Promise<void> =>
    ipcRenderer.invoke('store:setDetectedBpm', path, bpm),
  setDetectedKey: (path: string, key: string, fit?: number): Promise<void> =>
    ipcRenderer.invoke('store:setDetectedKey', path, key, fit),
  /** Whatever the user wrote about a file. An empty note removes it. */
  setNote: (path: string, note: string): Promise<void> =>
    ipcRenderer.invoke('store:setNote', path, note),
  /** Forgets analysed tempo and key for these files, so they are worked out again. */
  clearDetected: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke('store:clearDetected', paths),

  /**
   * The whole profile - settings plus the file index, probe cache and cached waveforms -
   * as one gzipped `.umak` file, so restoring a machine doesn't mean rescanning it.
   *
   * Split in two so the renderer can tell choosing a name from writing to it: the write is
   * tens of seconds on a large library and needs saying out loud.
   */
  /** Where Export writes without asking: the configured folder, with today's file name. */
  defaultBundlePath: (): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('store:defaultBundlePath'),
  pickBundlePath: (): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('store:pickBundlePath'),
  writeBundle: (file: string): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('store:writeBundle', file),
  /**
   * Unpacks one. Resolves with `applied` when every library folder was already here and
   * there was nothing to map; otherwise with a backup for the mapping wizard, the caches
   * for any folder that moved having been skipped.
   */
  restoreBundle: (
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
  }> => ipcRenderer.invoke('store:restoreBundle', file),
  /**
   * Step one: read a backup and report what it refers to. Applies nothing.
   *
   * Takes `.json` and `.umak` alike. A bundle comes back as `bundle` plus its `path`, which
   * is the caller's cue to call `restoreBundle` with it rather than the wizard.
   */
  readBackup: (): Promise<{
    backup?: SettingsBackup
    summary?: BackupSummary
    here?: 'windows' | 'posix'
    path?: string
    bundle?: BundleHeader
    error?: string
  }> => ipcRenderer.invoke('store:readBackup'),
  /**
   * Step two: apply it, translating every path through the folders the user chose.
   *
   * `adopted` is the library folders that were located and are now open here - an import
   * that mapped one has opened it, and the scan for it is already under way.
   */
  applyBackup: (
    backup: SettingsBackup,
    mapping: FolderMapping
  ): Promise<{
    data: UserData
    kept: Record<string, number>
    dropped: Record<string, number>
    adopted: LibraryRoot[]
  }> => ipcRenderer.invoke('store:applyBackup', backup, mapping),

  /** Hands the OS a native file drag so tracks can be dropped into a DAW. */
  startDrag: (paths: string[]): void => ipcRenderer.send('drag:start', paths),
  /** Temporary drag diagnostics. */
  logDrag: (message: string): void => ipcRenderer.send('drag:diag', message),

  /* --- contracts --- */
  contracts: (): Promise<ContractData> => ipcRenderer.invoke('contracts:get'),
  saveContractProfile: (profile: Partial<ContractProfile>): Promise<ContractData> =>
    ipcRenderer.invoke('contracts:saveProfile', profile),
  saveContractTemplate: (template: string): Promise<ContractData> =>
    ipcRenderer.invoke('contracts:saveTemplate', template),
  saveContractPreset: (preset: ContractPreset): Promise<ContractData> =>
    ipcRenderer.invoke('contracts:savePreset', preset),
  deleteContractPreset: (key: string): Promise<ContractData> =>
    ipcRenderer.invoke('contracts:deletePreset', key),
  deleteContractRecord: (id: string): Promise<ContractData> =>
    ipcRenderer.invoke('contracts:deleteRecord', id),
  setContractOutputDir: (dir: string): Promise<ContractData> =>
    ipcRenderer.invoke('contracts:setOutputDir', dir),
  /**
   * The contract rendered as it would print, for the live preview. Writes nothing, and is
   * lenient about half-filled input so the panel is never blank while the form is typed.
   */
  previewContract: (input: ContractInput): Promise<string> =>
    ipcRenderer.invoke('contracts:preview', input),
  generateContract: (
    input: ContractInput
  ): Promise<{ record?: ContractRecord; error?: string; data: ContractData }> =>
    ipcRenderer.invoke('contracts:generate', input),

  /* --- videos --- */
  videoData: (): Promise<VideoData> => ipcRenderer.invoke('videos:get'),
  saveVideoProject: (project: VideoProject): Promise<VideoData> =>
    ipcRenderer.invoke('videos:saveProject', project),
  deleteVideoProject: (id: string): Promise<VideoData> =>
    ipcRenderer.invoke('videos:deleteProject', id),
  saveCaptureSettings: (patch: Partial<CaptureSettings>): Promise<VideoData> =>
    ipcRenderer.invoke('videos:saveCapture', patch),
  setVideoOutputDir: (dir: string): Promise<VideoData> =>
    ipcRenderer.invoke('videos:setOutputDir', dir),
  pickVideoOutputDir: (): Promise<string | null> => ipcRenderer.invoke('videos:pickOutputDir'),
  /** Forgets a take. `deleteFile` also removes it from disk, which is asked separately. */
  removeRecording: (id: string, deleteFile: boolean): Promise<VideoData> =>
    ipcRenderer.invoke('videos:removeRecording', id, deleteFile),
  /** Screens and windows, each with a thumbnail, for the capture picker. */
  captureSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('videos:sources'),
  /** Asks for audio, video or an image to bring in as a layer. */
  pickMedia: (kind: 'audio' | 'video' | 'image'): Promise<string | null> =>
    ipcRenderer.invoke('videos:pickMedia', kind),
  /**
   * Opens a file and streams to it.
   *
   * Three calls rather than one because a recording is hundreds of megabytes arriving as a
   * stream of chunks: it is appended to an open handle as it comes, so neither process ever
   * holds a whole video. `finishVideoWrite` renames the `.part` into place and, for a
   * recording, lists it.
   */
  beginVideoWrite: (
    kind: 'recording' | 'export',
    name: string,
    ext: string
  ): Promise<{ id: string; path: string } | { error: string }> =>
    ipcRenderer.invoke('videos:beginWrite', kind, name, ext),
  writeVideoChunk: (id: string, bytes: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke('videos:writeChunk', id, bytes),
  finishVideoWrite: (
    id: string,
    meta: {
      durationMs: number
      width: number
      height: number
      source: 'screen' | 'window' | 'camera'
      sourceName: string
    } | null
  ): Promise<{ path?: string; size?: number; recording?: Recording; error?: string }> =>
    ipcRenderer.invoke('videos:finishWrite', id, meta),
  abortVideoWrite: (id: string): void => ipcRenderer.send('videos:abortWrite', id),

  /* --- library --- */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('library:pickFolder'),
  openLibrary: (path: string): Promise<string | null> => ipcRenderer.invoke('library:open', path),
  /** Asks for another folder to add to the library. Same dialog as the first one. */
  addLibraryFolder: (): Promise<string | null> => ipcRenderer.invoke('library:addFolder'),
  /** Drops a folder from the library by its label. The files on disk are untouched. */
  removeLibraryFolder: (label: string): Promise<LibraryRoot[]> =>
    ipcRenderer.invoke('library:removeFolder', label),
  rescan: (): Promise<LibraryRoot[]> => ipcRenderer.invoke('library:rescan'),
  /** Watch the folder being browsed, so a file re-exported into it shows up by itself. */
  watchFolder: (dir: string | null): Promise<string | null> =>
    ipcRenderer.invoke('library:watchFolder', dir),
  /** Reads headers for files a refresh found new or changed. */
  probeFiles: (paths: string[]): Promise<MetadataPatch[]> =>
    ipcRenderer.invoke('library:probeFiles', paths),
  /** Re-read one folder now. */
  refreshFolder: (dir: string): Promise<string> =>
    ipcRenderer.invoke('library:refreshFolder', dir),
  onFolderChanged: (
    handler: (payload: { dir: string; tracks: Track[] }) => void
  ): (() => void) => subscribe('library:folder', handler),

  onLibraryReset: (handler: (payload: { roots: LibraryRoot[] }) => void): (() => void) =>
    subscribe('library:reset', handler),
  /** The library gained a folder. Nothing already loaded is thrown away. */
  onLibraryRoots: (handler: (payload: { roots: LibraryRoot[] }) => void): (() => void) =>
    subscribe('library:roots', handler),
  onTracks: (handler: (tracks: Track[]) => void): (() => void) =>
    subscribe('library:tracks', handler),
  onProgress: (handler: (progress: ScanProgress) => void): (() => void) =>
    subscribe('library:progress', handler),
  onMetadata: (handler: (patches: MetadataPatch[]) => void): (() => void) =>
    subscribe('library:metadata', handler),
  onRemoved: (handler: (paths: string[]) => void): (() => void) =>
    subscribe('library:removed', handler),
  /** Something went wrong scanning - a root that couldn't be walked, a scanner crash. */
  onLibraryError: (
    handler: (payload: { stage: string; message: string }) => void
  ): (() => void) => subscribe('library:error', handler),
  /** Something main wants said in-app, like a folder pick that was declined. */
  onLibraryNotice: (handler: (payload: { message: string }) => void): (() => void) =>
    subscribe('library:notice', handler),

  /** Lists indexable files sitting in the OS Downloads folder, newest first. */
  listDownloads: (): Promise<Track[]> => ipcRenderer.invoke('fs:listDownloads'),

  /* --- file operations --- */
  /** Copies or moves files and folders into a folder, creating it if needed. */
  transfer: (paths: string[], destination: string, mode: TransferMode): Promise<TransferResult> =>
    ipcRenderer.invoke('fs:transfer', paths, destination, mode),
  /** Sends files and folders to the OS trash, where they can be got back. */
  trash: (paths: string[]): Promise<TrashResult> => ipcRenderer.invoke('fs:trash', paths),
  /** Creates a folder. Refuses a name that is already taken. */
  createFolder: (parent: string, name: string): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('fs:createFolder', parent, name),
  /**
   * Asks for a folder, without opening it as a library. Null if the user backed out.
   * `startIn` is where the dialog opens, for choices that are only meaningful somewhere
   * particular, such as inside the library.
   */
  pickDirectory: (title?: string, startIn?: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:pickDirectory', title, startIn),
  /**
   * Which of these paths are folders that exist here. The import wizard checks its guesses
   * about where a backup's folders went before acting on any of them.
   */
  directoriesExist: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('fs:directoriesExist', paths),
  /** Renames a file or folder in place. */
  renameEntry: (path: string, newName: string): Promise<TransferResult> =>
    ipcRenderer.invoke('fs:rename', path, newName),
  /**
   * Writes a region cut out of a track as a new file beside it.
   *
   * Refuses to overwrite anything and says so instead: this is the one path that makes
   * audio rather than moving it, and a name that collides has to cost a retype, never a
   * take. Resolves with where it landed so the caller can re-read that folder.
   */
  saveTrim: (
    source: string,
    name: string,
    bytes: Uint8Array
  ): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('fs:saveTrim', source, name, bytes),

  /* --- undo --- */
  /**
   * The last file operation, ready to be reversed, or null when there is nothing.
   *
   * Asked for on mount as well as subscribed to: the record lives in main and survives a
   * renderer reload, so a page that only listened would show nothing until the next
   * operation. `label` is composed in main so the menu, the toolbar and the notice cannot
   * word the same fact three different ways.
   */
  undoState: (): Promise<UndoSummary | null> => ipcRenderer.invoke('undo:current'),
  /**
   * Runs it backwards. Resolves with the reverse operation as an ordinary `TransferResult`,
   * for `applyTransfer`, and an outcome saying how much of it landed.
   *
   * The record is spent either way, including on a partial failure - so this is called once
   * per press and the outcome is the only report there will be.
   */
  runUndo: (
    id: string
  ): Promise<{ result: TransferResult; outcome: UndoOutcome }> =>
    ipcRenderer.invoke('undo:run', id),
  /** Asks a running undo to stop. It stops between files, never inside one. */
  cancelUndo: (): Promise<void> => ipcRenderer.invoke('undo:cancel'),
  onUndoState: (handler: (summary: UndoSummary | null) => void): (() => void) =>
    subscribe('undo:state', handler),
  onUndoProgress: (handler: (progress: UndoProgress) => void): (() => void) =>
    subscribe('undo:progress', handler),

  /** What has been undone and can be put forward again, or null. Same shape as `undoState`. */
  redoState: (): Promise<UndoSummary | null> => ipcRenderer.invoke('redo:current'),
  /** Runs it forwards. Reports on `onUndoProgress`, which serves whichever is running. */
  runRedo: (
    id: string
  ): Promise<{ result: TransferResult; outcome: UndoOutcome }> =>
    ipcRenderer.invoke('redo:run', id),
  onRedoState: (handler: (summary: UndoSummary | null) => void): (() => void) =>
    subscribe('redo:state', handler),
  /** The Edit menu's Redo, which owns Ctrl/⌘+Y for the same reason Undo owns Ctrl/⌘+Z. */
  onMenuRedo: (handler: () => void): (() => void) => subscribe('menu:redo', handler),
  /**
   * The Edit menu's Undo, which owns Ctrl/⌘+Z whether or not there is a file operation to
   * reverse - an application menu accelerator is claimed before the page sees the key, so
   * the renderer has to decide which undo was meant rather than letting the field have it.
   */
  onMenuUndo: (handler: () => void): (() => void) => subscribe('menu:undo', handler),
  /**
   * Chromium's own text undo, for when a text field has focus. There is no way for a page
   * to trigger it - `document.execCommand('undo')` does nothing in a modern Chromium - so it
   * goes through `webContents.undo()` in main.
   */
  textUndo: (): Promise<void> => ipcRenderer.invoke('edit:textUndo'),

  /**
   * The path behind a dropped File. Chromium stopped exposing `File.path` in Electron 32,
   * and this is the only sanctioned way back to it - it has to happen in the preload,
   * where `webUtils` lives.
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /** Runs the user's own key-detection command over a file. Null if it failed. */
  externalKey: (template: string, path: string): Promise<string | null> =>
    ipcRenderer.invoke('analysis:externalKey', template, path),

  /* --- stem separation --- */
  /** Splits stems through LALAL.AI. Resolves once every file has been dealt with. */
  splitStems: (paths: string[], options: StemSplitOptions): Promise<StemOutcome[]> =>
    ipcRenderer.invoke('stems:split', paths, options),
  /** Processing minutes left on the account, or null if it can't be asked. */
  stemMinutesLeft: (licenseKey: string): Promise<number | null> =>
    ipcRenderer.invoke('stems:minutesLeft', licenseKey),
  onStemProgress: (handler: (progress: StemProgress) => void): (() => void) =>
    subscribe('stems:progress', handler),

  /* --- waveform peak cache --- */
  getPeaks: (path: string): Promise<string | null> => ipcRenderer.invoke('peaks:get', path),
  putPeaks: (path: string, data: string): Promise<void> =>
    ipcRenderer.invoke('peaks:put', path, data),
  /** Drops cached waveforms for files whose contents have changed. */
  forgetPeaks: (paths: string[]): Promise<void> => ipcRenderer.invoke('peaks:forget', paths),

  /* --- os integration --- */
  /** The OS's own icon for a file, as a data URL. Null when it has none. */
  fileIcon: (path: string): Promise<string | null> => ipcRenderer.invoke('shell:fileIcon', path),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  openExternally: (path: string): Promise<string | null> => ipcRenderer.invoke('shell:open', path),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),
  /**
   * Puts the files themselves on the system clipboard, so a paste in Explorer copies them.
   * Resolves false where the platform can't, and the caller falls back to the paths.
   */
  copyFiles: (paths: string[]): Promise<boolean> => ipcRenderer.invoke('clipboard:writeFiles', paths),

  /* --- window controls (Windows/Linux draw their own) --- */
  setCompact: (compact: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setCompact', compact),
  /** Shrinks to a square, always-on-top mini player at the top of the display. */
  setMini: (mini: boolean): Promise<void> => ipcRenderer.invoke('window:setMini', mini),
  setAlwaysOnTop: (pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setAlwaysOnTop', pinned),
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  onMaximizedChange: (handler: (maximized: boolean) => void): (() => void) =>
    subscribe('window:maximized', handler),

  /* --- application menu --- */
  /* --- updates --- */
  /**
   * What the updater last did.
   *
   * Asked for on mount as well as subscribed to, because the first check fires half a
   * minute after launch and a renderer that reloads afterwards would otherwise show
   * nothing at all until the next one, twelve hours later.
   */
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  onUpdateStatus: (handler: (status: UpdateStatus) => void): (() => void) =>
    subscribe('update:status', handler),

  onMenuRescan: (handler: () => void): (() => void) => subscribe('menu:rescan', handler),
  onMenuFocusSearch: (handler: () => void): (() => void) => subscribe('menu:focusSearch', handler)
}

export type UmakbangApi = typeof api

contextBridge.exposeInMainWorld('umakbang', api)
