import type React from 'react'
import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Music2,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Type,
  Video,
  Waves
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MediaPickerDialog } from './MediaPickerDialog'
import { useVideos } from '@/state/videos'
import { cn } from '@/lib/utils'
import { toUmakbangVisualUrl } from '@shared/url'
import {
  ASPECT_ORDER,
  ASPECTS,
  FONT_FAMILIES,
  createLayer,
  type AudioLayer,
  type ImageLayer,
  type Layer,
  type LayerKind,
  type ShapeLayer,
  type SpectrumLayer,
  type TextLayer,
  type VideoLayer,
  type VideoVisualizerId,
  type VideoVisualizerOrientation,
  type VisualizersLayer,
  type WaveformLayer
} from '@shared/video'

const KIND_ICONS: Record<LayerKind, React.ReactNode> = {
  audio: <Music2 className="h-3 w-3" />,
  video: <Video className="h-3 w-3" />,
  image: <ImageIcon className="h-3 w-3" />,
  visualizers: <Waves className="h-3 w-3" />,
  waveform: <Waves className="h-3 w-3" />,
  spectrum: <Music2 className="h-3 w-3" />,
  text: <Type className="h-3 w-3" />,
  shape: <Square className="h-3 w-3" />
}

/** A labelled row, so every control in the panel lines up without each one saying how. */
function Field({
  label,
  children,
  hint
}: {
  label: string
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[10.5px] text-muted-foreground/70">{hint}</span>}
    </label>
  )
}

function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 min-w-0 flex-1 accent-primary"
      />
      <span className="w-9 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">
        {step >= 1 ? Math.round(value) : value.toFixed(2)}
      </span>
    </div>
  )
}


/** Numeric field whose label is also a scrub handle, like a proper graphics editor. */
function ScrubNumber({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; value: number } | null>(null)
  return (
    <label className="flex items-center gap-1 border bg-background px-1">
      <span
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, value }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          onChange(Math.max(min, Math.min(max, drag.current.value + (event.clientX - drag.current.x) * 0.002)))
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        className="w-4 cursor-ew-resize select-none text-[10.5px] font-semibold uppercase text-muted-foreground"
      >
        {label}
      </span>
      <Input
        type="number"
        step={0.01}
        value={Number(value.toFixed(3))}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-6 border-0 px-0 shadow-none focus-visible:ring-0"
      />
    </label>
  )
}

function Colour({
  value,
  onChange,
  allowEmpty
}: {
  value: string
  onChange: (value: string) => void
  allowEmpty?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value && value.startsWith('#') ? value : '#ffffff'}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border bg-transparent"
      />
      <Input value={value} onChange={(event) => onChange(event.target.value)} className="h-6" />
      {allowEmpty && value && (
        <Button variant="subtle" size="sm" onClick={() => onChange('')}>
          None
        </Button>
      )}
    </div>
  )
}

function Toggle({
  label,
  value,
  onChange
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-primary"
      />
      {label}
    </label>
  )
}

const SELECT_CLASS =
  'h-7 w-full rounded-md border border-input bg-background px-1.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** The stack, bottom of the list being the front of the picture. */
