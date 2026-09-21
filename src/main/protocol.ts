/**
 * The `umakbang-file://` scheme, which streams local audio into the renderer.
 *
 * Going through a custom protocol rather than file:// keeps webSecurity on and lets us
 * transparently rewrap AIFF into WAV.
 *
 * Files are read and served here rather than delegated to net.fetch, because a media
 * element needs an explicit Content-Length and byte-range support to know a file's
 * duration and to seek within it. Without those the transport still plays, but the
 * timeline sits at 0:00 and clicking the waveform does nothing.
 */

import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { extname } from 'node:path'
import { aiffToWav, type RewrapResult } from './aiff'
import { UMAKBANG_FILE_SCHEME, fromUmakbangFileUrl, urlFamily } from '../shared/url'
import { relFor, rootFor, withinRoot } from '../shared/roots'
import type { LibraryRoot } from '../shared/types'
import { REMOTE_PORT } from './remote'
import { getUserData } from './store'

/** Must run before the app 'ready' event. */
export function registerFileSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: UMAKBANG_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        // Without this Chromium refuses cross-scheme fetches outright, whatever headers
        // the response carries - and the waveform builder has to fetch the bytes to
        // decode them. <audio> is unaffected either way, which is why playback worked
        // while waveforms silently didn't.
        corsEnabled: true
      }
    }
  ])
}

const AIFF_EXTENSIONS = new Set(['.aif', '.aiff', '.aifc'])

/**
 * The last rewrapped AIFF, keyed by path + mtime + size.
 *
 * One entry is enough: a media element issues several range requests per playback and one
 * per seek, all against the currently playing file, and each used to re-read and
 * re-byte-swap the whole AIFF on the thread that serves every other request too.
 */
let aiffCache: { path: string; mtimeMs: number; size: number; wav: RewrapResult } | null = null

async function rewrapAiff(filePath: string): Promise<RewrapResult | null> {
  const info = await stat(filePath)
  if (
    aiffCache &&
    aiffCache.path === filePath &&
    aiffCache.mtimeMs === info.mtimeMs &&
    aiffCache.size === info.size
  ) {
    return aiffCache.wav
  }
  const wav = await aiffToWav(filePath)
  if (wav) aiffCache = { path: filePath, mtimeMs: info.mtimeMs, size: info.size, wav }
  return wav
}

/**
 * Types for a request that asked for `visual`.
 *
 * A separate table rather than a merged one because `.mp4` and `.webm` belong to both and
 * mean different things in each - see `toUmakbangVisualUrl` for why the caller decides
 * rather than the extension.
 */
const VISUAL_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp'
}

const MIME_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm'
}

/**
 * The same bytes, from the machine that has them.
 *
 * This is the whole of what "a remote root is a root" costs. The renderer asks for a path
 * exactly as it always has - `player.ts` still does `element.src = fileUrl(track.path)` and
 * knows nothing about any of this - and the only question here is whether that path belongs
 * to a folder on this disk or to one on a peer's.
 *
 * `Range` is forwarded and the upstream status comes back untouched, because seeking is the
 * point: a media element asks for a few kilobytes at a time and will not show a duration,
 * let alone scrub, without honest 206s. The content type is decided here rather than taken
 * from the peer, which deliberately answers `octet-stream` - one place deciding it is one
 * place to get it wrong.
 */
