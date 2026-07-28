import type React from 'react'
import { memo, useState } from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Five-star rating for a row.
 *
 * Clicking the star you're already on clears the rating - the usual idiom, and the only
 * way to get back to "unrated" without a separate control. Unrated rows stay quiet until
 * hovered so a folder of unrated files isn't a wall of grey stars.
 *
 * The stars are the visualizer ramp read across their own length, quiet at one and hot at
 * five, which is the level meter's trick again: the rating is how far along the ramp the
 * run of filled stars reaches, so it can be read without counting them. Amber for all five
 * was one colour saying the same thing five times.
 *
 * `wave` is a prop rather than a `usePalette()` call because this renders once per row, and
 * a subscription per row is the cost this table is built to avoid.
 */
export const StarRating = memo(function StarRating({
  value,
  onChange,
  wave,
  className
}: {
  value: number
  onChange: (rating: number) => void
  /** The ramp, low → high. Resolved once by the table. */
  wave: readonly string[]
  className?: string
}): React.JSX.Element {
  const [hover, setHover] = useState(0)
  const shown = hover || value

  // Mixed with a little foreground, like the coloured columns: the quiet end of somebody's
  // ramp can be very dark, and a star at 10px has no area to spare.
  const colorFor = (star: number): string | undefined => {
    if (wave.length === 0) return undefined
    const step = wave[Math.round(((star - 1) / 4) * (wave.length - 1))]
    return `color-mix(in oklab, ${step} 85%, var(--foreground))`
  }

  return (
    <span
      className={cn('flex items-center justify-end gap-px', className)}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`${star} star${star === 1 ? '' : 's'}`}
          onMouseEnter={() => setHover(star)}
          onClick={(event) => {
            event.stopPropagation()
            onChange(value === star ? 0 : star)
          }}
          style={star <= shown ? { color: colorFor(star) } : undefined}
          className={cn(
            'p-0 transition-opacity',
            star <= shown
              ? 'opacity-100'
              : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100'
          )}
        >
          <Star className={cn('h-[10px] w-[10px]', star <= shown && 'fill-current')} />
        </button>
      ))}
    </span>
  )
})
