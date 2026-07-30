/**
 * Everything a project needs to be alive: the sources, the clock, and the recorder.
 *
 * Published from the module rather than through zustand, the same shape as `lib/updates.ts`
 * and the reprocess progress in `lib/analysis.ts`. The time ticks sixty times a second and
 * the export reports several times a second on top of that; routing either through the
 * library store would repaint a quarter-million-row explorer for each one, and nothing
 * outside this page needs to know.
 *
 * The one thing worth understanding before changing anything here: **the export is the
 * preview, recorded.** It plays the project from zero at real speed while `MediaRecorder`
 * samples the same canvas the editor has been drawing into and the same audio graph the
 * editor has been playing through. That costs a minute of wall clock for a minute of video,
 * and it is a deliberate trade. Rendering faster than real time means driving the canvas
 * frame by frame with `captureStream(0)` and `requestFrame()`, which works - but there is
 * then no way to put audio beside it, because `MediaRecorder` will only take a live audio
 * track and muxing one in afterwards means an `ffmpeg` binary. The contracts feature already
 * settled that question for this app: a packed Electron app cannot count on a system binary,
 * and this one would be a 70MB dependency to save a minute per post.
 */

import { drawFrame, frameSize, type Sources } from './compositor'
import { analyseBuffer, emptyAnalysis, type ClipAnalysis } from './analysis'
import {
  projectDuration,
  type AudioLayer,
  type VideoClip,
  type VideoLayer,
  type VideoProject
} from '@shared/video'
import { toUmakbangVisualUrl } from '@shared/url'
import { getPalette } from '@/components/visualizers/palette'
import { useVideos } from '@/state/videos'
import { useLibrary } from '@/state/library'

export interface ExportProgress {
  /** 0 to 1 of the way through the clip. */
  progress: number
  /** Where it is being written. */
  path: string
  /** Bytes handed to main so far, so a long export visibly does something. */
  bytes: number
}

export interface StageState {
  playing: boolean
  /** Seconds from the start of the video. */
  time: number
  duration: number
  /** What is still being loaded, for the overlay. Null when everything is here. */
  loading: string | null
  error: string | null
  exporting: ExportProgress | null
  /** Set once the audio has been decoded and measured. */
  analysed: boolean
  /**
   * The longest loaded video layer, in seconds, or 0 when there is none.
   *
   * A project built from a recording has no library track to take its length from, and the
   * created default of 15 seconds against a 45 second capture is not a starting point, it is
   * a video that stops a third of the way in - which is what "playback stops" and "the
   * scrubber only covers the beginning" both were.
   */
  longestVideo: number
}

let state: StageState = {
  playing: false,
  time: 0,
  duration: 0,
  loading: null,
  error: null,
  exporting: null,
  analysed: false,
  longestVideo: 0
}

const listeners = new Set<() => void>()

export function subscribeStage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function stageState(): StageState {
  return state
}

