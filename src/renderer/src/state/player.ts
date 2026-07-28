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
  /**
   * Output level, 0..1, kept separate from `muted` on purpose: muting is a thing you undo,
   * and undoing it has to give back the level that was set rather than full volume.
   *
   * Mirrored into `Settings.volume`, which is where it survives a restart. This copy exists
   * because the audio element needs it on every change and the transport reads it on every
   * render, and neither wants to wait on the settings round trip.
   */
  volume: number
  error: string | null
  /**
   * The stretch of the current track playback is being held inside, in seconds.
   *
   * Belongs to the track it was drawn on and to nothing else, so `load` clears it: a region
   * carried onto the next file would name seconds that mean something entirely different
   * there, and the playhead would appear to be stuck for no reason anybody could see.
   */
  region: { start: number; end: number } | null

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
  /** Sets the output level, 0..1. Anything above zero also lifts a mute. */
  setVolume: (volume: number) => void
  /** Sets the loop region, or clears it with null. */
  setRegion: (region: { start: number; end: number } | null) => void
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

/**
 * How much more often an unrated beat comes up than a rated one, when the setting is on.
 *
 * A *weight* rather than a filter, and that is the whole design. Excluding rated files
 * outright has a cliff in it: at 95% rated the dice would be picking from the same handful
 * of leftovers over and over, which is worse than the problem it set out to solve, and at
 * 100% there would be nothing to pick at all. Weighting has no cliff - the unrated ones come
 * up four times as often while there are unrated ones, the library stays whole underneath,
 * and a fully rated library degrades to exactly the uniform draw it had before.
 */
const UNRATED_WEIGHT = 4

/** Draws one track, favouring the unrated ones when asked to. */
function weightedPick(
  tracks: Track[],
  favourUnrated: boolean,
  ratings: Record<string, number>
): Track {
  if (!favourUnrated) return tracks[Math.floor(Math.random() * tracks.length)]

  const weightOf = (track: Track): number =>
    (ratings[track.path] ?? 0) === 0 ? UNRATED_WEIGHT : 1

  let total = 0
  for (const track of tracks) total += weightOf(track)

  let ticket = Math.random() * total
  for (const track of tracks) {
    ticket -= weightOf(track)
    if (ticket <= 0) return track
  }
  // Only reachable through floating-point drift on the last ticket.
  return tracks[tracks.length - 1]
}

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
    enforceRegion()
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
 * Keeps playback inside the loop region, wrapping to its start when it runs off the end.
 *
 * Called from two places deliberately. `timeupdate` fires about four times a second, so on
 * its own the loop can run a quarter of a second past the end before it comes back, which
 * over a two-bar loop is plainly audible. The waveform's animation frame calls this as
 * well, and while the waveform is on screen that lands the wrap within a frame.
 *
 * The `timeupdate` call is not redundant, it is the floor: the waveform is unmounted in the
 * mini player and in visualizers-only mode, and a loop that quietly stopped looping when a
 * panel was closed would be far worse than a loose one.
 */
export function enforceRegion(): void {
  const region = usePlayer.getState().region
  if (!region) return
  const element = getAudioElement()
  /**
   * Only while it is actually moving. Scrubbing a paused track outside the region is how
   * you look at the rest of the file before deciding where the region should have been, and
   * snapping the playhead back would make one impossible to see past without clearing it.
   */
  if (element.paused) return
  if (element.currentTime >= region.end) {
    element.currentTime = region.start
    usePlayer.setState({ time: region.start })
  }
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
  /**
   * The saved level, applied here rather than at launch.
   *
   * `hydrate` would be the obvious place, but it lives in `library.ts` and this module
   * already imports that one - the reverse import would close a cycle for one number. Every
   * track goes through here, and the element is a singleton, so reading the setting on load
   * is both the single choke point and always current. `setVolume` handles live changes.
   */
  const saved = useLibrary.getState().settings.volume
  const volume = Math.max(0, Math.min(1, Number.isFinite(saved) ? saved : 1))
  element.volume = volume
  if (usePlayer.getState().volume !== volume) usePlayer.setState({ volume })

  element.src = window.umakbang.fileUrl(track.path)
  element.currentTime = 0
  usePlayer.setState({
    current: track,
    time: 0,
    // The region was drawn on the outgoing track's waveform and means nothing on this one.
    region: null,
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
  volume: 1,
  error: null,
  region: null,

  play: (track, context) => {
    const queue = buildQueue(track, context)
    const index = queue.findIndex((t) => t.path === track.path)
    set({ queue, index })

    /**
     * Clicking the track that is already playing starts it again rather than pausing it.
     *
     * It used to toggle, and pausing is the one thing a click on a row should never do:
     * every other click in the explorer selects or auditions, so a click that stops the
     * music reads as having hit the wrong thing. Space is the pause, in one place, and the
     * transport has a button. Re-clicking a beat in a sample browser means "again".
     *
     * Playing but paused is the exception - there the click resumes, since the alternative
     * is a row you can click twice with nothing to show for it.
     */
    if (get().current?.path === track.path) {
      const element = getAudioElement()
      if (!get().playing) {
        void element.play().catch(() => {
          /* The 'error' listener reports this to the user. */
        })
        return
      }
      element.currentTime = get().region?.start ?? 0
      set({ time: element.currentTime })
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
    const pick = weightedPick(draw, library.settings.randomFavourUnrated, library.ratings)

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
    const { current, region } = get()
    if (!current) return
    if (element.paused) {
      // Starting from outside the loop starts it at the beginning instead. Playing a
      // stretch that is not the thing being looped, and only arriving in the region a
      // minute later, is not what pressing play on a region means.
      if (region && (element.currentTime < region.start || element.currentTime >= region.end)) {
        element.currentTime = region.start
        set({ time: region.start })
      }
      void element.play().catch(() => undefined)
    } else {
      element.pause()
    }
  },

  next: () => {
    const { queue, index } = get()
    const nextIndex = index + 1
    if (nextIndex >= queue.length) {
      // The element has to stop too: setting the flag alone showed the play icon while
      // the audio carried on underneath it.
      getAudioElement().pause()
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
    // Deliberately leaves `volume` where it is, so unmuting comes back to the level that
    // was set rather than to whatever the element happens to hold.
    set({ muted })
  },

  setVolume: (value) => {
    const volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1))
    const element = getAudioElement()
    element.volume = volume
    // Touching the level at all lifts a mute, as long as it lands somewhere audible.
    // Otherwise the user drags a slider that visibly does nothing, which reads as a broken
    // control rather than as a mute they had forgotten about.
    const muted = volume > 0 ? false : get().muted
    element.muted = muted
    set({ volume, muted })
    // Persisted, so the level survives a restart. The store debounces its own write, which
    // is what makes it safe to call on every frame of a slider drag.
    useLibrary.getState().patchSettings({ volume })
  },

  setRegion: (region) => {
    // A press that never became a drag is a click, and a click clears the region rather
    // than leaving a loop of no length behind, which would pin the playhead on one sample.
    set({ region: region && region.end > region.start ? region : null })
  },

  stop: () => {
    const element = getAudioElement()
    element.pause()
    element.removeAttribute('src')
    element.load()
    set({
      current: null,
      queue: [],
      index: -1,
      playing: false,
      time: 0,
      duration: 0,
      error: null,
      region: null
    })
  }
}))
