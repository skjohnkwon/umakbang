import type React from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Download,
  FolderOpen,
  Loader2,
  PanelBottomClose,
  PanelBottomOpen,
  Pencil,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Hint } from '@/components/ui/tooltip'
import { useLibrary } from '@/state/library'
import { useVideos } from '@/state/videos'
import { VideoStage, stageState, subscribeStage } from '@/lib/video/stage'
import { Stage } from '@/components/videos/Stage'
import { LayerList, ProjectFields } from '@/components/videos/Inspector'
import { Recorder } from '@/components/videos/Recorder'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { formatDateTime, formatSize, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  projectDuration,
  type VideoProject
} from '@shared/video'

const SECTIONS = [
  { id: 'record', label: 'Record' },
  { id: 'projects', label: 'Videos' },
  { id: 'settings', label: 'Settings' }
] as const

/**
 * The videos page.
 *
 * Two states rather than two pages: a list of what you have made, and the editor. They share
 * the route because a project is not somewhere you navigate to, it is the thing this page is
 * about - and the editor holds a live `VideoStage` with decoded audio and playing video
 * elements, which a route change would throw away every time somebody looked at the list.
 */
export function VideosPage(): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const load = useVideos((s) => s.load)
  const loaded = useVideos((s) => s.loaded)

  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  return project ? <Editor /> : <Browser />
}

/* --- the list ---------------------------------------------------------------------- */

