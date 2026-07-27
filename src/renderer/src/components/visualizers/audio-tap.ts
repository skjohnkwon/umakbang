import { useSyncExternalStore } from 'react'
import { getAudioElement, usePlayer } from '@/state/player'

/**
 * The Web Audio tap the visualizers read from, plus the one animation frame loop they
 * all share.
 *
 * `createMediaElementSource()` can only ever be called once per element for the life of
 * the page, so the graph below is a module singleton: built lazily the first time a
 * visualizer mounts, never rebuilt, never torn down.
 *
 * Two things can feed it - the app's own player, or the machine's speaker output
 * captured through loopback. They meet at an analysis bus, so switching is a pair of
 * gain changes rather than a rewire.
 */

export interface AudioTap {
  context: AudioContext
  /** Downmixed to mono by the analyser itself - spectrum and scope work off this. */
  mono: AnalyserNode
  left: AnalyserNode
  right: AnalyserNode
  /** Frequency bins per analyser (fftSize / 2). */
  bins: number
  /**
   * A second analyser, for the panels that draw a frequency axis.
   *
   * On a log axis the bottom of the range is where resolution runs out: at 23Hz bins the
   * whole of 40–200Hz is eight of them, so a third of the height of a spectrogram is eight
   * distinct values painted in blocks while the top of it averages dozens of bins per row.
   * Four times the transform makes those bins ~6Hz.
   */
  fine: AnalyserNode
  fineBins: number
}

/** 2048 gives ~23Hz bins at 48k: enough resolution without a costly transform. */
const FFT_SIZE = 2048

/**
 * The frequency panels get 8192 instead - a quarter of the bin width, at the cost of a
 * longer window (~170ms). That trade only makes sense for them: the scope, the meters and
 * the rolling waveform read the time domain, where a longer window is a slower response.
 */
const FINE_FFT_SIZE = 8192

interface Graph extends AudioTap {
  /** Feeds from the <audio> element into the analysis bus. */
  playerGain: GainNode
  /** Feeds from the captured desktop stream into the same bus. */
  desktopGain: GainNode
  bus: GainNode
}

let graph: Graph | null = null
let unavailable = false

/**
 * Builds (or returns) the tap. Null means Web Audio refused - callers should simply draw
 * nothing rather than crash the panel.
 */
export function getAudioTap(): AudioTap | null {
  if (graph || unavailable) return graph

  try {
    const context = new AudioContext()
    const source = context.createMediaElementSource(getAudioElement())

    const analyser = (size: number = FFT_SIZE): AnalyserNode => {
      const node = context.createAnalyser()
      node.fftSize = size
      // Slight smoothing hides FFT frame-to-frame jitter without feeling laggy.
      node.smoothingTimeConstant = 0.72
      node.minDecibels = -96
      node.maxDecibels = -12
      return node
    }

    const mono = analyser()
    const left = analyser()
    const right = analyser()
    const fine = analyser(FINE_FFT_SIZE)
    // Less smoothing than the others: a 170ms window is already averaging over time, and
    // stacking the analyser's own smoothing on top of it drags the low end behind the beat.
    fine.smoothingTimeConstant = 0.55
    // Four times the bins means anything broadband lands about 6dB lower in each of them,
    // which showed up as the whole panel dimming when the transform grew. The window moves
    // down to match, so the picture keeps the brightness it had.
    fine.minDecibels = -102
    fine.maxDecibels = -18
    const splitter = context.createChannelSplitter(2)
    // Analysers only receive data while they have a path to the destination, so the whole
    // analysis branch is parked behind a muted gain. Desktop capture is already coming out
    // of the speakers, so this is the only thing keeping it from being played back twice.
    const silent = context.createGain()
    silent.gain.value = 0

    // The two possible inputs, mixed at the bus. Exactly one is open at a time.
    const bus = context.createGain()
    const playerGain = context.createGain()
    const desktopGain = context.createGain()
    playerGain.gain.value = 1
    desktopGain.gain.value = 0

    // Routing the element into a graph replaces its direct output, so it needs an explicit
    // path to the destination or playback goes silent.
    source.connect(context.destination)
    source.connect(playerGain)
    playerGain.connect(bus)
    desktopGain.connect(bus)

    bus.connect(mono)
    bus.connect(fine)
    bus.connect(splitter)
    splitter.connect(left, 0)
    splitter.connect(right, 1)
    mono.connect(silent)
    fine.connect(silent)
    left.connect(silent)
    right.connect(silent)
    silent.connect(context.destination)

    graph = {
      context,
      mono,
      left,
      right,
      bins: mono.frequencyBinCount,
      fine,
      fineBins: fine.frequencyBinCount,
      playerGain,
      desktopGain,
      bus
    }

    // Chromium can hand back a suspended context; a gesture (or pressing play) unlocks it.
    document.addEventListener('pointerdown', resumeAudioTap, { once: true })
    resumeAudioTap()
    return graph
  } catch (error) {
    console.error('[umakbang] audio tap unavailable', error)
    unavailable = true
    return null
  }
}

