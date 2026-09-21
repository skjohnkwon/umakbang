/**
 * Bringing a file over from another machine.
 *
 * A remote library is read-only, so this is a copy and never a move: nothing leaves the
 * machine that owns the file, and the row stays exactly where it was. That is worth being
 * strict about in the naming, because "move" is what the same gesture means everywhere else
 * in the explorer and here it would be a lie.
 *
 * Streamed to a temporary name and renamed at the end, so an interrupted copy leaves a
 * `.part` behind rather than a file that looks complete and is not - the same rule
 * `bundle.ts` follows for the same reason.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Agent, get as httpGet } from 'node:http'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { LibraryRoot } from '../shared/types'
import { relFor, rootFor, withinRoot } from '../shared/roots'
import { REMOTE_PORT } from './remote'
import { getUserData } from './store'
import { defaultFlUserData, readPluginInventory } from './plugins'
import { zipDir } from './archives'

/**
 * The file's own name, whichever machine's separators the path uses.
 *
 * `node:path`'s `basename` is the *running* platform's - on a Mac it does not treat `\` as
 * a separator at all, so `Z:\SECRET SAUCE\beat.mp3` came back whole and was written as a
 * single file with that entire path for a name. The explorer then folded the backslashes
 * into `/` when building `rel` and drew folders that did not exist.
 *
 * The renderer has had this right since before any of this (`paths.ts`, `baseName`); this
 * is the same rule, on the side of the app that deals in two platforms' paths at once.
 */
function leafName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut === -1 ? path : path.slice(cut + 1)
}

export interface DownloadResult {
  /** Where each file landed, for the message that says it is done. */
  written: string[]
  /** One line per file that did not make it, already phrased for a person. */
  failures: string[]
}

/**
 * A name that is not already taken in the destination.
 *
 * Copies from two machines collide by design - the same beat is called the same thing in
 * both libraries - and silently overwriting the local one would be the worst possible
 * answer. `beat.wav`, `beat (2).wav`, and so on.
 */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  for (let n = 2; ; n++) {
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
    candidate = join(dir, `${stem} (${n})${ext}`)
  }
}

/** At most this often per file: a progress bar redrawing faster than this says nothing. */
const PROGRESS_THROTTLE_MS = 150

/**
 * How many ranges of one file are fetched at once.
 *
 * Not a guess. Measured against the real peer, which sits across the internet rather than
 * on the LAN - 87ms round trip - where a single stream is limited by how much can be in
 * flight at once rather than by the link:
 *
 *     1 stream    0.9 MB/s
 *     4 streams   3.6 MB/s
 *     8 streams  13.8 MB/s
 *    24 streams  16.2 MB/s
 *
 * An order of magnitude for the first eight, then noise. Eight is where the gain stops
 * being worth the connections, and a peer being asked for a file is also serving a window
 * somebody is browsing.
 */
const PARALLEL_CHUNKS = 8

/**
 * Below this, one stream.
 *
 * Splitting a small file costs eight round trips to save nothing - at 87ms each, that is
 * slower than simply asking for the whole thing.
 */
const MIN_CHUNK_BYTES = 2 * 1024 * 1024

/**
 * How much each range asks for, which is *not* the file divided by eight.
 *
 * Splitting a file into exactly as many pieces as there are streams means the copy ends at
 * the speed of its slowest piece: seven streams finish, and the last few percent crawl
 * along on one connection at one stream's speed. Which is precisely what a big copy looked
 * like - quick to the nineties, then a long tail.
 *
 * Fixed-size pieces handed out from a queue instead, so a stream that finishes early takes
 * the next one and the tail is never longer than a single chunk. Two megabytes is the
 * balance: large enough that the round trip to ask for it is a few percent of fetching it,
 * small enough that the last one cannot hold the file up for long.
 */
const CHUNK_BYTES = 2 * 1024 * 1024

/**
 * One pool of sockets for every range of every file.
 *
 * Without this each chunk is a fresh TCP connection, and at 87ms that handshake costs more
 * than a tenth of the time it then spends transferring. Keeping them alive is what makes
 * small chunks - and therefore a short tail - affordable in the first place.
 */
const agent = new Agent({ keepAlive: true, maxSockets: PARALLEL_CHUNKS })

