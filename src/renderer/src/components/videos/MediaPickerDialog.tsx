import { useMemo, useState } from 'react'
import { FileAudio, FolderOpen, Search, Video } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLibrary } from '@/state/library'
import { useVideos } from '@/state/videos'
import { matchesQuery, parseQuery, scoreMatch } from '@/lib/search'
import type { Track } from '@shared/types'

const RESULT_LIMIT = 100

function durationLabel(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return minutes + ':' + String(remainder).padStart(2, '0')
}

export function MediaPickerDialog({
  kind,
  open,
  onOpenChange,
  onPick
}: {
  kind: 'audio' | 'video'
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const recordings = useVideos((state) => state.data?.recordings ?? [])
  const tracks = useLibrary((state) => state.tracks)
  const revision = useLibrary((state) => state.revision)
  const ratings = useLibrary((state) => state.ratings)
  const tags = useLibrary((state) => state.tags)

  const audioResults = useMemo(() => {
    if (kind !== 'audio') return []
    const parsed = parseQuery(query)
    const context = { ratings, tags }
    const results: Track[] = []

    for (const track of tracks) {
      if (track.kind !== 'audio' || !matchesQuery(track, parsed, context)) continue
      results.push(track)
      if (parsed.terms.length === 0 && results.length >= RESULT_LIMIT) break
    }
    if (parsed.terms.length > 0) {
      results.sort((left, right) => scoreMatch(right, parsed) - scoreMatch(left, parsed))
    }
    return results.slice(0, RESULT_LIMIT)
  }, [kind, query, ratings, revision, tags, tracks])

  function choose(path: string): void {
    onPick(path)
    onOpenChange(false)
    setQuery('')
  }

  async function browse(): Promise<void> {
    const path = await window.umakbang.pickMedia(kind)
    if (path) choose(path)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setQuery('')
      }}
    >
      <DialogContent aria-describedby={undefined} className="max-w-[620px]">
        <header className="border-b px-4 py-3">
          <DialogTitle>{kind === 'video' ? 'Add video' : 'Add audio'}</DialogTitle>
          <DialogDescription>
            {kind === 'video'
              ? 'Choose a take recorded in umakbang, or browse for another video.'
              : 'Search your audio library, or browse for a file outside it.'}
          </DialogDescription>
        </header>

        {kind === 'audio' && (
          <div className="border-b px-3 py-2">
            <label className="flex items-center gap-2 rounded-md border bg-background px-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name, path, BPM, key, tag…"
                className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
              />
            </label>
          </div>
        )}

        <div className="scroll-thin max-h-[430px] min-h-[180px] overflow-y-auto">
          {kind === 'video' ? (
            recordings.length > 0 ? (
              recordings.map((recording) => (
                <button
                  key={recording.id}
                  type="button"
                  onClick={() => choose(recording.path)}
                  className="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-accent"
                >
                  <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">
                      {recording.name}
                    </span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">
                      {recording.sourceName}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {durationLabel(recording.durationMs / 1000)}
                  </span>
                </button>
              ))
            ) : (
              <div className="flex min-h-[180px] items-center justify-center px-5 text-center text-[11.5px] text-muted-foreground">
                No umakbang recordings yet. Record a take, or browse for an existing video.
              </div>
            )
          ) : audioResults.length > 0 ? (
            audioResults.map((track) => (
              <button
                key={track.path}
                type="button"
                onClick={() => choose(track.path)}
                className="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-accent"
              >
                <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{track.name}</span>
                  <span className="block truncate text-[10.5px] text-muted-foreground">
                    {track.relDir || track.dir}
                  </span>
                </span>
                {track.duration !== undefined && (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {durationLabel(track.duration)}
                  </span>
                )}
              </button>
            ))
          ) : (
            <div className="flex min-h-[180px] items-center justify-center px-5 text-center text-[11.5px] text-muted-foreground">
              {tracks.length === 0
                ? 'Your audio library is empty. Browse for an audio file instead.'
                : 'No audio matches that search.'}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t px-3 py-2">
          <span className="text-[10.5px] text-muted-foreground">
            {kind === 'video'
              ? recordings.length + ' recording' + (recordings.length === 1 ? '' : 's')
              : audioResults.length + (audioResults.length === RESULT_LIMIT ? '+' : '') +
                ' result' + (audioResults.length === 1 ? '' : 's')}
          </span>
          <Button variant="subtle" onClick={() => void browse()}>
            <FolderOpen className="h-3.5 w-3.5" />
            Browse files
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
