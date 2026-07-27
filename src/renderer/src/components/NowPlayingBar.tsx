import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Clock,
  ListMusic,
  LocateFixed,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { Track } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Waveform } from '@/components/Waveform'
import { usePlayer } from '@/state/player'
import { useLibrary } from '@/state/library'
import { useProjectFor } from '@/hooks/useLibraryView'
import { QUICK } from '@/lib/motion'
import { formatHours } from '@/lib/stats'
import { formatTime } from '@/lib/format'
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
  const muted = usePlayer((s) => s.muted)
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
  const keyDetected = current !== null && detectedKey[current.path] !== undefined
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
  const toggleMute = usePlayer((s) => s.toggleMute)
  const revealTrack = useLibrary((s) => s.revealTrack)

  const VolumeIcon = muted ? VolumeX : Volume2

  return (
    <section
      className="relative flex shrink-0 items-center gap-3 border-t bg-card/50 px-3"
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
      <div
        className="flex shrink-0 flex-col justify-center gap-2 overflow-hidden"
        style={{ width: effectiveSplit }}
      >
        {current ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.path}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={QUICK}
              className="flex min-w-0 flex-col"
            >
              <div className="truncate text-[12px] font-medium leading-tight" title={current.path}>
                {current.name}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
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
          <p className="truncate text-[11px] text-muted-foreground/70">
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

          {/* Right after mute rather than pinned to the far end: the time belongs with the
              controls that act on what is playing, not stranded across the strip. */}
          {current && (
            <span className="tnum shrink-0 pl-1 text-[11px] text-muted-foreground">
              {formatTime(time)} / {formatTime(duration || current.duration || 0)}
            </span>
          )}
        </div>
      </div>

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
