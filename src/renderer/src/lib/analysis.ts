/**
 * Tempo and key worked out from the audio itself, lazily and once.
 *
 * Modelled on `peaks.ts`, and for the same reason: the answer costs a full decode, so it
 * is computed only for rows you actually look at and kept forever afterwards. What is
 * cached lives in the user data store alongside the ratings and tags, which means it
 * travels in a settings export like everything else you can't reproduce.
 *
 * Two things fill the cache:
 *
 *   - the waveform decode, when it happens, hands its buffer over here for free;
 *   - anything the waveform *didn't* decode - which is most of a library after the first
 *     visit, since peaks come back from disk without decoding - is decoded here.
 *
 * That second path is the whole point. Before it existed, tempo was only ever detected on
 * a file's first appearance on screen, so a library browsed once was a library that would
 * never be analysed again.
 */

import { useSyncExternalStore } from 'react'
import type { Track } from '@shared/types'
import { normaliseKey } from '@shared/keys'
import { toMonoDecimated, type AudioBufferLike } from '@/lib/dsp'
import type { KeyProfile } from '@/lib/key-essentia'
import { decodeTrack, peekPeaks, requestPeaks } from '@/lib/peaks'
import type { AnalyseResponse } from '@/lib/analysis.worker'
import AnalysisWorker from '@/lib/analysis.worker?worker'

export interface Analysis {
  bpm?: number
  musicalKey?: string
  /**
   * How well the winning key profile fitted, 0 to 1, for a key that was *guessed*.
   *
   * Measured and then thrown away until now. A reading the detector barely believes was
   * drawn exactly like one it is sure of, which is the column asserting more than the
   * analysis established. Absent for a key that came off a tag, a file name or the user's
   * own tool, because those were declared rather than estimated.
   */
  keyFit?: number
}

/**
 * How many files are analysed at once. Configurable, because the right number depends on
 * the machine and on how much of a hurry you are in: each one in flight holds a decoded
 * buffer, and decoding still costs the renderer thread even though the detectors no longer
 * do. Clamped rather than trusted, since it arrives from settings.
 */
const MIN_CONCURRENT = 1
const MAX_CONCURRENT_LIMIT = 10
let maxConcurrent = 2

export function setAnalysisConcurrency(value: number): void {
  const next = Math.round(Number(value) || 0)
  maxConcurrent = Math.max(MIN_CONCURRENT, Math.min(MAX_CONCURRENT_LIMIT, next))
  // A raise takes effect immediately rather than at the next request.
  pump()
}

/**
 * Both detectors decimate to this rate and cap at this many seconds, so the downmix is
 * done once here and the same signal serves both. Kept in step with the constants in
 * `tempo.ts` and `key.ts`.
 */
const ANALYSIS_RATE = 11025
const ANALYSIS_SECONDS = 60

/** Decoding costs many times a file's size in RAM; skip the giants. */
const MAX_DECODE_BYTES = 300 * 1024 * 1024

/**
 * A tempo this unsure is worse than a blank cell - it would poison sorting and `bpm>`
 * filters - so it is dropped rather than stored.
 *
 * Low, because the thing that actually keeps one-shots out is the duration floor inside
 * the detector: a 0.3s hi-hat returns nothing at all rather than something uncertain. Real
 * tracks measured here scored between 0.20 and 0.65, so a stricter gate was throwing away
 * correct readings - one of them by nine ten-thousandths - and not excluding anything.
 */
const MIN_TEMPO_CONFIDENCE = 0.1

/**
 * How well the winning key profile has to fit before the answer is kept.
 *
 * Deliberately the fit and not the margin over the runner-up: the runner-up is nearly
 * always the relative major or minor, which correlates almost as well by construction, so
 * the margin is small even for good detections.
 *
 * The value is a compromise, and knowingly so. Measured across this library:
 *
 *     0.87, 0.68  full productions, unmistakably tonal
 *     0.53, 0.47, 0.45  EDM - dense, sidechained and noisy, which flattens the chroma
 *     0.46, 0.37, 0.36  drum loops, which have no key to find
 *
 * Tonal EDM and drum loops overlap, so no threshold separates them and anything set to
 * exclude every drum loop also blanks real tracks. This sits below the EDM and above most
 * of the percussion, which means the occasional drum loop is given a key it hasn't got.
 * That is the right way round here: a spurious key on a sample is a curiosity, a missing
 * one on a finished track is the thing you went looking for. Point `Settings.analysisTag`
 * at the folders holding music and the sample packs never reach this code at all.
 */
const MIN_KEY_FIT = 0.4

/** Whether key estimation is wanted at all. Set alongside the gate by the store. */
let wantsKey = true

/** A user-supplied command that does the job better than we do. Empty means "we do". */
let keyCommand = ''

