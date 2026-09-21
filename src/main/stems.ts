/**
 * Stem separation through LALAL.AI.
 *
 * The only part of umakbang that sends your audio anywhere. It is deliberately explicit -
 * an action you pick per file, never something that happens because a row scrolled past -
 * because the file leaves the machine and the service bills by the audio minute.
 *
 * The flow is upload, queue, poll, download:
 *
 *   POST /upload/                 the bytes, with the name in a Content-Disposition header
 *   POST /split/stem_separator/   the source id and what to pull out of it
 *   POST /check/                  polled until the task reports success
 *   GET  <track url>              each stem, written next to the others
 *
 * Everything here reports progress per file rather than per batch: a five-minute track is
 * a minute of waiting on somebody else's queue, and silence for that long reads as a hang.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readFile } from 'node:fs/promises'
import type { StemOptions, StemOutcome, StemPhase, StemProgress } from '../shared/types'

export type { StemOptions, StemOutcome, StemPhase, StemProgress }

const BASE = 'https://www.lalal.ai/api/v1'

/** The service allows 30 checks a minute; this leaves room for several files at once. */
const POLL_INTERVAL_MS = 3_000
/** A track that hasn't finished in this long has gone wrong at the far end. */
const POLL_TIMEOUT_MS = 20 * 60 * 1000

function headers(key: string): Record<string, string> {
  return { 'X-License-Key': key }
}

/**
 * Turns a failed response into something worth putting in front of a person.
 *
 * The shape of the body is the whole difficulty, and getting it wrong cost this feature. A
 * rejected *key* comes back as `{"detail": "..."}` and reads fine; a rejected *request* comes
 * back as a validation report, `{"detail": [{"loc": [...], "msg": "..."}]}`, and interpolating
 * that array into a template gives "[object Object]". Which is what the app said for every
 * split anyone tried: the service was explaining that the chosen model cannot separate vocals,
 * and the explanation was being destroyed on the way to the notice. An error reporter that
 * only handles the errors you expected is worse than none, because it looks like it worked.
 *
 * The status code is always kept. "Invalid license key" and "not a supported format" are the
 * same sentence to a user until you can see one was a 401 and the other a 422.
 */
