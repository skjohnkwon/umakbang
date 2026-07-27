import { cn } from '@/lib/utils'
import type React from 'react'

export function Separator({
  className,
  orientation = 'horizontal'
}: {
  className?: string
  orientation?: 'horizontal' | 'vertical'
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className
      )}
    />
  )
}
