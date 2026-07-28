import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useLibrary } from '@/state/library'
import { claimFocus } from '@/lib/focus'
import { useAllTags } from '@/hooks/useLibraryView'
import { cn } from '@/lib/utils'

/**
 * The tag editor itself, without deciding what it is mounted inside.
 *
 * It appears twice: as a panel hanging off the side of the context menu, and as a popover
 * anchored to a row when the keyboard shortcut opens it. One implementation, because a tag
 * editor that behaves differently depending on how you reached it is two things to learn.
 */
export function TagEditor({
  paths,
  label,
  onClose
}: {
  /** Absolute paths of whatever is being tagged - files, folders, or a mix. */
  paths: string[]
  /** What the heading calls the selection. */
  label: string
  onClose: () => void
}): React.JSX.Element {
  const tagsByPath = useLibrary((s) => s.tags)
  const addTags = useLibrary((s) => s.addTags)
  const removeTag = useLibrary((s) => s.removeTag)
  const allTags = useAllTags()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Claimed as the field attaches, not in an effect: the menu or popover this lives in
  // mounts its content in a portal on a later commit, so there is nothing to focus when an
  // effect would run. See lib/focus.
  const cancelClaim = useRef<(() => void) | null>(null)
  const attachInput = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input
    cancelClaim.current?.()
    cancelClaim.current = claimFocus(input)
  }, [])

  useEffect(() => () => cancelClaim.current?.(), [])

  // Escape commits and closes, from wherever focus happens to be.
  //
  // Relying on the field's own handler was not enough: a Radix submenu keeps focus on its
  // content rather than on the input inside it, so the keystroke never reached the field
  // and a half-typed tag was lost with the menu. A capture-phase listener on the document
  // sees it regardless, and deliberately does not preventDefault - whatever is holding
  // this open still needs the key in order to close.
  const commitRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') commitRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  /** Every tag on any selected entry, with how many of them carry it. */
  const applied = useMemo(() => {
    const counts = new Map<string, number>()
    for (const path of paths) {
      for (const tag of tagsByPath[path] ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag))
  }, [paths, tagsByPath])

  /**
   * Tags in use elsewhere that this selection doesn't already carry in full.
   *
   * Every one of them, not the first handful. The list used to stop at twelve, which on a
   * library with more tags than that meant the ones you were shown were whichever came
   * first alphabetically and the rest may as well not have existed - and a tag you cannot
   * see is a tag you type again slightly differently. The list scrolls rather than growing.
   *
   * Ranked rather than alphabetical: an exact match first, then the ones that start with
   * what you typed, then the ones that merely contain it, and inside each of those the tag
   * on more files first. `useAllTags` sorts by name, which is right for the sidebar - there
   * you are reading a list - and wrong here, where you are aiming at one entry.
   */
  const suggestions = useMemo(() => {
    const already = new Set(applied.filter((entry) => entry.count === paths.length).map((e) => e.tag))
    const typed = draft.trim().toLowerCase()
    const rank = (tag: string): number => {
      const lower = tag.toLowerCase()
      if (!typed) return 3
      if (lower === typed) return 0
      if (lower.startsWith(typed)) return 1
      return 2
    }
    return allTags
      .filter((entry) => !already.has(entry.tag))
      .filter((entry) => !typed || entry.tag.toLowerCase().includes(typed))
      .sort(
        (a, b) =>
          rank(a.tag) - rank(b.tag) || b.count - a.count || a.tag.localeCompare(b.tag)
      )
  }, [allTags, applied, paths.length, draft])

  /**
   * Whether what has been typed would make a new tag rather than pick an existing one.
   *
   * Compared case-insensitively against every tag in the library, not just the ones on
   * screen: typing `Drums` where `drums` exists should offer the one that exists rather
   * than quietly creating a second tag differing by one capital letter.
   */
  const typed = draft.trim()
  const creating =
    typed.length > 0 &&
    !allTags.some((entry) => entry.tag.toLowerCase() === typed.toLowerCase()) &&
    !applied.some((entry) => entry.tag.toLowerCase() === typed.toLowerCase())

  /** What the arrows walk: the create row, when there is one, then the matches. */
  const rows = useMemo(
    () => (creating ? [{ tag: typed, count: -1 }, ...suggestions] : suggestions),
    [creating, typed, suggestions]
  )

  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Anything typed changes what the rows are, so the highlight goes back to the top rather
  // than staying on whichever index it happened to hold over a different list.
  useEffect(() => setHighlight(0), [draft])

  // Keeps the highlighted row in view when the arrows walk past the edge of the box.
  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const add = (value: string): void => {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
    if (parts.length === 0) return
    addTags(paths, parts)
    setDraft('')
  }

  commitRef.current = (): void => {
    // Tags are applied as they are typed, so the only thing that could be lost is a
    // half-finished one. That is the surprise worth preventing.
    if (draft.trim()) add(draft)
    onClose()
  }

  return (
    <div
      // Keys typed here belong to the field, not to the menu's typeahead or the table's
      // shortcuts, either of which would otherwise swallow them. Escape is the exception:
      // it has to reach whatever is holding this open so that it closes.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') event.stopPropagation()
      }}
    >
    <div className="mb-1.5 truncate text-[11px] text-muted-foreground" title={label}>
      {label}
    </div>

    {applied.length > 0 && (
      <div className="mb-2 flex flex-wrap gap-1">
        {applied.map(({ tag, count }) => (
          <Badge
            key={tag}
            className="gap-1 border-border/60 bg-secondary py-0.5 pr-1 text-secondary-foreground"
            title={
              count === paths.length
                ? tag
                : `${tag} - on ${count} of ${paths.length} selected files`
            }
          >
            <span className={count === paths.length ? undefined : 'opacity-60'}>{tag}</span>
            {count !== paths.length && (
              <span className="tnum text-[10px] text-muted-foreground">{count}</span>
            )}
            <button
              type="button"
              onClick={() => removeTag(paths, tag)}
              aria-label={`Remove ${tag}`}
              className="rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
    )}

    <Input
      ref={attachInput}
      value={draft}
      role="combobox"
      aria-expanded={rows.length > 0}
      aria-controls="tag-editor-options"
      aria-activedescendant={rows[highlight] ? `tag-option-${highlight}` : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        // The table's shortcuts must not fire while a tag is being typed.
        event.stopPropagation()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          // Wraps, because a list this short is quicker to walk round than to walk back.
          if (rows.length === 0) return
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setHighlight((current) => (current + step + rows.length) % rows.length)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          // The highlighted row wins over the raw text, which is the whole point of having
          // a list: typing `dr` and pressing Enter should give you `drums` rather than a
          // new tag called `dr`. Only with nothing highlighted does the text stand alone.
          add(rows[highlight]?.tag ?? draft)
        } else if (event.key === 'Escape') {
          onClose()
        } else if (event.key === 'Backspace' && !draft && applied.length > 0) {
          removeTag(paths, applied[applied.length - 1].tag)
        }
      }}
      placeholder="Add a tag, then Enter"
      spellCheck={false}
    />

    {rows.length > 0 && (
      // Capped and scrollable, the same bargain the sidebar's tag strip makes: showing
      // every tag must not push the field it is filtered by off the top of the screen.
      <div
        ref={listRef}
        id="tag-editor-options"
        role="listbox"
        className="scroll-thin mt-1.5 max-h-[168px] overflow-y-auto"
      >
        {rows.map((row, index) => (
          <button
            key={row.count === -1 ? `create:${row.tag}` : row.tag}
            id={`tag-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === highlight}
            data-highlighted={index === highlight}
            // Highlight follows the pointer as well as the arrows, so clicking never takes
            // a different row from the one under the cursor.
            onMouseEnter={() => setHighlight(index)}
            onClick={() => add(row.tag)}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11.5px] transition-colors',
              index === highlight ? 'bg-accent text-foreground' : 'text-muted-foreground'
            )}
          >
            {row.count === -1 ? (
              <>
                <Plus className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  Create <span className="text-foreground">{row.tag}</span>
                </span>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">{row.tag}</span>
                {/* How many files already carry it, which is what makes one of two
                    similar tags the one you meant. */}
                <span className="tnum shrink-0 text-[10.5px] text-muted-foreground/50">
                  {row.count}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
    )}
    </div>
  )
}
