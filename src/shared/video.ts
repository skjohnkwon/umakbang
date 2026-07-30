/**
 * What a video is, as data.
 *
 * The compositor is a pure function of one of these plus a time in seconds, and both the
 * preview and the export call it. That is the whole reason this file exists separately from
 * the editor: the picture somebody arranges on screen and the picture that lands in the MP4
 * have to be produced by one implementation, or the export becomes a second renderer that
 * drifts from the first and nobody finds out until after they have posted it.
 *
 * Geometry is stored as fractions of the frame rather than pixels, so switching a project
 * from 9:16 to 1:1 moves everything sensibly instead of leaving half the layers off-canvas.
 */

/** The frames people actually post to. */
export type VideoAspect = '9:16' | '4:5' | '1:1' | '16:9'

export interface AspectSpec {
  width: number
  height: number
  label: string
  hint: string
}

/**
 * 1080 on the short edge throughout.
 *
 * Instagram and TikTok both re-encode whatever they are given and both cap the long edge
 * around 1920, so a 4K export is minutes of extra encoding for a file the platform throws
 * away. 1080x1920 is what their own guidance asks for.
 */
export const ASPECTS: Record<VideoAspect, AspectSpec> = {
  '9:16': { width: 1080, height: 1920, label: '9:16', hint: 'Reels, TikTok, Shorts' },
  '4:5': { width: 1080, height: 1350, label: '4:5', hint: 'Instagram feed post' },
  '1:1': { width: 1080, height: 1080, label: '1:1', hint: 'Square post' },
  '16:9': { width: 1920, height: 1080, label: '16:9', hint: 'YouTube, landscape' }
}

export const ASPECT_ORDER: VideoAspect[] = ['9:16', '4:5', '1:1', '16:9']

/** A box in fractions of the frame, or of a source image when it is a crop. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const FULL_FRAME: Rect = { x: 0, y: 0, w: 1, h: 1 }

export type LayerKind =
  | 'audio'
  | 'video'
  | 'image'
  | 'visualizers'
  | 'waveform'
  | 'spectrum'
  | 'text'
  | 'shape'

interface LayerBase {
  id: string
  kind: LayerKind
  /** What the layer list calls it. Defaults to something derived from the source. */
  name: string
  hidden: boolean
  /** Where it sits in the frame. */
  frame: Rect
  opacity: number
  /**
   * When the layer is on screen, in seconds from the start of the video. Undefined at
   * either end means "from the beginning" / "until the end" rather than a number that has
   * to be corrected every time the clip length changes.
   */
  from?: number
  to?: number
  /** Seconds of fade at each end of that window. */
  fadeIn: number
  fadeOut: number
}

/** How a source fills its box when the two are different shapes. */
export type Fit = 'cover' | 'contain' | 'stretch'

export interface VideoClip {
  /** Stable identity for timeline gestures and clip menus. */
  id: string
  /** Where this clip sits in the project timeline. */
  from: number
  to: number
  /** Where this clip begins in the source file. */
  offset: number
}

export interface VideoLayer extends LayerBase {
  kind: 'video'
  /**
   * An absolute path, or `camera` for a live webcam.
   *
   * The camera is a source rather than a layer kind of its own because everything else about
   * it - the box, the crop, the rounding, the mirroring - is what a video layer already
   * does, and a second kind would have been a copy of this one with a different loader.
   */
  source: string
  /**
   * Which part of the source is shown, in fractions of the source's own frame.
   *
   * This is the control the reference reels turn on: a 16:9 capture of a DAW put into a
   * 9:16 frame is either most of the window shrunk into a band, or one corner of it filling
   * the screen, and which of those you want depends entirely on what you were doing. `fit`
   * alone can only express the first.
   */
  crop: Rect
  fit: Fit
  /** Where in the source the layer starts, in seconds. */
  offset: number
  /**
   * Multiple edits of this source on one timeline row. Absent is the legacy single clip
   * described by from/to/offset; it stays optional so every saved project still opens.
   */
  clips?: VideoClip[]
  /** Whether it repeats when it runs out before the video does. */
  loop: boolean
  /** Front cameras read as wrong unmirrored, and only cameras do. */
  mirror: boolean
  /** Linear gain. Zero is silent. */
  volume: number
  /** Measured source duration, used to size the timeline without manual length settings. */
  sourceDuration?: number
}