export function LayerList({
  onRequestRemove
}: {
  onRequestRemove: (id: string) => void
}): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const selectedIds = useVideos((s) => s.selectedIds)
  const inspecting = useVideos((s) => s.inspecting)
  const select = useVideos((s) => s.select)
  const setSelection = useVideos((s) => s.setSelection)
  const toggleSelection = useVideos((s) => s.toggleSelection)
  const inspect = useVideos((s) => s.inspect)
  const anchorRef = useRef(-1)
  const patchLayer = useVideos((s) => s.patchLayer)
  const moveLayer = useVideos((s) => s.moveLayer)
  const addLayer = useVideos((s) => s.addLayer)
  const [mediaPicker, setMediaPicker] = useState<'audio' | 'video' | null>(null)

  if (!project) return <></>

  function addMedia(kind: 'audio' | 'video', path: string): void {
    const fileName = path.split(/[\/]/).pop() ?? (kind === 'audio' ? 'Audio' : 'Video')
    addLayer(
      kind === 'audio'
        ? createLayer('audio', {
            source: path,
            name: fileName.replace(/\.[^.]+$/, '')
          })
        : createLayer('video', {
            source: path,
            name: fileName,
            frame: { x: 0.06, y: 0.3, w: 0.5, h: 0.28 }
          })
    )
  }

  async function addImage(): Promise<void> {
    const path = await window.umakbang.pickMedia('image')
    if (!path) return
    addLayer(
      createLayer('image', {
        source: path,
        name: path.split(/[\/]/).pop() ?? 'Image',
        frame: { x: 0.16, y: 0.26, w: 0.68, h: 0.38 }
      })
    )
  }

  const rows = [...project.layers].reverse()

  function selectRow(event: React.MouseEvent, index: number, id: string): void {
    if (event.shiftKey) {
      const anchor = anchorRef.current < 0 ? index : anchorRef.current
      const lo = Math.min(anchor, index)
      const hi = Math.max(anchor, index)
      setSelection(rows.slice(lo, hi + 1).map((entry) => entry.id), id)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      toggleSelection(id)
      anchorRef.current = index
      return
    }
    select(id)
    anchorRef.current = index
  }

  return (
    <>
      <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <span className="mr-auto text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Add layer
        </span>
        <Button variant="ghost" size="sm" onClick={() => setMediaPicker('audio')}>
          <Plus className="h-3 w-3" /> Audio
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setMediaPicker('video')}>
          <Plus className="h-3 w-3" /> Video
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void addImage()}>
          <Plus className="h-3 w-3" /> Image
        </Button>
        <Button variant="ghost" size="sm" onClick={() => addLayer(createLayer('text'))}>
          <Plus className="h-3 w-3" /> Text
        </Button>
        <Button variant="ghost" size="sm" onClick={() => addLayer(createLayer('visualizers'))}>
          <Plus className="h-3 w-3" /> Visualizers
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="A live webcam, as a layer"
          onClick={() =>
            addLayer(
              createLayer('video', {
                source: 'camera',
                name: 'Camera',
                mirror: true,
                frame: { x: 0.08, y: 0.36, w: 0.42, h: 0.24 }
              })
            )
          }
        >
          <Plus className="h-3 w-3" /> Camera
        </Button>
      </div>

      <div className="scroll-thin min-h-0 overflow-y-auto">
        {project.layers.length === 0 && (
          <p className="px-2.5 py-3 text-[11.5px] text-muted-foreground">
            Nothing in the frame yet. Add a layer above.
          </p>
        )}
        {rows.map((layer, index) => (
          <div key={layer.id}>
            <div
              onClick={(event) => selectRow(event, index, layer.id)}
              onDoubleClick={(event) => {
                event.preventDefault()
                inspect(layer.id)
              }}
              className={cn(
                'group flex cursor-pointer items-center gap-1.5 border-b px-2 py-1.5',
                selectedIds.includes(layer.id) ? 'bg-accent' : 'hover:bg-accent/40'
              )}
            >
              <span className="text-muted-foreground">{KIND_ICONS[layer.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-[12px]">{layer.name}</span>
              <button
                type="button"
                aria-label={layer.hidden ? 'Show' : 'Hide'}
                onClick={(event) => {
                  event.stopPropagation()
                  patchLayer(layer.id, { hidden: !layer.hidden } as Partial<Layer>)
                }}
                className="text-muted-foreground/70 hover:text-foreground"
              >
                {layer.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
              <button
                type="button"
                aria-label="Bring forward"
                onClick={(event) => {
                  event.stopPropagation()
                  moveLayer(layer.id, 1)
                }}
                className="text-muted-foreground/70 hover:text-foreground"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label="Send back"
                onClick={(event) => {
                  event.stopPropagation()
                  moveLayer(layer.id, -1)
                }}
                className="text-muted-foreground/70 hover:text-foreground"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label="Remove layer"
                onClick={(event) => {
                  event.stopPropagation()
                  onRequestRemove(layer.id)
                }}
                className="text-muted-foreground/70 hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            {inspecting === layer.id && (
              <div className="border-b bg-background/45">
                <LayerInspector />
              </div>
            )}
          </div>
        ))}
      </div>
      </div>
      <MediaPickerDialog
        kind={mediaPicker ?? 'audio'}
        open={mediaPicker !== null}
        onOpenChange={(open) => {
          if (!open) setMediaPicker(null)
        }}
        onPick={(path) => {
          if (mediaPicker) addMedia(mediaPicker, path)
        }}
      />
    </>
  )
}

