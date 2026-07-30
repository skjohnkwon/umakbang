import type React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Circle, FolderOpen, Monitor, RefreshCw, Square, Trash2, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVideos } from '@/state/videos'
import { useLibrary } from '@/state/library'
import {
  cancel,
  listCaptureSources,
  listDevices,
  recorderState,
  start,
  stop,
  subscribeRecorder
} from '@/lib/video/record'
import { formatSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CaptureSource } from '@shared/video'

const SELECT_CLASS =
  'h-7 w-full rounded-md border border-input bg-background px-1.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-ring'

function elapsedLabel(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * The capture panel.
 *
 * The picker shows thumbnails because a list of window titles cannot be used: a DAW puts the
 * same name on its main window and on every plugin editor it has open, and picking the wrong
 * one is only discovered after the take.
 */
export function Recorder(): React.JSX.Element {
  const data = useVideos((s) => s.data)
  const saveCapture = useVideos((s) => s.saveCapture)
  const addRecordings = useVideos((s) => s.addRecordings)
  const forgetRecording = useVideos((s) => s.forgetRecording)
  const notify = useLibrary((s) => s.notify)
  const isWindows = useLibrary((s) => s.platform?.isWindows ?? false)
  const live = useSyncExternalStore(subscribeRecorder, recorderState)

  const [sources, setSources] = useState<CaptureSource[]>([])
  const [chosen, setChosen] = useState<string>('')
  const [devices, setDevices] = useState<{
    microphones: MediaDeviceInfo[]
    cameras: MediaDeviceInfo[]
  }>({ microphones: [], cameras: [] })
  const [name, setName] = useState('session')
  const [busy, setBusy] = useState(false)

  const capture = data?.capture

  const refresh = async (): Promise<void> => {
    const list = await listCaptureSources()
    setSources(list)
    setChosen((current) => (list.some((entry) => entry.id === current) ? current : (list[0]?.id ?? '')))
  }

  useEffect(() => {
    void refresh()
    void listDevices().then(setDevices)
  }, [])

  if (!capture) return <></>

  const source = sources.find((entry) => entry.id === chosen) ?? null

  async function begin(): Promise<void> {
    if (!source || !capture) return
    setBusy(true)
    const result = await start(source, capture, name.trim() || 'session')
    setBusy(false)
    if (result.error) notify(result.error, 'error')
  }

  async function end(): Promise<void> {
    setBusy(true)
    const made = await stop()
    setBusy(false)
    addRecordings(made)
    if (made.length > 0) {
      notify(
        made.length === 1
          ? `Recorded ${made[0].name}.`
          : `Recorded ${made.length} files, screen and camera.`
      )
    }
  }

  return (
    <div className="space-y-3">
      <section className="rounded-md border bg-card/40">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <h2 className="text-[12.5px] font-semibold">Record your screen</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Look again"
            className="ml-auto"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </header>

        <div className="space-y-2.5 px-3 py-2.5">
          {live.recording ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-2">
              <Circle className="h-2.5 w-2.5 shrink-0 animate-pulse fill-current text-destructive" />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                Recording {live.sourceName}
                {live.camera && ' and the camera'}
              </span>
              <span className="shrink-0 font-mono text-[12px]">{elapsedLabel(live.elapsed)}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatSize(live.bytes)}
              </span>
              <Button size="sm" disabled={busy} onClick={() => void end()}>
                <Square className="h-3 w-3" /> Stop
              </Button>
              {/* Throwing a take away is a separate button from stopping one: they are not
                  the same decision and one of them cannot be taken back. */}
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  cancel()
                  notify('Take discarded.')
                }}
              >
                Discard
              </Button>
            </div>
          ) : (
            <>
              <div className="scroll-thin grid max-h-[260px] grid-cols-3 gap-2 overflow-y-auto">
                {sources.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setChosen(entry.id)}
                    className={cn(
                      'overflow-hidden rounded-md border text-left transition-colors',
                      chosen === entry.id ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent/40'
                    )}
                  >
                    {entry.thumbnail ? (
                      <img src={entry.thumbnail} alt="" className="h-[76px] w-full object-cover" />
                    ) : (
                      <div className="flex h-[76px] items-center justify-center bg-muted/30">
                        <Monitor className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <span className="flex items-center gap-1 px-1.5 py-1">
                      {entry.appIcon && <img src={entry.appIcon} alt="" className="h-3 w-3" />}
                      <span className="truncate text-[11px]" title={entry.name}>
                        {entry.name}
                      </span>
                    </span>
                  </button>
                ))}
                {sources.length === 0 && (
                  <p className="col-span-3 py-3 text-center text-[11.5px] text-muted-foreground">
                    Nothing to capture yet. Open your DAW and look again.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-0.5 block text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
                    Name
                  </span>
                  <Input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
                    Frame rate
                  </span>
                  <select
                    value={capture.fps}
                    onChange={(event) => void saveCapture({ fps: Number(event.target.value) })}
                    className={SELECT_CLASS}
                  >
                    <option value={24}>24</option>
                    <option value={30}>30</option>
                    <option value={60}>60</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
                    Size
                  </span>
                  <select
                    value={capture.maxHeight}
                    onChange={(event) => void saveCapture({ maxHeight: Number(event.target.value) })}
                    className={SELECT_CLASS}
                  >
                    <option value={720}>720p</option>
                    <option value={1080}>1080p</option>
                    <option value={1440}>1440p</option>
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={capture.systemAudio}
                    onChange={(event) => void saveCapture({ systemAudio: event.target.checked })}
                    className="accent-primary"
                    disabled={!isWindows}
                  />
                  What the machine is playing
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={capture.microphone}
                    onChange={(event) => void saveCapture({ microphone: event.target.checked })}
                    className="accent-primary"
                  />
                  Microphone
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={capture.camera}
                    onChange={(event) => void saveCapture({ camera: event.target.checked })}
                    className="accent-primary"
                  />
                  Camera, as a second file
                </label>
              </div>

              {!isWindows && (
                <p className="text-[11px] text-muted-foreground">
                  Recording what the machine is playing is Windows only. Elsewhere the take is
                  silent, and the beat is laid over it from the library anyway.
                </p>
              )}

              {capture.microphone && devices.microphones.length > 0 && (
                <select
                  value={capture.microphoneId}
                  onChange={(event) => void saveCapture({ microphoneId: event.target.value })}
                  className={SELECT_CLASS}
                >
                  <option value="">Default microphone</option>
                  {devices.microphones.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || 'Microphone'}
                    </option>
                  ))}
                </select>
              )}
              {capture.camera && devices.cameras.length > 0 && (
                <select
                  value={capture.cameraId}
                  onChange={(event) => void saveCapture({ cameraId: event.target.value })}
                  className={SELECT_CLASS}
                >
                  <option value="">Default camera</option>
                  {devices.cameras.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || 'Camera'}
                    </option>
                  ))}
                </select>
              )}

              <Button disabled={!source || busy} onClick={() => void begin()}>
                <Circle className="h-3 w-3 fill-current" /> Start recording
              </Button>
              <p className="text-[11px] text-muted-foreground">
                The camera is recorded as its own file rather than burned into the capture, so
                where it sits in the frame is decided afterwards, looking at the beat.
              </p>
            </>
          )}

          {live.error && <p className="text-[11.5px] text-destructive">{live.error}</p>}
        </div>
      </section>

      <section className="rounded-md border bg-card/40">
        <header className="border-b px-3 py-2">
          <h2 className="text-[12.5px] font-semibold">Takes</h2>
          <p className="text-[11px] text-muted-foreground">
            Drop one into a project as a layer, or from a preset.
          </p>
        </header>
        <div className="scroll-thin max-h-[320px] overflow-y-auto">
          {(data?.recordings ?? []).length === 0 && (
            <p className="px-3 py-3 text-[11.5px] text-muted-foreground">Nothing recorded yet.</p>
          )}
          {(data?.recordings ?? []).map((recording) => (
            <div key={recording.id} className="flex items-center gap-2 border-b px-3 py-1.5">
              <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px]" title={recording.path}>
                {recording.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {elapsedLabel(recording.durationMs)} · {formatSize(recording.size)}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show in the file manager"
                onClick={() => void window.umakbang.reveal(recording.path)}
              >
                <FolderOpen className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Forget this take"
                onClick={() => void forgetRecording(recording.id, false)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