function urlFor(
  remote: NonNullable<LibraryRoot['remote']>,
  rel: string,
  scope?: 'fl'
): string {
  // `scope=fl` reads from the peer's FL user data folder - where a project's consolidated
  // tracks live - rather than from a library.
  const where = scope ? `&scope=${scope}` : ''
  return `/file?library=${encodeURIComponent(remote.libraryId)}&rel=${encodeURIComponent(rel)}${where}`
}

/**
 * How big the file is, asked for in the cheapest way there is.
 *
 * A one-byte range: the peer answers 206 with `Content-Range: bytes 0-0/<total>`, so the
 * size arrives without a byte of the file. Zero means it would not say, and the caller
 * falls back to one stream and an indeterminate bar.
 */
function remoteSize(
  remote: NonNullable<LibraryRoot['remote']>,
  rel: string,
  scope?: 'fl'
): Promise<number> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        host: remote.host,
        port: REMOTE_PORT,
        path: urlFor(remote, rel, scope),
        headers: { Range: 'bytes=0-0' },
        agent
      },
      (response) => {
        response.resume()
        const range = String(response.headers['content-range'] ?? '')
        const match = /\/(\d+)$/.exec(range)
        resolve(match ? Number(match[1]) : 0)
      }
    )
    request.on('error', () => resolve(0))
  })
}

/**
 * What the peer says the file hashes to, or null if it would not say.
 *
 * Null is not a failure - an older build has no `/hash` route - and the caller carries on
 * without the check rather than refusing a copy it could perfectly well make.
 */
function remoteHash(
  remote: NonNullable<LibraryRoot['remote']>,
  rel: string,
  scope?: 'fl'
): Promise<string | null> {
  const where = scope ? `&scope=${scope}` : ''
  const path = `/hash?library=${encodeURIComponent(remote.libraryId)}&rel=${encodeURIComponent(rel)}${where}`
  return new Promise((resolve) => {
    const request = httpGet({ host: remote.host, port: REMOTE_PORT, path, agent }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        resolve(null)
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096) request.destroy()
      })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { algo?: string; hex?: string }
          resolve(parsed.algo === 'sha256' && parsed.hex ? parsed.hex : null)
        } catch {
          resolve(null)
        }
      })
    })
    request.on('error', () => resolve(null))
  })
}

/** What actually landed on disk. */
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const source = createReadStream(file)
    source.on('error', reject)
    source.on('data', (chunk) => hash.update(chunk))
    source.on('end', () => resolve(hash.digest('hex')))
  })
}

/** One range, written straight to its own offset in the part file. */
function fetchChunk(
  remote: NonNullable<LibraryRoot['remote']>,
  rel: string,
  part: string,
  start: number,
  end: number,
  onBytes: (count: number) => void,
  scope?: 'fl'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      {
        host: remote.host,
        port: REMOTE_PORT,
        path: urlFor(remote, rel, scope),
        headers: { Range: `bytes=${start}-${end}` },
        agent
      },
      (response) => {
        if (response.statusCode !== 206 && response.statusCode !== 200) {
          response.resume()
          reject(new Error(`${remote.deviceName} answered ${response.statusCode}`))
          return
        }
        response.on('data', (chunk: Buffer) => onBytes(chunk.length))
        // `r+` and a start offset: every chunk writes into the same preallocated file at the
        // place it belongs, so there is nothing to stitch together at the end.
        pipeline(response, createWriteStream(part, { flags: 'r+', start })).then(resolve, reject)
      }
    )
    request.on('error', reject)
  })
}

/**
 * Fetches one file, in parallel ranges where that is worth doing.
 *
 * See `PARALLEL_CHUNKS` for why: across a high-latency link a single stream is limited by
 * what fits in flight, not by the link, and the peer already speaks Range properly.
 */