/** Everything about the one layer that is selected. */
export function LayerInspector(): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const inspecting = useVideos((s) => s.inspecting)
  const patchLayer = useVideos((s) => s.patchLayer)
  const layer = project?.layers.find((entry) => entry.id === inspecting) ?? null

  if (!project) return <></>
  if (!layer) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-muted-foreground">
        Pick a layer to change it, or click one in the frame.
      </div>
    )
  }

  const set = (patch: Partial<Layer>): void => patchLayer(layer.id, patch)
  return (
    <div className="space-y-2.5 px-3 py-2.5">
      <Field label="Name">
        <Input
          value={layer.name}
          onChange={(event) => set({ name: event.target.value } as Partial<Layer>)}
        />
      </Field>

      {layer.kind === 'audio' && <AudioFields layer={layer} set={set} />}
      {layer.kind === 'text' && <TextFields layer={layer} set={set} />}
      {layer.kind === 'video' && <VideoFields layer={layer} set={set} />}
      {layer.kind === 'visualizers' && <VisualizersFields layer={layer} set={set} />}
      {layer.kind === 'image' && <ImageFields layer={layer} set={set} />}
      {layer.kind === 'waveform' && <WaveformFields layer={layer} set={set} />}
      {layer.kind === 'spectrum' && <SpectrumFields layer={layer} set={set} />}
      {layer.kind === 'shape' && <ShapeFields layer={layer} set={set} />}

      {layer.kind !== 'audio' && (
        <>
          <div className="border-t pt-2">
            <Field label="Position and size" hint="Drag a label left or right, or type a precise value.">
              <div className="grid grid-cols-2 gap-1.5">
                {(['x', 'y', 'w', 'h'] as const).map((key) => (
                  <ScrubNumber
                    key={key}
                    label={key}
                    value={layer.frame[key]}
                    min={key === 'w' || key === 'h' ? 0.02 : -1}
                    max={key === 'w' || key === 'h' ? 2 : 1}
                    onChange={(value) =>
                      set({ frame: { ...layer.frame, [key]: value } } as Partial<Layer>)
                    }
                  />
                ))}
              </div>
            </Field>
          </div>
          <Field label="Opacity">
            <Slider value={layer.opacity} min={0} max={1} onChange={(value) => set({ opacity: value } as Partial<Layer>)} />
          </Field>
        </>
      )}
    </div>
  )
}

type Setter = (patch: Partial<Layer>) => void

function AudioFields({ layer, set }: { layer: AudioLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <p className="truncate text-[11px] text-muted-foreground" title={layer.source}>
        {layer.source}
      </p>
      <Field label="Level">
        <Slider value={layer.gain} min={0} max={2} onChange={(gain) => set({ gain } as Partial<Layer>)} />
      </Field>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label="Fade in">
          <Input type="number" min={0} step={0.25} value={layer.fadeIn} onChange={(event) => set({ fadeIn: Number(event.target.value) } as Partial<Layer>)} />
        </Field>
        <Field label="Fade out">
          <Input type="number" min={0} step={0.25} value={layer.fadeOut} onChange={(event) => set({ fadeOut: Number(event.target.value) } as Partial<Layer>)} />
        </Field>
      </div>
      <p className="text-[10.5px] text-muted-foreground">Move and trim this audio directly in the timeline.</p>
    </>
  )
}

