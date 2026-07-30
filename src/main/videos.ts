/**
 * Video projects, recordings and the files both of them write.
 *
 * Shaped like `contracts.ts`: one JSON document owned by main, every write going through
 * here and coming back whole, so there is one copy of the truth rather than two that drift.
 * It is deliberately not in `umakbang-data.json` and not in a settings export - a project
 * refers to absolute paths of recordings on this machine, and a backup that carried them
 * would restore a list of videos made of files that are not there.
 *
 * The interesting part is the writing. A screen recording is hundreds of megabytes and
 * arrives from `MediaRecorder` as a stream of chunks, so it is appended to an open handle as
 * it arrives rather than being collected in the renderer and posted over IPC in one piece.
 * The renderer holding a 400MB `Blob` and then structured-cloning it across the process
 * boundary is two copies of a recording in memory for no reason, and it is exactly the size
 * at which that stops being survivable.
 */

import { app, dialog, desktopCapturer } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { join } from 'node:path'
import { isPortable } from './portable'
import { remuxToProgressive } from './mp4-remux'
import {
  DEFAULT_CAPTURE,
  DEFAULT_VIDEO_DATA,
  type CaptureSettings,
  type CaptureSource,
  type Recording,
  type VideoData,
  type VideoProject
} from '../shared/video'

let file = ''
let recordingsDir = ''
let data: VideoData = { ...DEFAULT_VIDEO_DATA, projects: [], recordings: [] }

/** How many recordings the list keeps before the oldest are forgotten (not deleted). */
const MAX_RECORDINGS = 200

export function initVideos(dataDir: string): void {
  file = join(dataDir, 'umakbang-videos.json')

  // Somewhere a person would look for a video, the way contracts land in Documents. A
  // portable copy keeps them beside itself instead, for the reason stems do: the host's
  // Videos folder is a real place that would work, and the setting is remembered, so the
  // first machine's path would become the target on every later one.
  const fallback = isPortable()
    ? join(dataDir, 'videos')
    : join(videosPath(), 'umakbang videos')

  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<VideoData>
      data = {
        projects: saved.projects ?? [],
        recordings: saved.recordings ?? [],
        outputDir: saved.outputDir || fallback,
        capture: { ...DEFAULT_CAPTURE, ...(saved.capture ?? {}) }
      }
    } catch {
      // A corrupt file starts over rather than stopping the app from opening, like every
      // other cache here.
      data = { ...DEFAULT_VIDEO_DATA, projects: [], recordings: [], outputDir: fallback }
    }
  } else {
    data = { ...DEFAULT_VIDEO_DATA, projects: [], recordings: [], outputDir: fallback }
  }

  recordingsDir = join(data.outputDir, 'recordings')

  // A recording the user deleted in Explorer should not sit in the list forever claiming to
  // exist. Checked once at startup rather than per render: it is one `statSync` each and the
  // list is capped, and the alternative is the renderer discovering it by failing to play.
  data.recordings = data.recordings.filter((entry) => existsSync(entry.path))
}

function videosPath(): string {
  try {
    return app.getPath('videos')
  } catch {
    // Linux without xdg-user-dirs has no such folder. Home is somewhere, which is the point.
    return app.getPath('home')
  }
}

function persist(): void {
  if (!file) return
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Best effort.
  }
}

export function getVideoData(): VideoData {
  return data
}

export function saveVideoProject(project: VideoProject): VideoData {
  const stamped = { ...project, updatedAt: Date.now() }
  const at = data.projects.findIndex((entry) => entry.id === project.id)
  if (at >= 0) data.projects[at] = stamped
  else data.projects.unshift(stamped)
  persist()
  return data
}

export function deleteVideoProject(id: string): VideoData {
  data.projects = data.projects.filter((entry) => entry.id !== id)
  persist()
  return data
}

export function saveCaptureSettings(patch: Partial<CaptureSettings>): VideoData {
  data.capture = { ...data.capture, ...patch }
  persist()
  return data
}

export function setVideoOutputDir(dir: string): VideoData {
  data.outputDir = dir
  recordingsDir = join(dir, 'recordings')
  persist()
  return data
}

/**
 * Forgets a recording, and optionally deletes the file.
 *
 * Two separate things on purpose. Taking a take out of the list is tidying; deleting a
 * gigabyte of capture is not something to do as a side effect of tidying.
 */
export function removeRecording(id: string, deleteFile: boolean): VideoData {
  const entry = data.recordings.find((item) => item.id === id)
  if (entry && deleteFile) {
    try {
      rmSync(entry.path, { force: true })
    } catch {
      // If it will not go, the list entry still goes: the user asked for it gone from here.
    }
  }
  data.recordings = data.recordings.filter((item) => item.id !== id)
  persist()
  return data
}

/**
 * What can be captured, with a thumbnail each.
 *
 * Thumbnails are the expensive part of `getSources` and this is the one caller that wants
 * them: a list of window titles is not enough to pick your DAW out of eleven of them, and
 * "FL Studio 21" appears three times when a plugin editor is open.
 */
export async function listCaptureSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true
  })
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen') ? 'screen' : 'window',
    thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : ''
  }))
}

/* --- streamed writes --------------------------------------------------------------- */

interface OpenWrite {
  stream: WriteStream
  /** Where it will end up. Written to `<path>.part` until it is finished. */
  path: string
  partial: string
  bytes: number
  kind: 'recording' | 'export'
}

