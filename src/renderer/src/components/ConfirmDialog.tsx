import type React from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * A last check before something leaves the library.
 *
 * Deleting goes to the recycle bin rather than to nowhere, so this isn't guarding against
 * loss so much as against a misclick on a list where a single click already plays a file.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose
}: {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-[380px] p-4"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            onConfirm()
          }
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-1.5">{description}</DialogDescription>
        <div className="mt-4 flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