function TextFields({ layer, set }: { layer: TextLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <Field label="Text">
        <textarea
          value={layer.text}
          onChange={(event) => set({ text: event.target.value } as Partial<Layer>)}
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </Field>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label="Font">
          <select
            value={layer.family}
            onChange={(event) => set({ family: event.target.value } as Partial<Layer>)}
            className={SELECT_CLASS}
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Align">
          <select
            value={layer.align}
            onChange={(event) => set({ align: event.target.value as TextLayer['align'] } as Partial<Layer>)}
            className={SELECT_CLASS}
          >
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
      </div>
      <Field label="Size">
        <Slider value={layer.size} min={0.012} max={0.16} step={0.001} onChange={(value) => set({ size: value } as Partial<Layer>)} />
      </Field>
      <Field label="Weight">
        <Slider value={layer.weight} min={100} max={900} step={100} onChange={(value) => set({ weight: value } as Partial<Layer>)} />
      </Field>
      <Field label="Colour">
        <Colour value={layer.color} onChange={(value) => set({ color: value } as Partial<Layer>)} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Toggle label="Uppercase" value={layer.uppercase} onChange={(value) => set({ uppercase: value } as Partial<Layer>)} />
      </div>
      <Field label="Letter spacing">
        <Slider value={layer.tracking} min={-0.05} max={0.3} step={0.005} onChange={(value) => set({ tracking: value } as Partial<Layer>)} />
      </Field>
      <Field label="Shadow" hint="Captions sit over a moving picture; a little goes a long way.">
        <Slider value={layer.shadow} min={0} max={0.5} onChange={(value) => set({ shadow: value } as Partial<Layer>)} />
      </Field>
      <Field label="Outline">
        <Slider value={layer.stroke} min={0} max={0.16} step={0.005} onChange={(value) => set({ stroke: value } as Partial<Layer>)} />
      </Field>
      {layer.stroke > 0 && (
        <Field label="Outline colour">
          <Colour value={layer.strokeColor} onChange={(value) => set({ strokeColor: value } as Partial<Layer>)} />
        </Field>
      )}
      <Field label="Plate behind" hint="Leave empty for none.">
        <Colour value={layer.background} allowEmpty onChange={(value) => set({ background: value } as Partial<Layer>)} />
      </Field>
    </>
  )
}

