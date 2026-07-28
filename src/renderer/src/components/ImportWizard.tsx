import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FolderOpen,
  FolderSearch,
  Loader2,
  Sparkles,
  Wand2
} from 'lucide-react'
import type { BackupSummary, FolderMapping, SettingsBackup } from '@shared/backup'
import {
  candidatesUnder,
  coveredBy,
  lastSegment,
  proposeMapping,
  remapBackup,
  remapPath,
  resolvePick
} from '@shared/backup'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useLibrary } from '@/state/library'
import { cn } from '@/lib/utils'

/**
 * Bringing a settings file across from another machine.
 *
 * Nearly everything umakbang remembers is keyed by absolute path - every tag, rating,
 * detected tempo and key, the quick-access folders, where stems land. A backup written on
 * Windows and opened on a Mac refers to `Z:\\SAMPLES\\...`, which is not a place that
 * exists here, so folding it in would produce thousands of entries that can never match a
 * file and would look for all the world like the import had worked.
 *
 * So the import asks. One row per folder the backup refers to: point at where it lives on
 * this machine, or skip it. Skipping is a real answer - if the files aren't here, the tags
 * that describe them are worth nothing - and the count of what will be dropped is on screen
 * before anything is written.
 *
 * It only asks about what it can't work out, though. A backup names a dozen folders and
 * they moved together: the same drive under a new letter, the same library copied under a
 * new home directory. So each answer is generalised (`proposeMapping`) and every guess it
 * produces is checked against the disk before it is taken - a wrong guess finds nothing and
 * the row simply stays unanswered. Answering one folder usually answers the rest, and
 * "Find them all in one folder" does the whole list at once from a single pick.
 */
