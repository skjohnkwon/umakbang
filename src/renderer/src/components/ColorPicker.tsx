import * as React from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { hexToRgb, normalizeHex, readableTextOn, rgbToHex, type Rgb } from '@/lib/theme'

/** Accent suggestions: mid-lightness, similar chroma, so any of them reads as "the" accent. */
export const ACCENT_PRESETS = [
  '#4fb3c8',
  '#5b8def',
  '#7c6cf0',
  '#b56ce0',
  '#e0607e',
  '#e0873c',
  '#3fb27f',
  '#94a3b8'
] as const

/** Background suggestions: four dark, four light, all barely-tinted neutrals. */
export const SURFACE_PRESETS = [
  '#0e1013',
  '#16191f',
  '#1c2028',
  '#232833',
  '#ffffff',
  '#f7f8fa',
  '#eff1f5',
  '#e7eaf0'
] as const

export interface ColorPickerProps {
  /** Current colour as hex ("#4fb3c8"); 3-digit shorthand is accepted. */
  value: string
  /** Fired with a canonical "#rrggbb" string on every change. */
  onChange: (colour: string) => void
  /** Accessible name, also shown as the popover heading. */
  label: string
  /** When provided, a "Reset" affordance appears. Persistence is the caller's job. */
  onReset?: () => void
  presets?: readonly string[]
  /** Applied to the swatch trigger (e.g. `app-no-drag` inside the title bar). */
  className?: string
}

interface Hsv {
  h: number
  s: number
  v: number
}

const HUE_GRADIENT =
  'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)'

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * HSV rather than OKLCH for the *picker surface*: the classic square + hue strip is
 * what users can aim at, and its gradients are expressible in plain CSS. The theme
 * layer does its perceptual maths on the hex we hand back.
 */
function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s
  const hp = ((((h % 360) + 360) % 360) / 60) % 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = v - c
  return { r: r + m, g: g + m, b: b + m }
}

function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max }
}

const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv))

function hexToHsv(hex: string): Hsv | null {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHsv(rgb) : null
}

export function ColorPicker({
  value,
  onChange,
  label,
  onReset,
  presets = ACCENT_PRESETS,
  className
}: ColorPickerProps): React.JSX.Element {
  const [hsv, setHsv] = React.useState<Hsv>(() => hexToHsv(value) ?? { h: 200, s: 0.5, v: 0.7 })
  const [draft, setDraft] = React.useState<string>(() => normalizeHex(value) ?? '#000000')
  // What we last sent upstream, so the controlled-value sync can ignore its own echo
  // (round-tripping through hex would otherwise reset hue on greys).
  const emitted = React.useRef<string | null>(normalizeHex(value))

  React.useEffect(() => {
    const next = normalizeHex(value)
    if (!next || next === emitted.current) return
    emitted.current = next
    setDraft(next)
    const asHsv = hexToHsv(next)
    if (!asHsv) return
    // Black and pure greys carry no hue; keep the one the user was working with.
    setHsv((prev) => ({ ...asHsv, h: asHsv.s < 1e-6 || asHsv.v < 1e-6 ? prev.h : asHsv.h }))
  }, [value])

  const commit = React.useCallback(
    (next: Hsv): void => {
      setHsv(next)
      const hex = hsvToHex(next)
      emitted.current = hex
      setDraft(hex)
      onChange(hex)
    },
    [onChange]
  )

  const current = React.useMemo(() => hsvToHex(hsv), [hsv])

  const pickHex = (hex: string): void => {
    const asHsv = hexToHsv(hex)
    if (!asHsv) return
    commit({ ...asHsv, h: asHsv.s < 1e-6 || asHsv.v < 1e-6 ? hsv.h : asHsv.h })
  }

  const applyFromPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    commit({
      ...hsv,
      s: clamp01((event.clientX - rect.left) / rect.width),
      v: 1 - clamp01((event.clientY - rect.top) / rect.height)
    })
  }

  const onAreaKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.1 : 0.02
    let { s, v } = hsv
    switch (event.key) {
      case 'ArrowLeft':
        s -= step
        break
      case 'ArrowRight':
        s += step
        break
      case 'ArrowUp':
        v += step
        break
      case 'ArrowDown':
        v -= step
        break
      case 'Home':
        s = 0
        break
      case 'End':
        s = 1
        break
      default:
        return
    }
    event.preventDefault()
    commit({ ...hsv, s: clamp01(s), v: clamp01(v) })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current}`}
          title={`${label} - ${current}`}
          style={{ backgroundColor: current }}
          className={cn(
            'h-[14px] w-[14px] shrink-0 rounded-[4px] border border-border shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]',
            'transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1',
            'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className
          )}
        />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[228px] p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>

        {/* Saturation (x) / brightness (y) field. */}
        <div
          role="group"
          tabIndex={0}
          aria-label={`${label} saturation and brightness. Arrow keys adjust, shift for larger steps.`}
          onKeyDown={onAreaKeyDown}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            applyFromPointer(event)
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) applyFromPointer(event)
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          className="relative h-[112px] w-full cursor-crosshair touch-none rounded-[4px] border border-border/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{
            background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`
          }}
        >
          <div
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>

        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(hsv.h)}
          onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
          aria-label={`${label} hue`}
          style={{ background: HUE_GRADIENT }}
          className={cn(
            'mt-2 h-2.5 w-full cursor-pointer appearance-none rounded-full border border-border/70',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none',
            '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2',
            '[&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-transparent',
            '[&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]'
          )}
        />

        <div className="mt-2 flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-6 w-6 shrink-0 rounded-[4px] border border-border"
            style={{ backgroundColor: current }}
          />
          <Input
            value={draft}
            spellCheck={false}
            aria-label={`${label} hex value`}
            onChange={(event) => {
              const next = event.target.value
              setDraft(next)
              // Commit as soon as the text parses; typing "#4fb" shouldn't be punished.
              const parsed = normalizeHex(next)
              if (parsed) pickHex(parsed)
            }}
            onBlur={() => setDraft(current)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setDraft(current)
            }}
            className="h-6 flex-1 px-1.5 font-mono text-[11px] uppercase"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={`${label} presets`}>
          {presets.map((preset) => {
            const selected = normalizeHex(preset) === current
            return (
              <button
                key={preset}
                type="button"
                onClick={() => pickHex(preset)}
                aria-label={preset}
                aria-pressed={selected}
                title={preset}
                style={{ backgroundColor: preset }}
                className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] border border-border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover"
              >
                {selected && (
                  <Check className="h-3 w-3" style={{ color: readableTextOn(preset) }} />
                )}
              </button>
            )
          })}
        </div>

        <span className="sr-only" aria-live="polite">
          {`${label} ${current}`}
        </span>
      </PopoverContent>
    </Popover>
  )
}
