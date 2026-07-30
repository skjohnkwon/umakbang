/**
 * Undo for file operations, most recent first.
 *
 * The whole design is one decision: an undo is modelled as an ordinary `TransferResult` and
 * pushed back through the machinery that already exists. `index.ts` `journal()` turns one
 * into index-journal patches, and the renderer's `applyTransfer` turns one into in-place
 * index moves that carry ratings, tags and notes across. So reversing a move is not a second
 * implementation of moving files - it is the same report, with the arrows the other way
 * round, and `fs-ops.ts` needed no changes at all to make it.
 *
 * It was one record rather than a stack, and that was wrong in the case people actually hit:
 * copy, paste, paste, paste is four operations and each one replaced the last, so the first
 * Ctrl+Z reversed the final paste and the second had nothing left to reverse. Reported as
 * "undo only works the first time", which is exactly what a single slot looks like from the
 * outside. The stack is LIFO and nothing else changed - each entry is still an independent
 * `TransferResult`, and `verify` still refuses any file that has moved on since.
 *
 * The stack is module state and it is not persisted. Undo is what you press because you just
 * did the wrong thing; an undo offered on the next launch would be reversing something whose
 * folder you have since reorganised, and the stamp check below would refuse most of them
 * anyway.
 */

import { basename, dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { link, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { shell } from 'electron'
import { describeFile, describeTree } from './fs-ops'
import { relFor } from '../shared/roots'
import { DEFAULT_SETTINGS } from '../shared/types'
import type {
  LibraryRoot,
  TransferResult,
  UndoEntry,
  UndoKind,
  UndoOutcome,
  UndoProgress,
  UndoRecord,
  UndoSummary
} from '../shared/types'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ the stack */

/**
 * Most recent last, so the end of the array is the next thing Ctrl+Z reverses.
 *
 * Bounded because an entry holds one `UndoEntry` per file it touched, and a paste of a large
 * folder is tens of thousands of them - an unbounded stack would keep every one of those
 * alive for the life of the process. The oldest is dropped rather than refusing to record
 * the newest: what people reach for is the last few things they did, and a stack that
 * stopped recording once it filled would fail at exactly the moment it was wanted.
 */
const stack: UndoRecord[] = []

/**
 * What has been undone, newest last, waiting to be put forward again.
 *
 * A redo is not a third operation: it is an undo of an undo. Reversing a record produces an
 * ordinary `TransferResult`, so it becomes a record through the same `buildRecord` and runs
 * through the same runner, with the arrows the other way round again. That is why redo needed
 * no new filesystem code and gets the stamp checks for nothing.
 *
 * Only the kinds whose reversal *moves* something can come back this way. Undoing a copy
 * sends the copies to the trash and undoing a New Folder removes it, and neither leaves a
 * move to invert, so those two offer no redo rather than one that would have to guess. An
 * absent affordance beats a dead one - the same reason a delete carries no Undo at all.
 */
const redoStack: UndoRecord[] = []

/** The range the setting is held to, so a hand-edited file or an old bundle cannot uncap it. */
const MIN_DEPTH = 1
const MAX_DEPTH = 200

/** `Settings.undoDepth`, applied through `setUndoLimit`. */
let limit = DEFAULT_SETTINGS.undoDepth

/**
 * The only reading of `undoDepth`, so what is stored and what is in force cannot disagree.
 *
 * Exported because the settings handler clamps on the way *in* as well: storing 9999 while
 * running 200 would leave the number in the file describing something the app never does,
 * and the control in Settings showing none of its options as chosen.
 */
export function clampUndoDepth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.undoDepth
  return Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, Math.floor(value)))
}

/**
 * How deep the history goes.
 *
 * Pushed in from `index.ts` rather than read from the store here, the same shape as
 * `initAutoBackup`'s predicate: this module knows about records and nothing about settings,
 * and giving it the store would be a second thing to keep in step at startup.
 *
 * Trims immediately, because the reason to turn it down is usually that the records are
 * holding memory - a limit that only applied to the next operation would leave exactly what
 * was being complained about sitting there until something else happened.
 */
