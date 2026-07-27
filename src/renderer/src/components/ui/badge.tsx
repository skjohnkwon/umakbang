import * as React from 'react'
import { cn } from '@/lib/utils'

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[10.5px] font-medium leading-4 tracking-wide',
        className
      )}
      {...props}
    />
  )
}
