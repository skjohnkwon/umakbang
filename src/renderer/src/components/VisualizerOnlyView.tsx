import type React from 'react'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { motion } from 'motion/react'
import { VisualizerStack, type VisualizerId } from '@/components/visualizers/Visualizers'
import { WindowActions } from '@/components/WindowActions'
import { Logo } from '@/components/Logo'
import { useVisualizerInput } from '@/components/visualizers/audio-tap'
import { Button } from '@/components/ui/button'
import { usePlayer } from '@/state/player'
import { useLibrary } from '@/state/library'
import { QUICK } from '@/lib/motion'
import { formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Visualizers filling the window, with the library hidden.
 *
 * The transport sits over the plots and fades out until you move the mouse, so nothing
 * competes with the visuals - but the track name and position stay reachable without
 * having to switch back.
 */
export function VisualizerOnlyView(): React.JSX.Element {
  const current = usePlayer((s) => s.current)
  const playing = usePlayer((s) => s.playing)
  const time = usePlayer((s) => s.time)
  const duration = usePlayer((s) => s.duration)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const next = usePlayer((s) => s.next)
  const previous = usePlayer((s) => s.previous)

  const { input } = useVisualizerInput()
  const visualizers = useLibrary((s) => s.settings.visualizers)
  const patchSettings = useLibrary((s) => s.patchSettings)

  return (
    <div
      className="group/stage relative flex min-h-0 flex-1 flex-col bg-background"
      // The window's caption buttons are drawn by the OS over the top-right of the page
      // and cannot be taken away while the window is framed. With no title bar under them
      // they were sitting on top of the panels, so the plots start below the strip they
      // occupy. The overlay publishes its own height; where there is no overlay the strip
      // is still worth having, because it is the only thing left to drag the window by.
      style={
        {
          '--stage-chrome': 'env(titlebar-area-height, 30px)',
          paddingTop: 'var(--stage-chrome)'
        } as React.CSSProperties
      }
    >
      {/* The window has no title bar in this mode, so this strip is what moves it. It sits
          in the space the caption buttons occupy, left of them - the OS owns its own
          corner and takes those clicks first. */}
      <div
        className="app-drag absolute inset-x-0 top-0"
        style={{ height: 'var(--stage-chrome)' }}
      />
      {/* Side by side, so a wide short window reads like a meter bridge. */}
      <VisualizerStack
        className="min-h-0 flex-1 p-1"
        orientation="horizontal"
        enabled={visualizers as VisualizerId[]}
        onChange={(ids) => patchSettings({ visualizers: ids })}
      />

      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-3 px-4 py-2.5',
          'bg-gradient-to-t from-background via-background/80 to-transparent',
          'opacity-0 transition-opacity duration-200 group-hover/stage:opacity-100'
        )}
      >
        {/* This mode has no title bar, so the overlay is the only place left that says
            what is playing this. It fades with the rest of the overlay - a mark burned
            permanently into a corner of the plots would be the one thing here that never
            gets out of the way. */}
        <Logo className="h-4 w-4 text-primary/70" />

        <div className="pointer-events-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" disabled={!current} onClick={previous}>
            <SkipBack className="h-3.5 w-3.5" />
          </Button>
          <motion.button
            type="button"
            disabled={!current}
            onClick={togglePlay}
            whileTap={{ scale: 0.92 }}
            transition={QUICK}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
          </motion.button>
          <Button variant="ghost" size="icon" disabled={!current} onClick={next}>
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
        </div>

        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {input === 'desktop' ? 'Desktop audio' : (current?.name ?? 'Nothing playing')}
        </span>

        {current && input === 'player' && (
          <span className="tnum shrink-0 text-[11px] text-muted-foreground">
            {formatTime(time)} / {formatTime(duration || current.duration || 0)}
          </span>
        )}

        {/* The title bar's toggles, since there is no title bar in this mode at all. */}
        <div className="pointer-events-auto shrink-0">
          <WindowActions side="top" stage />
        </div>
      </div>
    </div>
  )
}
