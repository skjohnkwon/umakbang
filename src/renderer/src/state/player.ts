import { create } from 'zustand'
import type { Track } from '@shared/types'
import { isUnderAnyDir } from '@/lib/paths'
import { useLibrary } from './library'

interface PlayerState {
  current: Track | null
  /** The auto-built up-next list. */
  queue: Track[]
  index: number
  playing: boolean
  /** Updated at the ~4Hz rate of the audio element's timeupdate event. */
  time: number
  duration: number
  muted: boolean
  error: string | null

  play: (track: Track, context: Track[]) => void
  /**
   * Picks a playable file at random, plays it, and takes the explorer to it. Unlike
   * `next`, moving the library view is the whole point here: the file you landed on is one
   * you'd otherwise never have found, so it has to be somewhere you can act on it.
   */
  playRandom: () => void
  togglePlay: () => void
  next: () => void
  previous: () => void
  seek: (seconds: number) => void
  /** Nudges playback by a relative amount, clamped to the track. */
  seekBy: (delta: number) => void
  toggleMute: () => void
  stop: () => void
}

/**
 * How many of the last random picks are off the table. A uniform draw over even a large
 * library repeats far sooner than it feels like it should - with 5,000 playable files the
 * odds of a repeat inside 100 draws are better than even - and a random button that hands
 * back a beat you heard ten minutes ago reads as broken rather than as chance.
 */
const RANDOM_HISTORY = 100

/**
 * Paths `playRandom` has drawn, oldest first. Session-only and deliberately not in the
 * store: nothing renders from it, so putting it in zustand would repaint the library on
 * every draw, and a window that survived a restart would be answering for a library that
 * has since moved underneath it.
 */
const recentRandom: string[] = []

let audio: HTMLAudioElement | null = null

/**
 * The single <audio> element every playback path goes through. Exposed so the waveform
 * can read currentTime on its own animation frame instead of forcing a React render at
 * 60fps just to move a playhead.
 */
export function getAudioElement(): HTMLAudioElement {
  if (audio) return audio

  const element = new Audio()
  element.preload = 'auto'
  /**
   * Required for the visualizers, and must be set before any src is assigned.
   *
   * `umakbang-file://` is a different origin from the renderer, and a
   * MediaElementAudioSourceNode built from cross-origin media that wasn't fetched with
   * CORS is silently zeroed by the browser - the element appears to play while the graph
   * outputs nothing at all. The protocol already answers with
   * `Access-Control-Allow-Origin` and has `corsEnabled`, so the check passes and the
   * media stays untainted.
   */
  element.crossOrigin = 'anonymous'

  element.addEventListener('timeupdate', () => {
    usePlayer.setState({ time: element.currentTime })
  })
  element.addEventListener('durationchange', () => {
    if (Number.isFinite(element.duration)) usePlayer.setState({ duration: element.duration })
  })
  element.addEventListener('play', () => usePlayer.setState({ playing: true }))
  element.addEventListener('pause', () => usePlayer.setState({ playing: false }))
  element.addEventListener('ended', () => {
    const { autoAdvance } = useLibrary.getState().settings
    if (autoAdvance) usePlayer.getState().next()
    else usePlayer.setState({ playing: false })
  })
  element.addEventListener('error', () => {
    const track = usePlayer.getState().current
    usePlayer.setState({
      playing: false,
      error: track ? `Can't decode .${track.ext} - open it in your DAW instead.` : 'Playback failed.'
    })
  })

  audio = element
  return element
}

/**
 * Builds the up-next list around a track. "folder" - the default - queues everything in
 * the same directory, which is how stems and takes are actually organised. "view"
 * queues whatever the current filter is showing, so a search doubles as a playlist.
 */
function buildQueue(track: Track, context: Track[]): Track[] {
  const source = useLibrary.getState().settings.queueSource
  const playable = context.filter((t) => t.playable)
  const scoped =
    source === 'folder' ? playable.filter((t) => t.dir === track.dir) : playable

  // The clicked track must be in its own queue even if the context list didn't hold it.
  return scoped.some((t) => t.path === track.path) ? scoped : [track, ...scoped]
}

function load(track: Track, autoplay: boolean): void {
  const element = getAudioElement()
  element.src = window.umakbang.fileUrl(track.path)
  element.currentTime = 0
  usePlayer.setState({
    current: track,
    time: 0,
    // Fall back to the probed duration until the element reports its own.
    duration: track.duration ?? 0,
    error: track.playable ? null : `.${track.ext} files can't be previewed in Umakbang.`
  })
  if (autoplay && track.playable) {
    void element.play().catch(() => {
      /* The 'error' listener reports this to the user. */
    })
  }
}