export function setKeyDetectionEnabled(enabled: boolean): void {
  wantsKey = enabled
}

export function setKeyCommand(command: string): void {
  keyCommand = command.trim()
}

/** Which detector the worker should use, and which profile if it is Essentia's. */
let keyEngine: 'builtin' | 'essentia' = 'builtin'
let keyProfile: KeyProfile = 'edma'

let reportedEngineFailure = false

export function setKeyEngine(engine: 'builtin' | 'essentia', profile: KeyProfile): void {
  keyEngine = engine
  keyProfile = profile
  // Choosing the engine again is worth one more report if it still cannot be loaded.
  reportedEngineFailure = false
}

/**
 * Asks the user's own tool for a key, if one is configured.
 *
 * Its answer is put through the same normaliser as a key read from a tag, so whatever
 * spelling the tool uses ends up matching everything else in the library. Anything
 * unrecognisable is treated as no answer rather than written through.
 */
async function externalKey(path: string): Promise<string | undefined> {
  if (!keyCommand) return undefined
  try {
    const raw = await window.umakbang.externalKey(keyCommand, path)
    if (!raw) return undefined
    // Tools vary: some print just the key, some a line of other detail with it.
    const [firstLine] = raw.split(/\r?\n/)
    for (const token of firstLine.split(/[\s,;|]+/)) {
      const key = normaliseKey(token)
      if (key) return key
    }
  } catch {
    // A tool that fails is a tool that has no answer.
  }
  return undefined
}

type Sink = (path: string, analysis: Analysis) => void

let sink: Sink | null = null
/** Answers whether a path is worth analysing at all - scope, and what is already known. */
let gate: ((path: string) => boolean) | null = null

/**
 * Wires the module to the library store. Kept as a hook rather than an import so this file
 * stays free of the store and can be exercised on its own.
 */
export function configureAnalysis(options: { sink: Sink; gate: (path: string) => boolean }): void {
  sink = options.sink
  gate = options.gate
}

const done = new Set<string>()
const queue: Track[] = []
const queued = new Set<string>()
/**
 * Requests that were asked for outright rather than because a row happened to be on
 * screen. The visibility sweep drops anything scrolled past, which is right for
 * speculative work and quite wrong for a recalculation the user pressed a button for.
 */
const pinned = new Set<string>()
let active = 0

/**
 * Paths being worked on right now, so a row can show that its value is coming rather than
 * that it doesn't exist. A plain external store, subscribed to once by the table.
 */
const running = new Set<string>()
const watchers = new Set<() => void>()
let runningRevision = 0

function markRunning(path: string, on: boolean): void {
  if (on === running.has(path)) return
  if (on) running.add(path)
  else running.delete(path)
  runningRevision++
  for (const watcher of watchers) watcher()
}

export function isAnalysing(path: string): boolean {
  return running.has(path)
}

export function subscribeAnalysing(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => watchers.delete(watcher)
}

/**
 * The set of files being analysed, re-rendering the caller whenever it changes.
 *
 * Returns the live set rather than a copy: `useSyncExternalStore` compares the snapshot by
 * identity and a fresh Set every call would loop forever, so the revision counter is the
 * snapshot and the set is read through it.
 */
export function useAnalysing(): Set<string> {
  useSyncExternalStore(subscribeAnalysing, analysingRevision, analysingRevision)
  return running
}

function analysingRevision(): number {
  return runningRevision
}

/* ------------------------------------------------------------------ the worker */

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<number, (response: AnalyseResponse) => void>()

/**
 * Built on first use and kept for the life of the window. Starting one per file would cost
 * more in spin-up than the analysis saves.
 */
function analysisWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new AnalysisWorker()
    worker.addEventListener('message', (event: MessageEvent<AnalyseResponse>) => {
      const resolve = pending.get(event.data.id)
      if (!resolve) return
      pending.delete(event.data.id)
      resolve(event.data)
    })
    worker.addEventListener('error', () => {
      // A dead worker must not strand every queued file forever.
      for (const [, resolve] of pending) resolve({ id: -1 })
      pending.clear()
      worker = null
    })
  } catch {
    worker = null
  }
  return worker
}

/**
 * Downmixes on this thread and hands the result over.
 *
 * The downmix is one linear pass; the FFTs that follow are the expensive part and they are
 * what goes across. The signal is transferred rather than copied, so nothing of the size of
 * a decoded track crosses the boundary.
 */
