import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { claimFocus } from '@/lib/focus'

/**
 * Asks for a name, anchored to the row it belongs to. Renaming and creating a folder are
 * the same question asked twice, so they ask it with the same thing.
 *
 * Renaming opens with the base name selected and the extension left alone - changing a
 * `.wav` to something else is almost never what you meant, and having to re-type it every
 * time is a papercut.
 */
export interface NamePrompt {
  title: string
  initial: string
  confirmLabel: string
  busyLabel: string
  /** Preselect only the part before the extension, the way a file manager does. */
  selectStem: boolean
  /**
   * Treat an untouched name as "never mind". True when renaming - leaving the name alone
   * is a cancel. False when creating, where the suggested name is a real answer.
   */
  skipIfUnchanged: boolean
  /** Resolves to an error message to show in place, or null when it worked. */
  submit: (name: string) => Promise<string | null>
  x: number
  y: number
}

export function NamePopover({
  prompt,
  onClose
}: {
  prompt: NamePrompt
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(prompt.initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Focus is claimed from a ref callback rather than an effect.
   *
   * The field lives inside a portal that Radix mounts on a later commit, so at effect
   * time there is no input to focus yet. Doing it as the element attaches is the only
   * moment that is certainly right, and `claimFocus` then holds on against the context
   * menu still unwinding behind us.
   */
  const cancelClaim = useRef<(() => void) | null>(null)
  const attachInput = useCallback(
    (input: HTMLInputElement | null) => {
      inputRef.current = input
      cancelClaim.current?.()
      cancelClaim.current = claimFocus(input, (element) => {
        const dot = prompt.initial.lastIndexOf('.')
        const end = prompt.selectStem && dot > 0 ? dot : prompt.initial.length
        ;(element as HTMLInputElement).setSelectionRange(0, end)
      })
    },
    [prompt.initial, prompt.selectStem]
  )

  useEffect(() => () => cancelClaim.current?.(), [])

  const submit = async (): Promise<void> => {
    if (busy) return
    if (prompt.skipIfUnchanged && name === prompt.initial) {
      onClose()
      return
    }
    setBusy(true)
    const failure = await prompt.submit(name)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div style={{ position: 'fixed', left: prompt.x, top: prompt.y, width: 1, height: 1 }} />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-80"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Focus arriving somewhere else must not close this. Opening from the context
        // menu does exactly that: the menu restores focus to the table as it goes, and
        // the editor would vanish before you could type. Escape and a click outside
        // still close it.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div className="mb-1.5 text-[11px] text-muted-foreground">{prompt.title}</div>
        <Input
          ref={attachInput}
          value={name}
          spellCheck={false}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            // The table's own shortcuts must not fire while a name is being typed.
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              onClose()
            }
          }}
        />
        {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
        <div className="mt-2 flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? prompt.busyLabel : prompt.confirmLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
