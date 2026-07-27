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
import { aiffToWav } from './aiff'
import { UMAKBANG_FILE_SCHEME, fromUmakbangFileUrl } from '../shared/url'

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

export function registerFileProtocol(): void {
  protocol.handle(UMAKBANG_FILE_SCHEME, async (request) => {
    const filePath = fromUmakbangFileUrl(request.url)
    if (!filePath) return new Response('Bad request', { status: 400 })

    const ext = extname(filePath).toLowerCase()

    // Chromium has no AIFF decoder, so serve a WAV-wrapped copy from memory instead.
    if (AIFF_EXTENSIONS.has(ext)) {
      try {
        const rewrapped = await aiffToWav(filePath)
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
