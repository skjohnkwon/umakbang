import { create } from 'zustand'
import {
  createLayer,
  createProject,
  projectDuration,
  type CaptureSettings,
  type Layer,
  type Recording,
  type VideoAspect,
  type VideoData,
  type VideoProject
} from '@shared/video'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'

/**
 * Video projects, kept apart from the library store for the same reason contracts are.
 *
 * Nothing here is on the path of scrolling a quarter-million rows. What is different from
 * contracts is that this store is also edited continuously - a colour picker drag writes to
 * it sixty times a second - so the write to disk is debounced rather than going through main
 * per change. The project in memory is the truth while the page is open; main gets it a
 * second after the user stops moving.
 */

/** How long after the last edit the project is written. */
const SAVE_DELAY = 900

interface VideoState {
  loaded: boolean
  data: VideoData | null
  /** The project being edited, held here rather than in `data` so edits are cheap. */
  project: VideoProject | null
  /** Primary layer in the current selection. */
  selected: string | null
  /** Explorer-style multi-selection, ordered by the most recent range operation. */
  selectedIds: string[]
  /** The selected row whose settings accordion is open. */
  inspecting: string | null
  /** Unsaved changes are pending a write. */
  dirty: boolean
  /**
   * Whether the app's own transport and visualizer panel are showing over the editor.
   *
   * Off while a project is open, because the editor has a transport of its own and two of
   * them side by side is two play buttons that do different things - and the panel takes the
   * width the frame wants. Not persisted: it is somewhere you step into, the same reasoning
   * `visualizerOnly` is deliberately forgotten at launch.
   */
  chromeOpen: boolean

  load: () => Promise<void>
  open: (id: string) => void
  /** Starts a project for a track, which is what the explorer's menu item does. */
  startFor: (path: string, name: string) => void
  close: () => void
  newProject: (aspect?: VideoAspect) => void
  patch: (patch: Partial<VideoProject>) => void
  setLayers: (layers: Layer[]) => void
  patchLayer: (id: string, patch: Partial<Layer>) => void
  addLayer: (layer: Layer) => void
  removeLayer: (id: string) => void
  moveLayer: (id: string, by: number) => void
  select: (id: string | null) => void
  setSelection: (ids: string[], primary?: string | null) => void
  toggleSelection: (id: string) => void
  inspect: (id: string | null) => void
  setChromeOpen: (open: boolean) => void
  save: () => Promise<void>
  /** Adds a successful render to this project's persistent history. */
  recordExport: (path: string) => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  saveCapture: (patch: Partial<CaptureSettings>) => Promise<void>
  addRecordings: (recordings: Recording[]) => void
  forgetRecording: (id: string, deleteFile: boolean) => Promise<void>
  chooseOutputDir: () => Promise<void>
}

let saveTimer = 0

/**
 * Stops the library playing before the editor takes over.
 *
 * The editor plays the project through its own audio graph, so without this the beat you
 * clicked in the explorer keeps going underneath the preview - two pieces of music at once,
 * and the transport that could stop it has just been collapsed. `togglePlay` rather than a
 * `pause` of its own because there isn't one, and inventing a second way to stop playback is
 * how the two get out of step.
 */
function hushLibrary(): void {
  if (usePlayer.getState().playing) usePlayer.getState().togglePlay()
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void useVideos.getState().save()
  }, SAVE_DELAY)
}

