import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { useLibrary } from '@/state/library'
import { cn } from '@/lib/utils'

/**
 * The twenty seconds after a first folder is opened.
 *
 * It runs itself. Every step is on a timer and moves on without being asked, because the
 * thing a "Next" button reliably produces is somebody clicking Next seven times without
 * reading anything - and because a tour that has to be driven is a second thing to learn
 * before you have learnt the first. The only control is the one that matters: Skip, on
 * screen for the whole run, and Escape does the same.
 *
 * It points at the real chrome rather than drawing pictures of it. The spotlight is a hole
 * in a dimmed sheet, positioned from the target's own `getBoundingClientRect`, so a panel
 * the user has resized is still framed correctly and there is nothing here to keep in step
 * with the layout.
 *
 * Nothing is blocked while it plays: the overlay is `pointer-events-none` apart from its own
 * card, so the app underneath stays live and a step you want to try can be tried as it is
 * described.
 */

/** How long each step holds. Short on purpose - this is a map, not a manual. */
const STEP_MS = 3000

interface Step {
  /** `data-tour` value of the element to frame, or null to sit in the middle of the window. */
  target: string | null
  title: string
  body: string
}

/**
 * Seven, and no more.
 *
 * Everything here is a place rather than a procedure: where things are, and the one gesture
 * per place that is not guessable. Anything that can be discovered by hovering something has
 * been left out, which is most of the app.
 */
const STEPS: Step[] = [
  {
    target: 'sidebar',
    title: 'Your library',
    body: 'Every folder underneath what you opened, plus saved views: rated, downloads, all files.'
  },
  {
    target: 'table',
    title: 'Click, then click again',
    body: 'One click selects. Clicking the selected row plays it, or opens a folder. Space pauses.'
  },
  {
    target: 'search',
    title: 'Ask, don’t scroll',
    body: 'Names, or questions: bpm>140, key:Cm, ext:wav, tag:keeper, stars:4-5.'
  },
  {
    target: 'tags',
    title: 'Tag as you go',
    body: 'Press T on a selection to tag it. Click a tag to filter; click a second to narrow.'
  },
  {
    target: 'random',
    title: 'Dig',
    body: 'R plays something at random from anywhere in the library and takes you to it.'
  },
  {
    target: 'transport',
    title: 'What’s playing',
    body: 'Drag across the waveform to loop a section, and save that stretch as its own file.'
  },
  {
    target: 'settings',
    title: 'That’s the whole app',
    body: 'Colours, shortcuts, key detection, backups and stems are behind the cog.'
  }
]

/** Where the card sits relative to the thing it is describing. */
const CARD_WIDTH = 300
const CARD_GAP = 12

export function Tutorial({ onDone }: { onDone: () => void }): React.JSX.Element | null {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const patchSettings = useLibrary((s) => s.patchSettings)

  /**
   * Ends it, whether it was watched or stopped.
   *
   * One exit for both, because a tour somebody skipped is a tour they have decided about,
   * and asking again on the next launch is the same intrusion a second time.
   */
  const finish = useCallback(() => {
    patchSettings({ tutorialSeen: true })
    onDone()
  }, [patchSettings, onDone])

  const step = STEPS[index]

  // Measured in a layout effect so the first paint of a step already has the frame in the
  // right place. A step whose target is missing - a panel the user has closed - simply has
  // no spotlight and the card goes to the middle, rather than the step being dropped: the
  // words are still true, and skipping steps would make the counter lie about the length.
  useLayoutEffect(() => {
    const measure = (): void => {
      if (!step?.target) {
        setRect(null)
        return
      }
      const node = document.querySelector(`[data-tour="${step.target}"]`)
      setRect(node ? node.getBoundingClientRect() : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [step])

  // The clock. Cleared and restarted per step, so the bar and the advance always agree.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (index >= STEPS.length - 1) finish()
      else setIndex((current) => current + 1)
    }, STEP_MS)
    return () => clearTimeout(timer)
  }, [index, finish])

  // Escape is what everything else dismissable answers to. Capture-phase, because the
  // explorer table and the search box both take the key first otherwise.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      finish()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [finish])

  if (!step) return null

  // The frame is the target's box with a little air around it, kept inside the window: the
  // tag strip and the sidebar both start hard against the left edge, so an unclamped ring
  // gets its left side clipped off and reads as a drawing mistake.
  const spot = rect
    ? (() => {
        const top = Math.max(2, rect.top - 6)
        const left = Math.max(2, rect.left - 6)
        return {
          top,
          left,
          width: Math.min(window.innerWidth - 2, rect.right + 6) - left,
          height: Math.min(window.innerHeight - 2, rect.bottom + 6) - top
        }
      })()
    : null

  // Below the target where there is room, above it otherwise, and clamped so a card never
  // hangs off an edge. The transport strip lives at the bottom of the window and the title
  // bar at the top, so both cases are real.
  const below = spot !== null && spot.top + spot.height + CARD_GAP + 150 < window.innerHeight
  const cardTop = spot === null ? window.innerHeight / 2 - 75 : below ? spot.top + spot.height + CARD_GAP : Math.max(CARD_GAP, spot.top - 150 - CARD_GAP)
  const cardLeft =
    spot === null
      ? window.innerWidth / 2 - CARD_WIDTH / 2
      : Math.min(
          Math.max(CARD_GAP, spot.left + spot.width / 2 - CARD_WIDTH / 2),
          window.innerWidth - CARD_WIDTH - CARD_GAP
        )

  return (
    // Above everything, and transparent to the pointer so the app underneath stays usable.
    <div className="pointer-events-none fixed inset-0 z-[60]">
      {/* The dim is the spotlight's own shadow rather than a second element, which is what
          keeps the hole exactly where the frame is with nothing to keep in sync. */}
      {spot ? (
        <div
          className="absolute rounded-lg ring-2 ring-primary/70 transition-all duration-300 ease-out"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)'
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      <div
        className="pointer-events-auto absolute w-[300px] rounded-lg border border-border/80 bg-card/95 p-3 shadow-xl backdrop-blur-sm transition-all duration-300 ease-out"
        style={{ top: cardTop, left: cardLeft }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium">{step.title}</h3>
          <span className="tnum shrink-0 text-[10.5px] text-muted-foreground/60">
            {index + 1}/{STEPS.length}
          </span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{step.body}</p>

        <div className="mt-2.5 flex items-center gap-2">
          {/* Keyed on the step so the animation restarts rather than resuming where the last
              one left off - without it the bar fills once and then sits full for six steps. */}
          <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              key={index}
              className="h-full rounded-full bg-primary"
              style={{ animation: `tour-step ${STEP_MS}ms linear forwards` }}
            />
          </div>
          <button
            type="button"
            onClick={finish}
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors',
              'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
