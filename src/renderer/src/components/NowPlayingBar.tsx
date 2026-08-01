import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  ListMusic,
  LocateFixed,
  Pause,
  Play,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { Track } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Waveform } from '@/components/Waveform'
import { NamePopover, type NamePrompt } from '@/components/NamePopover'
import { usePlayer } from '@/state/player'
import { useLibrary } from '@/state/library'
import { useProjectFor } from '@/hooks/useLibraryView'
import { decodeTrack } from '@/lib/peaks'
import { trimBuffer, trimName } from '@/lib/trim'
import { QUICK } from '@/lib/motion'
import { formatHours } from '@/lib/stats'
import { baseName, formatDurationPrecise, formatTime } from '@/lib/format'
import {
  DEFAULT_DETAIL_FIELDS,
  formatDetails,
  normalizeDetailFields
} from '@/lib/player-details'
import { cn } from '@/lib/utils'

/** How short and how tall the transport strip may be dragged. */
const MIN_HEIGHT = 92
const MAX_HEIGHT = 320
const DEFAULT_HEIGHT = 112

/** How far the boundary between the controls and the waveform may be dragged. */
const MIN_SPLIT = 250
const MAX_SPLIT = 900
const DEFAULT_SPLIT = 430

/**
 * Now playing, pinned across the bottom of the explorer.
 *
 * Everything about the current track lives here - name, format, elapsed time, how long
 * its project took, and the transport - so the right-hand panel is nothing but
 * visualizers.
 *
 * Laid out as one wide row rather than the narrow column this used to be at the foot of
 * the sidebar. The waveform is the reason: it is a scrub target as well as a picture, and
 * at sidebar width it was 200-odd pixels for a whole track, which is a couple of seconds
 * per pixel and impossible to aim with. Here it takes every pixel the other groups don't,
 * so it grows with the window.
 */