export function ImportWizard({
  backup,
  summary,
  here,
  onClose
}: {
  backup: SettingsBackup
  summary: BackupSummary
  /** The path style of the machine doing the importing. */
  here: 'windows' | 'posix'
  onClose: () => void
}): React.JSX.Element {
  const [mapping, setMapping] = useState<FolderMapping>({})
  /** Which entries the wizard worked out rather than the user pointing at. */
  const [guessed, setGuessed] = useState<Record<string, boolean>>({})
  /**
   * Folders the user has skipped. A skip is an answer - "those files aren't here" - and
   * without remembering it the next folder located would guess this one straight back.
   */
  const [refused, setRefused] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(true)
  const applyBackup = useLibrary((s) => s.applyBackup)

  const foreign = summary.style !== here
  const paths = useMemo(() => summary.folders.map((folder) => folder.path), [summary])

  /** Which of these paths are really folders here. Lower-cased for comparing. */
  const onDisk = useCallback(async (candidates: string[]): Promise<Set<string>> => {
    if (candidates.length === 0) return new Set()
    const found = await window.umakbang.directoriesExist(candidates)
    return new Set(found.map((path) => path.toLowerCase()))
  }, [])

  /**
   * Takes a mapping as far as it will go: propose, check the proposals against the disk,
   * keep what exists, and go round again - a folder placed this round is an anchor for the
   * next one, which is how pointing at a library root can end up placing a quick-access
   * folder three levels inside it. Bounded, since each round either places something or
   * stops.
   */
  const settle = useCallback(
    async (
      base: FolderMapping,
      hand: string[],
      blocked: Record<string, boolean>
    ): Promise<void> => {
      let current = base
      const found: Record<string, boolean> = {}
      for (let round = 0; round < 4; round++) {
        const proposals = proposeMapping(paths, current).filter(
          (proposal) => !blocked[proposal.source]
        )
        if (proposals.length === 0) break
        const exists = await onDisk([...new Set(proposals.flatMap((p) => p.candidates))])
        const next = { ...current }
        let placed = false
        for (const proposal of proposals) {
          const hit = proposal.candidates.find((path) => exists.has(path.toLowerCase()))
          if (!hit) continue
          next[proposal.source] = hit
          found[proposal.source] = true
          placed = true
        }
        if (!placed) break
        current = next
      }
      setMapping(current)
      setGuessed((previous) => {
        const merged = { ...previous, ...found }
        // Anything the user pointed at themselves is theirs, however it got there first.
        for (const path of hand) delete merged[path]
        return merged
      })
    },
    [onDisk, paths]
  )

  // On the way in, try the backup's own paths. A reinstall on the same machine, or a drive
  // that kept its letter, needs no mapping at all and should not be made to do one.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const exists = await onDisk(paths)
      const identity: FolderMapping = {}
      const found: Record<string, boolean> = {}
      for (const path of paths) {
        if (!exists.has(path.toLowerCase())) continue
        identity[path] = path
        found[path] = true
      }
      setGuessed(found)
      try {
        await settle(identity, [], {})
      } finally {
        // Always cleared, or a rejected disk probe leaves every button disabled for the
        // life of the dialog.
        setSearching(false)
      }
    })()
  }, [onDisk, paths, settle])

  // What the current answers would actually bring across, worked out with the same code
  // that will do the importing.
  const preview = useMemo(() => remapBackup(backup, mapping), [backup, mapping])

  const mapped = Object.values(mapping).filter(Boolean).length
  // Library folders that have been located get opened here, not just remapped - worth
  // saying before the button is pressed, since it is the one part of an import that
  // changes what's on screen rather than what's remembered. Doubly so now that locating
  // one can happen without the user pointing at anything.
  const opening = summary.folders.filter((folder) => folder.library && mapping[folder.path])
  const autoCount = summary.folders.filter((folder) => guessed[folder.path]).length
  // A skipped folder was answered - the answer was "it isn't here" - so it neither counts
  // as still-to-place nor keeps the locate-all button offering to find it.
  const unanswered = summary.folders.filter(
    (folder) => !mapping[folder.path] && !coveredBy(folder.path, mapping) && !refused[folder.path]
  ).length
  const total =
    preview.kept.tags + preview.kept.ratings + preview.kept.detectedBpm + preview.kept.detectedKey
  const lost =
    preview.dropped.tags +
    preview.dropped.ratings +
    preview.dropped.detectedBpm +
    preview.dropped.detectedKey

  const choose = async (folder: string): Promise<void> => {
    const picked = await window.umakbang.pickDirectory(`Where ${lastSegment(folder)} lives now`)
    if (!picked) return
    setSearching(true)
    // Pointing at a folder that holds the one being asked about is the ordinary way to
    // answer, so look inside the pick before taking it literally.
    const candidates = resolvePick(folder, picked)
    const exists = await onDisk(candidates)
    const target = candidates.find((path) => exists.has(path.toLowerCase())) ?? picked
    // Locating a folder takes back an earlier skip of it.
    const blocked = { ...refused }
    delete blocked[folder]
    setRefused(blocked)
    try {
      await settle({ ...mapping, [folder]: target }, [folder], blocked)
    } finally {
      setSearching(false)
    }
  }

  /** One pick for the whole list: everything that turns up inside it by name is placed. */
  const locateAll = async (): Promise<void> => {
    const picked = await window.umakbang.pickDirectory('Which folder holds them all')
    if (!picked) return
    setSearching(true)
    const open = paths.filter((path) => !mapping[path] && !refused[path])
    const exists = await onDisk([...new Set(open.flatMap((path) => candidatesUnder(path, picked)))])
    const next = { ...mapping }
    const found: Record<string, boolean> = {}
    for (const path of open) {
      const hit = candidatesUnder(path, picked).find((guess) => exists.has(guess.toLowerCase()))
      if (!hit) continue
      next[path] = hit
      found[path] = true
    }
    setGuessed((previous) => ({ ...previous, ...found }))
    try {
      await settle(next, [], refused)
    } finally {
      setSearching(false)
    }
  }

  const skip = (folder: string): void => {
    setMapping((current) => {
      const next = { ...current }
      delete next[folder]
      return next
    })
    setGuessed((current) => {
      const next = { ...current }
      delete next[folder]
      return next
    })
    setRefused((current) => ({ ...current, [folder]: true }))
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    await applyBackup(backup, mapping)
    setBusy(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-[620px]">
        <header className="border-b px-4 py-3">
          <DialogTitle>Import settings</DialogTitle>
          <DialogDescription>
            {foreign
              ? `This backup was written on ${summary.style === 'windows' ? 'Windows' : 'macOS or Linux'}, and its paths don't exist here.`
              : 'This backup came from a machine like this one.'}{' '}
            Point one folder at where it lives now and the rest are worked out from it.
          </DialogDescription>
        </header>

        <div className="space-y-3 px-4 py-3">
          {foreign && (
            <p className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11.5px] leading-relaxed text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                If the files are on this machine - synced, copied, or on an external drive -
                choose the folder they live in and everything about them comes across. If they
                aren't here, skip: tags and ratings for files that don't exist would be dead
                weight.
              </span>
            </p>
          )}

          {summary.folders.length > 1 && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11.5px] text-muted-foreground">
                {searching ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Looking for these folders…
                  </span>
                ) : autoCount > 0 ? (
                  <span className="flex items-center gap-1.5 text-primary">
                    <Sparkles className="h-3 w-3" />
                    {autoCount} found automatically
                    {unanswered > 0 && `, ${unanswered} still to place`}.
                  </span>
                ) : (
                  `${summary.folders.length} folders to place.`
                )}
              </p>
              {unanswered > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={searching}
                  onClick={() => void locateAll()}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  Find them all in one folder
                </Button>
              )}
            </div>
          )}

          <div className="scroll-thin max-h-[260px] space-y-1.5 overflow-y-auto">
            {summary.folders.map((folder) => {
              const target = mapping[folder.path] ?? ''
              // Folders nest - a quick-access folder inside a library root is listed in its
              // own right - and once the root is placed there is nothing left to ask.
              const cover = target ? null : coveredBy(folder.path, mapping)
              const derived = cover ? remapPath(folder.path, mapping) : null
              const settled = Boolean(target) || Boolean(derived)
              return (
                <div
                  key={folder.path}
                  className={cn(
                    'rounded border px-2 py-1.5',
                    settled ? 'border-primary/50 bg-primary/5' : 'border-border/70'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium" title={folder.path}>
                          {folder.label}
                        </span>
                        {folder.library && (
                          <span className="shrink-0 rounded-sm bg-secondary px-1 text-[10px] text-secondary-foreground">
                            library folder
                          </span>
                        )}
                        {guessed[folder.path] && (
                          <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-primary/15 px-1 text-[10px] text-primary">
                            <Sparkles className="h-2.5 w-2.5" />
                            found
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground" title={folder.path}>
                        {folder.path}
                        {folder.entries > 0 && ` · ${folder.entries.toLocaleString()} entries`}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={searching}
                      onClick={() => void choose(folder.path)}
                    >
                      <FolderSearch className="h-3.5 w-3.5" />
                      {settled ? 'Change' : 'Locate'}
                    </Button>
                    {target && (
                      // Disabled while a settle runs: it finishes by writing back the
                      // mapping it started from, which would quietly restore the very
                      // folder this button just removed.
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={searching}
                        onClick={() => skip(folder.path)}
                      >
                        Skip
                      </Button>
                    )}
                  </div>
                  {(target || derived) && (
                    <div
                      className={cn(
                        'mt-1 flex items-center gap-1 text-[11px]',
                        target ? 'text-primary' : 'text-muted-foreground'
                      )}
                    >
                      <ArrowRight className="h-3 w-3 shrink-0" />
                      <span className="truncate" title={target || derived || ''}>
                        {target || derived}
                      </span>
                      {!target && cover && (
                        <span className="shrink-0 text-[10px]">
                          · with {lastSegment(cover)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {summary.folders.length === 0 && (
              <p className="text-[12px] text-muted-foreground">
                Nothing in this backup is tied to a folder - settings only.
              </p>
            )}
          </div>

          <div className="rounded border bg-card/40 px-2 py-1.5 text-[11.5px]">
            <div className="flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-primary" />
              <span>
                {total.toLocaleString()} of{' '}
                {(total + lost).toLocaleString()} entries will come across
                {mapped > 0 && ` from ${mapped} folder${mapped === 1 ? '' : 's'}`}.
              </span>
            </div>
            {lost > 0 && (
              <div className="mt-0.5 pl-5 text-muted-foreground">
                {lost.toLocaleString()} left out: {preview.dropped.tags.toLocaleString()} tagged,{' '}
                {preview.dropped.ratings.toLocaleString()} rated,{' '}
                {(preview.dropped.detectedBpm + preview.dropped.detectedKey).toLocaleString()}{' '}
                analysed.
              </div>
            )}
            {summary.orphans > 0 && (
              <div className="mt-0.5 pl-5 text-muted-foreground">
                {summary.orphans.toLocaleString()} entries had no folder to place them in.
              </div>
            )}
            {opening.length > 0 && (
              <div className="mt-0.5 flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-primary" />
                <span>
                  {opening.map((folder) => folder.label).join(', ')} will be opened as your
                  library and indexed.
                </span>
              </div>
            )}
            <div className="mt-0.5 pl-5 text-muted-foreground">
              Preferences - colours, columns, player, analysis - come across either way.
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-1.5 border-t px-4 py-2.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || searching} onClick={() => void apply()}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mapped === 0 && total === 0 ? 'Import preferences only' : 'Import'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
