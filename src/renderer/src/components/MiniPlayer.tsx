import type React from 'react'
import { motion } from 'motion/react'
import {
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { Waveform } from '@/components/Waveform'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { QUICK } from '@/lib/motion'
import { formatTime, parentLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The whole app, shrunk to a square that sits over everything else.
 *
 * For when umakbang is the thing playing while you work somewhere else: a name, a waveform
 * you can still scrub, and a transport. The window itself is square and always on top -
 * see `window:setMini` in the main process - so this only has to fill it.
 *
 * Everything that isn't a control is a drag handle, since a 300px window has no title bar
 * worth the name.
 */
export function MiniPlayer(): React.JSX.Element {
  const current = usePlayer((s) => s.current)
  const playing = usePlayer((s) => s.playing)
  const time = usePlayer((s) => s.time)
  const duration = usePlayer((s) => s.duration)
  const muted = usePlayer((s) => s.muted)
  const error = usePlayer((s) => s.error)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const next = usePlayer((s) => s.next)
  const previous = usePlayer((s) => s.previous)
  const toggleMute = usePlayer((s) => s.toggleMute)

  const total = duration || current?.duration || 0

  return (
    <div className="app-drag flex min-h-0 flex-1 flex-col justify-between px-3 pb-3 pt-1">
      <div className="min-w-0">
        <div
          className="truncate text-[13px] font-medium leading-tight"
          title={current?.path ?? undefined}
        >
          {current?.name ?? 'Nothing playing'}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {current ? parentLabel(current.relDir) : 'Pick a track in the library'}
        </div>
      </div>

      {/* Still the scrub target, just smaller - the point of keeping it here. */}
      <div className="app-no-drag min-h-0 flex-1 py-2">
        <Waveform track={current} className="h-full w-full" />
      </div>

      <div className="tnum flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>{formatTime(time)}</span>
        {error ? (
          <span className="truncate px-2 text-destructive" title={error}>
            {error}
          </span>
        ) : null}
        <span>{formatTime(total)}</span>
      </div>

      <div className="app-no-drag mt-1.5 flex items-center justify-center gap-1.5">
        <Button variant="ghost" size="icon" disabled={!current} onClick={previous}>
          <SkipBack className="h-4 w-4" />
        </Button>
        <motion.button
          type="button"
          disabled={!current}
          onClick={togglePlay}
          whileTap={{ scale: 0.92 }}
          transition={QUICK}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {playing ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="h-4 w-4 fill-current" />
          )}
        </motion.button>
        <Button variant="ghost" size="icon" disabled={!current} onClick={next}>
          <SkipForward className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          className={cn('ml-1', muted && 'text-primary')}
        >
          {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

/**
 * The way out, in the strip beside the native caption buttons. It lives here rather than
 * with the other window toggles because in this mode there is no title bar to hold them.
 */
export function MiniPlayerExit(): React.JSX.Element {
  const setMiniPlayer = useLibrary((s) => s.setMiniPlayer)
  return (
    <Hint label="Back to the library" side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to the library"
        onClick={() => setMiniPlayer(false)}
        className="app-no-drag"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </Button>
    </Hint>
  )
}
