import type React from 'react'
import { useEffect, useState } from 'react'
import { Loader2, Split, Upload } from 'lucide-react'
import type { Track } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useLibrary } from '@/state/library'
import { baseName } from '@/lib/paths'
import { formatDuration } from '@/lib/format'

/**
 * The last check before audio leaves the machine.
 *
 * Everything else umakbang does happens on your own disk. This one uploads the file to a
 * service that bills by the audio minute, so it says what is going, how long it is, what
 * the account has left, and where the result will land - and then waits to be told yes.
 * An action with a price should never be one click from a right-click.
 */
export function StemDialog({
  tracks,
  onClose
}: {
  tracks: Track[]
  onClose: () => void
}): React.JSX.Element {
  const key = useLibrary((s) => s.settings.lalalKey)
  const outputDir = useLibrary((s) => s.settings.stemOutputDir)
  const format = useLibrary((s) => s.settings.stemFormat)
  const splitStems = useLibrary((s) => s.splitStems)
  const job = useLibrary((s) => s.stemJob)
  const setView = useLibrary((s) => s.setView)

  const [minutesLeft, setMinutesLeft] = useState<number | null | undefined>(undefined)

  // How much the account has, asked once when the dialog opens. Undefined means "still
  // asking", null means the service wouldn't say - neither is a reason to block.
  useEffect(() => {
    if (!key.trim()) return
    let cancelled = false
    void window.umakbang.stemMinutesLeft(key).then((value) => {
      if (!cancelled) setMinutesLeft(value)
    })
    return () => {
      cancelled = true
    }
  }, [key])

  const known = tracks.filter((track) => track.duration !== undefined)
  const seconds = known.reduce((total, track) => total + (track.duration ?? 0), 0)
  const minutes = seconds / 60
  const unknown = tracks.length - known.length

  const configured = key.trim().length > 0 && outputDir.trim().length > 0
  // Only blocks a second run; the first one is not waited on.
  const running = job !== null
  const short = minutesLeft !== undefined && minutesLeft !== null && minutesLeft < minutes

  return (
    // Closable even while a job runs: `running` only blocks a second submission. A dialog
    // opened during someone else's minutes-long job must not trap the user until LALAL's
    // queue clears.
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-[440px]">
        <header className="border-b px-4 py-3">
          <DialogTitle>Split vocals</DialogTitle>
          <DialogDescription>
            {tracks.length === 1 ? tracks[0].name : `${tracks.length} files`} will be uploaded to
            LALAL.AI.
          </DialogDescription>
        </header>

        <div className="space-y-2.5 px-4 py-3 text-[12px]">
          {!configured ? (
            <p className="text-muted-foreground">
              Set your LALAL.AI key and an output folder in Settings first.
            </p>
          ) : (
            <>
              <Line label="Audio to process">
                {minutes < 1 ? '<1 minute' : `${minutes.toFixed(1)} minutes`}
                {unknown > 0 && (
                  <span className="text-muted-foreground/60">
                    {' '}
                    (+{unknown} of unknown length)
                  </span>
                )}
              </Line>
              <Line label="Minutes on account">
                {minutesLeft === undefined
                  ? 'checking…'
                  : minutesLeft === null
                    ? 'could not be read'
                    : minutesLeft.toFixed(1)}
              </Line>
              <Line label="Stems written to">
                <span className="truncate" title={outputDir}>
                  {baseName(outputDir)}
                  <span className="text-muted-foreground/60">
                    {tracks.length === 1 ? ` / ${baseName(tracks[0].name)}` : ' / one folder each'}
                  </span>
                </span>
              </Line>
              <Line label="Format">{format.toUpperCase()}</Line>

              {short && (
                <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                  That is more audio than the account has minutes for. The service will
                  refuse whatever it can't cover.
                </p>
              )}

              {tracks.length > 1 && (
                <ul className="scroll-thin max-h-[110px] overflow-y-auto rounded border bg-card/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                  {tracks.map((track) => (
                    <li key={track.path} className="flex justify-between gap-2 truncate">
                      <span className="truncate">{track.name}</span>
                      <span className="tnum shrink-0">{formatDuration(track.duration)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {running && job && (
            <div className="space-y-1 rounded border bg-card/40 px-2 py-2">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="truncate">{baseName(job.path)}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {job.done}/{job.total}
                </span>
              </div>
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
                {job.phase}
                {job.percent !== undefined ? ` · ${Math.round(job.percent)}%` : ''}
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-1.5 border-t px-4 py-2.5">
          {!configured && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onClose()
                setView({ mode: 'settings' })
              }}
            >
              Open settings
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {running ? 'Close' : 'Cancel'}
          </Button>
          <Button
            size="sm"
            disabled={!configured || running}
            onClick={() => {
              // Deliberately not awaited: splitting a five-minute track is minutes of
              // somebody else's queue, and a modal sitting over the library for that long
              // makes the app unusable for the thing you were doing anyway. The toolbar
              // carries the spinner from here.
              void splitStems(tracks)
              onClose()
            }}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload and split
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function Line({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

/** The icon the menu uses, re-exported so the action and the dialog agree. */
export const StemIcon = Split
