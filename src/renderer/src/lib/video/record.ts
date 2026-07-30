/**
 * The screen recorder.
 *
 * A DAW session is the one piece of footage a producer already has and cannot get out of
 * this app any other way, so it is captured here rather than sending people to OBS and
 * asking them to come back with a file.
 *
 * Two recorders can run at once - the screen and the camera - and they are written as two
 * files rather than composited live. That is on purpose: where the camera box sits, how big
 * it is and whether it is even in the shot are decisions made afterwards while looking at
 * the beat, and a live composite bakes them in at the one moment nobody is thinking about
 * framing. Two files also means a take is still usable when the camera was pointing at the
 * ceiling.
 *
 * Chunks go to disk as they arrive. A twenty minute session at 12Mbps is 1.8GB, which is not
 * a `Blob` anybody should be holding.
 */

import type { CaptureSettings, CaptureSource, Recording } from '@shared/video'

export interface RecorderState {
  recording: boolean
  /** Milliseconds since it started. */
  elapsed: number
  /** Bytes written so far, across both files. */
  bytes: number
  error: string | null
  /** What is being captured, for the strip that says so. */
  sourceName: string
  /** Whether a camera is rolling alongside. */
  camera: boolean
}

let state: RecorderState = {
  recording: false,
  elapsed: 0,
  bytes: 0,
  error: null,
  sourceName: '',
  camera: false
}

const listeners = new Set<() => void>()

export function subscribeRecorder(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function recorderState(): RecorderState {
  return state
}

function publish(patch: Partial<RecorderState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

interface Leg {
  recorder: MediaRecorder
  stream: MediaStream
  writeId: string
  path: string
  width: number
  height: number
  kind: 'screen' | 'camera'
  /**
   * Serialises this leg's appends.
   *
   * Each chunk arrives as a `Blob` and has to go through `arrayBuffer()` before it can be
   * sent, and two promises settling in the other order would append the chunks in the other
   * order. A video container does not survive that.
   */
  queue: Promise<void>
}

let legs: Leg[] = []
let startedAt = 0
let ticker = 0
let sourceLabel = ''
let sourceKind: 'screen' | 'window' = 'screen'

/**
 * What a capture is written as.
 *
 * MP4 first for the same reason the export prefers it - it is what everything else on the
 * machine can open - but a capture is an intermediate rather than something posted, so a
 * WebM fallback costs nothing here beyond a slightly slower decode when it becomes a layer.
 */
function container(): { mimeType: string; ext: string } {
  const mp4 = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
  if (MediaRecorder.isTypeSupported(mp4)) return { mimeType: mp4, ext: '.mp4' }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
    return { mimeType: 'video/webm;codecs=vp9,opus', ext: '.webm' }
  }
  return { mimeType: 'video/webm', ext: '.webm' }
}

export function listCaptureSources(): Promise<CaptureSource[]> {
  return window.umakbang.captureSources()
}

/** Microphones and cameras, for the two pickers. Labels need permission to be populated. */
export async function listDevices(): Promise<{
  microphones: MediaDeviceInfo[]
  cameras: MediaDeviceInfo[]
}> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    microphones: devices.filter((device) => device.kind === 'audioinput'),
    cameras: devices.filter((device) => device.kind === 'videoinput')
  }
}

/**
 * Chromium's desktop capture constraints, which are not in the DOM types.
 *
 * `chromeMediaSource: 'desktop'` on the audio side with no source id is what Electron
 * implements loopback as, and it is Windows only - `enableSystemAudioCapture` in main says
 * the same thing from the other end.
 */
interface DesktopConstraints {
  mandatory: {
    chromeMediaSource: 'desktop'
    chromeMediaSourceId?: string
    maxWidth?: number
    maxHeight?: number
    maxFrameRate?: number
  }
}

function videoConstraint(sourceId: string, settings: CaptureSettings): DesktopConstraints {
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      // A 4K monitor captured at full size is an unusable file and an encoder that cannot
      // keep up, and the result is downscaled to 1080 by the platform anyway.
      maxWidth: Math.round((settings.maxHeight * 16) / 9),
      maxHeight: settings.maxHeight,
      maxFrameRate: settings.fps
    }
  }
}

async function captureStream(
  source: CaptureSource,
  settings: CaptureSettings
): Promise<MediaStream> {
  const video = videoConstraint(source.id, settings) as unknown as MediaTrackConstraints

  if (!settings.systemAudio) {
    return navigator.mediaDevices.getUserMedia({ video, audio: false })
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video,
      audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints
    })
  } catch {
    // Loopback is Windows only, and asking for it elsewhere fails the whole request rather
    // than the audio half of it. A silent capture is still a usable capture - the beat is
    // laid over it from the library afterwards anyway - so this falls back rather than
    // failing, and the caller says so.
    publish({ error: 'System audio was not available, so this take is silent.' })
    return navigator.mediaDevices.getUserMedia({ video, audio: false })
  }
}

async function microphoneStream(settings: CaptureSettings): Promise<MediaStream | null> {
  if (!settings.microphone) return null
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: settings.microphoneId
        ? { deviceId: { exact: settings.microphoneId } }
        : true
    })
  } catch {
    publish({ error: 'The microphone could not be opened; recording without it.' })
    return null
  }
}

async function cameraStream(settings: CaptureSettings): Promise<MediaStream | null> {
  if (!settings.camera) return null
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: settings.cameraId
        ? { deviceId: { exact: settings.cameraId }, frameRate: settings.fps }
        : { width: 1280, height: 720, frameRate: settings.fps },
      audio: false
    })
  } catch {
    publish({ error: 'The camera could not be opened; recording the screen only.' })
    return null
  }
}

