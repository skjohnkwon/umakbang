import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { FileSignature, Loader2, Star, X } from 'lucide-react'
import type { ContractInput } from '@shared/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useContracts } from '@/state/contracts'
import { cn } from '@/lib/utils'

/**
 * The one screen between a right-click and a finished contract.
 *
 * The track titles arrive already filled in from the rows that were selected - naming the
 * beat is the part you'd otherwise be retyping from the file you just clicked. Everything
 * else is either remembered (the buyer, as a preset) or a standing term (the shares, from
 * the profile), so the common case is: check the price, press the button.
 */
export function ContractDialog({ titles }: { titles: string[] }): React.JSX.Element {
  const data = useContracts((s) => s.data)
  const generate = useContracts((s) => s.generate)
  const savePreset = useContracts((s) => s.savePreset)
  const close = useContracts((s) => s.closeDraft)

  const [names, setNames] = useState(titles.join('\n'))
  const [customer, setCustomer] = useState('')
  const [alias, setAlias] = useState('')
  const [email, setEmail] = useState('')
  const [price, setPrice] = useState('300')
  const [writer, setWriter] = useState('25')
  const [publisher, setPublisher] = useState('25')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)

  // Reopening for a different selection starts from those titles, not the last ones.
  useEffect(() => setNames(titles.join('\n')), [titles])

  const presets = data?.presets ?? []
  const list = useMemo(
    () => names.split('\n').map((line) => line.trim()).filter(Boolean),
    [names]
  )
  const ready = list.length > 0 && customer.trim().length > 0 && /^\d+(\.\d+)?$/.test(price.trim())

  /**
   * The document itself, beside the form.
   *
   * It renders through the same values -> template -> Markdown -> HTML path the PDF does,
   * so this is the contract rather than an impression of one. That matters more here than
   * in most previews: the template is the legal text, it is editable, and a placeholder
   * that silently failed to fill would otherwise only show up in the finished PDF.
   *
   * Debounced, because each pass crosses to the main process and back, and the form is
   * typed into rather than filled in one field at a time.
   */
  const [preview, setPreview] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.umakbang
        .previewContract({
          titles: list,
          customer: customer.trim(),
          alias: alias.trim(),
          email: email.trim(),
          price: price.trim(),
          producerWriter: writer.trim() || '0',
          producerPublisher: publisher.trim() || '0'
        })
        .then(setPreview)
        .catch(() => {
          // A preview that cannot be built is not worth interrupting the form for.
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [list, customer, alias, email, price, writer, publisher])

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    const input: ContractInput = {
      titles: list,
      customer: customer.trim(),
      alias: alias.trim(),
      email: email.trim(),
      price: price.trim(),
      producerWriter: writer.trim() || '0',
      producerPublisher: publisher.trim() || '0'
    }
    if (remember) await savePreset({ name: input.customer, alias: input.alias, email: input.email })
    await generate(input)
    setBusy(false)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent aria-describedby={undefined} className="max-w-[980px]">
        <header className="border-b px-4 py-3">
          <DialogTitle>Generate contract</DialogTitle>
          <DialogDescription>
            {list.length === 1
              ? `An exclusive sale of "${list[0]}".`
              : `An exclusive sale covering ${list.length} tracks as combined Masters.`}
          </DialogDescription>
        </header>

      <div className="flex min-h-0">
        <div className="scroll-thin w-[460px] shrink-0 space-y-3 overflow-y-auto border-r px-4 py-3">
          <Field label="Track titles" hint="One per line - each becomes a named Master.">
            <textarea
              value={names}
              onChange={(event) => setNames(event.target.value)}
              rows={Math.min(5, Math.max(2, list.length + 1))}
              className="scroll-thin w-full resize-none rounded border bg-background px-2 py-1.5 text-[12.5px] outline-none focus-visible:border-primary"
            />
          </Field>

          {presets.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {presets.map((preset) => (
                <button
                  key={preset.alias || preset.name}
                  type="button"
                  onClick={() => {
                    setCustomer(preset.name)
                    setAlias(preset.alias)
                    setEmail(preset.email)
                  }}
                  className={cn(
                    'rounded border px-2 py-0.5 text-[11.5px] transition-colors',
                    customer === preset.name
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {preset.alias || preset.name}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field label="Purchaser">
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Full legal name" />
            </Field>
            <Field label="Alias">
              <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="p.k.a." />
            </Field>
          </div>

          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="where the files go" />
            </Field>
            <Field label="Price (USD)">
              <Input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-[92px]"
                inputMode="decimal"
              />
            </Field>
            <Field label="Your shares" hint="Writer / publisher, %">
              <div className="flex items-center gap-1">
                <Input value={writer} onChange={(e) => setWriter(e.target.value)} className="w-[52px]" />
                <span className="text-muted-foreground">/</span>
                <Input value={publisher} onChange={(e) => setPublisher(e.target.value)} className="w-[52px]" />
              </div>
            </Field>
          </div>

          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="accent-primary"
            />
            <Star className="h-3 w-3" />
            Remember this purchaser
          </label>

          <p className="text-[11px] text-muted-foreground/70">
            Written to {data?.outputDir || 'nowhere yet - set a folder in Contracts'} as Markdown
            and PDF.
          </p>
        </div>

        {/* The page, on paper, so the width and the margins are the printed ones. Rendered
            in an iframe: the contract carries its own stylesheet and must not inherit the
            app's dark theme, since what it will look like printed is the whole question. */}
        <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-muted/30 p-4">
          <div className="mx-auto max-w-[760px] overflow-hidden rounded bg-white shadow-lg">
            <iframe
              title="Contract preview"
              srcDoc={preview}
              sandbox=""
              className="h-[620px] w-full border-0 bg-white"
            />
          </div>
        </div>
      </div>

        <footer className="flex items-center justify-end gap-1.5 border-t px-4 py-2.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSignature className="h-3.5 w-3.5" />}
            Generate
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
        {hint && <span className="ml-1 font-normal text-muted-foreground/60">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** The icon the menu action uses, so the action and the dialog agree. */
export const ContractIcon = FileSignature
export const ContractCloseIcon = X