export function NowPlayingBar(): React.JSX.Element {
  const current = usePlayer((s) => s.current)
  const playing = usePlayer((s) => s.playing)
  const time = usePlayer((s) => s.time)
  const duration = usePlayer((s) => s.duration)
  const error = usePlayer((s) => s.error)
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)

  const height = useLibrary((s) => s.settings.playerHeight)
  const patchSettings = useLibrary((s) => s.patchSettings)

  // Height follows the pointer locally and is written once on release, the same way the
  // sidebar and the dock handle their widths.
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  dragRef.current = dragHeight
  const savedRef = useRef(height)
  savedRef.current = height
  const effectiveHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragHeight ?? height))

  // Where the controls end and the waveform begins. Same local-drag, persist-on-release
  // pattern as the height above it.
  const split = useLibrary((s) => s.settings.playerSplit)
  const savedDetails = useLibrary((s) => s.settings.playerDetails)
  const detectedKey = useLibrary((s) => s.detectedKey)
  const keyDetected = current !== null && detectedKey[current.pathKey ?? current.path] !== undefined
  const detailFields = useMemo(
    () => (savedDetails.length > 0 ? normalizeDetailFields(savedDetails) : DEFAULT_DETAIL_FIELDS),
    [savedDetails]
  )
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  const dragSplitRef = useRef<number | null>(null)
  dragSplitRef.current = dragSplit
  const splitRef = useRef(split)
  splitRef.current = split
  const effectiveSplit = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, dragSplit ?? split))

  const beginSplit = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startSplit = splitRef.current

    const onMove = (move: PointerEvent): void => {
      setDragSplit(
        Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, Math.round(startSplit + (move.clientX - startX))))
      )
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const settled = dragSplitRef.current
      setDragSplit(null)
      if (settled !== null) useLibrary.getState().patchSettings({ playerSplit: settled })
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const beginResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = savedRef.current

    // Dragging up makes it taller, since the strip is anchored to the bottom edge.
    const onMove = (move: PointerEvent): void => {
      setDragHeight(
        Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(startHeight - (move.clientY - startY))))
      )
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const settled = dragRef.current
      setDragHeight(null)
      if (settled !== null) useLibrary.getState().patchSettings({ playerHeight: settled })
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const togglePlay = usePlayer((s) => s.togglePlay)
  const next = usePlayer((s) => s.next)
  const previous = usePlayer((s) => s.previous)
  const revealTrack = useLibrary((s) => s.revealTrack)

  const region = usePlayer((s) => s.region)
  const setRegion = usePlayer((s) => s.setRegion)
  /**
   * Whether a drag on the waveform paints a region instead of scrubbing.
   *
   * Component state and not a setting: it is somewhere you step into to cut one piece out
   * of one beat, and a waveform that had silently stopped scrubbing since the last session
   * would read as the transport being broken.
   */
  const [trimming, setTrimming] = useState(false)
  const [prompt, setPrompt] = useState<NamePrompt | null>(null)
  const saveAnchor = useRef<HTMLButtonElement>(null)

  /**
   * Decode, cut, encode, write.
   *
   * Everything up to the write happens in the renderer because that is where the decoder
   * is - `decodeAudioData` needs an AudioContext, which main has no equivalent of - and
   * main is handed finished bytes and the one job it is actually needed for, which is
   * refusing to land on top of an existing file.
   *
   * Reads the track and region from the store rather than closing over them: this is handed
   * to the name popover once, and by the time it runs the user has typed a name and a
   * couple of seconds have passed.
   */
  const saveTrim = useCallback(async (name: string): Promise<string | null> => {
    const { current: track, region: area } = usePlayer.getState()
    if (!track || !area) return 'There is no selection to save.'
    try {
      const buffer = await decodeTrack(track.path, track.size)
      if (!buffer) return `Couldn't decode .${track.ext} to cut a piece out of it.`
      const trimmed = await trimBuffer(buffer, track, area.start, area.end)
      const written = await window.umakbang.saveTrim(track.path, name, trimmed.bytes)
      if (written.error || !written.path) return written.error ?? 'Could not write the file.'
      // The folder re-read is what puts the new file in the list; a rescan would rebuild the
      // whole library to learn about one file that is already right there.
      void window.umakbang.refreshFolder(track.dir)
      useLibrary.getState().notify(`Saved ${baseName(written.path)}.`)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [])

  return (
    <section
      data-tour="transport"
      className="relative flex shrink-0 items-center gap-3 overflow-hidden border-t bg-card/50 px-3"
      style={{ height: effectiveHeight }}
      aria-label="Now playing"
    >
      {/* Straddles the top border with an 11px hit area; double-click restores the
          default. The waveform grows with the strip, so this is really a control for how
          precisely you can aim at it. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize player"
        aria-valuenow={effectiveHeight}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={MAX_HEIGHT}
        tabIndex={0}
        onPointerDown={beginResize}
        onDoubleClick={() => patchSettings({ playerHeight: DEFAULT_HEIGHT })}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 8
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            patchSettings({ playerHeight: Math.min(MAX_HEIGHT, height + step) })
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            patchSettings({ playerHeight: Math.max(MIN_HEIGHT, height - step) })
          }
        }}
        className="group absolute -top-[5px] left-0 z-30 flex h-[11px] w-full cursor-row-resize items-center justify-center focus-visible:outline-none"
      >
        <span
          className={cn(
            'pointer-events-none h-[3px] w-7 rounded-full transition-colors',
            dragHeight !== null ? 'bg-primary' : 'bg-border group-hover:bg-primary'
          )}
        />
      </div>

      {/* The controls half: what is playing on top, how to control it underneath.
          Stacked rather than in a row because the two are different questions - the name is
          read, the buttons are aimed at - and side by side each was squeezing the other.
          Sized by the boundary to its right rather than by its contents, so the waveform
          doesn't jump every time a longer file name loads. */}
      {/* The split is a preferred width, not a floor: with the visualizer panel open the
          explorer can be narrower than the split alone, and a half that refuses to give way
          pushes the transport out over the panel beside it. */}
      <div
        className="flex min-w-0 shrink flex-col items-center justify-center gap-2 overflow-hidden text-center"
        style={{ width: effectiveSplit, maxWidth: '100%' }}
      >
        {current ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.path}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={QUICK}
              className="flex w-full min-w-0 flex-col items-center"
            >
              <div className="w-full truncate text-[12px] font-medium leading-tight" title={current.path}>
                {current.name}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center justify-center gap-1.5">
                {/* Everything the table used to spend a column each on. One file's worth of
                    detail belongs to the file you're listening to, not to all 250,000 rows
                    at once. */}
                <span className="tnum truncate text-[10.5px] text-muted-foreground">
                  {formatDetails(current, detailFields, keyDetected)}
                </span>
                {detailFields.includes('projectTime') && <ProjectTime track={current} />}
              </div>
            </motion.div>
          </AnimatePresence>
        ) : (
          <p className="w-full truncate text-center text-[11px] text-muted-foreground/70">
            Select a file to start playing - the rest of its folder queues up automatically.
          </p>
        )}

        {/* Transport underneath, in the same place whether or not anything is loaded, so the
            bar doesn't rearrange itself under the pointer when a track starts. Given room
            to breathe: stacked directly under the details it read as one crowded block,
            and the buttons are aimed at rather than read. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <Hint label="Previous">
            <Button variant="ghost" size="icon-sm" disabled={!current} onClick={previous}>
              <SkipBack className="h-3.5 w-3.5" />
            </Button>
          </Hint>
          <motion.button
            type="button"
            disabled={!current}
            onClick={togglePlay}
            whileTap={{ scale: 0.92 }}
            transition={QUICK}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-30"
          >
            {playing ? (
              <Pause className="h-3 w-3 fill-current" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
          </motion.button>
          <Hint label="Next">
            <Button variant="ghost" size="icon-sm" disabled={!current} onClick={next}>
              <SkipForward className="h-3.5 w-3.5" />
            </Button>
          </Hint>

          {/* Locate, queue and volume sit with the transport rather than across the bar:
              they all act on what is playing, and having them at opposite ends meant
              crossing the whole strip to use two of them together. */}
          <Hint label="Show in library">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!current}
              onClick={() => current && revealTrack(current)}
              className="text-muted-foreground hover:text-foreground"
            >
              <LocateFixed className="h-3.5 w-3.5" />
            </Button>
          </Hint>
          <Popover>
            <Hint label="Up next">
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={queue.length === 0}>
                  <ListMusic className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
            </Hint>
            <PopoverContent align="start" side="top" className="w-72 p-1">
              <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Queue &middot; {queue.length}
              </div>
              <div className="scroll-thin max-h-[260px] overflow-y-auto">
                {queue.map((track, position) => (
                  <button
                    key={track.path}
                    type="button"
                    onClick={() => usePlayer.getState().play(track, queue)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] transition-colors hover:bg-accent',
                      position === index && 'text-primary',
                      position < index && 'text-muted-foreground/50'
                    )}
                  >
                    <span className="tnum w-5 shrink-0 text-right text-[10.5px] text-muted-foreground/60">
                      {position + 1}
                    </span>
                    <span className="truncate">{track.name}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <VolumeControl />

          {/* Right after mute rather than pinned to the far end: the time belongs with the
              controls that act on what is playing, not stranded across the strip. */}
          {current && (
            <span className="tnum shrink-0 pl-1 text-[11px] text-muted-foreground">
              {formatTime(time)} / {formatTime(duration || current.duration || 0)}
            </span>
          )}

          {/* Trim. Nothing but the toggle shows until a region has been drawn - the strip is
              thirty pixels of chrome and a length and a save button that mean nothing yet
              would be two thirds of a control group nobody asked for. */}
          <Hint label={trimming ? 'Stop selecting' : 'Select a region to loop and save'}>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!current?.playable}
              onClick={() => {
                const on = !trimming
                setTrimming(on)
                // Leaving the mode takes the loop with it. The region is only reachable from
                // these controls, so one left running behind a switched-off toggle is a
                // track that mysteriously refuses to play past a point.
                if (!on) setRegion(null)
              }}
              className={cn(trimming && 'text-primary')}
            >
              <Scissors className="h-3.5 w-3.5" />
            </Button>
          </Hint>

          {current && region && (
            <>
              <span className="tnum shrink-0 text-[11px] text-primary" title="Looping this much">
                {formatDurationPrecise(region.end - region.start)}
              </span>
              <Hint label="Save selection…">
                <Button
                  ref={saveAnchor}
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    const rect = saveAnchor.current?.getBoundingClientRect()
                    setPrompt({
                      title: `Save ${formatDurationPrecise(region.end - region.start)} beside ${current.name}`,
                      // The extension follows what `trimBuffer` will actually produce: an
                      // MP3 stays an MP3, everything else comes back as a WAV, and offering
                      // a name the bytes are not would be a lie in the one field the user
                      // is looking at.
                      initial: trimName(
                        current.name,
                        region.start,
                        region.end,
                        current.ext === 'mp3' ? 'mp3' : 'wav'
                      ),
                      confirmLabel: 'Save',
                      busyLabel: 'Saving…',
                      selectStem: true,
                      skipIfUnchanged: false,
                      // NamePopover holds the button disabled for the whole of this promise,
                      // which is what keeps a second decode-and-encode from starting on top
                      // of the first.
                      submit: saveTrim,
                      x: rect?.left ?? 200,
                      y: (rect?.top ?? 200) - 8
                    })
                  }}
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              </Hint>
            </>
          )}
        </div>
      </div>

      {prompt && <NamePopover prompt={prompt} onClose={() => setPrompt(null)} />}

      {/* The boundary between the two halves. Drag it to trade control room for scrub
          precision; double-click puts it back. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize waveform"
        aria-valuenow={effectiveSplit}
        aria-valuemin={MIN_SPLIT}
        aria-valuemax={MAX_SPLIT}
        tabIndex={0}
        onPointerDown={beginSplit}
        onDoubleClick={() => patchSettings({ playerSplit: DEFAULT_SPLIT })}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 12
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            patchSettings({ playerSplit: Math.max(MIN_SPLIT, split - step) })
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            patchSettings({ playerSplit: Math.min(MAX_SPLIT, split + step) })
          }
        }}
        className="group relative flex h-full w-[11px] shrink-0 cursor-col-resize items-center justify-center focus-visible:outline-none"
      >
        <span
          className={cn(
            'pointer-events-none h-[70%] w-[2px] rounded-full transition-colors',
            dragSplit !== null ? 'bg-primary' : 'bg-border group-hover:bg-primary'
          )}
        />
      </div>

      {/* The waveform half: the same scrub target as the playing row, kept here because
          that row is often scrolled away or in a folder you have navigated out of. */}
      <div className="flex min-w-0 flex-1 items-center">
        {current ? (
          <Waveform
            track={current}
            selectable={trimming}
            className="min-w-0 flex-1"
            style={{ height: Math.max(24, effectiveHeight - 18) }}
          />
        ) : (
          <span className="w-full text-center text-[10.5px] text-muted-foreground/40">
            nothing playing
          </span>
        )}
      </div>

      {error && (
        <span className="max-w-[240px] shrink-0 truncate text-[10.5px] text-destructive">
          {error}
        </span>
      )}

    </section>
  )
}

