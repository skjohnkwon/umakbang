import type React from 'react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'

/** Where the source lives, for the invitation to contribute at the end of the text. */
const REPOSITORY = 'https://github.com/skjohnkwon/umakbang'

/** Milliseconds a letter. Slow enough to read as typing, quick enough not to be a wait. */
const LETTER_MS = 70

/**
 * The name, typed out.
 *
 * A cursor that stops blinking once the word is finished, so the dialog settles rather than
 * pulsing at you the whole time it is open. `prefers-reduced-motion` gets the finished word
 * immediately - an animation nobody asked for should not be the thing standing between
 * somebody and the version number.
 */
function TypedTitle({ text }: { text: string }): React.JSX.Element {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = useState(reduced ? text.length : 0)

  useEffect(() => {
    if (shown >= text.length) return
    const timer = setTimeout(() => setShown((count) => count + 1), LETTER_MS)
    return () => clearTimeout(timer)
  }, [shown, text.length])

  const done = shown >= text.length

  return (
    <span className="font-medium tracking-tight">
      {text.slice(0, shown)}
      <span
        aria-hidden
        className={`ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-primary ${
          done ? 'opacity-0' : 'animate-pulse'
        }`}
      />
    </span>
  )
}

/**
 * What this is and why it exists, from the mark in the title bar.
 *
 * The text is the author's, kept in his voice rather than rewritten into product copy: it
 * says what the app is for and who it is currently for, which is the honest thing to put in
 * front of somebody who has just opened it.
 */
export function AboutDialog({
  version,
  onClose
}: {
  version: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[440px]">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7 shrink-0 text-primary" />
          <div className="min-w-0">
            <DialogTitle className="text-[15px]">
              <TypedTitle text="umakbang" />
            </DialogTitle>
            <p className="tnum text-[11px] text-muted-foreground/70">
              {version ? `Version ${version}` : 'Version unknown'} · AGPL-3.0
            </p>
          </div>
        </div>

        <DialogDescription asChild>
          <div className="mt-3 space-y-2.5 text-[12px] leading-relaxed text-muted-foreground">
            <p>The premium music production file explorer.</p>
            <p>
              On Windows, using File Explorer to navigate through my work in progress was a
              pain. Mac was a little better, but not great either. So this is the solution: a
              key and BPM detecting, stem splitting, audio visualizing, tagging, searching,
              customizable way to work on your music.
            </p>
            <p>
              Right now this is only for FL users, because the stats page only reads
              <code className="mx-1 rounded bg-secondary px-1 py-px text-[11px]">.flp</code>
              projects. But who knows - if someone wants to help build Ableton support, this is
              an open source project, so contribute away.
            </p>
            <p className="text-foreground">Make listening to your music enjoyable.</p>
          </div>
        </DialogDescription>

        <div className="mt-4 flex justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.umakbang.openExternally(REPOSITORY)}
          >
            View the source
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
