import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type FlPlugin = Awaited<ReturnType<typeof window.umakbang.flCatalog>>['plugins'][number]

/**
 * FL's plugin database, as the two lists it actually is.
 *
 * The database is a scan and a favourites tree, and every plugin is in one side or the
 * other - so the shape of the thing is two columns and a pair of arrows, not a list with a
 * star on each row. Moving between them is what this is for, and with a thousand plugins it
 * needs the room.
 *
 * The search and the format chips sit above both, because narrowing is how anybody finds
 * the twenty they meant, and narrowing one side only would hide half the answer.
 */
export function FlPluginsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [catalog, setCatalog] = useState<FlPlugin[] | null>(null)
  const [from, setFrom] = useState('')
  const [missing, setMissing] = useState(false)
  const [query, setQuery] = useState('')
  const [formats, setFormats] = useState<Set<string>>(() => new Set())
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** Per side, so a shift-range in one column cannot reach into the other. */
  const anchors = useRef<{ favourite: number | null; other: number | null }>({
    favourite: null,
    other: null
  })

  const load = useCallback(async () => {
    const result = await window.umakbang.flCatalog()
    setCatalog(result.plugins)
    setFrom(result.from)
    setMissing(Boolean(result.missing))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog ?? []).filter((plugin) => {
      // Any format matches: a plugin FL scanned as both VST3 and AU belongs in both chips.
      if (formats.size > 0 && !plugin.formats.some((format) => formats.has(format))) return false
      return !needle || plugin.name.toLowerCase().includes(needle)
    })
  }, [catalog, query, formats])

  const favourites = useMemo(() => matching.filter((p) => p.favourite), [matching])
  const others = useMemo(() => matching.filter((p) => !p.favourite), [matching])

  /** Formats present, commonest first. Read off the catalogue - they differ per machine. */
  const formatCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const plugin of catalog ?? [])
      for (const format of plugin.formats) counts.set(format, (counts.get(format) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [catalog])

  const apply = useCallback(
    async (names: string[], wanted: boolean) => {
      if (names.length === 0) return
      setBusy(true)
      try {
        const result = await window.umakbang.flSetFavourites(names, wanted)
        setNote(
          result.failures.length > 0
            ? result.failures[0]
            : `${wanted ? 'Favourited' : 'Unfavourited'} ${result.changed}.`
        )
        await load()
        // Those rows have crossed to the other column; a selection about where they were is
        // worse than none.
        setPicked(new Set())
      } finally {
        setBusy(false)
      }
    },
    [load]
  )

  const pickedIn = useCallback(
    (list: FlPlugin[]) => list.filter((plugin) => picked.has(plugin.name)).map((p) => p.name),
    [picked]
  )

  if (missing) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-[520px] p-4">
          <DialogTitle className="text-[15px]">FL plugins</DialogTitle>
          <DialogDescription asChild>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Nothing at {from}. Point the plugin database folder at FL&apos;s before managing
              anything.
            </p>
          </DialogDescription>
        </DialogContent>
      </Dialog>
    )
  }

  const toFavourite = pickedIn(others)
  const toRemove = pickedIn(favourites)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-[1000px] flex-col p-4">
        <DialogTitle className="text-[15px]">FL plugins</DialogTitle>
        <DialogDescription asChild>
          <p className="text-[11.5px] text-muted-foreground">
            A favourite is what appears when you add a plugin to a channel. FL adds them one at
            a time; this does not.
          </p>
        </DialogDescription>

        <div className="mt-2 flex items-center gap-1.5">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${catalog?.length ?? 0} plugins`}
            className="h-7 text-[12px]"
          />
        </div>

        {formatCounts.length > 1 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {formatCounts.map(([format, count]) => {
              const on = formats.has(format)
              return (
                <button
                  key={format}
                  type="button"
                  onClick={() =>
                    setFormats((current) => {
                      const next = new Set(current)
                      if (next.has(format)) next.delete(format)
                      else next.add(format)
                      return next
                    })
                  }
                  className={cn(
                    'rounded border px-1.5 py-px text-[10.5px]',
                    on
                      ? 'border-primary/30 bg-primary/15 text-primary'
                      : 'border-border/60 text-muted-foreground hover:bg-secondary/60'
                  )}
                >
                  {format}
                  <span className="tnum pl-1 text-muted-foreground/50">{count}</span>
                </button>
              )
            })}
            {formats.size > 0 && (
              <button
                type="button"
                onClick={() => setFormats(new Set())}
                className="px-1 text-[10.5px] text-muted-foreground/60 hover:text-foreground"
              >
                clear
              </button>
            )}
          </div>
        )}

        <div className="mt-2 flex min-h-0 flex-1 gap-2">
          <PluginPane
            title="Not favourites"
            plugins={others}
            picked={picked}
            busy={busy}
            onPick={(index, extend) =>
              setPicked((current) => range(current, others, index, extend, anchors.current, 'other'))
            }
            onSelectAll={() =>
              setPicked((current) => {
                const next = new Set(current)
                const all = others.every((plugin) => next.has(plugin.name))
                for (const plugin of others) {
                  if (all) next.delete(plugin.name)
                  else next.add(plugin.name)
                }
                return next
              })
            }
          />

          {/* The arrows are the whole interaction: what is picked, moved across. */}
          <div className="flex shrink-0 flex-col items-center justify-center gap-1.5">
            <Button
              size="sm"
              disabled={busy || toFavourite.length === 0}
              onClick={() => void apply(toFavourite, true)}
              className="gap-1"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {toFavourite.length || ''}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || toRemove.length === 0}
              onClick={() => void apply(toRemove, false)}
              className="gap-1"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {toRemove.length || ''}
            </Button>
          </div>

          <PluginPane
            title="Favourites"
            plugins={favourites}
            picked={picked}
            busy={busy}
            onPick={(index, extend) =>
              setPicked((current) =>
                range(current, favourites, index, extend, anchors.current, 'favourite')
              )
            }
            onSelectAll={() =>
              setPicked((current) => {
                const next = new Set(current)
                const all = favourites.every((plugin) => next.has(plugin.name))
                for (const plugin of favourites) {
                  if (all) next.delete(plugin.name)
                  else next.add(plugin.name)
                }
                return next
              })
            }
          />
        </div>

        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/70">
            {note ?? `${(catalog ?? []).filter((p) => p.favourite).length} favourites of ${catalog?.length ?? 0}`}
          </span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Extends a selection within one column.
 *
 * The run takes its lead from the row that started it, so dragging across a mixed stretch
 * turns them all on rather than flipping each one - which is the thing that makes a range
 * feel broken.
 */
function range(
  current: Set<string>,
  list: FlPlugin[],
  index: number,
  extend: boolean,
  anchors: { favourite: number | null; other: number | null },
  side: 'favourite' | 'other'
): Set<string> {
  const next = new Set(current)
  const from = extend && anchors[side] !== null ? (anchors[side] as number) : index
  const [lo, hi] = from <= index ? [from, index] : [index, from]
  const turningOn = !current.has(list[from]?.name ?? '')
  for (const plugin of list.slice(lo, hi + 1)) {
    if (turningOn) next.add(plugin.name)
    else next.delete(plugin.name)
  }
  anchors[side] = index
  return next
}

function PluginPane({
  title,
  plugins,
  picked,
  busy,
  onPick,
  onSelectAll
}: {
  title: string
  plugins: FlPlugin[]
  picked: Set<string>
  busy: boolean
  onPick: (index: number, extend: boolean) => void
  onSelectAll: () => void
}): React.JSX.Element {
  const chosen = plugins.filter((plugin) => picked.has(plugin.name)).length
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border bg-card/40">
      <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-1">
        <span className="text-[11px] font-medium">{title}</span>
        <span className="tnum text-[10.5px] text-muted-foreground/60">
          {plugins.length.toLocaleString()}
          {chosen > 0 ? ` · ${chosen} picked` : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10.5px]"
          disabled={busy || plugins.length === 0}
          onClick={onSelectAll}
        >
          Select all
        </Button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {plugins.length === 0 ? (
          <p className="px-2.5 py-2 text-[11px] text-muted-foreground/50">Nothing here.</p>
        ) : (
          plugins.map((plugin, index) => {
            const on = picked.has(plugin.name)
            return (
              <div
                key={`${plugin.kind}-${plugin.name}`}
                onClick={(event) => onPick(index, event.shiftKey)}
                className={cn(
                  'flex cursor-default select-none items-center gap-2 px-2.5 py-1 text-[11.5px]',
                  on ? 'bg-primary/15' : 'hover:bg-secondary/60'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-3 w-3 shrink-0 rounded-[3px] border',
                    on ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                  )}
                />
                <span className="truncate">{plugin.name}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/50">
                  {plugin.formats.join(' + ')}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
