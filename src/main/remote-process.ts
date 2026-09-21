/**
 * The tailnet server, in a utility process of its own.
 *
 * Separate from the browser process for the reason the scanner is: what this will do is
 * sustained I/O - streaming a 240MB index, a sample being auditioned, a project packed
 * straight from disk into a socket - and doing it on the thread that runs the window is how
 * an app stops answering. It also means a fault while parsing something that arrived over a
 * socket costs a respawn rather than the whole app.
 *
 * It suits the split better than the scanner does: almost everything it serves is already a
 * file on disk, so it reads its own way there and the parent is left holding only the things
 * that are genuinely the parent's - what the settings say, and where Tailscale is.
 *
 * Security lives at the bind, and the bind is here. The address is handed over by the parent
 * and used exactly as given: there is no discovery, no fallback and no `0.0.0.0` path in this
 * file, because a server that quietly listens on the wrong interface is serving somebody's
 * whole library to an airport.
 */

import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createGzip } from 'node:zlib'
import type { RemoteHello, RemoteLibrary } from '../shared/types'
import { indexFileFor, initIndexStore, patchFileFor } from './index-store'
import { parseRange, resolveInLibrary } from './remote-routes'

export interface RemoteConfig {
  /** The tailnet address to bind. Never a wildcard - see the note above. */
  address: string
  port: number
  protocol: number
  device: { id: string; name: string; os: string; version: string }
  libraries: RemoteLibrary[]
  /** Where this install keeps its index and caches, for the endpoints that read them. */
  dataDir: string
}

export type RemoteCommand = { type: 'init'; config: RemoteConfig } | { type: 'stop' }

export type RemoteEvent =
  | { type: 'ready' }
  | { type: 'listening'; address: string; port: number }
  | { type: 'failed'; reason: string }

let server: Server | null = null
let config: RemoteConfig | null = null

function post(event: RemoteEvent): void {
  process.parentPort?.postMessage(event)
}

/** The index file's mtime, which is what a rename moves when a scan finishes. */
function generationOf(root: string): number | undefined {
  try {
    return statSync(indexFileFor(root)).mtimeMs
  } catch {
    // No index yet. Absent rather than 0, so a puller can tell "never scanned" from "empty".
    return undefined
  }
}

function hello(): RemoteHello {
  const current = config
  if (!current) throw new Error('hello before init')
  return {
    app: 'umakbang',
    protocol: current.protocol,
    device: current.device,
    // Read now rather than at init: a scan that finished since this process started has
    // moved it, and a stale generation is exactly the thing it exists to prevent.
    libraries: current.libraries.map((library) => ({
      ...library,
      generation: generationOf(library.path)
    }))
  }
}

/** The library a request named, or null. Never falls back to "the first one". */
function libraryOf(params: URLSearchParams): RemoteLibrary | null {
  const id = params.get('library')
  if (!id) return null
  return config?.libraries.find((entry) => entry.id === id) ?? null
}

function fail(response: ServerResponse, status: number): void {
  response.writeHead(status).end()
}

function sendJson(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/**
 * Streams a file through gzip.
 *
 * For the index and its journal, which are NDJSON and compress five to ten times - the one
 * transfer in this whole system big enough to be worth the CPU. A missing file is 204 rather
 * than 404: a library with no journal yet has nothing to send, which is not an error.
 */
function sendGzipped(response: ServerResponse, file: string): void {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    response.writeHead(204).end()
    return
  }
  if (size === 0) {
    response.writeHead(204).end()
    return
  }
  response.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'content-encoding': 'gzip',
    // No content-length: the compressed size is not known until it has been compressed, and
    // buffering 240MB to find out is the thing streaming exists to avoid.
    'x-umakbang-raw-length': String(size)
  })
  const source = createReadStream(file)
  source.on('error', () => response.destroy())
  source.pipe(createGzip()).pipe(response)
}