export function setUndoLimit(next: number): void {
  limit = clampUndoDepth(next)
  trim()
}

/** Oldest first out. `splice` rather than a `shift` loop - lowering the limit drops many. */
function trim(): void {
  if (stack.length > limit) stack.splice(0, stack.length - limit)
}

/** Set by `cancelUndo`, read between entries by a run in flight. */
let cancelling = false
/** One undo at a time - a second one started over the first would fight it for the files. */
let running = false
let serial = 0

const VERBS: Record<UndoKind, string> = {
  move: 'Move',
  copy: 'Copy',
  rename: 'Rename',
  newFolder: 'New Folder'
}

/**
 * The one sentence three places say.
 *
 * The menu item, the toolbar button and the notice all read this rather than each composing
 * their own from `kind` and a count, because three renderings of one fact drift the first
 * time anybody touches one of them.
 */
function labelFor(verb: 'Undo' | 'Redo', kind: UndoKind, fileCount: number): string {
  if (fileCount === 0) return `${verb} ${VERBS[kind]}`
  return `${verb} ${VERBS[kind]} (${fileCount} ${fileCount === 1 ? 'file' : 'files'})`
}

/**
 * Records what an operation just did, so it can be run backwards.
 *
 * An operation that failed part way is still remembered for the part that landed: that is
 * the case where an undo is worth the most, and `TransferResult` already reports exactly how
 * far it got.
 *
 * One that produced nothing records nothing, and deliberately no longer clears anything. With
 * a single slot it had to: leaving the previous record standing meant Ctrl+Z after a failed
 * move quietly reversed something from ten minutes ago. A stack does not have that problem -
 * the top of it is the last thing that actually happened, and the button and the menu item
 * both name it - so throwing the whole history away because one operation moved no files
 * would cost far more than it protects.
 */
export function remember(kind: UndoKind, result: TransferResult): void {
  const record = buildRecord(kind, result)
  if (!record) return
  stack.push(record)
  trim()
  // A new operation is a new branch, and everything that was undone is on the old one. Redoing
  // into it after moving those same files somewhere else is how a redo destroys work.
  redoStack.length = 0
}

/**
 * Turns what an operation did into a record that can run it backwards.
 *
 * Shared by `remember` and by the runner, which builds one out of a reversal so it can be
 * reversed again - that is the whole of redo. Null when there is nothing to reverse.
 */
function buildRecord(kind: UndoKind, result: TransferResult): UndoRecord | null {
  if (result.moves.length === 0) return null

  const entries: UndoEntry[] = []
  const covered = new Set<string>()
  for (const { from, track } of result.items) {
    // A copy came from nowhere - the source is still sitting where it always was, and
    // pairing the copy with it would describe the undo as a move back onto a live file.
    entries.push({
      at: track.path,
      ...(kind === 'copy' ? {} : { from }),
      size: track.size,
      mtimeMs: track.mtimeMs
    })
    covered.add(track.path)
  }

  // A top-level file the library does not index has no item to take its stamp from, so it
  // is stated here. Synchronously, and deliberately: the operation that just finished
  // renamed every one of these files, so one stat each is not what makes anything slow, and
  // an async pass would leave a window where the record exists without its stamps.
  for (const move of result.moves) {
    if (move.directory || covered.has(move.to)) continue
    try {
      const info = statSync(move.to)
      entries.push({
        at: move.to,
        ...(kind === 'copy' ? {} : { from: move.from }),
        size: info.size,
        mtimeMs: info.mtimeMs
      })
    } catch {
      // Gone again already, or unreadable. There is nothing to put back, and one file must
      // never cost the whole record.
    }
  }

  return {
    id: `undo-${++serial}`,
    kind,
    moves: result.moves,
    items: entries,
    originDir: dirname(result.moves[0].from),
    at: Date.now()
  }
}