/**
 * Mixes the loopback and the microphone into one track.
 *
 * Only when there are actually two: a single track is passed through untouched rather than
 * round-tripped through an AudioContext, which would cost a resample and a few milliseconds
 * of latency for nothing.
 */
let mixContext: AudioContext | null = null

function mixAudio(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  if (tracks.length < 2) return tracks
  // One context, kept: a context per take is a graph per take that nothing ever closes, and
  // Chromium caps how many a page may have open at once.
  if (!mixContext) mixContext = new AudioContext()
  const context = mixContext
  const destination = context.createMediaStreamDestination()
  for (const track of tracks) {
    const source = context.createMediaStreamSource(new MediaStream([track]))
    source.connect(destination)
  }
  return destination.stream.getAudioTracks()
}

function beginLeg(
  stream: MediaStream,
  kind: 'screen' | 'camera',
  settings: CaptureSettings,
  opened: { id: string; path: string }
): Leg {
  const { mimeType } = container()
  const track = stream.getVideoTracks()[0]
  const captured = track?.getSettings() ?? {}

  const recorder = new MediaRecorder(stream, {
    mimeType,
    // A camera does not need what a piano roll needs.
    videoBitsPerSecond: kind === 'camera' ? 4_000_000 : settings.bitrate,
    audioBitsPerSecond: 192_000
  })

  const leg: Leg = {
    recorder,
    stream,
    writeId: opened.id,
    path: opened.path,
    width: captured.width ?? 0,
    height: captured.height ?? 0,
    kind,
    queue: Promise.resolve()
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return
    publish({ bytes: state.bytes + event.data.size })
    leg.queue = leg.queue
      .then(() => event.data.arrayBuffer())
      .then((bytes) => window.umakbang.writeVideoChunk(leg.writeId, new Uint8Array(bytes)))
      .then(() => undefined)
  }

  // A capture ends when the user closes the window being captured, and Chromium reports that
  // by ending the track rather than by erroring. Without this the recorder sits there
  // writing nothing and the timer keeps counting.
  track?.addEventListener('ended', () => {
    if (state.recording) void stop()
  })

  recorder.start(1000)
  return leg
}

export async function start(
  source: CaptureSource,
  settings: CaptureSettings,
  name: string
): Promise<{ error?: string }> {
  if (state.recording) return { error: 'Already recording.' }
  publish({ error: null, bytes: 0, elapsed: 0 })

  const { ext } = container()
  let screen: MediaStream
  try {
    screen = await captureStream(source, settings)
  } catch (error) {
    return { error: `Could not capture that: ${(error as Error).message}` }
  }

  const microphone = await microphoneStream(settings)
  if (microphone) {
    const mixed = mixAudio([...screen.getAudioTracks(), ...microphone.getAudioTracks()])
    const combined = new MediaStream([...screen.getVideoTracks(), ...mixed])
    screen.getAudioTracks().forEach((track) => screen.removeTrack(track))
    screen = combined
  }

  const camera = await cameraStream(settings)

  const opened = await window.umakbang.beginVideoWrite('recording', name, ext)
  if ('error' in opened) {
    screen.getTracks().forEach((track) => track.stop())
    camera?.getTracks().forEach((track) => track.stop())
    return { error: opened.error }
  }

  legs = [beginLeg(screen, 'screen', settings, opened)]

  if (camera) {
    const cameraOpened = await window.umakbang.beginVideoWrite('recording', `${name} camera`, ext)
    if ('error' in cameraOpened) camera.getTracks().forEach((track) => track.stop())
    else legs.push(beginLeg(camera, 'camera', settings, cameraOpened))
  }

  sourceLabel = source.name
  sourceKind = source.kind
  startedAt = performance.now()
  publish({ recording: true, sourceName: source.name, camera: legs.length > 1 })

  ticker = window.setInterval(() => {
    publish({ elapsed: performance.now() - startedAt })
  }, 200)

  return {}
}

/** Stops both legs and lists whatever landed. */
export async function stop(): Promise<Recording[]> {
  if (!state.recording) return []
  window.clearInterval(ticker)
  const durationMs = performance.now() - startedAt
  const running = legs
  legs = []
  publish({ recording: false })

  const finished = await Promise.all(
    running.map(
      (leg) =>
        new Promise<Recording | null>((resolve) => {
          leg.recorder.onstop = () => {
            leg.stream.getTracks().forEach((track) => track.stop())
            // After the queue, or the rename lands ahead of the final chunk's write.
            void leg.queue
              .then(() =>
                window.umakbang.finishVideoWrite(leg.writeId, {
                  durationMs,
                  width: leg.width,
                  height: leg.height,
                  source: leg.kind === 'camera' ? 'camera' : sourceKind,
                  sourceName: leg.kind === 'camera' ? 'Camera' : sourceLabel
                })
              )
              .then((result) => {
                if (result.error) publish({ error: result.error })
                resolve(result.recording ?? null)
              })
          }
          try {
            leg.recorder.stop()
          } catch {
            resolve(null)
          }
        })
    )
  )

  return finished.filter((entry): entry is Recording => entry !== null)
}

/** Throws the take away rather than keeping it. */
export function cancel(): void {
  if (!state.recording) return
  window.clearInterval(ticker)
  for (const leg of legs) {
    leg.recorder.ondataavailable = null
    try {
      leg.recorder.stop()
    } catch {
      // Already stopped.
    }
    leg.stream.getTracks().forEach((track) => track.stop())
    window.umakbang.abortVideoWrite(leg.writeId)
  }
  legs = []
  publish({ recording: false, bytes: 0, elapsed: 0 })
}
