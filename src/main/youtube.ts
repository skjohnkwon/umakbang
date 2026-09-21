/**
 * Pulling audio off a link and turning it into a file the library can hold.
 *
 * The one thing umakbang cannot do for itself. Every other "we need an external binary"
 * question in this app was answered by not needing one - contracts print through Electron
 * rather than pandoc, the video exporter containerises by hand rather than through ffmpeg -
 * and that answer is not available here. Extraction is a moving target: the site changes its
 * player and its signature scheme every few weeks, and the whole of what it takes to keep up
 * with that is yt-dlp, a project that ships a new build most weeks for exactly this reason.
 * Writing a second one inside this app would be signing up to that maintenance forever, and
 * losing.
 *
 * So the binary is fetched rather than bundled, and that is the interesting decision. Bundled,
 * it would be whatever was current on the day the installer was built, and a feature that
 * quietly stops working a month after release is worse than one that says it needs something.
 * Fetched, it lands in `userData/tools` - beside the caches, not inside the app folder, so it
 * survives an update and a portable copy carries it - and it keeps itself current: a binary
 * whose mtime has not moved in a week runs `-U` before the next download. That clock is the
 * file's own mtime, the same trick `auto-backup.ts` uses and for the same reason: nothing to
 * store, nothing in the settings file, and deleting the file repairs it.
 *
 * MP3 is not made here. yt-dlp's own `--audio-format mp3` needs ffmpeg, which is the second
 * binary this app is not going to acquire; the renderer already carries LAME for trims and
 * already decodes audio through Chromium, so what comes down is handed over as it arrived and
 * re-encoded there. See `lib/youtube.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import type { YoutubeFetched, YoutubeInfo, YoutubeProgress, YoutubeToolStatus } from '../shared/types'

export type { YoutubeFetched, YoutubeInfo, YoutubeProgress, YoutubeToolStatus }

const isWindows = process.platform === 'win32'

/** Which asset of the latest release this platform wants. */
const ASSET =
  isWindows ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux'

