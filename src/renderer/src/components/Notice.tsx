import type React from 'react'
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlert, Check } from 'lucide-react'
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

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismiss, notice.tone === 'error' ? 8000 : 3200)
    return () => clearTimeout(timer)
    // The nonce is what makes a repeat of the same message restart the clock.
  }, [notice, dismiss])

  return (
    <AnimatePresence>
      {notice && (
        <motion.button
          type="button"
          key="notice"
          onClick={dismiss}
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
          <span className="truncate">{notice.message}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
