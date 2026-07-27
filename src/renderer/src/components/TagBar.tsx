import type React from 'react'
import { Hash, X } from 'lucide-react'
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
export function TagBar(): React.JSX.Element {
  const tags = useAllTags()
  const tagFilter = useLibrary((s) => s.tagFilter)
  const toggleTagFilter = useLibrary((s) => s.toggleTagFilter)
  const clearTagFilter = useLibrary((s) => s.clearTagFilter)

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

      {tags.length === 0 ? (
        <p className="px-1 pb-0.5 text-[11px] leading-snug text-muted-foreground/60">
          No tags yet - select files and press <kbd className="font-sans font-medium">T</kbd> to
          add one.
        </p>
      ) : (
        // Capped and scrollable: a library can accumulate a lot of tags, and this strip
        // must never grow enough to squeeze the transport off the bottom.
        <div className="scroll-thin flex max-h-[92px] flex-wrap gap-1 overflow-y-auto">
          {tags.map(({ tag, count }) => {
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
