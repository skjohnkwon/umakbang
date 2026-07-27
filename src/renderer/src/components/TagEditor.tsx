import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useLibrary } from '@/state/library'
import { claimFocus } from '@/lib/focus'
import { useAllTags } from '@/hooks/useLibraryView'

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

  /** Tags in use elsewhere that this selection doesn't already carry in full. */
  const suggestions = useMemo(() => {
    const already = new Set(applied.filter((entry) => entry.count === paths.length).map((e) => e.tag))
    const typed = draft.trim().toLowerCase()
    return allTags
      .filter((entry) => !already.has(entry.tag))
      .filter((entry) => !typed || entry.tag.toLowerCase().includes(typed))
      .slice(0, 12)
  }, [allTags, applied, paths.length, draft])

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
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        // The table's shortcuts must not fire while a tag is being typed.
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          add(draft)
        } else if (event.key === 'Escape') {
          onClose()
        } else if (event.key === 'Backspace' && !draft && applied.length > 0) {
          removeTag(paths, applied[applied.length - 1].tag)
        }
      }}
      placeholder="Add a tag, then Enter"
      spellCheck={false}
    />

    {suggestions.length > 0 && (
      <div className="mt-2 flex flex-wrap gap-1">
        {suggestions.map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            onClick={() => add(tag)}
            className="rounded border border-dashed border-border px-1.5 py-px text-[11px] text-muted-foreground transition-colors hover:border-solid hover:bg-accent hover:text-foreground"
          >
            {tag}
            <span className="ml-1 text-muted-foreground/50">{count}</span>
          </button>
        ))}
      </div>
    )}
    </div>
  )
}