export interface AudioLayer extends LayerBase {
  kind: 'audio'
  source: string
  /** Seconds into the source where playback begins. */
  offset: number
  /** Measured from the decoded file and persisted for deterministic timeline length. */
  sourceDuration?: number
  /** Linear gain. */
  gain: number
}

export interface ImageLayer extends LayerBase {
  kind: 'image'
  source: string
  crop: Rect
  fit: Fit
}


export type VideoVisualizerId =
  | 'spectrogram'
  | 'spectrum'
  | 'wave'
  | 'scope'
  | 'levels'
  | 'stereo'

export type VideoVisualizerOrientation = 'horizontal' | 'vertical'

/** One horizontal meter bridge, configured as one layer and one timeline clip. */
export interface VisualizersLayer extends LayerBase {
  kind: 'visualizers'
  enabled: VideoVisualizerId[]
  /** False: panels side by side. True: wide horizontal bands stacked top to bottom. */
  horizontalBands: boolean
  /**
   * Drawing direction for each panel. Missing entries are horizontal so projects saved
   * before this setting existed keep opening without an automatic aspect-ratio rotation.
   */
  orientations?: Partial<Record<VideoVisualizerId, VideoVisualizerOrientation>>
  colorMode: 'ramp' | 'solid'
  color: string
  /** Arc is the compact stereo-width view; full is the filled goniometer field. */
  stereoMode: 'arc' | 'fill'
}

export type WaveformStyle = 'bars' | 'mirror' | 'line' | 'filled'

export interface WaveformLayer extends LayerBase {
  kind: 'waveform'
  style: WaveformStyle
  /** Columns across the box. */
  bars: number
  /** Fraction of each column's slot left empty, so bars read as bars. */
  gap: number
  /** The visualizer ramp the rest of the app is coloured by, or one flat colour. */
  colorMode: 'ramp' | 'solid'
  color: string
  /** Colour behind the playhead, for the filling-up look. Empty means no progress fill. */
  playedColor: string
  /**
   * Whether the whole clip is drawn with a playhead moving across it, or a window that
   * scrolls under a fixed centre line. Both are common and they say different things: the
   * first shows the shape of the beat, the second shows the moment.
   */
  scroll: boolean
  /** Seconds either side of the playhead when scrolling. */
  window: number
  rounded: boolean
}