function measure(buffer: AudioBufferLike): Promise<Analysis> {
  const target = analysisWorker()
  if (!target) return Promise.resolve({})

  const { signal, rate } = toMonoDecimated(buffer, ANALYSIS_RATE, ANALYSIS_SECONDS)
  const id = ++nextRequestId

  return new Promise<Analysis>((resolve) => {
    pending.set(id, (response) => {
      const analysis: Analysis = {}
      // Once, not per file: a WebAssembly build that would not load will not load for the
      // next one either, and a library's worth of the same line helps nobody.
      if (response.keyEngineFailure && !reportedEngineFailure) {
        reportedEngineFailure = true
        console.warn(
          `[umakbang] key engine "essentia" unavailable, using the built-in detector: ${response.keyEngineFailure}`
        )
      }
      if (response.bpm !== undefined && (response.tempoConfidence ?? 0) >= MIN_TEMPO_CONFIDENCE) {
        analysis.bpm = response.bpm
      }
      if (wantsKey && response.key !== undefined && (response.keyFit ?? 0) >= MIN_KEY_FIT) {
        analysis.musicalKey = response.key
        analysis.keyFit = response.keyFit
      }
      resolve(analysis)
    })
    target.postMessage({ id, signal, rate, keyEngine, keyProfile }, [signal.buffer])
  })
}

/**
 * Asks for a track to be analysed, if it needs it and is allowed it. Cheap to call for
 * every visible row on every render: everything already known or already queued falls out
 * immediately.
 */
export function requestAnalysis(track: Track, pin = false): void {
  // `running` matters here as much as `queued`: `markRunning` itself triggers the render
  // that re-runs the table's visibility sweep, so without it every file being analysed
  // was immediately queued a second time and decoded twice.
  if (!track.playable || done.has(track.path) || queued.has(track.path) || running.has(track.path)) {
    return
  }
  if (track.size > MAX_DECODE_BYTES) return
  if (!gate || !gate(track.path)) return

  if (pin) pinned.add(track.path)
  queued.add(track.path)
  queue.push(track)
  pump()
}

/**
 * Forgets that these files were analysed, so asking again actually re-runs them.
 *
 * Without this a recalculation is a no-op: every path is in `done` from the first time
 * round, and `requestAnalysis` drops it before it reaches the queue.
 */
export function forgetAnalysis(paths: Iterable<string>): void {
  for (const path of paths) done.delete(path)
}

/** How much work is outstanding, for a caller that wants to say so. */
export function analysisBacklog(): number {
  return queue.length + active
}

/** Paths waiting their turn, so a caller can drop the ones that scrolled away. */
export function queuedAnalysis(): string[] {
  return [...queued]
}

/* ------------------------------------------------------- reprocessing in bulk */

/**
 * A second, lower-priority lane.
 *
 * Re-analysing a library's worth of files is the same work as analysing one, but there is
 * a lot of it, and the queue is FIFO - so pushing thousands of files into it would put
 * every row you then scrolled to behind all of them. `pump` drains this only when the
 * interactive queue is empty, which keeps browsing responsive while the batch grinds
 * through underneath.
 */
const bulk: Track[] = []
const bulkQueued = new Set<string>()
let bulkTotal = 0
let bulkFinished = 0
/**
 * Which run a dequeued bulk item belongs to. A reprocess started while the previous one
 * still has files in flight would otherwise have those stragglers counted against the new
 * run's totals as they land.
 */
let bulkGeneration = 0

const bulkWatchers = new Set<() => void>()

function announceBulk(): void {
  for (const watcher of bulkWatchers) watcher()
}

export function subscribeReprocess(watcher: () => void): () => void {
  bulkWatchers.add(watcher)
  return () => bulkWatchers.delete(watcher)
}

export interface ReprocessProgress {
  /** How many files the run started with. 0 when nothing is running. */
  total: number
  /** How many have been dealt with, successfully or not. */
  finished: number
  running: boolean
}

export function reprocessProgress(): ReprocessProgress {
  return { total: bulkTotal, finished: bulkFinished, running: bulkTotal > 0 }
}

/**
 * Re-analyses files that already have an answer, discarding what was cached for them.
 *
 * The point is a detector change: a different engine, profile or key command produces
 * different results, and everything already measured was measured by the old one. Results
 * are replaced per file as they arrive rather than all cleared up front, so nothing is lost
 * if the run is cancelled or the app is closed half way through.
 *
 * Returns how many files were actually taken on, which is fewer than offered whenever the
 * analysis scope excludes some.
 */
export function reprocessAll(tracks: Iterable<Track>): number {
  cancelReprocess()
  for (const track of tracks) {
    if (!track.playable || track.size > MAX_DECODE_BYTES) continue
    if (!gate || !gate(track.path)) continue
    if (queued.has(track.path) || bulkQueued.has(track.path)) continue
    // Without this every path is still in `done` from the first pass and would be dropped.
    done.delete(track.path)
    bulkQueued.add(track.path)
    bulk.push(track)
  }
  bulkTotal = bulk.length
  bulkFinished = 0
  announceBulk()
  pump()
  return bulkTotal
}

