import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { claimFocus } from '@/lib/focus'

export interface NoteTarget {
  path: string
  label: string
  initial: string
  x: number
  y: number
}

/**
 * The whole of a note, when the column is too narrow to hold it.
 *
 * Deliberately a popover rather than a dialog: a note is a sentence about the row you are
 * looking at, and a modal that dims the library to hold four words is the app making more of
 * it than the user did. Same shell as `NamePopover`, for the same reasons - anchored where it
 * was opened from, and it keeps focus when the context menu unwinds behind it.
 *
 * Saving happens as you type, like the inline field, so there is nothing to confirm and
 * nothing to lose by clicking away. The button says Done rather than Save for that reason.
 */
export function NotePopover({
  target,
  onChange,
  onClose
}: {
  target: NoteTarget
  onChange: (note: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [note, setNote] = useState(target.initial)
  const cancelClaim = useRef<(() => void) | null>(null)

  const attach = (element: HTMLTextAreaElement | null): void => {
    cancelClaim.current?.()
    cancelClaim.current = claimFocus(element, (el) => {
      // The caret goes to the end rather than selecting everything: this is opened to add to
      // a note far more often than to replace one.
      const end = (el as HTMLTextAreaElement).value.length
      ;(el as HTMLTextAreaElement).setSelectionRange(end, end)
    })
  }

  useEffect(() => () => cancelClaim.current?.(), [])

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div style={{ position: 'fixed', left: target.x, top: target.y, width: 1, height: 1 }} />
      </PopoverAnchor>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-80"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div className="mb-1.5 truncate text-[11px] text-muted-foreground" title={target.label}>
          {target.label}
        </div>
        <textarea
          ref={attach}
          value={note}
          rows={5}
          spellCheck={false}
          placeholder="Anything worth remembering about this one"
          onChange={(event) => {
            setNote(event.target.value)
            onChange(event.target.value)
          }}
          // The table's shortcuts are bound on the scroll container this sits inside, and a
          // note with a "3" in it would otherwise rate the file three stars.
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') onClose()
          }}
          className="scroll-thin w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
