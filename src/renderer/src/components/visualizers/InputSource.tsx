import type React from 'react'
import { MonitorSpeaker, Music } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { useLibrary } from '@/state/library'
import { cn } from '@/lib/utils'
import { setVisualizerInput, useVisualizerInput } from './audio-tap'

/**
 * Swaps the visualizers between the app's own player and the machine's speaker output.
 *
 * Loopback capture needs a user gesture, so the switch is deliberately a button rather
 * than something restored from settings on launch.
 */
export function InputSourceButton({
  className,
  side = 'bottom'
}: {
  className?: string
  /** 'top' when the button sits along the bottom of the window. */
  side?: 'top' | 'bottom'
}): React.JSX.Element {
  const { input, connecting, error } = useVisualizerInput()
  const platform = useLibrary((s) => s.platform)
  // Electron only implements loopback on Windows. Elsewhere the request would fail, so
  // the control says why instead of failing on click.
  const supported = platform?.isWindows !== false
  const desktop = input === 'desktop'

  const label = !supported
    ? 'Desktop audio is Windows only'
    : error && !desktop
      ? `Desktop audio unavailable - ${error}`
      : desktop
        ? 'Listening to desktop audio - switch back to the player'
        : 'Visualize desktop audio'

  return (
    <Hint label={label} side={side}>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!supported || connecting}
        aria-pressed={desktop}
        aria-label={desktop ? 'Listen to the player' : 'Listen to desktop audio'}
        onClick={() => void setVisualizerInput(desktop ? 'player' : 'desktop')}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          desktop && 'text-primary',
          connecting && 'animate-pulse',
          className
        )}
      >
        {desktop ? (
          <MonitorSpeaker className="h-3.5 w-3.5" />
        ) : (
          <Music className="h-3.5 w-3.5" />
        )}
      </Button>
    </Hint>
  )
}
