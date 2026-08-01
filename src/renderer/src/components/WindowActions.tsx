import type React from 'react'
import { AudioLines, Cog, PanelRight, PictureInPicture2, Pin, PinOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { InputSourceButton } from '@/components/visualizers/InputSource'
import { useLibrary } from '@/state/library'
import { cn } from '@/lib/utils'

/**
 * The app-level toggles: visualizers-only, pin on top, the side panel, theme, settings.
 *
 * They live in the title bar normally, and move into the hover overlay in
 * visualizers-only mode - where there is no title bar at all.
 *
 * That mode keeps only what still means something with the library hidden: the way back
 * out, pin-on-top, and which audio is being watched. A mini player, a side panel and a
 * settings page are all things you would have to leave the mode to see anyway.
 */
export function WindowActions({
  side = 'bottom',
  stage = false
}: {
  /** Which way the tooltips open - 'top' when the row sits at the bottom of the window. */
  side?: 'top' | 'bottom'
  /** The visualizers-only overlay, which wants a smaller set. */
  stage?: boolean
}): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const setMiniPlayer = useLibrary((s) => s.setMiniPlayer)
  // Neither shrunken mode is somewhere to be before there is a library.
  //
  // Visualizers-only has nothing to plot, and since the stage is what carries the hover
  // overlay that turns it back off, nowhere to put its own way out either - `App` already
  // refuses to enter it without roots, which left this button as a switch that visibly
  // latched and did nothing at all. The mini player does enter, and strands you: it keeps
  // the transport and the way back and nothing else, so the Choose folder button - the only
  // thing there is to do on that screen - is not on it.
  const noLibrary = useLibrary((s) => s.roots.length === 0)

  return (
    <div className="app-no-drag flex items-center gap-0.5">
      {!stage && (
      <Hint
        label={noLibrary ? 'Open a folder first - there is nothing to play yet' : 'Mini player'}
        side={side}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Mini player"
          disabled={noLibrary}
          onClick={() => setMiniPlayer(true)}
        >
          <PictureInPicture2 className="h-3.5 w-3.5" />
        </Button>
      </Hint>
      )}

      <Hint
        label={
          noLibrary
            ? 'Open a folder first - there is nothing to visualize yet'
            : settings.visualizerOnly
              ? 'Show library'
              : 'Visualizers only'
        }
        side={side}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Visualizers only"
          aria-pressed={settings.visualizerOnly}
          disabled={noLibrary}
          onClick={() => patchSettings({ visualizerOnly: !settings.visualizerOnly })}
          className={cn(settings.visualizerOnly && 'bg-primary/15 text-primary')}
        >
          <AudioLines className="h-3.5 w-3.5" />
        </Button>
      </Hint>

      <Hint label={settings.alwaysOnTop ? 'Unpin from top' : 'Pin on top'} side={side}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Pin on top"
          aria-pressed={settings.alwaysOnTop}
          onClick={() => {
            const pinned = !settings.alwaysOnTop
            patchSettings({ alwaysOnTop: pinned })
            void window.umakbang.setAlwaysOnTop(pinned)
          }}
          className={cn(settings.alwaysOnTop && 'bg-primary/15 text-primary')}
        >
          {settings.alwaysOnTop ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </Button>
      </Hint>

      {/* Which audio is being watched - the one control that gains meaning here, since
          the whole window is now given over to watching it. */}
      {stage && <InputSourceButton side={side} />}

      {!stage && (
        <>
          <Hint label={settings.panelOpen ? 'Hide now playing' : 'Show now playing'} side={side}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show now playing"
              aria-pressed={settings.panelOpen}
              onClick={() => patchSettings({ panelOpen: !settings.panelOpen })}
              className={cn(settings.panelOpen && 'text-primary')}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </Button>
          </Hint>

          <Hint label="Settings" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              data-tour="settings"
              aria-label="Settings"
              title="Settings"
              onClick={() => useLibrary.getState().setView({ mode: 'settings' })}
            >
              <Cog className="h-3.5 w-3.5" />
            </Button>
          </Hint>
        </>
      )}
    </div>
  )
}