async function fetchTo(
  root: LibraryRoot,
  rel: string,
  part: string,
  onProgress: (received: number, total: number, bps: number) => void,
  scope?: 'fl'
): Promise<void> {
  const remote = root.remote
  if (!remote) throw new Error('not a remote root')

  const total = await remoteSize(remote, rel, scope)

  let received = 0
  let last = 0
  let lastBytes = 0
  const onBytes = (count: number): void => {
    received += count
    const now = Date.now()
    if (now - last < PROGRESS_THROTTLE_MS) return
    /*
     * Measured over the window since the last report rather than over the whole transfer,
     * because an average tells you what the link *was* doing. A copy that has stalled should
     * read as stalled within a second rather than decaying towards it over a minute.
     */
    const bps = last === 0 ? 0 : ((received - lastBytes) * 1000) / (now - last)
    last = now
    lastBytes = received
    onProgress(received, total, bps)
  }

  if (total < MIN_CHUNK_BYTES) {
    // One stream, and the whole file: no range header, nothing to preallocate.
    await new Promise<void>((resolve, reject) => {
      const request = httpGet(
        { host: remote.host, port: REMOTE_PORT, path: urlFor(remote, rel, scope), agent },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume()
            reject(new Error(`${remote.deviceName} answered ${response.statusCode}`))
            return
          }
          response.on('data', (chunk: Buffer) => onBytes(chunk.length))
          pipeline(response, createWriteStream(part)).then(resolve, reject)
        }
      )
      request.on('error', reject)
    })
    onProgress(received, total || received, 0)
    return
  }

  // Preallocated, so each range can be written at its offset rather than in turn.
  await writeFile(part, '')
  await truncate(part, total)

  const ranges: Array<[number, number]> = []
  for (let start = 0; start < total; start += CHUNK_BYTES) {
    ranges.push([start, Math.min(start + CHUNK_BYTES, total) - 1])
  }

  // Handed out rather than dealt out: whichever stream finishes first takes the next range,
  // so a slow connection holds up one chunk instead of the whole tail of the file.
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= ranges.length) return
      const [start, end] = ranges[index]
      await fetchChunk(remote, rel, part, start, end, onBytes, scope)
    }
  }

  // One failed range fails the file. A part file with a hole in it looks complete and is
  // not, which is the one outcome worth refusing outright.
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_CHUNKS, ranges.length) }, () => worker())
  )
  onProgress(total, total, 0)
}

/**
 * Copies remote files into the configured folder.
 *
 * Sequential rather than parallel: these are whole files over a network, and several at once
 * would finish no sooner while making the progress meaningless. Each failure is collected
 * and the rest carry on - one unreachable file should not abandon a selection of twenty.
 */
export async function downloadRemote(
  paths: string[],
  onProgress: (
    path: string,
    received: number,
    total: number,
    target?: string,
    bps?: number,
    verifying?: boolean,
    /** Whether the destination should show a row while this arrives. */
    row?: boolean
  ) => void = () => undefined
): Promise<DownloadResult> {
  const { settings } = getUserData()
  const destination = settings.remoteDownloadDir
  if (!destination) {
    return { written: [], failures: ['No download folder is set - see Settings, Remote.'] }
  }
  await mkdir(destination, { recursive: true })

  const written: string[] = []
  const failures: string[] = []

  for (const path of paths) {
    const root = rootFor(settings.roots, path)
    if (!root?.remote) {
      failures.push(`${leafName(path)} is not on another machine.`)
      continue
    }
    // Within the root and with no label on it: a label is this machine's name for the
    // folder and means nothing to the machine being asked. See `serveRemote`.
    const rel = relFor([root], path)
    const within = rel ? withinRoot(rel) : ''
    if (!within) {
      failures.push(`${leafName(path)} could not be located in ${root.label}.`)
      continue
    }

    // Flat, by design: the file goes where it was asked to go, under its own name. The
    // folders it sat in on the other machine are that machine's business.
    const target = await freeName(destination, leafName(path))
    try {
      await copyOne(root, within, target, (received, total, bps, verifying) =>
        onProgress(path, received, total, target, bps, verifying, true)
      )
      written.push(target)
    } catch (error) {
      failures.push(`${leafName(path)}: ${(error as Error).message}`)
    } finally {
      // Whatever happened, the row stops claiming to be downloading. A failed copy that
      // left a bar on screen for the session would be worse than the failure.
      onProgress(path, -1, -1, target, 0, false, true)
    }
  }

  return { written, failures }
}

/**
 * One file, fetched and checked, ending in place or not at all.
 *
 * Shared by an ordinary copy and by packing, so a packaged sample arrives with the same
 * parallel ranges and the same hash check as anything else - there is no second, weaker
 * transfer path to keep honest.
 */
