import type React from 'react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { GithubMark } from '@/components/GithubMark'
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
      <DialogContent className="max-w-[320px] p-4">
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
            <p className="text-foreground">Make listening to your music enjoyable.</p>
          </div>
        </DialogDescription>

        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            size="icon"
            title="View the source"
            aria-label="View the source"
            onClick={() => void window.umakbang.openExternally(REPOSITORY)}
          >
            <GithubMark className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
