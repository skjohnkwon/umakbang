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
 */
export const StarRating = memo(function StarRating({
  value,
  onChange,
  className
}: {
  value: number
  onChange: (rating: number) => void
  className?: string
}): React.JSX.Element {
  const [hover, setHover] = useState(0)
  const shown = hover || value

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
          className={cn(
            'p-0 transition-opacity',
            star <= shown
              ? 'text-amber-400 opacity-100'
              : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100'
          )}
        >
          <Star className={cn('h-[10px] w-[10px]', star <= shown && 'fill-current')} />
        </button>
      ))}
    </span>
  )
})
