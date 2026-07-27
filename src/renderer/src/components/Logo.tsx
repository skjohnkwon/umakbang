import type React from 'react'
import { cn } from '@/lib/utils'

/**
 * The umakbang mark.
 *
 * Inline SVG rather than an imported file, because the whole point is that it takes the
 * accent colour: `fill="currentColor"` means any Tailwind text class tints it, and the
 * accent lands on `--primary` (`ThemeBridge` -> `applyThemeOverrides`), so `text-primary`
 * follows whatever is chosen in Settings -> Appearance -> Accent. An `<img src>` or a CSS
 * `background-image` cannot be recoloured at all, and a `mask-image` can but costs a
 * second file and a second way of doing the same thing.
 *
 * The source art is solid black on transparent. The colour is dropped here rather than
 * kept as a black default: a mark that renders invisible against this app's background
 * unless every caller remembers to override it is a trap, and there is no light mode for
 * black to have been right in.
 *
 * The viewBox is tightened to the artwork rather than kept at the source's 1254 square.
 * The shapes only span x 204-1051 and y 163-1079, so a third of that square is margin,
 * and at icon sizes the mark came out visibly smaller than the lucide icons beside it -
 * `h-4` drew about 11px of ink. The box below is the ink's bounding box grown to a square
 * about its own centre (centre 627.5,621, side 916), so `h-4 w-4` means 16px of mark and
 * sizing this is the same act as sizing any other icon in the app.
 */
export function Logo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="169.5 163 916 916"
      fill="currentColor"
      className={cn('shrink-0', className)}
      role="img"
      aria-label="umakbang"
    >
      <rect x="535" y="163" width="184" height="204" />
      <rect x="204" y="370" width="181" height="179" />
      <rect x="870" y="370" width="181" height="179" />
      <path d="M535 545H719V716H885V893H719V1079H535V893H369V716H535Z" />
    </svg>
  )
}