/**
 * Drops every record, both directions. Called whenever the library changes shape.
 *
 * All of them rather than the top one: the reason they stop being safe is that `journal()`
 * decides which index a patch belongs to from the current roots, and a set of roots that has
 * changed underneath the stack invalidates everything on it, not just the newest.
 */
export function forget(): void {
  stack.length = 0
  redoStack.length = 0
}

/** What is pending, for the menu, the toolbar and the notice. Null when there is nothing. */
export function summary(): UndoSummary | null {
  const record = stack[stack.length - 1]
  if (!record) return null
  return {
    id: record.id,
    kind: record.kind,
    label: labelFor('Undo', record.kind, record.items.length),
    fileCount: record.items.length,
    // What is behind this one, so the UI can say there is more than one press in it.
    depth: stack.length
  }
}

/** The same, for the way forward. Null when nothing has been undone, which is most of the time. */
export function redoSummary(): UndoSummary | null {
  const record = redoStack[redoStack.length - 1]
  if (!record) return null
  return {
    id: record.id,
    kind: record.kind,
    label: labelFor('Redo', record.kind, record.items.length),
    fileCount: record.items.length,
    depth: redoStack.length
  }
}

/**
 * Asks a run in flight to stop.
 *
 * Read between entries and never inside one: interrupting a rename mid-flight is not
 * something the filesystem offers, and pretending otherwise would be a way to lose a file
 * rather than a way to stop. "Interruptible at file boundaries" is the whole promise.
 */
export function cancelUndo(): void {
  cancelling = true
}

/* ------------------------------------------------------------------ checking */

type Verdict = 'ok' | 'missing' | 'changed'

/**
 * Whether the file at an entry is still the one umakbang put there.
 *
 * A move preserves size and mtime, so a matching stamp means nothing has written to the
 * file since. Anything else is somebody's work - a re-export over the top, an edit in a
 * DAW - and an undo that overwrote it would be the exact failure undo exists to prevent.
 */
async function verify(entry: UndoEntry): Promise<Verdict> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(entry.at)
  } catch {
    return 'missing'
  }
  // A millisecond of slack, because the stamp recorded by `describeFile` and the one read
  // back here travel through two different `stat` calls and network shares round them.
  if (info.size !== entry.size) return 'changed'
  if (Math.abs(info.mtimeMs - entry.mtimeMs) > 1) return 'changed'
  return 'ok'
}

/** True when `path` is `base` or sits somewhere beneath it. */
function isAtOrUnder(path: string, base: string): boolean {
  const a = path.toLowerCase()
  const b = base.toLowerCase().replace(/[\\/]+$/, '')
  if (a === b) return true
  return a.startsWith(b) && (a[b.length] === '\\' || a[b.length] === '/')
}

/**
 * Puts one entry back where it was, and can never replace what is there.
 *
 * `link` then `unlink` is the guarantee, the same way `{ flag: 'wx' }` is the guarantee in
 * `fs:saveTrim`: a hard link fails EEXIST atomically when the origin is occupied, where
 * `rename` silently replaces the destination on both platforms. `uniqueTarget`'s "name (2)"
 * fallback is no answer here either - that is a second file, not an undo.
 *
 * Hard links are the one thing not every case supports: another volume answers EXDEV, a
 * directory answers EPERM or EISDIR, and a FAT stick has no links at all. Those fall back
 * to a check and a rename, which has a gap between the two that the link path does not -
 * hence the fallback rather than the implementation.
 */
async function putBack(current: string, origin: string): Promise<void> {
  try {
    await link(current, origin)
    await unlink(current)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'EXDEV' &&
      code !== 'EPERM' &&
      code !== 'EISDIR' &&
      code !== 'ENOSYS' &&
      code !== 'ENOTSUP'
    ) {
      throw error
    }
  }

  if (existsSync(origin)) {
    const occupied = new Error('Something is already there.') as NodeJS.ErrnoException
    occupied.code = 'EEXIST'
    throw occupied
  }
  await rename(current, origin)
}

type Failure = Omit<UndoOutcome['failures'][number], 'path'>