/** How long the slider stays up after the pointer leaves it. */
const VOLUME_LINGER = 200

/**
 * Mute on the button, level on hover.
 *
 * The speaker is the only place in the strip that is about how loud things are, so the
 * slider hangs off it rather than taking a second slot in a row that is already full. The
 * click has to keep working untouched, which is why the button is a `PopoverAnchor` and not
 * a `PopoverTrigger`: a trigger would own the press and toggling mute would stop being one
 * click.
 *
 * The panel is opened and closed by hand rather than by Radix, for the gap between the
 * button and the panel: closing on `pointerleave` alone shuts the slider the instant the
 * pointer crosses that gap, which makes it unreachable. A short grace period that
 * re-entering either half cancels is the whole fix.
 */
function VolumeControl(): React.JSX.Element {
  const muted = usePlayer((s) => s.muted)
  const volume = usePlayer((s) => s.volume)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  const hold = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
    setOpen(true)
  }, [])

  const release = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), VOLUME_LINGER)
  }, [])

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    []
  )

  const VolumeIcon = muted || volume === 0 ? VolumeX : Volume2

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span ref={anchorRef} onPointerEnter={hold} onPointerLeave={release} className="inline-flex">
          <Hint label={muted ? 'Unmute' : 'Mute'}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleMute}
              className={cn(muted && 'text-destructive')}
            >
              <VolumeIcon className="h-3.5 w-3.5" />
            </Button>
          </Hint>
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={2}
        onPointerEnter={hold}
        onPointerLeave={release}
        // A panel that arrived because the pointer passed over something must not take the
        // keyboard away from whatever the user was actually doing.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          // Muting is the thing you do with this panel open, and the button counts as
          // outside it because it is the anchor rather than the trigger. Without this the
          // slider vanishes on the one click it is there to sit beside.
          const target = event.detail.originalEvent.target
          if (target instanceof Node && anchorRef.current?.contains(target)) {
            event.preventDefault()
          }
        }}
        className="flex w-auto flex-col items-center gap-1.5 p-2"
      >
        {/* Rotated rather than given a vertical writing mode: which end of a
            `writing-mode: vertical-*` range is the maximum depends on the direction as well,
            and a volume slider that turns out to be upside down is not a thing to find out
            about later. A quarter turn anticlockwise puts the maximum at the top, always. */}
        <div className="flex h-24 w-6 items-center justify-center">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(volume * 100)}
            aria-label="Volume"
            onChange={(event) => setVolume(Number(event.target.value) / 100)}
            // An input is one of the targets App.tsx's global shortcuts already step around,
            // so the arrow keys nudge the level here instead of seeking the track.
            onKeyDown={(event) => event.stopPropagation()}
            className="h-1 w-24 shrink-0 -rotate-90 cursor-pointer"
            style={{ accentColor: 'var(--primary)' }}
          />
        </div>
        <span className="tnum text-[10.5px] text-muted-foreground">
          {muted ? 'muted' : `${Math.round(volume * 100)}%`}
        </span>
      </PopoverContent>
    </Popover>
  )
}

/**
 * How long the matching FL Studio project was open - the closest thing there is to "how
 * long this beat took". A clock rather than a word: the line beside it is already a run of
 * abbreviations, and one more of those would read as another format field.
 *
 * Silent when no project matches, rather than showing a zero.
 */
function ProjectTime({ track }: { track: Track }): React.JSX.Element | null {
  const project = useProjectFor(track)
  const revealTrack = useLibrary((s) => s.revealTrack)
  if (!project || project.projectSeconds === undefined || project.projectSeconds <= 0) return null

  return (
    <button
      type="button"
      onClick={() => revealTrack(project)}
      title={`Time on project - ${project.name}, click to show it`}
      className="tnum flex shrink-0 items-center gap-0.5 text-[10.5px] text-muted-foreground hover:text-primary"
    >
      <Clock className="h-2.5 w-2.5" />
      {formatHours(project.projectSeconds / 3600)}
    </button>
  )
}