export const useVideos = create<VideoState>((set, get) => ({
  loaded: false,
  data: null,
  project: null,
  selected: null,
  selectedIds: [],
  inspecting: null,
  dirty: false,
  chromeOpen: false,

  load: async () => {
    const data = await window.umakbang.videoData()
    set({ data, loaded: true })
  },

  open: (id) => {
    const saved = get().data?.projects.find((entry) => entry.id === id)
    if (!saved) return
    const legacyAudio = saved.audio
    const savedLayers = saved.layers.map((layer) =>
      layer.kind === 'video' && layer.source !== 'camera' && (layer.name === layer.source || layer.name === 'Video')
        ? { ...layer, name: layer.source.split(/[\\/]/).pop() ?? 'Video' }
        : layer
    )
    const layers = legacyAudio
      ? [
          ...savedLayers,
          createLayer('audio', {
            name: legacyAudio.name,
            source: legacyAudio.path,
            offset: legacyAudio.from,
            gain: legacyAudio.gain,
            fadeIn: legacyAudio.fadeIn,
            fadeOut: legacyAudio.fadeOut
          })
        ]
      : savedLayers
    const project = { ...saved, audio: null, layers, exports: saved.exports ?? [] }
    hushLibrary()
    set({ project, selected: layers[0]?.id ?? null, selectedIds: layers[0] ? [layers[0].id] : [], inspecting: null, chromeOpen: false })
  },

  /**
   * A project for one track, from the explorer.
   *
   * Deliberately empty of layers: which preset to build is the first question the editor
   * asks, and answering it here would mean the menu item silently deciding what the video
   * looks like. The track and its full length are filled in, because those are facts.
   */
  startFor: (path, name) => {
    const project = createProject(name)
    project.layers = [
      createLayer('audio', {
        source: path,
        name: name.replace(/\.[^.]+$/, ''),
        offset: 0,
        gain: 1
      })
    ]
    hushLibrary()
    set({ project, selected: project.layers[0].id, selectedIds: [project.layers[0].id], inspecting: null, dirty: true, chromeOpen: false })
    useLibrary.getState().setView({ mode: 'videos' })
    scheduleSave()
  },

  close: () => {
    void get().save()
    set({ project: null, selected: null, selectedIds: [], inspecting: null })
  },

  newProject: (aspect = '9:16') => {
    const project = createProject('Untitled video', aspect)
    hushLibrary()
    set({ project, selected: null, selectedIds: [], inspecting: null, dirty: true, chromeOpen: false })
    scheduleSave()
  },

  patch: (patch) => {
    const project = get().project
    if (!project) return
    set({ project: { ...project, ...patch }, dirty: true })
    scheduleSave()
  },

  setLayers: (layers) => {
    const project = get().project
    if (!project) return
    set({ project: { ...project, layers }, dirty: true })
    scheduleSave()
  },

  patchLayer: (id, patch) => {
    const project = get().project
    if (!project) return
    const layers = project.layers.map((layer) =>
      layer.id === id ? ({ ...layer, ...patch } as Layer) : layer
    )
    set({ project: { ...project, layers }, dirty: true })
    scheduleSave()
  },

  addLayer: (layer) => {
    const project = get().project
    if (!project) return
    const added =
      layer.kind === 'video' && layer.source !== 'camera' && (layer.name === layer.source || layer.name === 'Video')
        ? { ...layer, name: layer.source.split(/[\\/]/).pop() ?? 'Video' }
        : layer
    set({
      project: { ...project, layers: [...project.layers, added] },
      selected: added.id,
      selectedIds: [added.id],
      inspecting: null,
      dirty: true
    })
    scheduleSave()
  },

  removeLayer: (id) => {
    const project = get().project
    if (!project) return
    const layers = project.layers.filter((layer) => layer.id !== id)
    const selectedIds = get().selectedIds.filter((entry) => entry !== id)
    const selected = get().selected === id ? (selectedIds[selectedIds.length - 1] ?? null) : get().selected
    set({
      project: { ...project, layers },
      selected,
      selectedIds,
      inspecting: get().inspecting === id ? null : get().inspecting,
      dirty: true
    })
    scheduleSave()
  },

  /** Moves a layer up or down the stack, which is what decides what covers what. */
  moveLayer: (id, by) => {
    const project = get().project
    if (!project) return
    const at = project.layers.findIndex((layer) => layer.id === id)
    const to = at + by
    if (at < 0 || to < 0 || to >= project.layers.length) return
    const layers = [...project.layers]
    const [moved] = layers.splice(at, 1)
    layers.splice(to, 0, moved)
    set({ project: { ...project, layers }, dirty: true })
    scheduleSave()
  },

  select: (id) => set({ selected: id, selectedIds: id ? [id] : [], inspecting: null }),
  setSelection: (ids, primary) => {
    const unique = [...new Set(ids)]
    const selected = primary === undefined ? (unique[unique.length - 1] ?? null) : primary
    set({ selected, selectedIds: unique, inspecting: null })
  },
  toggleSelection: (id) => {
    const current = get().selectedIds
    const selectedIds = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    set({ selectedIds, selected: selectedIds[selectedIds.length - 1] ?? null, inspecting: null })
  },
  inspect: (id) => set({
    inspecting: id,
    selected: id ?? get().selected,
    selectedIds: id && !get().selectedIds.includes(id) ? [id] : get().selectedIds
  }),
  setChromeOpen: (open) => set({ chromeOpen: open }),

  save: async () => {
    const project = get().project
    if (!project || !get().dirty) return
    const data = await window.umakbang.saveVideoProject(project)
    set({ data, dirty: false })
  },

  recordExport: async (path) => {
    const project = get().project
    if (!project) return
    window.clearTimeout(saveTimer)
    const name = path.split(/[\\/]/).pop() || 'Exported video'
    const entry = {
      id: `video-export-${crypto.randomUUID()}`,
      path,
      name,
      createdAt: Date.now()
    }
    const next = {
      ...project,
      // A repeated path represents the latest render at that location, not two different files.
      exports: [entry, ...(project.exports ?? []).filter((item) => item.path !== path)].slice(0, 100)
    }
    set({ project: next, dirty: true })
    const data = await window.umakbang.saveVideoProject(next)
    if (get().project === next) set({ data, dirty: false })
    else set({ data })
  },

  renameProject: async (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const project = get().project
    if (project?.id === id) {
      get().patch({ name: trimmed })
      return
    }
    const saved = get().data?.projects.find((entry) => entry.id === id)
    if (!saved || saved.name === trimmed) return
    set({ data: get().data ? {
      ...get().data!,
      projects: get().data!.projects.map((entry) =>
        entry.id === id ? { ...entry, name: trimmed } : entry
      )
    } : null })
    set({ data: await window.umakbang.saveVideoProject({ ...saved, name: trimmed }) })
  },

  remove: async (id) => {
    const data = await window.umakbang.deleteVideoProject(id)
    set({ data })
    if (get().project?.id === id) set({ project: null, selected: null, selectedIds: [], inspecting: null, dirty: false })
  },

  saveCapture: async (patch) => {
    set({ data: await window.umakbang.saveCaptureSettings(patch) })
  },

  addRecordings: (recordings) => {
    const data = get().data
    if (!data || recordings.length === 0) return
    set({ data: { ...data, recordings: [...recordings, ...data.recordings] } })
  },

  forgetRecording: async (id, deleteFile) => {
    set({ data: await window.umakbang.removeRecording(id, deleteFile) })
  },

  chooseOutputDir: async () => {
    const picked = await window.umakbang.pickVideoOutputDir()
    if (!picked) return
    set({ data: await window.umakbang.setVideoOutputDir(picked) })
  }
}))

/** The current project's length, for anything that needs it outside the editor. */
export function currentDuration(): number {
  const project = useVideos.getState().project
  return project ? projectDuration(project) : 0
}