export function resumeAudioTap(): void {
  if (graph && graph.context.state === 'suspended') void graph.context.resume()
}

/* ----------------------------------------------------------------- input source */

export type VisualizerInput = 'player' | 'desktop'

export interface InputState {
  input: VisualizerInput
  /** True while the capture request is in flight. */
  connecting: boolean
  /** Why the last attempt to capture the desktop failed, if it did. */
  error: string | null
}

let inputState: InputState = { input: 'player', connecting: false, error: null }
const inputListeners = new Set<() => void>()
let capture: { stream: MediaStream; node: MediaStreamAudioSourceNode } | null = null

function publish(next: Partial<InputState>): void {
  inputState = { ...inputState, ...next }
  for (const listener of inputListeners) listener()
  sync()
}

function stopCapture(): void {
  if (!capture) return
  capture.node.disconnect()
  for (const track of capture.stream.getTracks()) track.stop()
  capture = null
}

/**
 * Chromium hands back a loopback track dressed for a conference call - mono, auto-gained,
 * echo-cancelled and noise-suppressed - which pumps and gates music into nonsense. The
 * processing can only be refused in the opening request (applyConstraints afterwards
 * fails with OverconstrainedError), so ask for raw stereo first and take the cooked track
 * only if the platform won't give it.
 */
async function requestDesktopStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 2
      }
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw error
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  }
}

/**
 * Switches what the visualizers listen to. Selecting 'desktop' asks for a loopback
 * capture, which needs a user gesture behind it - call this straight from a click.
 */