/**
 * Why one entry could not be reversed.
 *
 * Two of these are refusals rather than faults, and it matters that they read as such: a
 * path that is occupied again and a folder somebody has since put files into both have a
 * right answer, and it is to leave them alone and say so.
 */
function classify(error: unknown, move: { from: string; to: string }): Failure {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'EEXIST':
      return { reason: 'occupied', message: `Something is already at ${basename(move.from)}.` }
    case 'ENOTEMPTY':
      return { reason: 'occupied', message: `${basename(move.to)} is not empty any more.` }
    default:
      return { reason: 'error', message: describeError(error) }
  }
}

/** `describeTree`'s shape for one file, so the two branches below read the same. */
async function describeOne(
  path: string,
  roots: LibraryRoot[]
): Promise<Awaited<ReturnType<typeof describeTree>>> {
  const track = await describeFile(path, roots)
  return track ? [track] : []
}

/* ------------------------------------------------------------------ running */

const NOTHING: TransferResult = { moves: [], items: [], removed: [] }

function refusal(message: string): { result: TransferResult; outcome: UndoOutcome } {
  return {
    result: NOTHING,
    outcome: {
      restored: 0,
      total: 0,
      cancelled: false,
      failures: [{ path: '', reason: 'missing', message }]
    }
  }
}

/**
 * Runs the newest record backwards, and remembers the reversal so it can be put forward.
 *
 * Reports what it did as a `TransferResult`, which is the point of the whole module: main
 * hands that straight to `journal()` and the renderer hands it straight to `applyTransfer`,
 * so an undo updates the index, the journal, the ratings and the tags through the code that
 * already does all of that for a move.
 */
export async function runUndo(
  id: string,
  roots: LibraryRoot[],
  report: (progress: UndoProgress) => void
): Promise<{ result: TransferResult; outcome: UndoOutcome }> {
  return run(stack, redoStack, 'undo', id, roots, report)
}

/**
 * Runs the newest undone record forwards again, and puts it back on the undo stack.
 *
 * Exactly `runUndo` with the two stacks swapped: reversing a reversal is the original
 * operation, so this is the same code, the same stamp checks and the same reporting.
 */
export async function runRedo(
  id: string,
  roots: LibraryRoot[],
  report: (progress: UndoProgress) => void
): Promise<{ result: TransferResult; outcome: UndoOutcome }> {
  return run(redoStack, stack, 'redo', id, roots, report)
}

/**
 * Takes the newest record off `from`, runs it backwards, and leaves the reversal on `onto`.
 *
 * Both directions are this function because they are the same act. `running` is shared
 * deliberately: an undo and a redo started over each other would be two passes fighting for
 * the same files, and which won would be a matter of timing.
 */