async function serveRemote(
  root: LibraryRoot,
  filePath: string,
  request: Request,
  mimeType: string
): Promise<Response> {
  const remote = root.remote
  if (!remote) return new Response('Not found', { status: 404 })

  /**
   * Within the root, with no label on the front.
   *
   * The label is this machine's name for the folder and nothing more - the same library is
   * `SECRET SAUCE` on the machine serving it and `SECRET SAUCE (jkpc)` here, precisely
   * because they had to be told apart locally. Sending ours asked the peer for a folder
   * that does not exist on it, and every remote file came back 404 as "can't decode".
   */
  const rel = relFor([root], filePath)
  const within = rel ? withinRoot(rel) : ''
  if (!within) return new Response('Not found', { status: 404 })

  const url =
    `http://${remote.host}:${REMOTE_PORT}/file` +
    `?library=${encodeURIComponent(remote.libraryId)}&rel=${encodeURIComponent(within)}`

  const range = request.headers.get('range')
  const upstream = await fetch(url, { headers: range ? { Range: range } : undefined })

  // 416 is an answer, not a failure: a media element that seeks past the end has to be told
  // so, and passing it through with its Content-Range is how the local path replies too.
  if (upstream.status === 416) {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders(mimeType),
        'Content-Range': upstream.headers.get('content-range') ?? 'bytes */0'
      }
    })
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    return new Response('Not found', { status: upstream.status === 404 ? 404 : 502 })
  }

  // `baseHeaders` rather than a hand-written pair, and that is not tidiness: it carries
  // `Access-Control-Allow-Origin`, without which an <audio> element still plays and the
  // waveform builder's `fetch()` silently does not - a remote row that sounds right and
  // draws nothing.
  const headers = new Headers(baseHeaders(mimeType))
  for (const name of ['content-length', 'content-range']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

export function registerFileProtocol(): void {
  protocol.handle(UMAKBANG_FILE_SCHEME, async (request) => {
    const filePath = fromUmakbangFileUrl(request.url)
    if (!filePath) return new Response('Bad request', { status: 400 })

    const ext = extname(filePath).toLowerCase()
    const visual = urlFamily(request.url) === 'visual'

    // Which machine has it. `rootFor` folds separators and matches the root's own prefix
    // case-insensitively, so a Windows path asked for from a Mac resolves without anything
    // here knowing that is what happened.
    const root = rootFor(getUserData().settings.roots, filePath)
    if (root?.remote) {
      try {
        const mimeType = visual
          ? (VISUAL_MIME_TYPES[ext] ?? 'application/octet-stream')
          : (MIME_TYPES[ext] ?? 'application/octet-stream')
        // AIFF is served raw rather than rewrapped: the rewrap reads the whole file off
        // disk, and there is no disk here. A remote AIFF surfaces as unplayable, which is
        // honest, and is what the local path did before `aiff.ts` existed.
        return await serveRemote(root, filePath, request, mimeType)
      } catch {
        return new Response('Not reachable', { status: 504 })
      }
    }

    if (visual) {
      try {
        return await serveFile(filePath, VISUAL_MIME_TYPES[ext] ?? 'application/octet-stream', request)
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }

    // Chromium has no AIFF decoder, so serve a WAV-wrapped copy from memory instead.
    if (AIFF_EXTENSIONS.has(ext)) {
      try {
        const rewrapped = await rewrapAiff(filePath)
        if (rewrapped) return serveBuffer(rewrapped.buffer, rewrapped.mimeType, request)
      } catch {
        // Fall through; the renderer will surface the file as unplayable.
      }
    }

    try {
      return await serveFile(filePath, MIME_TYPES[ext] ?? 'application/octet-stream', request)
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Parses a Range header against a known total size. Null means "send the whole thing". */
function parseRange(
  header: string | null,
  total: number
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /bytes=(\d*)-(\d*)/.exec(header)
  if (!match) return null

  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) return null

  let start: number
  let end: number
  if (hasStart) {
    start = Number.parseInt(match[1], 10)
    end = hasEnd ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1
  } else {
    // A suffix range ("bytes=-500") asks for the final N bytes.
    const suffix = Number.parseInt(match[2], 10)
    start = Math.max(0, total - suffix)
    end = total - 1
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start >= total || start > end) return 'invalid'
  return { start, end }
}

function baseHeaders(mimeType: string): Record<string, string> {
  return {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    // An <audio> element loads cross-origin without CORS, but fetch() - which the
    // waveform builder uses - does not.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  }
}

/** Streams a file from disk, honouring byte ranges so the media element can seek. */
async function serveFile(filePath: string, mimeType: string, request: Request): Promise<Response> {
  const info = await stat(filePath)
  if (!info.isFile()) return new Response('Not found', { status: 404 })
  const total = info.size

  const range = parseRange(request.headers.get('range'), total)

  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders(mimeType), 'Content-Range': `bytes */${total}` }
    })
  }

  if (range === null) {
    return new Response(toWebStream(createReadStream(filePath)), {
      status: 200,
      headers: { ...baseHeaders(mimeType), 'Content-Length': String(total) }
    })
  }

  const { start, end } = range
  return new Response(toWebStream(createReadStream(filePath, { start, end })), {
    status: 206,
    headers: {
      ...baseHeaders(mimeType),
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`
    }
  })
}

/** Same contract as serveFile, for content we already hold in memory (rewrapped AIFF). */
function serveBuffer(buffer: Buffer, mimeType: string, request: Request): Response {
  const total = buffer.length
  const range = parseRange(request.headers.get('range'), total)

  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders(mimeType), 'Content-Range': `bytes */${total}` }
    })
  }

  if (range === null) {
    return new Response(toArrayBuffer(buffer), {
      status: 200,
      headers: { ...baseHeaders(mimeType), 'Content-Length': String(total) }
    })
  }

  const { start, end } = range
  const slice = buffer.subarray(start, end + 1)
  return new Response(toArrayBuffer(slice), {
    status: 206,
    headers: {
      ...baseHeaders(mimeType),
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${total}`
    }
  })
}

function toWebStream(stream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(stream) as ReadableStream
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