export async function setVisualizerInput(input: VisualizerInput): Promise<void> {
  const tap = getAudioTap()
  if (!tap || !graph) return

  if (input === 'player') {
    stopCapture()
    graph.desktopGain.gain.value = 0
    graph.playerGain.gain.value = 1
    publish({ input: 'player', connecting: false, error: null })
    return
  }

  if (inputState.connecting) return
  publish({ connecting: true, error: null })

  try {
    // Video is requested only because Chromium rejects an audio-only display capture; the
    // main process answers with `audio: 'loopback'` and the track is dropped immediately.
    const stream = await requestDesktopStream()
    for (const track of stream.getVideoTracks()) {
      track.stop()
      stream.removeTrack(track)
    }

    const [track] = stream.getAudioTracks()
    if (!track) {
      for (const other of stream.getTracks()) other.stop()
      throw new Error('The capture returned no audio. System audio needs Windows.')
    }

    // Anything that ends the capture from outside (a device change, the OS stop button)
    // drops back to the player rather than leaving dead visualizers.
    track.addEventListener('ended', () => {
      if (inputState.input === 'desktop') void setVisualizerInput('player')
    })

    stopCapture()
    const node = graph.context.createMediaStreamSource(stream)
    node.connect(graph.desktopGain)
    capture = { stream, node }

    graph.playerGain.gain.value = 0
    graph.desktopGain.gain.value = 1
    resumeAudioTap()
    publish({ input: 'desktop', connecting: false, error: null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[umakbang] desktop audio capture failed', error)
    publish({ input: 'player', connecting: false, error: message })
  }
}

function subscribeInput(listener: () => void): () => void {
  inputListeners.add(listener)
  return () => inputListeners.delete(listener)
}

const readInput = (): InputState => inputState

/** Subscribes a component to which source the visualizers are reading. */
export function useVisualizerInput(): InputState {
  return useSyncExternalStore(subscribeInput, readInput, readInput)
}

/* ------------------------------------------------------------------ frame loop */

/**
 * What a frame means.
 *
 * - `live` - audio is moving, draw it.
 * - `idle` - the single settling frame emitted when playback stops.
 * - `clear` - nothing has played for a while; throw away whatever is on screen.
 */
export type FramePhase = 'live' | 'idle' | 'clear'

type FrameListener = (phase: FramePhase, time: number) => void

const listeners = new Set<FrameListener>()
let handle = 0
let playing = false
let watchingPlayer = false

/**
 * How long silence has to last before the panels are wiped.
 *
 * Short enough that a stopped player doesn't leave a frozen spectrogram sitting there
 * looking live, long enough that pausing to reposition, or stepping between takes,
 * doesn't throw away the trace you were just looking at.
 */
const IDLE_CLEAR_MS = 5000

let clearTimer: ReturnType<typeof setTimeout> | null = null
/** Whether anything has been drawn since the last wipe - nothing else is worth wiping. */
let painted = false

/**
 * The loop targets 60fps and drops the extra frames a 120/144Hz panel would hand it.
 * Beyond the CPU it saves, the scrolling panels advance one column per frame, so an
 * uncapped loop would make their time axis depend on the monitor.
 */
const FRAME_MS = 1000 / 60
let lastFrame = 0

function tick(time: number): void {
  handle = requestAnimationFrame(tick)
  const elapsed = time - lastFrame
  if (elapsed < FRAME_MS - 1) return
  // Carry the remainder instead of resetting, so pacing doesn't drift against the display.
  lastFrame = time - (elapsed % FRAME_MS)
  painted = true
  for (const listener of listeners) listener('live', time)
}

/**
 * One rAF for every visualizer, and only while audio is actually moving. On desktop
 * capture there's no transport to watch, so the loop runs for as long as the capture does.
 */
function sync(): void {
  const live = inputState.input === 'desktop' ? true : playing
  const shouldRun = live && listeners.size > 0
  if (shouldRun) {
    if (clearTimer) {
      clearTimeout(clearTimer)
      clearTimer = null
    }
    if (!handle) handle = requestAnimationFrame(tick)
    return
  }
  if (handle) {
    cancelAnimationFrame(handle)
    handle = 0
    const now = performance.now()
    for (const listener of listeners) listener('idle', now)
  }
  scheduleClear()
}

/**
 * Wipes the panels once silence has gone on long enough.
 *
 * A stopped player leaves its last frame frozen on screen, which reads as though
 * something is still playing. Waiting rather than clearing immediately means a pause is
 * still a pause - the trace is there when you press play again a second later.
 */
function scheduleClear(): void {
  if (clearTimer || !painted || listeners.size === 0) return
  clearTimer = setTimeout(() => {
    clearTimer = null
    painted = false
    const now = performance.now()
    for (const listener of listeners) listener('clear', now)
  }, IDLE_CLEAR_MS)
  clearTimer.unref?.()
}

/**
 * Subscribes to the shared loop. The listener gets one immediate idle frame so a panel
 * mounted while paused still paints itself.
 */
export function subscribeFrames(listener: FrameListener): () => void {
  if (!watchingPlayer) {
    watchingPlayer = true
    playing = usePlayer.getState().playing
    usePlayer.subscribe((state) => {
      if (state.playing === playing) return
      playing = state.playing
      if (playing) resumeAudioTap()
      sync()
    })
  }

  listeners.add(listener)
  sync()
  if (!handle) listener('idle', performance.now())

  return () => {
    listeners.delete(listener)
    sync()
  }
}