async function run(
  from: UndoRecord[],
  onto: UndoRecord[],
  what: 'undo' | 'redo',
  id: string,
  roots: LibraryRoot[],
  report: (progress: UndoProgress) => void
): Promise<{ result: TransferResult; outcome: UndoOutcome }> {
  // Only ever the top. Reversing something from the middle would mean replaying the entries
  // above it against a disk they no longer describe, and there is no affordance that asks
  // for one - the button and the menu item both name the newest.
  const target = from[from.length - 1]
  if (!target || target.id !== id || running) {
    return refusal(
      running ? 'Something is already running.' : `There is nothing left to ${what}.`
    )
  }

  running = true
  cancelling = false

  const failures: UndoOutcome['failures'] = []
  const moves: TransferResult['moves'] = []
  const items: TransferResult['items'] = []
  const removed: string[] = []
  const total = target.items.length
  let restored = 0
  let done = 0
  let cancelled = false

  try {
    for (const move of [...target.moves].reverse()) {
      // Between entries, never inside one. See `cancelUndo`.
      if (cancelling) {
        cancelled = true
        break
      }

      // A folder is answered as a folder. Half-restoring one leaves two incomplete copies of
      // it with the tree grafted in both places, which is worse than not restoring it.
      const group = target.items.filter((entry) => isAtOrUnder(entry.at, move.to))
      const advance = (): void => {
        done += group.length
        report({ done, total })
      }

      let refused: { reason: UndoOutcome['failures'][number]['reason']; message: string } | null =
        null
      for (const entry of group) {
        const verdict = await verify(entry)
        if (verdict === 'ok') continue
        refused = {
          reason: verdict,
          message:
            verdict === 'missing'
              ? `${basename(entry.at)} is no longer there.`
              : `${basename(entry.at)} has changed on disk since.`
        }
        break
      }
      if (refused) {
        failures.push({
          path: move.to,
          reason: refused.reason,
          message: move.directory
            ? `${basename(move.to)} was left where it is: ${refused.message}`
            : refused.message
        })
        advance()
        continue
      }

      try {
        if (target.kind === 'copy') {
          // A copy is undone by sending the copies to the trash, never by removing them.
          // Nothing in this app deletes outright, and an undo is the last place to start.
          await shell.trashItem(move.to)
          removed.push(...group.map((entry) => entry.at))
        } else if (target.kind === 'newFolder') {
          // `rmdir`, never a recursive remove: the folder was created empty, and anything
          // that has been put in it since is something an undo has no business taking away.
          await rmdir(move.to)
        } else {
          await putBack(move.to, move.from)
          moves.push({ from: move.to, to: move.from, directory: move.directory })
          // Paired by prefix swap rather than from the record, so a file that appeared in the
          // folder after the move travels with it and lands in the index too.
          const landed = move.directory
            ? await describeTree(move.from, roots)
            : await describeOne(move.from, roots)
          for (const track of landed) {
            items.push({ from: move.to + track.path.slice(move.from.length), track })
          }
          removed.push(...group.map((entry) => entry.at))
        }
        restored += group.length
      } catch (error) {
        failures.push({ path: move.to, ...classify(error, move) })
      }
      advance()
    }
  } finally {
    running = false
    cancelling = false
    // Spent here rather than by the caller, because only this function knows whether it ran.
    // The handler used to `forget()` unconditionally after every `undo:run`, including the
    // refusals above - which with a stack would empty the whole thing on a mistimed press.
    // The early return never reaches this block, which is the point. Popped by identity
    // rather than blindly, so a record pushed while this one was running is not the one
    // thrown away.
    const at = from.indexOf(target)
    if (at !== -1) from.splice(at, 1)

    // The reversal, so it can be reversed again - that is the whole of redo, and going the
    // other way this is what puts a redone operation back within reach of Ctrl+Z. `kind` is
    // carried across so the label still names what the user did rather than what the machine
    // did.
    const back = buildRecord(target.kind, { moves, items, removed })
    if (back) {
      onto.push(back)
      if (onto.length > limit) onto.splice(0, onto.length - limit)
    } else {
      /**
       * Nothing to invert, so everything queued the other way is dropped with it.
       *
       * A trashed copy and a removed folder leave no move to describe, and what was already
       * on the forward stack was written against the disk as it stood *before* this ran.
       * Measured: make a folder, file two beats into it, then undo twice - the second undo
       * removes the folder, and the "Redo Move" still on offer would have tried to link two
       * files into a directory that no longer exists. It fails safely, `link` being atomic,
       * but the message is an ENOENT nobody can act on, and the affordance promised something
       * it could not do.
       *
       * Also reached when a reversal was refused outright. That is conservative - the disk
       * did not change, so the forward stack would still have applied - but "we cannot say
       * how to get back" is the wrong moment to be clever about file operations.
       */
      onto.length = 0
    }
  }

  // Where to look for what came back. Only for the kinds that put something somewhere - a
  // copy's undo leaves nothing behind to go and see.
  const landedRel =
    restored > 0 && target.kind !== 'copy' && target.kind !== 'newFolder'
      ? relFor(roots, target.originDir)
      : null

  return {
    result: { moves, items, removed },
    outcome: {
      restored,
      total,
      failures,
      cancelled,
      ...(landedRel ? { landedRel } : {})
    }
  }
}
