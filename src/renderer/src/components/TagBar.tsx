import type React from 'react'
import { useMemo, useState } from 'react'
import { Hash, Search, X } from 'lucide-react'
import { useLibrary } from '@/state/library'
import { useAllTags } from '@/hooks/useLibraryView'
import { cn } from '@/lib/utils'

/**
 * Every tag in the library, as a row of chips, sat between the saved views and the folder
 * tree.
 *
 * They started at the very bottom of the sidebar, under the whole tree - far enough down a
 * real library that they may as well not have existed. Up here they sit with the other
 * ways of choosing what to look at, and are reached without scrolling past a few thousand
 * folders. Clicking one narrows whatever you're already looking at rather than throwing
 * you into a separate list: the folder you're browsing, minus everything not tagged that
 * way.
 */
/**
 * Above how many tags a search field is worth the two lines it costs.
 *
 * Below this the whole set is on screen already and a box to narrow seven chips is furniture.
 * The strip caps at 92px, so past roughly this many the ones you want are behind a scroll.
 */
const SEARCH_FROM = 10

export function TagBar({ height }: { height: number }): React.JSX.Element {
  const tags = useAllTags()
  const tagFilter = useLibrary((s) => s.tagFilter)
  const toggleTagFilter = useLibrary((s) => s.toggleTagFilter)
  const clearTagFilter = useLibrary((s) => s.clearTagFilter)
  const [query, setQuery] = useState('')

  const searchable = tags.length >= SEARCH_FROM
  const shown = useMemo(() => {
    const typed = query.trim().toLowerCase()
    if (!typed) return tags
    // Anything already filtering the library stays on screen whether or not it matches, or
    // narrowing the list would hide the chip you need in order to switch that filter off.
    return tags.filter(
      (entry) => entry.tag.toLowerCase().includes(typed) || tagFilter.includes(entry.tag)
    )
  }, [tags, query, tagFilter])

  return (
    <div className="shrink-0 px-2 pt-3">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Tags
        </span>
        {tagFilter.length > 0 && (
          <button
            type="button"
            onClick={clearTagFilter}
            className="flex items-center gap-0.5 rounded px-1 text-[10px] text-primary transition-colors hover:bg-accent"
          >
            <X className="h-2.5 w-2.5" />
            Clear
          </button>
        )}
      </div>

      {searchable && (
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Escape clears rather than closing anything: the strip is always on screen, so
            // there is nothing to dismiss and an empty box is the only "never mind" there is.
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder={`Search ${tags.length} tags`}
            spellCheck={false}
            className="h-[22px] w-full rounded border border-border/60 bg-secondary/40 pl-6 pr-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50 focus-visible:border-primary/60"
          />
        </div>
      )}

      {tags.length === 0 ? (
        <p className="px-1 pb-0.5 text-[11px] leading-snug text-muted-foreground/60">
          No tags yet - select files and press <kbd className="font-sans font-medium">T</kbd> to
          add one.
        </p>
      ) : (
        /* Scrollable, and capped at whatever the sidebar's split is set to rather than at a
           fixed 92px. The cap exists so the strip can never grow enough to squeeze the
           transport off the bottom; who decides where it sits is the user, by dragging the
           divider directly under these chips. */
        <div
          className="scroll-thin flex flex-wrap gap-1 overflow-y-auto"
          style={{ maxHeight: height }}
        >
          {shown.length === 0 && (
            <p className="px-1 text-[11px] text-muted-foreground/60">No tag matches that.</p>
          )}
          {shown.map(({ tag, count }) => {
            const active = tagFilter.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                title={`${count} ${count === 1 ? 'file' : 'files'} tagged ${tag}`}
                aria-pressed={active}
                onClick={() => toggleTagFilter(tag)}
                className={cn(
                  'flex items-center gap-0.5 rounded border px-1.5 py-px text-[11px] transition-colors',
                  active
                    ? 'border-primary bg-primary/20 text-foreground'
                    : 'border-border/60 bg-secondary/50 text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Hash className={cn('h-2.5 w-2.5', active ? 'text-primary' : 'opacity-50')} />
                <span className="max-w-[10rem] truncate">{tag}</span>
                <span className="tnum pl-0.5 text-[10px] text-muted-foreground/60">{count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