export const usePlayer = create<PlayerState>((set, get) => ({
  current: null,
  queue: [],
  index: -1,
  playing: false,
  time: 0,
  duration: 0,
  muted: false,
  error: null,

  play: (track, context) => {
    const queue = buildQueue(track, context)
    const index = queue.findIndex((t) => t.path === track.path)
    set({ queue, index })

    // Clicking the already-loaded track toggles rather than restarting it.
    if (get().current?.path === track.path) {
      get().togglePlay()
      return
    }
    load(track, true)
  },

  playRandom: () => {
    const library = useLibrary.getState()
    const excluded = library.settings.randomExcludeDirs
    // Only files the player can actually decode: landing on a .flp would reveal a row and
    // then refuse to play it, which reads as the button being broken.
    const candidates = library.tracks.filter(
      (track) => track.playable && !isUnderAnyDir(track.relDir, excluded)
    )
    if (candidates.length === 0) {
      library.notify(
        excluded.length > 0
          ? 'Nothing left to pick from: every playable file is in an excluded folder.'
          : 'Nothing in the library can be previewed yet.'
      )
      return
    }

    /**
     * The last RANDOM_HISTORY draws are out of the running - but the window can never eat
     * the whole pool, or a library of thirty playable files would run out of beats to
     * offer and the button would stop doing anything.
     */
    const windowSize = Math.min(RANDOM_HISTORY, candidates.length - 1)
    const recent = new Set(recentRandom.slice(-windowSize))
    // What's playing counts as recent however it got there - reached by clicking a row, it
    // isn't in the history, and drawing it would look like the button did nothing at all.
    const playing = get().current?.path
    if (playing) recent.add(playing)

    const pool = candidates.filter((track) => !recent.has(track.path))
    // Only reachable when the library holds a single playable file, which the seek below
    // then handles: everything else leaves at least one candidate outside the window.
    const draw = pool.length > 0 ? pool : candidates
    const pick = draw[Math.floor(Math.random() * draw.length)]

    recentRandom.push(pick.path)
    if (recentRandom.length > RANDOM_HISTORY) recentRandom.shift()

    library.revealTrack(pick)
    // Reveal has just moved the explorer to the file's folder, so the folder's own files
    // are the right queue whichever queue source is set.
    const folder = candidates.filter((track) => track.dir === pick.dir)

    // A library with a single playable file can draw the same one twice, and `play` would
    // read that as a click on the playing row and pause it.
    if (get().current?.path === pick.path) {
      get().seek(0)
      if (!get().playing) get().togglePlay()
      return
    }
    get().play(pick, folder)
  },

  togglePlay: () => {
    const element = getAudioElement()
    const { current } = get()
    if (!current) return
    if (element.paused) {
      void element.play().catch(() => undefined)
    } else {
      element.pause()
    }
  },

  next: () => {
    const { queue, index } = get()
    const nextIndex = index + 1
    if (nextIndex >= queue.length) {
      set({ playing: false })
      return
    }
    set({ index: nextIndex })
    load(queue[nextIndex], true)
    // Deliberately leaves the explorer where it is. Playback moving the list out from
    // under you - changing the folder and the selection mid-browse - makes it impossible
    // to keep working while something plays. The player bar's "show playing track"
    // button is there for when you do want to go to it.
  },

  previous: () => {
    const element = getAudioElement()
    // Standard transport behaviour: restart the track unless you're near its start.
    if (element.currentTime > 3) {
      element.currentTime = 0
      return
    }
    const { queue, index } = get()
    const prevIndex = index - 1
    if (prevIndex < 0) {
      element.currentTime = 0
      return
    }
    set({ index: prevIndex })
    load(queue[prevIndex], true)
  },

  seek: (seconds) => {
    const element = getAudioElement()
    if (!Number.isFinite(seconds)) return
    const max = Number.isFinite(element.duration) ? element.duration : get().duration
    element.currentTime = Math.max(0, Math.min(seconds, max || 0))
    set({ time: element.currentTime })
  },

  seekBy: (delta) => {
    const element = getAudioElement()
    if (!get().current) return
    // Fall back to the probed duration when the element hasn't reported one yet.
    const duration = Number.isFinite(element.duration) ? element.duration : get().duration
    if (!duration) return
    const next = Math.max(0, Math.min(element.currentTime + delta, duration))
    element.currentTime = next
    set({ time: next })
  },

  toggleMute: () => {
    const muted = !get().muted
    getAudioElement().muted = muted
    set({ muted })
  },

  stop: () => {
    const element = getAudioElement()
    element.pause()
    element.removeAttribute('src')
    element.load()
    set({ current: null, queue: [], index: -1, playing: false, time: 0, duration: 0, error: null })
  }
}))
