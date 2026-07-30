import type React from 'react'
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlert, Check, Undo2 } from 'lucide-react'
import { useLibrary } from '@/state/library'
import { cn } from '@/lib/utils'

/**
 * What just happened to your files, said briefly and then gone.
 *
 * File operations are the one place umakbang writes to the library, so they say so - silence
 * after a paste or a delete leaves you checking the folder to find out whether it worked.
 * Errors sit for longer, because they're worth reading.
 */
export function Notice(): React.JSX.Element {
  const notice = useLibrary((s) => s.notice)
  const dismiss = useLibrary((s) => s.dismissNotice)
  /**
   * Read live rather than carried on the notice.
   *
   * Main sends `undo:state` from inside the `fs:transfer` handler, before the invoke that
   * started the operation resolves, so a label copied onto the notice at `notify` time would
   * depend on which of those two arrived first. Reading it here also means the button leaves
   * with the record when something else spends it, instead of naming a reversal that is no
   * longer on offer.
   */
  const undo = useLibrary((s) => s.undo)
  const runUndo = useLibrary((s) => s.runUndo)

  const action = notice?.undoable === true && undo !== null

  useEffect(() => {
    if (!notice) return
    // A notice with something to press needs long enough to reach for it. 3.2s is the read
    // time of a sentence, which is all the plain ones ask for.
    const timer = setTimeout(dismiss, notice.tone === 'error' || action ? 8000 : 3200)
    return () => clearTimeout(timer)
    // The nonce is what makes a repeat of the same message restart the clock.
  }, [notice, action, dismiss])

  return (
    <AnimatePresence>
      {notice && (
        /* A div with a span and a button inside it, rather than the single button this used
           to be. A button nested in a button is invalid HTML, and the outer one's click
           handler would have swallowed the inner one's anyway - so dismissing moved onto the
           text, which is the part that was only ever there to be read. */
        <motion.div
          role="status"
          key="notice"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className={cn(
            'fixed bottom-4 left-1/2 z-50 flex max-w-[min(30rem,80vw)] -translate-x-1/2 items-center gap-2',
            'rounded-md border bg-popover px-3 py-1.5 text-[12px] shadow-lg',
            notice.tone === 'error' ? 'border-destructive/50 text-destructive' : 'text-foreground'
          )}
        >
          {notice.tone === 'error' ? (
            <CircleAlert className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          <button
            type="button"
            onClick={dismiss}
            className="min-w-0 truncate text-left"
            title="Dismiss"
          >
            {notice.message}
          </button>
          {action && (
            <button
              type="button"
              onClick={() => void runUndo()}
              className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
            >
              <Undo2 className="h-3 w-3" />
              {undo.label}
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