/** Abandons the rest of a run. Files already done keep their new answers. */
export function cancelReprocess(): void {
  bulkGeneration++
  bulk.length = 0
  bulkQueued.clear()
  bulkTotal = 0
  bulkFinished = 0
  announceBulk()
}

/** Drops a not-yet-started request, so scrolling past a row leaves no work behind. */
export function cancelAnalysis(path: string): void {
  if (!queued.has(path) || pinned.has(path)) return
  const index = queue.findIndex((track) => track.path === path)
  if (index !== -1) {
    queue.splice(index, 1)
    queued.delete(path)
  }
}

/**
 * Folds in a buffer somebody else has already decoded - the waveform pass. Free tempo and
 * key for any file being seen for the first time.
 */
/**
 * A `run()` that is waiting on the peaks decode registers here, so the buffer that decode
 * produces is handed to it instead of being measured twice. The observer fires inside
 * `peaks.ts load()` before the request resolves, so by the time `run()` continues the
 * hand-off has either happened or never will.
 */
const bufferHandoff = new Map<string, (buffer: AudioBuffer) => void>()

export function analyseDecoded(path: string, buffer: AudioBuffer): void {
  const handoff = bufferHandoff.get(path)
  if (handoff) {
    handoff(buffer)
    return
  }
  if (done.has(path) || running.has(path)) return
  // The waveform decodes whatever is on screen, in or out of scope; only the analysis is
  // gated, so an excluded folder still draws its waveforms and simply isn't measured.
  if (!gate || !gate(path)) return
  cancelAnalysis(path)
  markRunning(path, true)
  void measure(buffer)
    .then((analysis) => publish(path, analysis))
    .finally(() => markRunning(path, false))
}

function pump(): void {
  while (active < maxConcurrent) {
    // Interactive work first, always: a row that just came on screen should not wait behind
    // a batch of ten thousand.
    const fromQueue = queue.length > 0
    const track = fromQueue ? queue.shift() : bulk.shift()
    if (!track) return

    if (fromQueue) {
      queued.delete(track.path)
      pinned.delete(track.path)
    } else {
      bulkQueued.delete(track.path)
    }

    active++
    const generation = bulkGeneration
    void run(track).finally(() => {
      active--
      if (!fromQueue && generation === bulkGeneration && bulkTotal > 0) {
        bulkFinished++
        // The run is over when the last one lands, not when the queue empties - the final
        // few are still in flight at that point.
        if (bulkFinished >= bulkTotal) {
          bulkTotal = 0
          bulkFinished = 0
        }
        announceBulk()
      }
      pump()
    })
  }
}

async function run(track: Track): Promise<void> {
  // Something else - `analyseDecoded`, or the other lane during a reprocess - may have
  // finished this file between queueing and here; a full decode just to find that out
  // afterwards is the expensive way to return.
  if (done.has(track.path)) return
  markRunning(track.path, true)
  try {
    // Peaks first: if the file has never been seen, that request decodes it, and the
    // hand-off below captures the buffer so it isn't decoded a second time here.
    let shared: AudioBuffer | null = null
    if (peekPeaks(track.path) === undefined) {
      bufferHandoff.set(track.path, (buffer) => {
        shared = buffer
      })
      try {
        await requestPeaks(track.path, track.size)
      } finally {
        bufferHandoff.delete(track.path)
      }
      if (done.has(track.path)) return
    }

    // The user's own tool gets asked first, since it is configured precisely because it is
    // better than the built-in guess.
    const supplied = await externalKey(track.path)

    const buffer = shared ?? (await decodeTrack(track.path, track.size))
    if (!buffer) {
      // A file that can't be fetched or decoded would otherwise be retried in full on
      // every scroll-past, since only a *thrown* failure used to reach `done`.
      done.add(track.path)
      return
    }
    if (done.has(track.path)) return
    const analysis = await measure(buffer)
    if (supplied) analysis.musicalKey = supplied
    publish(track.path, analysis)
  } catch {
    // An undecodable file is not worth retrying, and not worth reporting either - the
    // row simply keeps its blank cells.
    done.add(track.path)
  } finally {
    markRunning(track.path, false)
  }
}



function publish(path: string, analysis: Analysis): void {
  done.add(path)
  if (analysis.bpm === undefined && analysis.musicalKey === undefined) return
  sink?.(path, analysis)
}

/** Forgets what has been analysed, for when the library or the scope changes underneath. */
export function resetAnalysis(): void {
  done.clear()
  queue.length = 0
  queued.clear()
  running.clear()
  pinned.clear()
  cancelReprocess()
  runningRevision++
  for (const watcher of watchers) watcher()
}
