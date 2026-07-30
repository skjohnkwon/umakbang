import { useEffect, useState } from 'react'
import { Scissors, Shuffle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export interface SplitShuffleSettings {
  /** Number of boundaries inserted; pieces are cuts + 1. */
  cuts: number
  /** 0..1 jitter applied while distributing source durations. */
  unevenness: number
  /** 0..1 chance that each Fisher-Yates position participates. */
  shuffle: number
  keepFirst: boolean
}

function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  suffix,
  onChange
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <label className="block border-b px-4 py-3">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {value}{suffix}
        </span>
      </span>
      <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{hint}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 h-1 w-full accent-primary"
      />
    </label>
  )
}

export function SplitShuffleDialog({
  duration,
  onApply,
  onClose
}: {
  duration: number
  onApply: (settings: SplitShuffleSettings) => void
  onClose: () => void
}): React.JSX.Element {
  const maxCuts = Math.max(1, Math.min(63, Math.floor(duration / 0.05) - 1))
  const [cuts, setCuts] = useState(Math.min(7, maxCuts))
  const [unevenness, setUnevenness] = useState(28)
  const [shuffle, setShuffle] = useState(80)
  const [keepFirst, setKeepFirst] = useState(false)

  useEffect(() => setCuts((value) => Math.min(value, maxCuts)), [maxCuts])

  const pieces = cuts + 1
  const averageMs = Math.max(1, Math.round((duration / pieces) * 1000))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[460px]"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Shuffle className="h-4 w-4" /> Split &amp; shuffle
          </DialogTitle>
          <DialogDescription className="mt-1">
            Chop this clip in place, then rearrange its source pieces without changing the
            total timeline length.
          </DialogDescription>
        </header>

        <SliderRow
          label="Cuts"
          hint={pieces + ' pieces, averaging about ' + averageMs + ' ms each.'}
          value={cuts}
          min={1}
          max={maxCuts}
          onChange={setCuts}
        />
        <SliderRow
          label="Cut unevenness"
          hint="Zero is metronomic; higher values vary the piece lengths while keeping every piece usable."
          value={unevenness}
          min={0}
          max={100}
          suffix="%"
          onChange={setUnevenness}
        />
        <SliderRow
          label="Shuffle amount"
          hint="Zero keeps the source order; 100 fully randomizes it."
          value={shuffle}
          min={0}
          max={100}
          suffix="%"
          onChange={setShuffle}
        />

        <label className="flex cursor-pointer items-start gap-2 px-4 py-3 text-[12px]">
          <input
            type="checkbox"
            checked={keepFirst}
            onChange={(event) => setKeepFirst(event.target.checked)}
            className="mt-0.5 accent-primary"
          />
          <span>
            <span className="block font-medium">Keep the first piece first</span>
            <span className="block text-[10.5px] text-muted-foreground">
              Useful when the clip needs to land on its original opening beat.
            </span>
          </span>
        </label>

        <footer className="flex items-center justify-end gap-1.5 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() =>
              onApply({
                cuts,
                unevenness: unevenness / 100,
                shuffle: shuffle / 100,
                keepFirst
              })
            }
          >
            <Scissors className="h-3.5 w-3.5" /> Split &amp; shuffle
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