const writes = new Map<string, OpenWrite>()

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Adds a counter to a name that is already taken, rather than writing over a take. */
function freePath(dir: string, name: string, ext: string): string {
  let candidate = join(dir, `${name}${ext}`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${name} (${n})${ext}`)
    n += 1
  }
  return candidate
}

/**
 * Opens a file for a recording or an export and hands back an id to append to.
 *
 * `.part` until it is finished, the same as the bundle writer, so a capture that was
 * interrupted never sits on disk looking like a finished video.
 */
export function beginVideoWrite(
  kind: 'recording' | 'export',
  name: string,
  ext: string
): { id: string; path: string } | { error: string } {
  const dir = kind === 'recording' ? recordingsDir : data.outputDir
  try {
    ensureDir(dir)
  } catch (error) {
    return { error: `Could not create ${dir}: ${(error as Error).message}` }
  }

  const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled'
  const path = freePath(dir, safe, ext)
  const partial = `${path}.part`
  const id = `${kind}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  try {
    writes.set(id, {
      stream: createWriteStream(partial),
      path,
      partial,
      bytes: 0,
      kind
    })
  } catch (error) {
    return { error: (error as Error).message }
  }
  return { id, path }
}

/**
 * Appends one chunk.
 *
 * Awaits the drain when the stream asks for it, so a capture that outruns the disk applies
 * backpressure to the renderer instead of queueing the whole file in main's memory - which
 * is the failure this design exists to avoid, just moved one process along.
 */
export function writeVideoChunk(id: string, chunk: Uint8Array): Promise<boolean> {
  const open = writes.get(id)
  if (!open) return Promise.resolve(false)
  open.bytes += chunk.byteLength
  return new Promise((resolve) => {
    const ok = open.stream.write(Buffer.from(chunk), () => undefined)
    if (ok) resolve(true)
    else open.stream.once('drain', () => resolve(true))
  })
}

export function abortVideoWrite(id: string): void {
  const open = writes.get(id)
  if (!open) return
  writes.delete(id)
  open.stream.destroy()
  try {
    rmSync(open.partial, { force: true })
  } catch {
    // Nothing to do about it, and nothing depends on it.
  }
}

export interface FinishMeta {
  durationMs: number
  width: number
  height: number
  source: Recording['source']
  sourceName: string
}

/**
 * Closes the file, indexes it, renames it into place, and lists it if it was a recording.
 *
 * The remux is the difference between a file that plays and a file that can be *used*.
 * `MediaRecorder` only writes fragmented MP4, which carries no sample table and no duration,
 * so Windows Media Player plays it start to finish without seeking and Chromium has to scan
 * the whole thing to scrub - which is why dragging the editor's playhead over a recording
 * stalled. See `mp4-remux.ts`. It is done before the rename, on the `.part` file, so a
 * failure leaves the original bytes and the file only appears once it is right.
 */
export function finishVideoWrite(
  id: string,
  meta: FinishMeta | null
): Promise<{ path?: string; size?: number; recording?: Recording; error?: string }> {
  const open = writes.get(id)
  if (!open) return Promise.resolve({ error: 'That write is no longer open.' })
  writes.delete(id)

  return new Promise((resolve) => {
    open.stream.end(() => {
      void (async () => {
      try {
        if (open.bytes === 0) {
          rmSync(open.partial, { force: true })
          resolve({ error: 'Nothing was recorded.' })
          return
        }

        const indexed = await remuxToProgressive(open.partial)
        if (!indexed.ok && indexed.reason !== 'already progressive') {
          // Kept rather than treated as a failure: an unindexed file still plays everywhere,
          // it just cannot be scrubbed, and losing the take would be far worse.
          console.log(`umakbang: could not index ${open.path}: ${indexed.reason}`)
        }

        renameSync(open.partial, open.path)
        const size = statSync(open.path).size

        if (open.kind !== 'recording' || !meta) {
          resolve({ path: open.path, size })
          return
        }

        const recording: Recording = {
          id: `rec-${Date.now().toString(36)}`,
          path: open.path,
          name: open.path.split(/[\\/]/).pop() ?? 'recording',
          createdAt: Date.now(),
          durationMs: meta.durationMs,
          width: meta.width,
          height: meta.height,
          size,
          source: meta.source,
          sourceName: meta.sourceName
        }
        data.recordings.unshift(recording)
        if (data.recordings.length > MAX_RECORDINGS) {
          data.recordings = data.recordings.slice(0, MAX_RECORDINGS)
        }
        persist()
        resolve({ path: open.path, size, recording })
      } catch (error) {
        resolve({ error: (error as Error).message })
      }
      })()
    })
  })
}

/** Asks where finished videos should go. Opens in the folder already configured. */
export async function pickVideoDir(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Where videos are written',
    defaultPath: existsSync(data.outputDir) ? data.outputDir : undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Asks for a video or an image to bring in as a layer. */
export async function pickMedia(kind: 'audio' | 'video' | 'image'): Promise<string | null> {
  const filters =
    kind === 'audio'
      ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'] }]
      : kind === 'video'
        ? [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'] }]
        : [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] }]
  const result = await dialog.showOpenDialog({
    title: kind === 'audio' ? 'Choose audio' : kind === 'video' ? 'Choose a video' : 'Choose an image',
    filters,
    properties: ['openFile']
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
