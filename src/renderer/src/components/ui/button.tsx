import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 shrink-0 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        subtle: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
      },
      size: {
        default: 'h-7 px-2.5',
        sm: 'h-6 px-2 text-[12px]',
        icon: 'h-7 w-7',
        'icon-sm': 'h-6 w-6',
        'icon-lg': 'h-9 w-9'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** Opts a button out of the hover tint - for one that is already saying something in colour. */
  noHoverTint?: boolean
}

/** Icon-only sizes. A button with words in it is not what "hovering over an icon" means. */
const ICON_SIZES = new Set(['icon', 'icon-sm', 'icon-lg'])

/**
 * A colour for one hover, at random.
 *
 * Hue only: lightness and chroma are pinned, so every draw is legible on the dark surface
 * and none of them can come out muddy or fluorescent. Random RGB would give both. A fresh
 * hue per hover rather than one fixed per button, because the point is that it is alive -
 * an icon that always turns the same green is just a second accent colour.
 */
function randomTint(): string {
  return `oklch(0.8 0.17 ${Math.floor(Math.random() * 360)})`
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, noHoverTint, onPointerEnter, onPointerLeave, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    const tinted = ICON_SIZES.has(String(size)) && !noHoverTint && !props.disabled

    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        onPointerEnter={(event: React.PointerEvent<HTMLButtonElement>) => {
          // Written to the element rather than held in state: this fires on every icon in
          // the chrome, and a re-render per hover for one colour is work for nothing.
          if (tinted) event.currentTarget.style.color = randomTint()
          onPointerEnter?.(event)
        }}
        onPointerLeave={(event: React.PointerEvent<HTMLButtonElement>) => {
          if (tinted) event.currentTarget.style.color = ''
          onPointerLeave?.(event)
        }}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { buttonVariants }