export interface SpectrumLayer extends LayerBase {
  kind: 'spectrum'
  bars: number
  gap: number
  /** Mirrored draws up and down from the middle of the box. */
  mirror: boolean
  colorMode: 'ramp' | 'solid'
  color: string
  /** 0 to 1, how much of the previous frame is held. Stops the bars strobing. */
  smoothing: number
  rounded: boolean
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextLayer extends LayerBase {
  kind: 'text'
  text: string
  family: string
  /** Fraction of the frame height, so it survives an aspect change. */
  size: number
  weight: number
  align: TextAlign
  color: string
  /** Outline width as a fraction of the font size. 0 is none. */
  stroke: number
  strokeColor: string
  /** Drop shadow blur as a fraction of the font size. */
  shadow: number
  uppercase: boolean
  /** Letter spacing as a fraction of the font size. */
  tracking: number
  lineHeight: number
  /** A filled plate behind the text. Empty means none. */
  background: string
  padding: number
}

export interface ShapeLayer extends LayerBase {
  kind: 'shape'
  color: string
  /** A second colour makes it a vertical gradient. Empty means flat. */
  color2: string
}

export type Layer =
  | AudioLayer
  | VideoLayer
  | ImageLayer
  | VisualizersLayer
  | WaveformLayer
  | SpectrumLayer
  | TextLayer
  | ShapeLayer

/** The track the video is of. */
export interface VideoAudio {
  /** Absolute path to the file in the library. */
  path: string
  /** Its name, kept so a project still reads sensibly when the file has moved. */
  name: string
  /** The stretch of it the video covers, in seconds. */
  from: number
  to: number
  fadeIn: number
  fadeOut: number
  /** Linear gain. */
  gain: number
}

export interface VideoExport {
  id: string
  path: string
  /** File name kept separately so the row stays readable even if the file later moves. */
  name: string
  createdAt: number
}

export interface VideoProject {
  id: string
  name: string
  aspect: VideoAspect
  /**
   * 30 is what both platforms encode to. 60 is worth having for a screen capture, where the
   * thing being filmed is a playhead moving smoothly across a grid.
   */
  fps: number
  background: string
  audio: VideoAudio | null
  /** Bottom first, so the list draws in the order it composites. */
  layers: Layer[]
  /** Successful renders made from this project, newest first. */
  exports: VideoExport[]
  /** Used only when there is no audio to take the length from. */
  duration: number
  createdAt: number
  updatedAt: number
}

/**
 * How long the video is.
 *
 * The audio range wins when there is one, rather than being copied into `duration` on every
 * edit: two fields holding the same fact is two fields that can disagree, and the one that
 * would be wrong is the one the export reads.
 */
export function projectDuration(project: VideoProject): number {
  const mediaEnds: number[] = []
  if (project.audio) mediaEnds.push(Math.max(0, project.audio.to - project.audio.from))
  for (const layer of project.layers) {
    if (layer.hidden) continue
    if (layer.kind !== 'audio' && layer.kind !== 'video') continue
    if (layer.kind === 'video' && layer.source === 'camera') continue
    if (layer.kind === 'video' && layer.clips?.length) {
      for (const clip of layer.clips) if (clip.to > clip.from) mediaEnds.push(clip.to)
      continue
    }
    const from = layer.from ?? 0
    const available = Math.max(0, (layer.sourceDuration ?? 0) - layer.offset)
    const end = layer.to ?? from + available
    if (end > from) mediaEnds.push(end)
  }
  return Math.max(0.1, ...mediaEnds)
}

/** Whether a layer is on screen at a given time, and how far into its fades. */
export function layerAlpha(layer: Layer, time: number, duration: number): number {
  let from = layer.from ?? 0
  let to = layer.to ?? duration
  if (layer.kind === 'video' && layer.clips?.length) {
    const active = layer.clips.find((clip) => time >= clip.from && time < clip.to)
    if (!active) return 0
    from = active.from
    to = active.to
  }
  if (time < from || time > to) return 0
  let alpha = layer.opacity
  if (layer.fadeIn > 0 && time < from + layer.fadeIn) alpha *= (time - from) / layer.fadeIn
  if (layer.fadeOut > 0 && time > to - layer.fadeOut) alpha *= (to - time) / layer.fadeOut
  return Math.max(0, Math.min(1, alpha))
}

/** A recording made by the built-in capture, as main remembers it. */
export interface Recording {
  id: string
  path: string
  name: string
  createdAt: number
  /** Milliseconds, as measured by the recorder rather than read back off the file. */
  durationMs: number
  width: number
  height: number
  size: number
  source: 'screen' | 'window' | 'camera'
  /** What was captured, for the list: a monitor name, or the window's title. */
  sourceName: string
}

/** Everything the videos page keeps, which is per machine and never in a settings export. */
export interface VideoData {
  projects: VideoProject[]
  recordings: Recording[]
  /** Where finished videos are written. */
  outputDir: string
  /** Defaults the recorder reopens with. */
  capture: CaptureSettings
}

export interface CaptureSettings {
  /** Frames a second asked of the capture. */
  fps: number
  /** Cap on the captured height; a 4K monitor at full size is an unusable file. */
  maxHeight: number
  /** Record what the machine is playing. Windows only, which the UI says. */
  systemAudio: boolean
  /** Record a microphone alongside. */
  microphone: boolean
  /** Device id of that microphone, or empty for the default. */
  microphoneId: string
  /** Record the webcam at the same time, as a second file to lay over the first. */
  camera: boolean
  cameraId: string
  /** Bits a second for the video track. */
  bitrate: number
}

export const DEFAULT_CAPTURE: CaptureSettings = {
  fps: 30,
  maxHeight: 1080,
  systemAudio: true,
  microphone: false,
  microphoneId: '',
  camera: false,
  cameraId: '',
  // 12Mbps at 1080p30. A DAW window is a worst case for an encoder - fine grids, sharp text
  // and a playhead moving over all of it - and at the 2.5Mbps a webcam is happy with, the
  // piano roll comes back as mush.
  bitrate: 12_000_000
}

/** A source the capture picker offers. */
export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** A PNG data URL, small, so the picker can show what it is offering. */
  thumbnail: string
  appIcon: string
}

let counter = 0

export function newId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

const BASE: Omit<LayerBase, 'id' | 'kind' | 'name'> = {
  hidden: false,
  frame: { ...FULL_FRAME },
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0
}