/**
 * Streams file bytes, honouring Range.
 *
 * Deliberately not gzipped. Audio is already compressed or close to it, and an encoded body
 * cannot be range-requested - which would cost seeking, the one thing auditioning needs.
 *
 * The content type is left as octet-stream: the puller serves these through its own
 * `umakbang-file://` handler, which already decides the type from the extension and rewraps
 * AIFF on the way. Two places deciding it is two places to disagree.
 */
function sendFile(request: IncomingMessage, response: ServerResponse, file: string): void {
  let size: number
  try {
    const info = statSync(file)
    if (!info.isFile()) {
      fail(response, 404)
      return
    }
    size = info.size
  } catch {
    fail(response, 404)
    return
  }

  const range = parseRange(request.headers.range, size)
  if (range === 'invalid') {
    response.writeHead(416, { 'content-range': `bytes */${size}` }).end()
    return
  }

  if (!range) {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'accept-ranges': 'bytes'
    })
    const whole = createReadStream(file)
    whole.on('error', () => response.destroy())
    whole.pipe(response)
    return
  }

  response.writeHead(206, {
    'content-type': 'application/octet-stream',
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'accept-ranges': 'bytes'
  })
  const part = createReadStream(file, { start: range.start, end: range.end })
  part.on('error', () => response.destroy())
  part.pipe(response)
}

/**
 * The route table.
 *
 * Everything that names a path goes through `resolveInLibrary`, without exception - a route
 * that opens something by a string off the wire is the one bug in this process that matters.
 * Every refusal is a bare 404 for the same reason: distinguishing "outside the library" from
 * "not there" would let anyone on the tailnet map the disk one request at a time.
 */
function handle(request: IncomingMessage, response: ServerResponse): void {
  const current = config
  if (!current) {
    fail(response, 503)
    return
  }

  // A base is required and irrelevant - only the pathname and the query are ever read.
  const url = new URL(request.url ?? '/', 'http://localhost')
  const params = url.searchParams

  switch (url.pathname) {
    case '/hello':
      sendJson(response, hello())
      return

    case '/index': {
      const library = libraryOf(params)
      if (!library) {
        fail(response, 404)
        return
      }
      sendGzipped(response, indexFileFor(library.path))
      return
    }

    case '/index/patch': {
      const library = libraryOf(params)
      if (!library) {
        fail(response, 404)
        return
      }
      sendGzipped(response, patchFileFor(library.path))
      return
    }

    case '/file': {
      const library = libraryOf(params)
      const rel = params.get('rel')
      if (!library || !rel) {
        fail(response, 404)
        return
      }
      const file = resolveInLibrary(library, rel)
      if (!file) {
        fail(response, 404)
        return
      }
      sendFile(request, response, file)
      return
    }

    default:
      fail(response, 404)
  }
}

function start(next: RemoteConfig): void {
  config = next
  // `indexFileFor` derives its filename from a hash of the root and this directory, and the
  // comment on it is emphatic about the two agreeing forever - so the same function is used
  // here rather than the name being rebuilt.
  initIndexStore(next.dataDir)
  const created = createServer((request, response) => {
    // Read-only, and that is enforced here rather than route by route. Nothing this process
    // serves can be written to over the wire, so a method that implies otherwise never
    // reaches the table.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fail(response, 405)
      return
    }
    try {
      handle(request, response)
    } catch {
      // A thrown handler must answer rather than leave a socket open - and must not be the
      // thing that takes this process down, since the parent would respawn it into the same
      // request. Headers may already be out, in which case the only honest move is to cut
      // the connection.
      if (response.headersSent) response.destroy()
      else fail(response, 500)
    }
  })

  created.once('error', (error) => {
    server = null
    post({ type: 'failed', reason: `Could not listen on ${next.address}: ${error.message}` })
  })
  created.listen(next.port, next.address, () => {
    server = created
    post({ type: 'listening', address: next.address, port: next.port })
  })
}

function stop(): void {
  const current = server
  server = null
  if (current) current.close()
}

process.parentPort?.on('message', (message) => {
  const command = message.data as RemoteCommand
  if (command.type === 'init') {
    stop()
    start(command.config)
    return
  }
  if (command.type === 'stop') stop()
})

post({ type: 'ready' })