async function copyOne(
  root: LibraryRoot,
  within: string,
  target: string,
  onProgress: (received: number, total: number, bps: number, verifying?: boolean) => void,
  scope?: 'fl'
): Promise<void> {
  const remote = root.remote
  if (!remote) throw new Error('not a remote root')
  const part = `${target}.part`
  try {
    // Announced before a byte moves, so the row can exist in the folder it is arriving into
    // rather than appearing only once it lands. Until the rename there is nothing on disk
    // but a `.part`, which is not an indexable extension and so cannot be listed.
    onProgress(0, 0, 0)
    await fetchTo(root, within, part, (received, total, bps) => onProgress(received, total, bps), scope)

    /*
     * Checked before the rename, never after.
     *
     * A `.part` that fails is deleted and reported; a file that has already taken its
     * real name is indistinguishable from one that arrived intact, and the library would
     * index it, draw a waveform for it and hand it to a DAW. The whole point of writing
     * to a temporary name is that this check gets to happen while it is still temporary.
     */
    // Said out loud: hashing both ends of a large file is a pause at exactly the moment
    // a progress bar reaches the end, which is when a pause looks most like a hang.
    onProgress(0, 0, 0, true)
    const expected = await remoteHash(remote, within, scope)
    if (expected) {
      const actual = await hashFile(part)
      if (actual !== expected) {
        throw new Error('arrived damaged - the copy did not match the original')
      }
    }

    await rename(part, target)
  } catch (error) {
    // Nothing half-written is left behind to be mistaken for a file.
    await unlink(part).catch(() => undefined)
    throw error
  }
}

export interface PackManifest {
  flp: { rel: string; name: string; size: number; scope?: 'fl' }
  samples: Array<{ rel: string; name: string; size: number; scope?: 'fl' }>
  /** Sample paths the project uses that are not in that library - factory content, mostly. */
  elsewhere: string[]
  plugins: string[]
  error?: string
}

function manifestFor(
  remote: NonNullable<LibraryRoot['remote']>,
  within: string
): Promise<PackManifest | null> {
  const path = `/pack?library=${encodeURIComponent(remote.libraryId)}&rel=${encodeURIComponent(within)}`
  return new Promise((resolve) => {
    const request = httpGet({ host: remote.host, port: REMOTE_PORT, path, agent }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        resolve(null)
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 4 * 1024 * 1024) request.destroy()
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body) as PackManifest)
        } catch {
          resolve(null)
        }
      })
    })
    request.on('error', () => resolve(null))
  })
}

export interface PackResult {
  dir?: string
  /** Samples the project uses that could not come - named, so nobody finds out in FL. */
  elsewhere: string[]
  plugins: string[]
  error?: string
}

/**
 * Builds a loop package for a project that lives on another machine.
 *
 * The project and its samples land flat in one folder, which is the only thing that makes
 * the result portable: FL resolves a missing sample by looking in the folder the project is
 * in, which is why its own zipped packages carry absolute paths into a temp folder that
 * stopped existing years ago and still open. Nothing is rewritten inside the `.flp`.
 *
 * Nothing is written on the machine being asked, either. It answers with a list; every file
 * then comes over the ordinary ranged, hash-checked path, so a package is exactly as
 * verified as any other copy.
 */