/** A layer of each kind, with defaults that look like something the moment they are added. */
export function createLayer(kind: LayerKind, patch: Partial<Layer> = {}): Layer {
  const id = newId(kind)
  switch (kind) {
    case 'audio':
      return {
        ...BASE,
        id,
        kind: 'audio',
        name: 'Audio',
        source: '',
        frame: { ...FULL_FRAME },
        offset: 0,
        gain: 1,
        ...(patch as Partial<AudioLayer>)
      }
    case 'video':
      return {
        ...BASE,
        id,
        kind: 'video',
        name: 'Video',
        source: '',
        crop: { ...FULL_FRAME },
        fit: 'cover',
        offset: 0,
        loop: true,
        mirror: false,
        volume: 1,
        ...(patch as Partial<VideoLayer>)
      }
    case 'image':
      return {
        ...BASE,
        id,
        kind: 'image',
        name: 'Image',
        source: '',
        crop: { ...FULL_FRAME },
        fit: 'cover',
        ...(patch as Partial<ImageLayer>)
      }
    case 'visualizers':
      return {
        ...BASE,
        id,
        kind: 'visualizers',
        name: 'Visualizers',
        frame: { x: 0.04, y: 0.72, w: 0.92, h: 0.2 },
        enabled: ['spectrogram', 'spectrum', 'wave', 'scope', 'levels', 'stereo'],
        horizontalBands: false,
        orientations: {
          spectrogram: 'horizontal',
          spectrum: 'horizontal',
          wave: 'horizontal',
          scope: 'horizontal',
          levels: 'horizontal',
          stereo: 'horizontal'
        },
        colorMode: 'ramp',
        color: '#ffffff',
        stereoMode: 'arc',
        ...(patch as Partial<VisualizersLayer>)
      }
    case 'waveform':
      return {
        ...BASE,
        id,
        kind: 'waveform',
        name: 'Waveform',
        frame: { x: 0.06, y: 0.74, w: 0.88, h: 0.12 },
        style: 'mirror',
        bars: 72,
        gap: 0.35,
        colorMode: 'ramp',
        color: '#ffffff',
        playedColor: '',
        scroll: false,
        window: 4,
        rounded: true,
        ...(patch as Partial<WaveformLayer>)
      }
    case 'spectrum':
      return {
        ...BASE,
        id,
        kind: 'spectrum',
        name: 'Spectrum',
        frame: { x: 0.06, y: 0.74, w: 0.88, h: 0.14 },
        bars: 48,
        gap: 0.3,
        mirror: false,
        colorMode: 'ramp',
        color: '#ffffff',
        smoothing: 0.6,
        rounded: true,
        ...(patch as Partial<SpectrumLayer>)
      }
    case 'text':
      return {
        ...BASE,
        id,
        kind: 'text',
        name: 'Text',
        frame: { x: 0.08, y: 0.08, w: 0.84, h: 0.12 },
        text: 'text',
        family: 'system-ui',
        size: 0.045,
        weight: 600,
        align: 'center',
        color: '#ffffff',
        stroke: 0,
        strokeColor: '#000000',
        // Captions sit over whatever the recording happens to be showing, and a DAW is a
        // light-on-dark grid that goes bright without warning. A shadow costs nothing and is
        // the difference between readable and not.
        shadow: 0.18,
        uppercase: false,
        tracking: 0,
        lineHeight: 1.15,
        background: '',
        padding: 0.3,
        ...(patch as Partial<TextLayer>)
      }
    case 'shape':
    default:
      return {
        ...BASE,
        id,
        kind: 'shape',
        name: 'Shape',
        frame: { x: 0, y: 0.7, w: 1, h: 0.3 },
        color: '#000000',
        color2: '',
        ...(patch as Partial<ShapeLayer>)
      }
  }
}

export const FONT_FAMILIES = [
  'system-ui',
  'Segoe UI',
  'Arial',
  'Arial Black',
  'Impact',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Trebuchet MS',
  'Verdana'
]

export function createProject(name: string, aspect: VideoAspect = '9:16'): VideoProject {
  const now = Date.now()
  return {
    id: newId('video'),
    name,
    aspect,
    fps: 30,
    background: '#000000',
    audio: null,
    layers: [],
    exports: [],
    duration: 0.1,
    createdAt: now,
    updatedAt: now
  }
}

export const DEFAULT_VIDEO_DATA: VideoData = {
  projects: [],
  recordings: [],
  outputDir: '',
  capture: { ...DEFAULT_CAPTURE }
}