function Browser(): React.JSX.Element {
  const data = useVideos((s) => s.data)
  const newProject = useVideos((s) => s.newProject)
  const chooseOutputDir = useVideos((s) => s.chooseOutputDir)
  const setView = useLibrary((s) => s.setView)
  const lastFolderDir = useLibrary((s) => s.lastFolderDir)
  const [active, setActive] = useState<string>('record')

  const show = (id: string): string => (active === id ? 'block' : 'hidden')

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="scroll-thin w-[168px] shrink-0 overflow-y-auto border-r bg-card/30 py-2">
        <div className="flex items-center gap-1 px-3 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Videos
          </span>
          <Hint label="Close" side="right">
            <button
              type="button"
              aria-label="Close videos"
              onClick={() => setView({ mode: 'folder', dir: lastFolderDir })}
              className="ml-auto flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </Hint>
        </div>
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActive(section.id)}
            className={cn(
              'flex w-full items-center px-3 py-1.5 text-left text-[12.5px] transition-colors',
              active === section.id
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <div className={cn('mx-auto max-w-[720px] space-y-3', show('projects'))}>
          <section className="rounded-md border bg-card/40">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <div>
                <h2 className="text-[12.5px] font-semibold">Your videos</h2>
                <p className="text-[11px] text-muted-foreground">
                  A reel is a beat, a frame and a few layers. Right-click a track in the
                  explorer to start one from it.
                </p>
              </div>
              <Button size="sm" className="ml-auto" onClick={() => newProject()}>
                <Plus className="h-3 w-3" /> New
              </Button>
            </header>
            <div>
              {(data?.projects ?? []).length === 0 && (
                <p className="px-3 py-3 text-[11.5px] text-muted-foreground">
                  Nothing yet.
                </p>
              )}
              {(data?.projects ?? []).map((entry) => (
                <ProjectRow key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        </div>

        <div className={cn('mx-auto max-w-[720px] space-y-3', show('record'))}>
          <Recorder />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-3', show('settings'))}>
          <section className="rounded-md border bg-card/40">
            <header className="border-b px-3 py-2">
              <h2 className="text-[12.5px] font-semibold">Output</h2>
              <p className="text-[11px] text-muted-foreground">
                Finished videos land here, and takes in a `recordings` folder inside it.
              </p>
            </header>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {data?.outputDir || '…'}
              </span>
              <Button variant="outline" size="sm" onClick={() => void chooseOutputDir()}>
                <FolderOpen className="h-3 w-3" /> Change
              </Button>
              {data?.outputDir && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.umakbang.reveal(data.outputDir)}
                >
                  Open
                </Button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function ProjectRow({ entry }: { entry: VideoProject }): React.JSX.Element {
  const open = useVideos((s) => s.open)
  const remove = useVideos((s) => s.remove)
  const renameProject = useVideos((s) => s.renameProject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.name)

  const cancel = (): void => {
    setDraft(entry.name)
    setEditing(false)
  }
  const commit = (): void => {
    const next = draft.trim()
    if (!next) {
      cancel()
      return
    }
    setEditing(false)
    if (next !== entry.name) void renameProject(entry.id, next)
  }

  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5">
      <Clapperboard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {editing ? (
        <Input
          autoFocus
          value={draft}
          aria-label="Video name"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') cancel()
          }}
          className="h-6 min-w-0 flex-1"
        />
      ) : (
        <button
          type="button"
          onClick={() => open(entry.id)}
          className="min-w-0 flex-1 truncate text-left text-[12.5px] hover:underline"
        >
          {entry.name}
        </button>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {entry.aspect} · {formatTime(projectDuration(entry))} · {entry.layers.length}{' '}
        {entry.layers.length === 1 ? 'layer' : 'layers'}
      </span>
      {editing ? (
        <>
          <Button variant="ghost" size="icon-sm" aria-label="Save video name" onClick={commit}>
            <Check className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Cancel rename" onClick={cancel}>
            <X className="h-3 w-3" />
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Rename this video"
            onClick={() => {
              setDraft(entry.name)
              setEditing(true)
            }}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete this project"
            onClick={() => void remove(entry.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </>
      )}
    </div>
  )
}

/* --- the editor -------------------------------------------------------------------- */

/**
 * Export is deliberately not among these.
 *
 * It is the one thing in the editor that is not an edit: everything else here changes what
 * the frame looks like and is watched while it is changed, where export is a decision you
 * make once and then wait on. As a third of a 330px side panel it also had to fold the
 * quality picker, the progress bar and the whole history of past renders into a column
 * narrower than the file paths it was listing.
 */
const TABS = [
  { id: 'layers', label: 'Layers' },
  { id: 'project', label: 'Frame' }
] as const

function Editor(): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const close = useVideos((s) => s.close)
  const selectedIds = useVideos((s) => s.selectedIds)
  const inspecting = useVideos((s) => s.inspecting)
  const [tab, setTab] = useState<string>('layers')
  const [pendingDelete, setPendingDelete] = useState<string[]>([])
  const [panelWidth, setPanelWidth] = useState(330)
  const [exportOpen, setExportOpen] = useState(false)

  // One stage for the life of the editor. Rebuilding it per render would re-decode the track
  // and reload every video element, which is seconds of work and a black frame each time.
  const stageRef = useRef<VideoStage | null>(null)
  if (!stageRef.current) stageRef.current = new VideoStage()
  const stage = stageRef.current

  useEffect(() => () => stage.dispose(), [stage])

  // Every edit is handed to the stage, which reconciles: a source that is already loaded
  // under the same path is left playing.
  useEffect(() => {
    if (project) void stage.setProject(project)
  }, [project, stage])

  useEffect(() => {
    if (project) stage.refreshAudioLevels(project)
  }, [project, stage])

  useEffect(() => {
    if (inspecting) setTab('layers')
  }, [inspecting])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return
      if (selectedIds.length === 0) return
      event.preventDefault()
      setPendingDelete(selectedIds)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedIds])

  function beginPanelResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelWidth
    const move = (pointer: PointerEvent): void => {
      const max = Math.max(330, Math.min(620, window.innerWidth * 0.55))
      setPanelWidth(Math.max(260, Math.min(max, startWidth + startX - pointer.clientX)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!project) return <></>

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <Button variant="ghost" size="sm" onClick={close}>
            <ArrowLeft className="h-3 w-3" /> All videos
          </Button>
          <EditorVideoName project={project} />
          <SaveState />
          <PlayerToggle />
          {/* The way out of the editor, next to the other thing you do when you have
              finished: it sits at the end of the header rather than in the panel, because
              it is the one control here that is about the file rather than the frame. */}
          <ExportButton onOpen={() => setExportOpen(true)} />
        </div>
        <Stage stage={stage} onRequestRemove={(id) => setPendingDelete([id])} />
      </div>

      <div
        className="relative flex shrink-0 flex-col border-l bg-card/30"
        style={{ width: panelWidth }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize settings panel"
          onPointerDown={beginPanelResize}
          className="absolute inset-y-0 -left-1 z-30 w-2 cursor-ew-resize"
        />
        <div className="flex shrink-0 border-b">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={cn(
                'flex-1 px-2 py-1.5 text-[12px] transition-colors',
                tab === entry.id
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {tab === 'layers' && <LayerList onRequestRemove={(id) => setPendingDelete([id])} />}
          {tab === 'project' && <ProjectFields />}
        </div>
      </div>

      <ExportDialog stage={stage} open={exportOpen} onOpenChange={setExportOpen} />

      {pendingDelete.length > 0 && (
        <ConfirmDialog
          title={pendingDelete.length === 1 ? 'Remove this layer?' : 'Remove ' + pendingDelete.length + ' layers?'}
          description={pendingDelete.length === 1
            ? '"' + (project.layers.find((layer) => layer.id === pendingDelete[0])?.name ?? 'This layer') + '" will be removed from the project and timeline.'
            : 'The selected layers will be removed from the project and timeline.'}
          confirmLabel={pendingDelete.length === 1 ? 'Remove layer' : 'Remove layers'}
          destructive
          onConfirm={() => {
            for (const id of pendingDelete) useVideos.getState().removeLayer(id)
            setPendingDelete([])
          }}
          onClose={() => setPendingDelete([])}
        />
      )}
    </div>
  )
}


function EditorVideoName({ project }: { project: VideoProject }): React.JSX.Element {
  const renameProject = useVideos((s) => s.renameProject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)

  const cancel = (): void => {
    setDraft(project.name)
    setEditing(false)
  }
  const commit = (): void => {
    const next = draft.trim()
    if (!next) {
      cancel()
      return
    }
    setEditing(false)
    if (next !== project.name) void renameProject(project.id, next)
  }

  if (editing) {
    return (
      <div className="flex min-w-0 max-w-[360px] flex-1 items-center gap-1">
        <Input
          autoFocus
          value={draft}
          aria-label="Video name"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') cancel()
          }}
          className="h-6 min-w-0"
        />
        <Button variant="ghost" size="icon-sm" aria-label="Save video name" onClick={commit}>
          <Check className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Cancel rename" onClick={cancel}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate text-[12.5px] font-medium">{project.name}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rename this video"
        onClick={() => {
          setDraft(project.name)
          setEditing(true)
        }}
      >
        <Pencil className="h-3 w-3" />
      </Button>
    </div>
  )
}

/** Says whether what is on screen has reached disk, without a Save button to press. */
function SaveState(): React.JSX.Element {
  const dirty = useVideos((s) => s.dirty)
  return (
    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
      {dirty ? 'Saving…' : 'Saved'}
    </span>
  )
}

/**
 * Puts the app's own transport and visualizer panel back while editing.
 *
 * They are folded away when a project opens - see `hideChrome` in `App.tsx` - because the
 * editor has its own transport and the frame wants the width. This is the way back to them,
 * for auditioning something in the library without leaving the project.
 */
function PlayerToggle(): React.JSX.Element {
  const open = useVideos((s) => s.chromeOpen)
  const setOpen = useVideos((s) => s.setChromeOpen)
  return (
    <Hint label={open ? 'Hide the library player' : 'Show the library player'} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={open ? 'Hide the library player' : 'Show the library player'}
        onClick={() => setOpen(!open)}
      >
        {open ? <PanelBottomClose className="h-3.5 w-3.5" /> : <PanelBottomOpen className="h-3.5 w-3.5" />}
      </Button>
    </Hint>
  )
}

/* --- export ------------------------------------------------------------------------ */

const BITRATES = [
  { value: 8_000_000, label: 'Good (8 Mbps)' },
  { value: 12_000_000, label: 'High (12 Mbps)' },
  { value: 20_000_000, label: 'Very high (20 Mbps)' }
]

/**
 * The header button, which also has to be the one place that says an export is running.
 *
 * The dialog can be closed while a render carries on - it is minutes of work on a long
 * project, and trapping the user in a modal to watch a progress bar is the reason people
 * alt-tab away and lose track of it. So the button carries the percentage when the dialog
 * is shut, and pressing it puts the dialog back.
 */
function ExportButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const live = useSyncExternalStore(subscribeStage, stageState)
  const running = live.exporting

  return (
    <Button
      variant={running ? 'secondary' : 'default'}
      size="sm"
      className="ml-auto"
      onClick={onOpen}
    >
      {running ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Rendering {Math.round(running.progress * 100)}%
        </>
      ) : (
        <>
          <Download className="h-3 w-3" /> Export
        </>
      )}
    </Button>
  )
}

function ExportDialog({
  stage,
  open,
  onOpenChange
}: {
  stage: VideoStage
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const project = useVideos((s) => s.project)
  const save = useVideos((s) => s.save)
  const recordExport = useVideos((s) => s.recordExport)
  const notify = useLibrary((s) => s.notify)
  const live = useSyncExternalStore(subscribeStage, stageState)
  const [bitrate, setBitrate] = useState(12_000_000)
  /** Wall clock of the last run, so what it costs is measured rather than promised. */
  const [took, setTook] = useState(0)

  if (!project) return <></>
  const container = VideoStage.container()
  const duration = projectDuration(project)
  const exports = project.exports ?? []
  const hasMedia = project.layers.some((layer) => layer.kind === 'audio' || layer.kind === 'video')

  async function run(): Promise<void> {
    await save()
    // A local, not state: `setBegan(...)` then reading `began` in the same closure reads the
    // value from *before* the render, which is zero on the first run - so the elapsed time
    // came out as however long the window had been open. It reported 22 seconds for a render
    // that took one and a half.
    const startedAt = performance.now()
    setTook(0)
    const result = await stage.renderVideo(bitrate)
    const elapsed = performance.now() - startedAt
    // Stopping it was the user's own doing and needs no notice.
    if (result.cancelled) return
    if (result.error) {
      notify(result.error, 'error')
      return
    }
    if (!result.path) {
      notify('The export finished but did not return a file location.', 'error')
      return
    }
    setTook(elapsed)
    await recordExport(result.path)
    notify(`Video written to ${result.path}.`)
  }

  const progress = live.exporting

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-[760px]">
        <header className="border-b px-4 py-3">
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>
            {project.aspect} at {project.fps}fps, {formatTime(duration)},{' '}
            {container.ext.slice(1).toUpperCase()}.{' '}
            {container.ext === '.mp4'
              ? 'H.264 and AAC, which is what Instagram and TikTok take.'
              : 'This build has no MP4 encoder, so it writes WebM. Most platforms refuse that; convert it before posting.'}
          </DialogDescription>
        </header>

        <div className="grid gap-4 px-4 py-3 sm:grid-cols-[1fr_320px]">
          <section className="min-w-0 space-y-3">
            <label className="block">
              <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
                Quality
              </span>
              <select
                value={bitrate}
                disabled={Boolean(progress)}
                onChange={(event) => setBitrate(Number(event.target.value))}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {BITRATES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>

            {progress ? (
              <div className="space-y-2 rounded-md border bg-card/50 p-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-200"
                    style={{ width: `${Math.round(progress.progress * 100)}%` }}
                  />
                </div>
                <p className="text-[11.5px] tabular-nums text-muted-foreground">
                  {Math.round(progress.progress * 100)}% · {formatSize(progress.bytes)} written
                </p>
                <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={progress.path}>
                  {progress.path}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => stage.cancelExport()}>
                    Stop
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                    Leave it running
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Button className="w-full" disabled={!hasMedia} onClick={() => void run()}>
                  <Download className="h-3.5 w-3.5" /> Render {formatTime(duration)}
                </Button>
                {!hasMedia && (
                  <p className="text-[11px] text-muted-foreground">
                    Add an audio or video layer first - there is nothing to render yet.
                  </p>
                )}
                {took > 0 && (
                  <p className="text-[11px] text-primary">
                    {/* Seconds with a decimal below a minute. A render that beat real time by
                        4x rounded to "0:01" says nothing about how much faster it now is. */}
                    Last render took{' '}
                    {took < 60_000
                      ? `${(took / 1000).toFixed(1)}s`
                      : formatTime(Math.round(took / 1000))}{' '}
                    for {formatTime(duration)} of video.
                  </p>
                )}
              </div>
            )}

            {/* Said out loud rather than discovered, the way the old real-time note was.
                What it says has changed: the render is no longer paced by the clock, so how
                long it takes is a property of the machine and of what is in the project. */}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Rendered as fast as this machine can draw and encode it, not by playing it
              through, and silently - nothing comes out of the speakers. A beat over
              visualizers goes many times faster than real time; a project built on video
              layers is paced by seeking them, so it takes longer.
            </p>
          </section>

          <section className="min-w-0 border-t pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                Project exports
              </span>
              <span className="text-[10.5px] tabular-nums text-muted-foreground/60">
                {exports.length}
              </span>
            </div>
            {exports.length === 0 ? (
              <p className="rounded-md border border-dashed px-2 py-6 text-center text-[11px] text-muted-foreground">
                Exports from this project will appear here.
              </p>
            ) : (
              <div className="scroll-thin max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
                {exports.map((entry) => (
                  <div key={entry.id} className="rounded-md border px-2 py-1.5">
                    <p className="truncate text-[11.5px] font-medium" title={entry.name}>
                      {entry.name}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </p>
                    <p
                      className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70"
                      title={entry.path}
                    >
                      {entry.path}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1.5 w-full"
                      onClick={() => void window.umakbang.reveal(entry.path)}
                    >
                      <FolderOpen className="h-3 w-3" /> Open file location
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