const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`

/** A build older than this asks itself for a newer one before the next download. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Long enough for a slow link, short enough that a wedged process is not forever. */
const READ_TIMEOUT_MS = 60_000

function toolsDir(): string {
  return join(app.getPath('userData'), 'tools')
}

function toolPath(): string {
  return join(toolsDir(), isWindows ? 'yt-dlp.exe' : 'yt-dlp')
}

/** Somewhere to put the stream while it is still only a stream. */
function scratchDir(): string {
  return join(app.getPath('userData'), 'youtube-temp')
}

/**
 * Runs the tool and collects everything it said.
 *
 * `windowsHide` matters: without it every call flashes a console window over whatever the
 * user was doing, and a download reports progress by writing a line at a time.
 */
function run(
  args: string[],
  onLine?: (line: string) => void
): { done: Promise<{ code: number; out: string; err: string }>; child: ChildProcess } {
  const child = spawn(toolPath(), args, { windowsHide: true })

  let out = ''
  let err = ''
  let pending = ''

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    out += text
    if (!onLine) return
    // Progress arrives a line at a time under `--newline`, but a chunk boundary lands
    // wherever the pipe felt like putting it, so the tail is held back until it terminates.
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })

  const done = new Promise<{ code: number; out: string; err: string }>((resolve) => {
    child.on('error', (error) => resolve({ code: -1, out, err: err || String(error) }))
    child.on('close', (code) => {
      if (onLine && pending) onLine(pending)
      resolve({ code: code ?? -1, out, err })
    })
  })

  return { done, child }
}

/** Whether the extractor is here, and which build it is. */
export async function toolStatus(): Promise<YoutubeToolStatus> {
  if (!existsSync(toolPath())) return { ready: false }
  try {
    const { code, out, err } = await run(['--version']).done
    if (code !== 0) return { ready: false, error: err.trim() || 'The downloader would not run.' }
    return { ready: true, version: out.trim() }
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Fetches the extractor into `userData/tools`.
 *
 * Written to `.part` and renamed, the same rule the bundle export follows: a half-downloaded
 * 30MB file sitting under the name the app looks for is a feature that reports a baffling
 * error on every later run instead of simply not being installed yet.
 */
export async function installTool(report: (percent: number) => void): Promise<YoutubeToolStatus> {
  try {
    await mkdir(toolsDir(), { recursive: true })
    const target = toolPath()
    const part = `${target}.part`

    const response = await fetch(RELEASE_URL, { redirect: 'follow' })
    if (!response.ok || !response.body) {
      return { ready: false, error: `Could not reach the release: ${response.status} ${response.statusText}` }
    }

    const total = Number(response.headers.get('content-length') ?? 0)
    let seen = 0
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (total > 0) report(Math.min(100, (seen / total) * 100))
        controller.enqueue(chunk)
      }
    })

    await rm(part, { force: true })
    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(counted) as never),
      createWriteStream(part)
    )
    // A Windows exe needs no bit set; everywhere else an un-executable file is a download
    // that looks complete and fails with ENOENT's less helpful cousin, EACCES.
    if (!isWindows) await chmod(part, 0o755)

    await rm(target, { force: true })
    const { rename } = await import('node:fs/promises')
    await rename(part, target)

    return await toolStatus()
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Keeps the build current without anything for the user to press.
 *
 * Non-fatal in every direction: a machine that is offline, or a `-U` that fails because the
 * file is where the OS will not let it rewrite itself, must not stop a download that would
 * otherwise have worked with the build already here.
 */
async function updateIfStale(): Promise<void> {
  try {
    const info = await stat(toolPath())
    if (Date.now() - info.mtimeMs < STALE_MS) return
    await run(['-U']).done
    // Whether or not it replaced itself, the check has happened; touching it stops every
    // launch after this one from paying for the same answer.
    const { utimes } = await import('node:fs/promises')
    const now = new Date()
    await utimes(toolPath(), now, now)
  } catch {
    // An update is an optimisation, never a precondition.
  }
}

/** The tail of whatever the tool complained about, as one readable sentence. */
function complaint(err: string, fallback: string): string {
  const line = err
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.startsWith('ERROR:'))
    .pop()
  if (!line) return fallback
  return line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '')
}

interface DumpedJson {
  _type?: string
  id?: string
  title?: string
  uploader?: string
  channel?: string
  duration?: number
  thumbnail?: string
  entries?: unknown[]
  playlist_count?: number
}

/**
 * How big a thumbnail is worth inlining. They run 10-60KB; anything past this is not the
 * picture we asked for and is not worth putting through structured clone as base64.
 */
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024

/**
 * The thumbnail as a `data:` URL, fetched here rather than by the renderer.
 *
 * The renderer cannot load it. `img-src` is `'self' data: blob: umakbang-file:` and there is
 * no remote origin in it, so an `<img>` pointed at `i.ytimg.com` is refused by the content
 * security policy and draws nothing - silently, since a blocked image looks exactly like one
 * that has not arrived yet. Widening `img-src` to `https:` would fix it by giving every
 * script in the renderer a way to talk to any host on the internet, which is a large thing to
 * trade for a 90x160 picture.
 *
 * Main is already the side that does networking here - it runs the extractor, it fetches the
 * extractor - so it fetches this too and hands back bytes the existing policy already allows.
 *
 * Non-fatal in every direction: a thumbnail that will not load is a card without a picture,
 * never a link that cannot be read.
 */
async function inlineThumbnail(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return undefined

    const type = response.headers.get('content-type') ?? 'image/jpeg'
    if (!type.startsWith('image/')) return undefined

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return undefined

    return `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`
  } catch {
    return undefined
  }
}

/**
 * What the link turns out to be, asked before anything is downloaded.
 *
 * `withThumbnail` is off by default because `fetchAudio` probes on its way past and has no use
 * for a picture: only the dialog the user is looking at does, and fetching one for a download
 * already under way is a request nobody reads the answer to.
 */
export async function probe(
  url: string,
  withThumbnail = false
): Promise<{ info?: YoutubeInfo; error?: string }> {
  if (!existsSync(toolPath())) return { error: 'The downloader is not installed yet.' }

  let handle: ChildProcess | undefined
  // A link the site is slow to answer for must not leave a process running forever behind
  // a dialog that is still saying "reading".
  const timer = setTimeout(() => handle?.kill(), READ_TIMEOUT_MS)
  try {
    // `--no-playlist` is what turns a `watch?v=…&list=…` - which is most links anybody
    // copies out of a sidebar - into the one video they were actually looking at. A link
    // that names nothing but a playlist has no single video to resolve to and still comes
    // back as one, which is what the `_type` check below is for.
    const started = run([
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--flat-playlist',
      url
    ])
    handle = started.child
    const { code, out, err } = await started.done
    if (code !== 0) return { error: complaint(err, 'That link could not be read.') }

    const json = JSON.parse(out) as DumpedJson
    if (json._type === 'playlist') {
      return {
        info: {
          id: json.id ?? '',
          title: json.title ?? 'Playlist',
          uploader: json.uploader ?? json.channel ?? '',
          playlist: true,
          count: json.playlist_count ?? json.entries?.length
        }
      }
    }

    return {
      info: {
        id: json.id ?? '',
        title: json.title ?? 'Untitled',
        uploader: json.uploader ?? json.channel ?? '',
        seconds: typeof json.duration === 'number' ? json.duration : undefined,
        thumbnail:
          withThumbnail && json.thumbnail ? await inlineThumbnail(json.thumbnail) : undefined
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** The child currently downloading, so the dialog's Stop button has something to stop. */
let active: ChildProcess | null = null

export function cancel(): void {
  active?.kill()
  active = null
}

const PERCENT = /\[download\]\s+([\d.]+)%/

/**
 * Downloads the audio stream to somewhere temporary and says what it got.
 *
 * Temporary rather than straight into the destination folder because the folder on screen is
 * watched: a stream that lands there under one name and is replaced by an MP3 a few seconds
 * later would appear in the table, dim itself out and vanish, which is three visible events
 * for one download. Nothing enters the library until it is the file the user asked for.
 */
export async function fetchAudio(
  url: string,
  report: (progress: YoutubeProgress) => void
): Promise<YoutubeFetched> {
  if (!existsSync(toolPath())) return { error: 'The downloader is not installed yet.' }
  if (active) return { error: 'A download is already running.' }

  try {
    report({ phase: 'tool' })
    await updateIfStale()

    report({ phase: 'reading' })
    const looked = await probe(url)
    if (looked.error || !looked.info) return { error: looked.error ?? 'That link could not be read.' }
    if (looked.info.playlist) {
      return {
        error: `That link is a playlist${looked.info.count ? ` of ${looked.info.count} videos` : ''}. Paste a link to a single video.`
      }
    }
    const info = looked.info

    const dir = scratchDir()
    await mkdir(dir, { recursive: true })
    // A stem nothing else can collide with, so the file this run produced is the one found
    // below even if a previous run left its scratch behind.
    const stem = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

    report({ phase: 'downloading', percent: 0, title: info.title })

    const started = run(
      [
        // m4a first because Chromium decodes AAC everywhere and because it is the format
        // YouTube serves for almost everything; the bare `bestaudio` behind it catches the
        // Opus-only uploads, which decode just as well and only matter to the extension.
        '-f',
        'bestaudio[ext=m4a]/bestaudio/best',
        '--no-playlist',
        '--newline',
        '--no-warnings',
        // The library sorts and colours by Modified, and that column means "when this
        // arrived here". Left alone, yt-dlp stamps the file with the upload date and a beat
        // pulled down this afternoon sorts in among files from 2014.
        '--no-mtime',
        '-o',
        join(dir, `${stem}.%(ext)s`),
        url
      ],
      (line) => {
        const match = PERCENT.exec(line)
        if (match) report({ phase: 'downloading', percent: Number(match[1]), title: info.title })
      }
    )
    active = started.child

    const { code, err } = await started.done
    active = null
    if (code !== 0) {
      // A kill lands here too, and "cancelled" is not an error worth a red banner.
      if (started.child.killed) return { error: 'Cancelled.' }
      return { error: complaint(err, 'The download failed.') }
    }

    const produced = (await readdir(dir)).find((name) => name.startsWith(`${stem}.`))
    if (!produced) return { error: 'The download finished but left no file.' }

    const ext = produced.slice(stem.length + 1).toLowerCase()
    return { tempPath: join(dir, produced), ext, info }
  } catch (error) {
    active = null
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Clears anything a cancelled or failed run left behind. */
export async function discard(tempPath: string): Promise<void> {
  await rm(tempPath, { force: true }).catch(() => {})
}

/**
 * A video title turned into something a filesystem will accept.
 *
 * Titles carry the lot - colons, slashes, quotes, emoji - and Windows refuses a fair few of
 * them outright. Trailing dots and spaces go too: they make a file that exists and that
 * Explorer then cannot delete or rename.
 */
export function fileNameFor(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  // 120 leaves room for the extension and a disambiguating suffix inside the 255 a path
  // segment gets, without cutting most titles at all.
  return (cleaned.slice(0, 120).trim() || 'download').replace(/[. ]+$/, '') || 'download'
}

/** A name nothing is using, so a second download of the same video does not land on the first. */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const candidate = join(dir, n === 0 ? `${base}.${ext}` : `${base} (${n + 1}).${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${base} ${Date.now()}.${ext}`)
}

/**
 * Puts the finished audio where the user asked for it, and clears the scratch either way.
 *
 * Two callers in one handler because they differ only in where the bytes come from: with
 * `bytes` this is the renderer handing back an MP3 it encoded, without them it is the stream
 * as it arrived. Both are held to the rule every other file this app creates is held to - it
 * can only ever create, never land on top of something - and here that is `freeName` rather
 * than an error, because a name nobody typed is not a name worth refusing over.
 */
export async function place(
  tempPath: string,
  dir: string,
  base: string,
  ext: string,
  bytes?: Uint8Array
): Promise<{ path?: string; error?: string }> {
  try {
    await mkdir(dir, { recursive: true })
    const target = await freeName(dir, fileNameFor(base), ext)

    if (bytes && bytes.byteLength > 0) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(target, bytes, { flag: 'wx' })
    } else {
      const { copyFile } = await import('node:fs/promises')
      // Copy-then-delete rather than rename: the scratch lives under `userData` and the
      // destination is wherever the library is, which on this machine is a different drive -
      // and `rename` across volumes fails with EXDEV.
      await copyFile(tempPath, target)
    }

    await discard(tempPath)
    return { path: target }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