export async function packRemote(
  flpPath: string,
  onProgress: (
    path: string,
    received: number,
    total: number,
    target?: string,
    bps?: number,
    verifying?: boolean,
    row?: boolean
  ) => void = () => undefined
): Promise<PackResult> {
  const { settings } = getUserData()
  const root = rootFor(settings.roots, flpPath)
  if (!root?.remote) return { elsewhere: [], plugins: [], error: 'That project is not on another machine.' }

  const rel = relFor([root], flpPath)
  const within = rel ? withinRoot(rel) : ''
  if (!within) return { elsewhere: [], plugins: [], error: 'That project could not be located.' }

  const manifest = await manifestFor(root.remote, within)
  if (!manifest) {
    return { elsewhere: [], plugins: [], error: `${root.remote.deviceName} could not read that project.` }
  }
  if (manifest.error) return { elsewhere: [], plugins: [], error: manifest.error }

  const destination = settings.remoteDownloadDir
  if (!destination) {
    return { elsewhere: [], plugins: [], error: 'No download folder is set - see Settings, Remote.' }
  }
  // Named after the project, beside everything else that comes over. Never merged into an
  // existing folder: a package is a snapshot, and mixing two is how you get a project
  // playing a sample from a different version of itself.
  const stem = manifest.flp.name.replace(/\.flp$/i, '')
  // Assembled in a working folder and zipped at the end, so nothing half-built is ever
  // sitting in the library under the name the finished package will take.
  const dir = await freeDir(destination, `${stem}.packing`)
  await mkdir(dir, { recursive: true })

  const failures: string[] = []
  const items = [manifest.flp, ...manifest.samples]
  for (const item of items) {
    // Flat, and deliberately: the folders these sat in on the other machine are what FL
    // will not be able to find, and the flat copy beside the project is what it can.
    const target = await freeName(dir, item.name)
    try {
      await copyOne(
        root,
        item.rel,
        target,
        (received, total, bps, verifying) =>
        // `row: false` - the files of a package are not rows anybody wants to watch. Drawn,
        // they appear and vanish one at a time inside a folder that is still being built,
        // and the whole thing is replaced by the zip a moment later anyway.
          onProgress(flpPath, received, total, target, bps, verifying, false),
        // The project's own consolidated audio comes from FL's folder, not the library.
        item.scope
      )
    } catch (error) {
      failures.push(`${item.name}: ${(error as Error).message}`)
    } finally {
      /*
       * Every file clears its own progress, not just the project.
       *
       * Progress is keyed by where a file is going, so a package of seventeen leaves
       * seventeen entries behind - which is seventeen rows still claiming to be arriving,
       * and a toolbar reading "copying 17" for the rest of the session, after a pack that
       * finished perfectly well. `downloadRemote` has always done this in its own `finally`;
       * packing reached past it to `copyOne` and did not.
       */
      onProgress(flpPath, -1, -1, target, 0, false, false)
    }
  }

  if (failures.length > 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return { elsewhere: manifest.elsewhere, plugins: manifest.plugins, error: failures[0] }
  }

  // One file, the way FL's own loop packages are: the project and its samples flat inside a
  // zip named after the project.
  const zip = await freeName(destination, `${stem}.zip`)
  const failed = await zipDir(dir, zip)
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  if (failed) return { elsewhere: manifest.elsewhere, plugins: manifest.plugins, error: failed }

  return { dir: zip, elsewhere: manifest.elsewhere, plugins: manifest.plugins }
}

/** A folder beside the others that nothing is using. */
async function freeDir(parent: string, stem: string): Promise<string> {
  let candidate = join(parent, stem)
  for (let n = 2; ; n++) {
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
    candidate = join(parent, `${stem} (${n})`)
  }
}

export interface PackPreview {
  name: string
  sampleCount: number
  totalBytes: number
  elsewhere: string[]
  plugins: string[]
  /** Of those plugins, the ones FL has not found on *this* machine. */
  missingPlugins: string[]
  error?: string
}

/**
 * What packing this project would involve, before a byte moves.
 *
 * The plugin check is the reason this exists separately. A project opened without the
 * plugins it loads comes up with them stubbed out, and saving it there writes the stub -
 * so the settings are gone, silently, and the only sign is that the beat sounds wrong when
 * it gets back. Nothing about copying samples can prevent that; being told first can.
 */
export async function previewPack(flpPath: string): Promise<PackPreview> {
  const empty = { name: '', sampleCount: 0, totalBytes: 0, elsewhere: [], plugins: [], missingPlugins: [] }
  const { settings } = getUserData()
  const root = rootFor(settings.roots, flpPath)
  if (!root?.remote) return { ...empty, error: 'That project is not on another machine.' }

  const rel = relFor([root], flpPath)
  const within = rel ? withinRoot(rel) : ''
  if (!within) return { ...empty, error: 'That project could not be located.' }

  const manifest = await manifestFor(root.remote, within)
  if (!manifest) return { ...empty, error: `${root.remote.deviceName} could not read that project.` }
  if (manifest.error) return { ...empty, error: manifest.error }

  const here = await readPluginInventory(settings.flUserData || defaultFlUserData())
  /*
   * Compared with the punctuation taken out, because the two lists spell the same plugin
   * differently by nature: a project names the file FL loads (`Serum2.vst3`) and the
   * database names what the browser shows (`Serum 2`). Spaces, dashes and case are the
   * whole of the difference in most cases.
   *
   * Not a complete answer - `SerumFX` against `Serum 2 FX` still reads as missing - but it
   * is wrong in the safe direction: a plugin that is there and reported missing costs a
   * dialog somebody dismisses, where the reverse costs the settings on six channels.
   */
  const flatten = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const have = new Set(here.names.map(flatten))
  const missingPlugins = manifest.plugins.filter((name) => !have.has(flatten(name)))

  return {
    name: manifest.flp.name,
    sampleCount: manifest.samples.length,
    totalBytes: manifest.flp.size + manifest.samples.reduce((sum, one) => sum + one.size, 0),
    elsewhere: manifest.elsewhere,
    plugins: manifest.plugins,
    missingPlugins
  }
}