async function describe(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`
  // Read as text once: a body is a stream that can only be consumed once, and not every
  // failure is JSON - an HTML error page from something in front of the API is still worth
  // showing a few words of.
  const text = await response.text().catch(() => '')

  let said = ''
  try {
    const body = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown }
    said = flatten(body.error ?? body.detail ?? body.message)
  } catch {
    said = text.trim().slice(0, 300)
  }

  return said ? `${said} (${status})` : status
}

/** Any of the shapes an error body arrives in, as one sentence. */
function flatten(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail.map(flatten).filter(Boolean).join('; ')
  }
  if (detail && typeof detail === 'object') {
    const entry = detail as { msg?: unknown; message?: unknown; detail?: unknown }
    const message = entry.msg ?? entry.message ?? entry.detail
    // The validation framework prefixes its own category onto the sentence it was given.
    // "Value error, " in front of the only useful words is noise to whoever reads the notice.
    if (typeof message === 'string') return message.replace(/^Value error,\s*/, '')
    // Something structured nobody anticipated. Unreadable beats discarded: it is still the
    // only account of what went wrong, and it is what a bug report can be pasted from.
    return JSON.stringify(detail).slice(0, 300)
  }
  return ''
}

/** Minutes of processing left on the account, so a batch can be refused before it starts. */
export async function minutesLeft(licenseKey: string): Promise<number | null> {
  try {
    const response = await fetch(`${BASE}/limits/minutes_left/`, {
      method: 'POST',
      headers: headers(licenseKey)
    })
    if (!response.ok) return null
    const body = (await response.json()) as { minutes_left?: number }
    return typeof body.minutes_left === 'number' ? body.minutes_left : null
  } catch {
    return null
  }
}

/**
 * A header value has to be Latin-1 - fetch throws on anything else, so a file named in
 * Korean (or with a quote in it) failed before the service was ever reached. The real
 * name travels RFC 5987-encoded in `filename*`; the plain `filename` is an ASCII-safe
 * fallback for whatever on their side reads only that.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

async function upload(path: string, options: StemOptions): Promise<string> {
  const bytes = await readFile(path)
  const response = await fetch(`${BASE}/upload/`, {
    method: 'POST',
    headers: {
      ...headers(options.licenseKey),
      // The service takes the name from here rather than from a multipart part.
      'Content-Disposition': contentDisposition(basename(path)),
      'Content-Type': 'application/octet-stream'
    },
    body: new Uint8Array(bytes)
  })
  if (!response.ok) throw new Error(`Upload failed: ${await describe(response)}`)

  const body = (await response.json()) as { id?: string; error?: string }
  if (!body.id) throw new Error(`Upload failed: ${body.error ?? 'no id returned'}`)
  return body.id
}

async function queue(sourceId: string, options: StemOptions): Promise<string> {
  const response = await fetch(`${BASE}/split/stem_separator/`, {
    method: 'POST',
    headers: { ...headers(options.licenseKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_id: sourceId,
      presets: {
        stem: options.stem,
        splitter: options.splitter,
        // Detail over cleanliness: an acapella that keeps its breaths and tails is worth
        // more than one scrubbed smooth, and the instrumental is the complement anyway.
        extraction_level: 'deep_extraction',
        dereverb_enabled: false,
        encoder_format: options.format
      }
    })
  })
  if (!response.ok) throw new Error(`Could not start the split: ${await describe(response)}`)

  const body = (await response.json()) as { task_id?: string }
  if (!body.task_id) throw new Error('Could not start the split: no task id returned')
  return body.task_id
}

interface CheckedTrack {
  type?: string
  label?: string
  url?: string
}

async function waitForResult(
  taskId: string,
  options: StemOptions,
  report: (progress: Omit<StemProgress, 'path'>) => void
): Promise<CheckedTrack[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    const response = await fetch(`${BASE}/check/`, {
      method: 'POST',
      headers: { ...headers(options.licenseKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [taskId] })
    })
    if (!response.ok) throw new Error(`Lost track of the job: ${await describe(response)}`)

    const body = (await response.json()) as {
      result?: Record<string, {
        status?: string
        progress?: number
        result?: { tracks?: CheckedTrack[] }
        error?: { detail?: string }
      }>
    }
    const entry = body.result?.[taskId]
    if (!entry) continue

    if (entry.status === 'success') {
      const tracks = entry.result?.tracks ?? []
      if (tracks.length === 0) throw new Error('The service reported success but sent no stems')
      return tracks
    }
    if (entry.status === 'error' || entry.status === 'server_error') {
      throw new Error(entry.error?.detail ?? 'The service reported an error')
    }
    if (entry.status === 'cancelled') throw new Error('The job was cancelled')

    report({ phase: 'separating', percent: entry.progress })
  }

  throw new Error('Gave up waiting for the service')
}

/** What each returned track should be called on disk. */
function labelFor(track: CheckedTrack, stem: string): string {
  const label = (track.label ?? '').toLowerCase()
  if (label) return label.replace(/_/g, ' ')
  return track.type === 'back' ? `no ${stem}` : stem
}

/** Trims a file name down to something a folder can be called. */
function folderNameFor(path: string): string {
  const base = basename(path, extname(path)).trim()
  // Windows forbids these outright, and a trailing dot or space makes a folder that is
  // awkward to delete afterwards.
  const cleaned = base.replace(/[<>:"/\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  return cleaned || 'stems'
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Could not download a stem: ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target))
}

/** A name that isn't already taken, so a second run doesn't overwrite the first. */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const name = n === 0 ? `${base}${ext}` : `${base} ${n + 1}${ext}`
    const candidate = join(dir, name)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${base} ${Date.now()}${ext}`)
}

/**
 * Splits one file and writes every stem the service returns.
 *
 * Errors are returned rather than thrown: a batch should report which files failed and
 * keep the ones that worked, not lose the lot to one bad upload.
 */
export async function splitOne(
  path: string,
  options: StemOptions,
  report: (progress: StemProgress) => void
): Promise<StemOutcome> {
  const say = (partial: Omit<StemProgress, 'path'>): void => report({ path, ...partial })

  try {
    // Each track gets a folder of its own, named after it. Two stems per split times a
    // session's worth of tracks is otherwise a folder nobody can find anything in.
    const destination = join(options.outputDir, folderNameFor(path))
    await mkdir(destination, { recursive: true })

    say({ phase: 'uploading' })
    const sourceId = await upload(path, options)

    say({ phase: 'queued' })
    const taskId = await queue(sourceId, options)

    const tracks = await waitForResult(taskId, options, say)

    say({ phase: 'downloading' })
    const extension = `.${options.format}`
    const written: string[] = []

    for (const track of tracks) {
      if (!track.url) continue
      // Inside its own folder the file name only has to say which stem it is.
      const target = await freeName(destination, labelFor(track, options.stem), extension)
      await download(track.url, target)
      written.push(target)
    }

    if (written.length === 0) throw new Error('The service returned no downloadable stems')

    say({ phase: 'done' })
    return { path, written }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    say({ phase: 'failed', message })
    return { path, written: [], error: message }
  }
}