function publish(patch: Partial<StageState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/**
 * One AudioContext for the whole feature, built lazily and never torn down.
 *
 * Same constraint as `visualizers/audio-tap.ts`: `createMediaElementSource` can be called
 * once per element for the life of the page, so the node has to be remembered rather than
 * rebuilt, and a context per project would strand every node made under the last one.
 */
let context: AudioContext | null = null

function audio(): AudioContext {
  if (!context) context = new AudioContext()
  return context
}

/** Element to its tap, because the second `createMediaElementSource` on one element throws. */
const taps = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()

function tapOf(element: HTMLMediaElement): MediaElementAudioSourceNode {
  let node = taps.get(element)
  if (!node) {
    node = audio().createMediaElementSource(element)
    taps.set(element, node)
  }
  return node
}

interface ActiveVideoClip {
  from: number
  to: number
  offset: number
}

/** The one edit of a video layer occupying this project time. */
function videoClipAt(layer: VideoLayer, time: number): ActiveVideoClip | null {
  if (layer.clips?.length) {
    return layer.clips.find((clip: VideoClip) => time >= clip.from && time < clip.to) ?? null
  }
  const from = layer.from ?? 0
  const available = Math.max(0, (layer.sourceDuration ?? 0) - layer.offset)
  const to = layer.to ?? from + available
  return time >= from && time < to ? { from, to, offset: layer.offset } : null
}

interface LoadedAudio {
  source: string
  buffer: AudioBuffer
}

interface LoadedVideo {
  element: HTMLVideoElement
  source: string
  gain: GainNode
  /** A live camera keeps its stream so it can be stopped when the layer goes. */
  stream: MediaStream | null
}

/**
 * The live half of a project.
 *
 * Kept out of React entirely. A `<video>` element in the tree would be remounted by every
 * inspector keystroke, and remounting one throws away its decoder, its buffered frames and
 * its position.
 */
export class VideoStage {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private project: VideoProject | null = null

  private videos = new Map<string, LoadedVideo>()
  private audios = new Map<string, LoadedAudio>()
  private images = new Map<string, HTMLImageElement>()
  private analysis: ClipAnalysis | null = null
  /** Source file and source-time origin represented by the analysis table. */
  private analysisSource = ''
  private analysisSourceStart = 0
  /** Which file and source window the analysis describes. */
  private analysedFor = ''

  private buffer: AudioBuffer | null = null
  private master: GainNode | null = null
  /** Speaker-only branch, muted during export without muting the recorded audio track. */
  private monitor: GainNode | null = null
  private playheads = new Set<AudioBufferSourceNode>()
  private audioGains = new Map<string, GainNode>()

  private frame = 0
  /** Whether a scrub interrupted playback that should resume when the drag ends. */
  private resumeAfterScrub = false
  /** Context time the current run started at, and the project time it started from. */
  private startedAt = 0
  private startedFrom = 0
  private time = 0
  /** The clock only advances after a pending AudioContext resume has completed. */
  private clockReady = false
  /** Cancels a play request that is still waiting for AudioContext.resume(). */
  private playRequest = 0

  private recorder: MediaRecorder | null = null
  private writeId = ''
  private exportBytes = 0
  /** Last progress paint; export encoding must not compete with React sixty times a second. */
  private lastExportPublish = 0
  /** Serialises the chunk appends, so they reach main in the order they were encoded. */
  private writeQueue: Promise<void> = Promise.resolve()
  private streamDestination: MediaStreamAudioDestinationNode | null = null

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null
    if (canvas && this.project) this.sizeCanvas()
    this.tick()
  }

  private sizeCanvas(): void {
    if (!this.canvas || !this.project) return
    const size = frameSize(this.project)
    if (this.canvas.width !== size.width) this.canvas.width = size.width
    if (this.canvas.height !== size.height) this.canvas.height = size.height
  }

  /**
   * Takes the project on, loading whatever is new and dropping whatever is gone.
   *
   * Called on every edit, so it has to be cheap when nothing structural changed: a source
   * that is already loaded under the same path is left exactly as it is, playing.
   */
  async setProject(project: VideoProject): Promise<void> {
    const first = !this.project
    this.project = project
    this.sizeCanvas()
    publish({ duration: projectDuration(project) })

    const wanted = new Set(project.layers.map((layer) => layer.id))
    for (const [id, loaded] of this.videos) {
      const layer = project.layers.find((entry) => entry.id === id)
      const stale =
        !wanted.has(id) || layer?.kind !== 'video' || (layer as VideoLayer).source !== loaded.source
      if (stale) {
        loaded.element.pause()
        loaded.element.removeAttribute('src')
        loaded.stream?.getTracks().forEach((track) => track.stop())
        this.videos.delete(id)
      }
    }
    for (const [id, loaded] of this.audios) {
      const layer = project.layers.find((entry) => entry.id === id)
      if (!wanted.has(id) || layer?.kind !== 'audio' || layer.source !== loaded.source) {
        this.audios.delete(id)
      }
    }
    for (const id of [...this.images.keys()]) {
      if (!wanted.has(id)) this.images.delete(id)
    }

    await this.loadLayers(project)
    await this.loadAudio(project)
    publish({ duration: projectDuration(useVideos.getState().project ?? project) })
    if (first) this.tick()
  }

  private async loadLayers(project: VideoProject): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const layer of project.layers) {
      if (layer.kind === 'audio' && layer.source && !this.audios.has(layer.id)) {
        jobs.push(this.loadAudioLayer(layer))
      }
      if (layer.kind === 'video' && layer.source && !this.videos.has(layer.id)) {
        jobs.push(this.loadVideo(layer))
      }
      if (layer.kind === 'image' && layer.source && !this.images.has(layer.id)) {
        jobs.push(this.loadImage(layer.id, layer.source))
      }
    }
    if (jobs.length === 0) return
    publish({ loading: 'Loading layers' })
    await Promise.all(jobs)
    publish({ loading: null })
  }

  private async loadAudioLayer(layer: AudioLayer): Promise<void> {
    try {
      const response = await fetch(window.umakbang.fileUrl(layer.source))
      if (!response.ok) throw new Error('could not be read')
      const buffer = await audio().decodeAudioData(await response.arrayBuffer())
      this.audios.set(layer.id, { source: layer.source, buffer })
      if (layer.sourceDuration !== buffer.duration) {
        useVideos.getState().patchLayer(layer.id, { sourceDuration: buffer.duration } as Partial<AudioLayer>)
      }
    } catch (error) {
      publish({ error: 'That audio ' + (error as Error).message + '.' })
    }
  }

  private async loadVideo(layer: VideoLayer): Promise<void> {
    const element = document.createElement('video')
    element.playsInline = true
    // Muted until it is known whether the tap took. Autoplay is also only unconditionally
    // allowed on a muted element, and this one starts playing before any click has landed on
    // it when a project is reopened mid-playback.
    element.muted = true
    element.loop = layer.loop
    element.crossOrigin = 'anonymous'

    let stream: MediaStream | null = null
    if (layer.source === 'camera') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        element.srcObject = stream
      } catch (error) {
        publish({ error: `No camera: ${(error as Error).message}` })
        return
      }
    } else {
      element.src = toUmakbangVisualUrl(layer.source)
    }

    await new Promise<void>((resolve) => {
      const done = (): void => resolve()
      element.addEventListener('loadeddata', done, { once: true })
      element.addEventListener('error', done, { once: true })
      // A file that is somehow unreadable must not hang the editor behind it.
      window.setTimeout(done, 8000)
    })

    if (!stream && Number.isFinite(element.duration) && layer.sourceDuration !== element.duration) {
      useVideos.getState().patchLayer(layer.id, { sourceDuration: element.duration } as Partial<VideoLayer>)
    }

    const gain = audio().createGain()
    gain.gain.value = layer.volume
    try {
      tapOf(element).connect(gain)
      gain.connect(this.masterGain())
      // `muted` gates the element before the tap does, so leaving it set would make the gain
      // node meaningless and every video layer permanently silent - including in the export,
      // where it would look like the layer's own volume control did nothing. The gain is what
      // mutes from here on.
      element.muted = false
    } catch {
      // An element that cannot be tapped keeps its own mute, which is the same behaviour by
      // a different route rather than a layer that is suddenly loud.
      element.muted = true
    }

    this.videos.set(layer.id, { element, source: layer.source, gain, stream })
    this.publishLongestVideo()
    if (state.playing) this.syncVideos(this.time, true)
  }

  private loadImage(id: string, source: string): Promise<void> {
    return new Promise((resolve) => {
      const element = new Image()
      element.onload = () => {
        this.images.set(id, element)
        resolve()
      }
      element.onerror = () => resolve()
      element.src = toUmakbangVisualUrl(source)
    })
  }

  /** A live camera has no length, so it is not a candidate for the project's duration. */
  private publishLongestVideo(): void {
    let longest = 0
    for (const loaded of this.videos.values()) {
      if (loaded.stream) continue
      const length = loaded.element.duration
      if (Number.isFinite(length) && length > longest) longest = length
    }
    if (longest !== state.longestVideo) publish({ longestVideo: longest })
  }

  private monitorGain(): GainNode {
    if (!this.monitor) {
      this.monitor = audio().createGain()
      this.monitor.connect(audio().destination)
    }
    return this.monitor
  }

  private masterGain(): GainNode {
    if (!this.master) {
      this.master = audio().createGain()
      this.master.connect(this.monitorGain())
    }
    return this.master
  }

  private setMonitoring(enabled: boolean): void {
    const ctx = audio()
    this.monitorGain().gain.setValueAtTime(enabled ? 1 : 0, ctx.currentTime)
  }

  /** Decodes the selected source and builds the tables every visualizer reads. */
  private async loadAudio(project: VideoProject): Promise<void> {
    const audioLayer = project.layers.find(
      (layer): layer is AudioLayer => layer.kind === 'audio' && Boolean(layer.source) && !layer.hidden
    )
    const video = project.layers.find(
      (layer): layer is VideoLayer =>
        layer.kind === 'video' && Boolean(layer.source) && layer.source !== 'camera'
    )
    const path = project.audio?.path ?? audioLayer?.source ?? video?.source
    if (!path) {
      this.buffer = null
      this.analysis = null
      this.analysisSource = ''
      this.analysisSourceStart = 0
      this.analysedFor = ''
      publish({ analysed: false })
      return
    }

    // Cover every edit of the chosen source. A shuffled layer can begin with a piece from
    // the middle and return to the start later, so analysing only the first clip's tail
    // leaves those later pieces with no visualizer data.
    let from = project.audio?.from ?? Number.POSITIVE_INFINITY
    let requestedTo = project.audio?.to ?? 0
    if (!project.audio) {
      for (const layer of project.layers) {
        if ((layer.kind !== 'audio' && layer.kind !== 'video') || layer.source !== path) continue
        if (layer.kind === 'video' && layer.clips?.length) {
          for (const clip of layer.clips) {
            from = Math.min(from, clip.offset)
            requestedTo = Math.max(requestedTo, clip.offset + (clip.to - clip.from))
          }
          continue
        }
        const timelineStart = layer.from ?? 0
        const available = Math.max(
          0.05,
          (layer.sourceDuration ?? projectDuration(project)) - layer.offset
        )
        const timelineEnd = layer.to ?? timelineStart + available
        from = Math.min(from, layer.offset)
        requestedTo = Math.max(requestedTo, layer.offset + (timelineEnd - timelineStart))
      }
    }
    if (!Number.isFinite(from)) from = 0
    requestedTo = Math.max(from + 0.05, requestedTo)
    this.analysisSource = path
    this.analysisSourceStart = from

    const analysisRate = Math.max(60, project.fps)
    const signature = path + '|' + from + '|' + requestedTo + '|' + analysisRate
    if (this.analysedFor === signature) return

    publish({ loading: 'Reading audio', analysed: false })
    try {
      const loadedBuffer = audioLayer ? this.audios.get(audioLayer.id)?.buffer : null
      if (loadedBuffer) this.buffer = loadedBuffer
      else if (!this.buffer || !this.analysedFor.startsWith(path + '|')) {
        const response = await fetch(window.umakbang.fileUrl(path))
        if (!response.ok) throw new Error('could not be read')
        this.buffer = await audio().decodeAudioData(await response.arrayBuffer())
      }
      publish({ loading: 'Measuring' })
      const to = Math.max(from + 0.05, Math.min(this.buffer.duration, requestedTo))
      this.analysis = analyseBuffer(this.buffer, from, to, analysisRate)
      this.analysedFor = signature
      publish({ loading: null, error: null, analysed: true })
    } catch (error) {
      this.buffer = null
      this.analysis = null
      publish({ loading: null, error: 'That audio ' + (error as Error).message + '.', analysed: false })
    }
  }

  /** How long the track is, so the range control knows what it is trimming. */
  trackDuration(): number {
    return this.buffer?.duration ?? 0
  }

  private sources(): Sources {
    const videos = new Map<string, HTMLVideoElement>()
    for (const [id, loaded] of this.videos) videos.set(id, loaded.element)

    let analysisTime: number | null = null
    if (this.project?.audio && this.analysisSource === this.project.audio.path) {
      analysisTime = this.project.audio.from + this.time - this.analysisSourceStart
    } else if (this.project && this.analysisSource) {
      for (const layer of this.project.layers) {
        if ((layer.kind !== 'audio' && layer.kind !== 'video') || layer.source !== this.analysisSource) continue
        if (layer.kind === 'video') {
          const clip = videoClipAt(layer, this.time)
          if (!clip) continue
          analysisTime = clip.offset + (this.time - clip.from) - this.analysisSourceStart
          break
        }
        const from = layer.from ?? 0
        const available = Math.max(0, (layer.sourceDuration ?? 0) - layer.offset)
        const to = layer.to ?? from + available
        if (this.time < from || this.time >= to) continue
        analysisTime = layer.offset + (this.time - from) - this.analysisSourceStart
        break
      }
    }

    return {
      videos,
      images: this.images,
      analysis: this.analysis ?? (this.project?.audio ? null : emptyAnalysis()),
      analysisTime,
      headroomDb: Math.max(
        0,
        Math.min(18, useLibrary.getState().settings.visualizerHeadroomDb ?? 6)
      ),
      ramp: getPalette().wave
    }
  }

  /* --- transport ------------------------------------------------------------------- */

  /**
   * Starts the clock, the track and every video layer together.
   *
   * The resume is waited for rather than fired off, and that is the whole of it: the project
   * clock is `ctx.currentTime`, and **a suspended AudioContext does not advance it**. A
   * context built while the editor was loading rather than under a click starts suspended, so
   * kicking off a resume and then immediately reading `currentTime` gave a clock frozen at
   * zero - no sound, a playhead that never moved, and a scrubber with nothing to scrub. All
   * three read as separate bugs and were one.
   */
  play(): void {
    if (!this.project || state.playing) return
    const ctx = audio()
    const request = ++this.playRequest
    this.clockReady = false
    // Publish immediately so a second click is a real Pause even while resume() is pending.
    // Previously that second click called play() again and the first request won later.
    publish({ playing: true })

    const begin = async (): Promise<void> => {
      if (!this.project || !state.playing || request !== this.playRequest) return
      const duration = projectDuration(this.project)
      if (this.time >= duration - 0.02) this.time = 0

      // Let every active video finish its initial seek and enter playback before the audio
      // clock starts. Otherwise the project clock gets hundreds of milliseconds ahead while
      // Chromium is still priming a decoder, and the drift corrector has to skip forward.
      await this.startVideos(this.time)
      if (!this.project || !state.playing || request !== this.playRequest) return
      this.startedAt = ctx.currentTime
      this.startedFrom = this.time
      this.clockReady = true
      this.startAudio(this.time)
    }

    if (ctx.state === 'suspended') void ctx.resume().then(begin, begin)
    else void begin()
  }

  togglePlayback(): void {
    if (state.playing) this.pause()
    else this.play()
  }

  private startAudio(from: number): void {
    if (!this.project) return
    const ctx = audio()
    const projectEnd = projectDuration(this.project)
    for (const layer of this.project.layers) {
      if (layer.kind !== 'audio' || layer.hidden) continue
      const loaded = this.audios.get(layer.id)
      if (!loaded) continue
      const timelineStart = layer.from ?? 0
      const sourceAvailable = Math.max(0, loaded.buffer.duration - layer.offset)
      const timelineEnd = Math.min(projectEnd, layer.to ?? timelineStart + sourceAvailable)
      const playAt = Math.max(from, timelineStart)
      if (playAt >= timelineEnd) continue

      const sourceOffset = layer.offset + Math.max(0, playAt - timelineStart)
      const remaining = Math.min(timelineEnd - playAt, loaded.buffer.duration - sourceOffset)
      if (remaining <= 0) continue
      const startsIn = Math.max(0, playAt - from)
      const now = ctx.currentTime + startsIn
      const source = ctx.createBufferSource()
      source.buffer = loaded.buffer
      const gain = ctx.createGain()
      const elapsed = playAt - timelineStart
      const initial = layer.fadeIn > 0 && elapsed < layer.fadeIn
        ? layer.gain * (elapsed / layer.fadeIn)
        : layer.gain
      gain.gain.setValueAtTime(Math.max(0.0001, initial), now)
      if (layer.fadeIn > elapsed) {
        gain.gain.linearRampToValueAtTime(layer.gain, now + layer.fadeIn - elapsed)
      }
      const fadeStart = timelineEnd - layer.fadeOut
      if (layer.fadeOut > 0 && playAt + remaining > fadeStart) {
        gain.gain.setValueAtTime(layer.gain, now + Math.max(0, fadeStart - playAt))
        gain.gain.linearRampToValueAtTime(0.0001, now + remaining)
      }
      source.connect(gain)
      gain.connect(this.masterGain())
      source.start(now, sourceOffset, remaining)
      this.playheads.add(source)
      this.audioGains.set(layer.id, gain)
      source.onended = () => {
        this.playheads.delete(source)
        this.audioGains.delete(layer.id)
      }
    }
  }

  private async startVideos(from: number): Promise<void> {
    if (!this.project) return
    const starts: Promise<void>[] = []
    const tolerance = 0.5 / Math.max(1, this.project.fps)
    for (const layer of this.project.layers) {
      if (layer.kind !== 'video') continue
      const loaded = this.videos.get(layer.id)
      if (!loaded) continue
      if (loaded.stream) {
        starts.push(loaded.element.play().then(() => undefined, () => undefined))
        continue
      }
      const clip = videoClipAt(layer, from)
      if (!clip) {
        loaded.element.pause()
        continue
      }
      const into = clip.offset + Math.max(0, from - clip.from)
      const length = loaded.element.duration
      const wanted = layer.loop && Number.isFinite(length) && length > 0 ? into % length : into
      // A seek just completed by the scrubber is already displaying this frame. Assigning the
      // same currentTime again throws that decoded frame away and starts the decoder over.
      if (!loaded.element.seeking && Math.abs(loaded.element.currentTime - wanted) > tolerance) {
        loaded.element.currentTime = wanted
      }
      loaded.element.playbackRate = 1
      starts.push(loaded.element.play().then(() => undefined, () => undefined))
    }
    await Promise.all(starts)
  }

  pause(): void {
    if (!state.playing) return
    this.playRequest += 1
    this.clockReady = false
    this.stopAudio()
    for (const loaded of this.videos.values()) {
      if (!loaded.stream) loaded.element.pause()
    }
    publish({ playing: false })
  }

  private stopAudio(): void {
    for (const playhead of this.playheads) {
      try {
        playhead.stop()
      } catch {
        // Already stopped, which is the state we wanted.
      }
      playhead.disconnect()
    }
    this.playheads.clear()
    this.audioGains.clear()
  }

  /**
   * Dragging the playhead, as one gesture rather than a burst of seeks.
   *
   * A range input fires `change` on every pixel of a drag, and each one used to stop the
   * audio, tear down the buffer source, rebuild it and reschedule the fades - dozens of
   * times a second, which stutters and can leave playback stopped where the last event
   * landed. Pausing once at the start of the drag and resuming once at the end makes
   * scrubbing a single operation.
   */
  beginScrub(): void {
    this.resumeAfterScrub = state.playing
    if (state.playing) this.pause()
  }

  endScrub(): void {
    const resume = this.resumeAfterScrub
    this.resumeAfterScrub = false
    if (resume) this.play()
  }

  seek(to: number): void {
    if (!this.project) return
    const duration = projectDuration(this.project)
    const clamped = Math.max(0, Math.min(duration, to))
    const wasPlaying = state.playing
    if (wasPlaying) {
      this.stopAudio()
      publish({ playing: false })
    }
    this.time = clamped
    publish({ time: clamped })
    this.syncVideos(clamped, true)
    if (wasPlaying) this.play()
    else this.draw()
  }

  /**
   * Keeps the video layers with the clock.
   *
   * A nudge of the playback rate rather than a seek for small drift: seeking a `<video>`
   * flushes its decoder and shows a black frame for one or two of them, which on a layer
   * that is the whole background is a visible stutter several times a minute. Only drift
   * large enough that nudging cannot recover gets a real seek.
   */
  private syncVideos(time: number, hard: boolean): void {
    if (!this.project) return
    for (const layer of this.project.layers) {
      if (layer.kind !== 'video') continue
      const loaded = this.videos.get(layer.id)
      // Reassigning currentTime while a seek is in flight restarts the decoder on every
      // animation frame. Let the requested frame land before measuring drift again.
      if (!loaded || loaded.stream || loaded.element.readyState < 2 || loaded.element.seeking) continue
      const clip = videoClipAt(layer, time)
      if (!clip) {
        if (!loaded.element.paused) loaded.element.pause()
        loaded.element.playbackRate = 1
        continue
      }

      const length = loaded.element.duration
      let want = clip.offset + Math.max(0, time - clip.from)
      if (layer.loop && Number.isFinite(length) && length > 0) want %= length
      const drift = loaded.element.currentTime - want
      const frameTolerance = 0.5 / Math.max(1, this.project.fps)

      if (hard) {
        loaded.element.playbackRate = 1
        if (Math.abs(drift) > frameTolerance) loaded.element.currentTime = want
      } else if (Math.abs(drift) > 0.35) {
        loaded.element.currentTime = want
        loaded.element.playbackRate = 1
      } else if (Math.abs(drift) > 0.04 && state.playing && !loaded.element.paused) {
        loaded.element.playbackRate = drift > 0 ? 0.97 : 1.03
      } else {
        loaded.element.playbackRate = 1
      }
      if (state.playing && loaded.element.paused && !loaded.element.seeking) {
        void loaded.element.play().catch(() => undefined)
      }
    }
  }

  /* --- the loop -------------------------------------------------------------------- */

  private tick = (): void => {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(this.tick)
    if (!this.project) return

    if (state.playing && this.clockReady) {
      const duration = projectDuration(this.project)
      this.time = this.startedFrom + (audio().currentTime - this.startedAt)
      if (this.time >= duration) {
        this.time = duration
        this.pause()
        if (this.recorder) this.finishExport()
      }
      this.syncVideos(this.time, false)
      const exporting = this.recorder?.state === 'recording'
      if (!exporting) {
        // The editor playhead stays frame-rate smooth during ordinary playback.
        publish({ time: this.time })
      } else {
        // During export the canvas still draws every animation frame, but repainting the
        // React editor sixty times a second only steals CPU from the encoder. Five progress
        // updates a second is responsive without making the exported stream fight the UI.
        const now = performance.now()
        if (this.time >= duration || now - this.lastExportPublish >= 200) {
          this.lastExportPublish = now
          publish({
            time: this.time,
            exporting: {
              progress: Math.max(0, Math.min(1, this.time / duration)),
              path: state.exporting?.path ?? '',
              bytes: this.exportBytes
            }
          })
        }
      }
    }
    this.draw()
  }

  private draw(): void {
    if (!this.ctx || !this.project) return
    drawFrame(this.ctx, this.project, this.sources(), this.time)
  }

  /* --- export ---------------------------------------------------------------------- */

  /**
   * Which container this build can write.
   *
   * Measured in this Electron (Chromium 150): H.264 and AAC in MP4 are both supported by
   * `MediaRecorder`, which is what makes this feature possible without a bundled encoder -
   * Instagram and TikTok take an MP4 and will refuse a WebM outright. The WebM fallback is
   * kept anyway, because the codecs a build ships with are a property of the build and not
   * of the code, and silently producing a file the user cannot upload is worse than
   * producing one they can convert.
   */
  static container(): { mimeType: string; ext: string } {
    const mp4 = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
    if (MediaRecorder.isTypeSupported(mp4)) return { mimeType: mp4, ext: '.mp4' }
    if (MediaRecorder.isTypeSupported('video/mp4')) return { mimeType: 'video/mp4', ext: '.mp4' }
    return { mimeType: 'video/webm;codecs=vp9,opus', ext: '.webm' }
  }

  async exportVideo(bitrate: number): Promise<{ path?: string; error?: string }> {
    if (!this.canvas || !this.project) return { error: 'Nothing to export.' }
    if (this.recorder) return { error: 'An export is already running.' }

    const { mimeType, ext } = VideoStage.container()
    const opened = await window.umakbang.beginVideoWrite('export', this.project.name, ext)
    if ('error' in opened) return { error: opened.error }

    const ctx = audio()
    await ctx.resume()

    // The audio has to reach the recorder as a live track, so the master fans out to both
    // the speakers and a stream destination. Made once and kept: a second stream destination
    // per export would leave the first connected and mix the previous run in.
    if (!this.streamDestination) {
      this.streamDestination = ctx.createMediaStreamDestination()
      this.masterGain().connect(this.streamDestination)
    }

    const stream = new MediaStream([
      ...this.canvas.captureStream(this.project.fps).getVideoTracks(),
      ...this.streamDestination.stream.getAudioTracks()
    ])

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 192_000
      })
    } catch (error) {
      window.umakbang.abortVideoWrite(opened.id)
      return { error: `This build cannot encode ${mimeType}: ${(error as Error).message}` }
    }

    this.recorder = recorder
    this.writeId = opened.id
    this.exportBytes = 0
    this.lastExportPublish = 0
    this.setMonitoring(false)
    publish({ exporting: { progress: 0, path: opened.path, bytes: 0 }, error: null })

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      this.exportBytes += event.data.size
      // Straight to disk as it arrives. Collecting it into one Blob and posting that over
      // IPC at the end is two copies of a whole video in memory, and a three minute export
      // at 12Mbps is a quarter of a gigabyte of them.
      //
      // Chained rather than fired off in parallel. Each chunk needs `arrayBuffer()`, which
      // is a promise, and two chunks whose promises settle in the other order would be
      // appended in the other order - which in a video container is not a glitch, it is a
      // file that will not open. The events are a second apart so this queue is empty in
      // practice; the point is that "in practice" is not a guarantee.
      this.writeQueue = this.writeQueue
        .then(() => event.data.arrayBuffer())
        .then((bytes) => window.umakbang.writeVideoChunk(this.writeId, new Uint8Array(bytes)))
        .then(() => undefined)
    }

    return new Promise((resolve) => {
      recorder.onstop = () => {
        void this.settleExport().then(resolve)
      }
      recorder.onerror = () => {
        window.umakbang.abortVideoWrite(this.writeId)
        this.recorder = null
        this.setMonitoring(true)
        publish({ exporting: null })
        resolve({ error: 'The encoder stopped.' })
      }

      // A second of video per chunk, so backpressure is felt continuously rather than in one
      // lump at the end.
      recorder.start(1000)
      this.seek(0)
      this.play()
    })
  }

  private finishExport(): void {
    if (!this.recorder) return
    /**
     * A short tail before the encoder is closed, and deliberately a short one.
     *
     * Some is needed: `captureStream` samples the canvas asynchronously and the audio
     * reaches the recorder through a stream destination that is still holding a quantum or
     * two, so stopping in the same turn as the final draw loses the last frames and clips
     * the end of the sound. But every millisecond of it is a frozen frame over silence on
     * the end of the file, and these are watched on a loop, where the join is the one moment
     * everybody sees twice. Measured on a 3.00s clip: a 350ms tail wrote 3.32s, and three
     * frames plus a margin for the audio wrote 3.16s with nothing missing off either end.
     */
    const tail = Math.ceil(3000 / (this.project?.fps ?? 30)) + 50
    window.setTimeout(() => {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    }, tail)
  }

  private async settleExport(): Promise<{ path?: string; error?: string }> {
    const id = this.writeId
    this.recorder = null
    this.setMonitoring(true)
    // Every chunk has to have landed before the file is closed and renamed, or the last
    // second or two of the video is renamed away from underneath the write that carries it.
    await this.writeQueue
    this.writeId = ''
    const result = await window.umakbang.finishVideoWrite(id, null)
    publish({ exporting: null })
    if (result.error) return { error: result.error }
    return { path: result.path }
  }

  /** Stops an export where it is and throws away the partial file. */
  cancelExport(): void {
    if (!this.recorder) return
    const recorder = this.recorder
    this.recorder = null
    recorder.ondataavailable = null
    recorder.onstop = null
    try {
      recorder.stop()
    } catch {
      // Already inactive.
    }
    window.umakbang.abortVideoWrite(this.writeId)
    this.writeId = ''
    this.setMonitoring(true)
    this.pause()
    publish({ exporting: null })
  }

  isExporting(): boolean {
    return this.recorder !== null
  }

  /** Frees the elements and the camera. The AudioContext is deliberately kept. */
  dispose(): void {
    cancelAnimationFrame(this.frame)
    this.pause()
    this.cancelExport()
    for (const loaded of this.videos.values()) {
      loaded.element.pause()
      loaded.element.removeAttribute('src')
      loaded.stream?.getTracks().forEach((track) => track.stop())
    }
    this.videos.clear()
    this.audios.clear()
    this.images.clear()
    this.canvas = null
    this.ctx = null
  }

  /** Applies a live gain change without reloading the layer. */
  refreshAudioLevels(project: VideoProject): void {
    for (const layer of project.layers) {
      if (layer.kind === 'video') {
        const loaded = this.videos.get(layer.id)
        if (loaded) loaded.gain.gain.value = layer.hidden ? 0 : layer.volume
      }
      if (layer.kind === 'audio') {
        const gain = this.audioGains.get(layer.id)
        if (gain) gain.gain.value = layer.hidden ? 0 : layer.gain
      }
    }
  }
}