function CropFields({
  layer,
  set
}: {
  layer: VideoLayer | ImageLayer
  set: Setter
}): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'
    x: number
    y: number
    crop: VideoLayer['crop']
  } | null>(null)
  const [sourceSize, setSourceSize] = useState({ width: 16, height: 9 })
  const spec = project ? ASPECTS[project.aspect] : ASPECTS['9:16']
  const outputAspect = (layer.frame.w * spec.width) / Math.max(0.001, layer.frame.h * spec.height)
  const sourceAspect = sourceSize.width / Math.max(1, sourceSize.height)
  const ratio = outputAspect / sourceAspect
  const crop = layer.crop

  function largestCrop(): VideoLayer['crop'] {
    if (ratio >= 1) return { x: 0, y: (1 - 1 / ratio) / 2, w: 1, h: 1 / ratio }
    return { x: (1 - ratio) / 2, y: 0, w: ratio, h: 1 }
  }

  function pointerMove(event: React.PointerEvent<HTMLElement>): void {
    const active = drag.current
    const box = previewRef.current?.getBoundingClientRect()
    if (!active || !box) return
    const px = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
    const py = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))
    if (active.mode === 'move') {
      set({
        crop: {
          ...active.crop,
          x: Math.max(0, Math.min(1 - active.crop.w, active.crop.x + px - active.x)),
          y: Math.max(0, Math.min(1 - active.crop.h, active.crop.y + py - active.y))
        }
      } as Partial<Layer>)
      return
    }

    const west = active.mode.endsWith('w')
    const north = active.mode.startsWith('n')
    const anchorX = west ? active.crop.x + active.crop.w : active.crop.x
    const anchorY = north ? active.crop.y + active.crop.h : active.crop.y
    const wanted = Math.max(Math.abs(px - anchorX), Math.abs(py - anchorY) * ratio)
    const maxW = Math.min(
      west ? anchorX : 1 - anchorX,
      (north ? anchorY : 1 - anchorY) * ratio
    )
    const w = Math.max(0.05, Math.min(maxW, wanted))
    const h = w / ratio
    set({
      crop: {
        x: west ? anchorX - w : anchorX,
        y: north ? anchorY - h : anchorY,
        w,
        h
      }
    } as Partial<Layer>)
  }

  function begin(
    mode: 'move' | 'nw' | 'ne' | 'sw' | 'se',
    event: React.PointerEvent<HTMLElement>
  ): void {
    const box = previewRef.current?.getBoundingClientRect()
    if (!box) return
    drag.current = {
      mode,
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
      crop: { ...crop }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
  }

  const media =
    layer.kind === 'video' ? (
      <video
        src={layer.source === 'camera' ? undefined : toUmakbangVisualUrl(layer.source)}
        muted
        playsInline
        onLoadedMetadata={(event) =>
          setSourceSize({
            width: event.currentTarget.videoWidth || 16,
            height: event.currentTarget.videoHeight || 9
          })
        }
        className="absolute inset-0 h-full w-full object-fill"
      />
    ) : (
      <img
        src={toUmakbangVisualUrl(layer.source)}
        alt=""
        onLoad={(event) =>
          setSourceSize({
            width: event.currentTarget.naturalWidth || 16,
            height: event.currentTarget.naturalHeight || 9
          })
        }
        className="absolute inset-0 h-full w-full object-fill"
      />
    )

  return (
    <>
      <Field label="Fit" hint="Fill uses exactly the crop below. Fit letterboxes it.">
        <select
          value={layer.fit}
          onChange={(event) => set({ fit: event.target.value as VideoLayer['fit'] } as Partial<Layer>)}
          className={SELECT_CLASS}
        >
          <option value="cover">Fill the box</option>
          <option value="contain">Fit inside it</option>
          <option value="stretch">Stretch</option>
        </select>
      </Field>
      <Field label="Crop area" hint="Drag the area to move it. Drag a corner to resize; its proportions stay locked.">
        <div
          ref={previewRef}
          className="relative w-full overflow-hidden border bg-black"
          style={{ aspectRatio: sourceAspect }}
        >
          {media}
          <div
            role="presentation"
            onPointerDown={(event) => begin('move', event)}
            onPointerMove={pointerMove}
            onPointerUp={(event) => {
              drag.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            className="absolute cursor-move border border-primary shadow-[0_0_0_999px_rgba(0,0,0,0.62)]"
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.w * 100}%`,
              height: `${crop.h * 100}%`
            }}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
              <button
                key={handle}
                type="button"
                aria-label={`Resize crop ${handle}`}
                onPointerDown={(event) => begin(handle, event)}
                onPointerMove={pointerMove}
                onPointerUp={(event) => {
                  drag.current = null
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
                className={cn(
                  'absolute h-2.5 w-2.5 border border-background bg-primary',
                  handle.includes('n') ? '-top-1.5' : '-bottom-1.5',
                  handle.includes('w') ? '-left-1.5' : '-right-1.5'
                )}
              />
            ))}
          </div>
        </div>
      </Field>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => set({ crop: largestCrop() } as Partial<Layer>)}
      >
        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
        Reset {layer.kind === 'video' ? 'video' : 'image'} crop
      </Button>
    </>
  )
}

function VideoFields({ layer, set }: { layer: VideoLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <p className="truncate text-[11px] text-muted-foreground" title={layer.source}>
        {layer.source === 'camera' ? 'Live camera' : layer.source}
      </p>
      <CropFields layer={layer} set={set} />
      <div className="flex flex-wrap gap-3">
        <Toggle label="Loop" value={layer.loop} onChange={(value) => set({ loop: value } as Partial<Layer>)} />
        <Toggle label="Mirror" value={layer.mirror} onChange={(value) => set({ mirror: value } as Partial<Layer>)} />
      </div>
      <Field
        label="Video audio"
        hint="Set this to zero for silence. If the beat is also selected, two copies may phase."
      >
        <Slider value={layer.volume} min={0} max={2} onChange={(value) => set({ volume: value } as Partial<Layer>)} />
      </Field>
    </>
  )
}

function ImageFields({ layer, set }: { layer: ImageLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <p className="truncate text-[11px] text-muted-foreground" title={layer.source}>
        {layer.source}
      </p>
      <CropFields layer={layer} set={set} />
    </>
  )
}

const VIDEO_VISUALIZERS: Array<{ id: VideoVisualizerId; label: string }> = [
  { id: 'spectrogram', label: 'Spectrogram' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'wave', label: 'Waveform' },
  { id: 'scope', label: 'Scope' },
  { id: 'levels', label: 'Levels' },
  { id: 'stereo', label: 'Stereo field' }
]

function VisualizersFields({
  layer,
  set
}: {
  layer: VisualizersLayer
  set: Setter
}): React.JSX.Element {
  return (
    <>
      <Field
        label="Visible visualizers"
        hint="Panels stay in this order. Each enabled panel has its own drawing direction."
      >
        <div className="grid grid-cols-2 gap-1.5 border p-2">
          {VIDEO_VISUALIZERS.map((item) => {
            const enabled = layer.enabled.includes(item.id)
            const orientation = layer.orientations?.[item.id] ?? 'horizontal'
            return (
              <div key={item.id} className={cn('border p-1.5', enabled && 'bg-muted/30')}>
                <Toggle
                  label={item.label}
                  value={enabled}
                  onChange={(on) =>
                    set({
                      enabled: VIDEO_VISUALIZERS.filter((candidate) =>
                        candidate.id === item.id ? on : layer.enabled.includes(candidate.id)
                      ).map((candidate) => candidate.id)
                    } as Partial<Layer>)
                  }
                />
                {enabled && (
                  <label className="mt-1 block pl-5">
                    <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      Orientation
                    </span>
                    <select
                      aria-label={`${item.label} orientation`}
                      value={orientation}
                      onChange={(event) =>
                        set({
                          orientations: {
                            ...layer.orientations,
                            [item.id]: event.target.value as VideoVisualizerOrientation
                          }
                        } as Partial<Layer>)
                      }
                      className={cn(SELECT_CLASS, 'h-6 text-[11.5px]')}
                    >
                      <option value="horizontal">Horizontal</option>
                      <option value="vertical">Vertical</option>
                    </select>
                  </label>
                )}
              </div>
            )
          })}
        </div>
      </Field>
      <Toggle
        label="Stack as horizontal bands"
        value={Boolean(layer.horizontalBands)}
        onChange={(horizontalBands) => set({ horizontalBands } as Partial<Layer>)}
      />
      {layer.enabled.includes('stereo') && (
        <Toggle
          label="Fill stereo field"
          value={layer.stereoMode === 'fill'}
          onChange={(full) => set({ stereoMode: full ? 'fill' : 'arc' } as Partial<Layer>)}
        />
      )}
      <ColourMode
        mode={layer.colorMode}
        color={layer.color}
        set={set}
        hint="Use the same ramp as the rest of umakbang, or one colour across every panel."
      />
    </>
  )
}

function WaveformFields({ layer, set }: { layer: WaveformLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <Field label="Style">
        <select
          value={layer.style}
          onChange={(event) => set({ style: event.target.value as WaveformLayer['style'] } as Partial<Layer>)}
          className={SELECT_CLASS}
        >
          <option value="mirror">Mirrored bars</option>
          <option value="bars">Bars from the bottom</option>
          <option value="filled">Filled envelope</option>
          <option value="line">Line</option>
        </select>
      </Field>
      <Field
        label="Movement"
        hint="Scrolling shows a window under a fixed centre. Fixed shows the whole clip with a playhead."
      >
        <select
          value={layer.scroll ? 'scroll' : 'fixed'}
          onChange={(event) => set({ scroll: event.target.value === 'scroll' } as Partial<Layer>)}
          className={SELECT_CLASS}
        >
          <option value="fixed">The whole clip</option>
          <option value="scroll">Scrolling</option>
        </select>
      </Field>
      {layer.scroll && (
        <Field label="Window" hint="Seconds either side of the playhead.">
          <Slider value={layer.window} min={1} max={15} step={0.5} onChange={(value) => set({ window: value } as Partial<Layer>)} />
        </Field>
      )}
      <Field label="Bars">
        <Slider value={layer.bars} min={8} max={220} step={1} onChange={(value) => set({ bars: value } as Partial<Layer>)} />
      </Field>
      <Field label="Gap">
        <Slider value={layer.gap} min={0} max={0.8} onChange={(value) => set({ gap: value } as Partial<Layer>)} />
      </Field>
      <ColourMode
        mode={layer.colorMode}
        color={layer.color}
        set={set}
        hint="The ramp is the same one the visualizers use, from Settings."
      />
      {!layer.scroll && (
        <Field label="Played colour" hint="Leave empty to draw the whole clip in one colour.">
          <Colour value={layer.playedColor} allowEmpty onChange={(value) => set({ playedColor: value } as Partial<Layer>)} />
        </Field>
      )}
      <Toggle label="Rounded" value={layer.rounded} onChange={(value) => set({ rounded: value } as Partial<Layer>)} />
    </>
  )
}

function SpectrumFields({ layer, set }: { layer: SpectrumLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <Field label="Bars">
        <Slider value={layer.bars} min={8} max={128} step={1} onChange={(value) => set({ bars: value } as Partial<Layer>)} />
      </Field>
      <Field label="Gap">
        <Slider value={layer.gap} min={0} max={0.8} onChange={(value) => set({ gap: value } as Partial<Layer>)} />
      </Field>
      <Field label="Smoothing" hint="Holds the previous frames, so the bars do not strobe.">
        <Slider value={layer.smoothing} min={0} max={0.95} onChange={(value) => set({ smoothing: value } as Partial<Layer>)} />
      </Field>
      <ColourMode mode={layer.colorMode} color={layer.color} set={set} />
      <div className="flex gap-3">
        <Toggle label="Mirrored" value={layer.mirror} onChange={(value) => set({ mirror: value } as Partial<Layer>)} />
        <Toggle label="Rounded" value={layer.rounded} onChange={(value) => set({ rounded: value } as Partial<Layer>)} />
      </div>
    </>
  )
}

function ShapeFields({ layer, set }: { layer: ShapeLayer; set: Setter }): React.JSX.Element {
  return (
    <>
      <Field label="Colour">
        <Colour value={layer.color} onChange={(value) => set({ color: value } as Partial<Layer>)} />
      </Field>
      <Field label="Second colour" hint="Set one to make it a vertical gradient, for shading.">
        <Colour value={layer.color2} allowEmpty onChange={(value) => set({ color2: value } as Partial<Layer>)} />
      </Field>
    </>
  )
}

function ColourMode({
  mode,
  color,
  set,
  hint
}: {
  mode: 'ramp' | 'solid'
  color: string
  set: Setter
  hint?: string
}): React.JSX.Element {
  return (
    <>
      <Field label="Colour" hint={hint}>
        <select
          value={mode}
          onChange={(event) => set({ colorMode: event.target.value as 'ramp' | 'solid' } as Partial<Layer>)}
          className={SELECT_CLASS}
        >
          <option value="ramp">Your visualizer ramp</option>
          <option value="solid">One colour</option>
        </select>
      </Field>
      {mode === 'solid' && (
        <Colour value={color} onChange={(value) => set({ color: value } as Partial<Layer>)} />
      )}
    </>
  )
}

/** Project-wide settings: the frame, the rate, the background and the track. */
export function ProjectFields(): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const patch = useVideos((s) => s.patch)
  if (!project) return <></>

  return (
    <div className="space-y-2.5 px-3 py-2.5">
      <Field label="Name">
        <Input value={project.name} onChange={(event) => patch({ name: event.target.value })} />
      </Field>
      <Field label="Frame">
        <div className="grid grid-cols-2 gap-1">
          {ASPECT_ORDER.map((aspect) => (
            <button
              key={aspect}
              type="button"
              onClick={() => patch({ aspect })}
              className={cn(
                'rounded-md border px-2 py-1 text-left text-[11.5px] transition-colors',
                project.aspect === aspect
                  ? 'border-primary bg-accent'
                  : 'hover:bg-accent/50'
              )}
            >
              <span className="block font-medium">{ASPECTS[aspect].label}</span>
              <span className="block text-[10px] text-muted-foreground">
                {ASPECTS[aspect].hint}
              </span>
            </button>
          ))}
        </div>
      </Field>
      <Field
        label="Frame rate"
        hint="60 is worth it for a screen capture, where a playhead is moving the whole time."
      >
        <select
          value={project.fps}
          onChange={(event) => patch({ fps: Number(event.target.value) })}
          className={SELECT_CLASS}
        >
          <option value={24}>24</option>
          <option value={30}>30</option>
          <option value={60}>60</option>
        </select>
      </Field>
      <Field label="Background">
        <Colour value={project.background} onChange={(value) => patch({ background: value })} />
      </Field>
    </div>
  )
}
