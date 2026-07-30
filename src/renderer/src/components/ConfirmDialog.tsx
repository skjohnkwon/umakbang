import type React from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useLibrary } from '@/state/library'

/**
 * A last check before something big or something that cannot be taken back.
 *
 * Deliberately rare. Trashing a single file does not come through here and must not be made
 * to: it is reversible, it is the most common action in the app, and a prompt on it is the
 * prompt people learn to dismiss without reading - which is exactly what would disarm this
 * one for the cases where the answer matters. Scale and irreversibility reach it, ordinary
 * work does not.
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
  // Which side the confirming button sits on belongs to the platform, not to this component:
  // macOS puts it to the right of Cancel and Windows to the left, and a dialog that follows
  // neither reads as coming from somewhere else. Read off the store rather than threaded in
  // as a prop, or every caller would have to know a fact about the OS to open a dialog.
  const isMac = useLibrary((s) => s.platform?.isMac ?? false)

  const cancel = (
    <Button key="cancel" variant="ghost" size="sm" onClick={onClose}>
      Cancel
    </Button>
  )
  // The focus and the Enter binding stay on the confirming button whichever side it lands
  // on, so the keyboard answer is the same on both platforms even though the layout is not.
  const confirm = (
    <Button
      key="confirm"
      size="sm"
      variant={destructive ? 'destructive' : 'default'}
      onClick={onConfirm}
      autoFocus
    >
      {confirmLabel}
    </Button>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-[380px] p-4"
        onKeyDown={(event) => {
          // The table's shortcuts live on the scroll container behind this, so without
          // stopping the key here Delete would trash again and a digit would rate.
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
          {isMac ? [cancel, confirm] : [confirm, cancel]}
        </div>
      </DialogContent>
    </Dialog>
  )
}
