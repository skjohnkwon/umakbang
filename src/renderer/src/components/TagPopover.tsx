import type React from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { TagEditor } from '@/components/TagEditor'

/**
 * The tag editor anchored to a point on screen, for the keyboard shortcut.
 *
 * The context menu shows the same editor as a panel beside itself instead - see
 * `TagSubmenu`. This one exists because `T` has no menu to hang off.
 */
export function TagPopover({
  paths,
  label,
  x,
  y,
  onClose
}: {
  paths: string[]
  label: string
  x: number
  y: number
  onClose: () => void
}): React.JSX.Element {
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      {/* A zero-size anchor pinned to the click point keeps Radix's positioning logic. */}
      <PopoverAnchor asChild>
        <div style={{ position: 'fixed', left: x, top: y, width: 1, height: 1 }} />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-72"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Same reason as the rename editor: the context menu hands focus back to the
        // table on its way out, which would otherwise dismiss this immediately.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <TagEditor paths={paths} label={label} onClose={onClose} />
      </PopoverContent>
    </Popover>
  )
}
