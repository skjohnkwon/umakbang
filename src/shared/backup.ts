/**
 * Reading a settings backup that came from another machine.
 *
 * Most of what umakbang remembers is keyed by absolute path: every tag, rating, detected
 * tempo and detected key, plus the quick-access folders and where stems land. Carry that
 * file to a Mac and every one of those keys names a place that does not exist -
 * `Z:\SAMPLES\...` is not a path on a Mac, and merging it in produces a library-worth
 * of entries that can never match a file.
 *
 * So an import is not a merge, it is a translation: work out which folders the backup
 * refers to, ask where each one lives *here*, and rewrite every path through that mapping.
 * Anything whose folder isn't mapped is dropped rather than carried across broken, and the
 * wizard says how much that is before anything is written.
 *
 * Pure on purpose - no fs, no Electron - so main can apply it and the renderer can show
 * what applying it would do.
 */

import type { LibraryRoot, Settings } from './types'
import { isUnderKey, pathKey } from './path-key'

export interface SettingsBackup {
  kind: 'umakbang-settings'
  /** 1 predates the folder mapping; 2 records the library folders it was exported from. */
  version: 1 | 2
  exportedAt: string
  /** Where the library lived on the machine this came from, for reference on import. */
  exportedRoot: string | null
  /** Every library folder of the exporting machine. Absent in version 1 files. */
  exportedRoots?: LibraryRoot[]
  settings: Partial<Settings>
  tags: Record<string, string[]>
  ratings: Record<string, number>
  /** Absent in files exported before notes existed. */
  notes?: Record<string, string>
  detectedBpm: Record<string, number>
  detectedKey: Record<string, string>
}

export type PathStyle = 'windows' | 'posix'

/** One folder the backup refers to, and how much of the backup depends on it. */
export interface BackupFolder {
  /** The path as written on the machine that exported it. */
  path: string
  /** Its own name, which is what the user will recognise. */
  label: string
  /** True when it was one of the exporting machine's library folders. */
  library: boolean
  /** Tags, ratings and analysis entries that sit under it. */
  entries: number
}

export interface BackupSummary {
  style: PathStyle
  folders: BackupFolder[]
  counts: {
    tags: number
    ratings: number
    detectedBpm: number
    detectedKey: number
    quickMove: number
  }
  /** Entries whose folder could not be worked out at all. Always dropped. */
  orphans: number
}

/** Where each folder from the backup lives on this machine. '' means "skip it". */
export type FolderMapping = Record<string, string>

const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i

export function styleOf(path: string): PathStyle {
  return WINDOWS_ABSOLUTE.test(path) || path.startsWith('\\\\') || path.includes('\\')
    ? 'windows'
    : 'posix'
}

function separatorOf(path: string): string {
  return styleOf(path) === 'windows' ? '\\' : '/'
}

/**
 * Trailing separators off, one Unicode spelling, and one case - Windows is case-insensitive.
 *
 * The composition is the fix for the bug this file was reported with. A backup written on
 * Windows names `Z:\SAMPLES\ÁNDALE.mp3` composed; a Mac hands the same folder back
 * decomposed, `A` plus a combining acute. Compared with `toLowerCase` alone those are two
 * different strings, so `isUnder` said no, `rewrite` returned null, and the file's two tags
 * and its rating were dropped and counted as dropped - the import reporting, accurately, that
 * it had thrown away work it had every means of keeping.
 *
 * It is also what lets the wizard recognise a folder across two machines at all. `sameName`,
 * `anchorsFor`, `resolvePick` and `coveredBy` all come through here, and until now none of
 * them could tell that the `Música` in a Mac's paths and the `Música` in a Windows backup were
 * the same folder, so every guess it might have made from one answer was refused.
 *
 * Composed before lowercased, not after: composition is defined on the code points the
 * filesystem actually produced, and lowercasing first would hand `pathKey` a string nothing
 * on either machine ever wrote.
 */
function normalise(path: string): string {
  return pathKey(path.replace(/[\\/]+$/, '')).toLowerCase()
}

function isUnder(path: string, folder: string): boolean {
  return isUnderKey(normalise(path), normalise(folder))
}

/** The last segment of a path, whichever separator it uses. */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Every segment of a path below its root, whichever separator it uses. */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean)
}

/** Trailing separators off. */
function trim(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/**
 * The folder one level up, or null when there is no useful one left. `C:` on its own is a
 * drive letter rather than a folder, and `\\server` without a share is not a place either;
 * walking past those would produce candidates that can never exist.
 */
function parentOf(path: string): string | null {
  const trimmed = trim(path)
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut <= 0) return null
  const head = trimmed.slice(0, cut)
  if (/^[a-z]:$/i.test(head)) return null
  if (/^\\\\[^\\]*$/.test(head)) return null
  return head
}

/** Joins segments onto a base, in the base's own separator. */
export function joinPath(base: string, ...segments: string[]): string {
  const separator = separatorOf(base)
  return [trim(base), ...segments.filter(Boolean)].join(separator)
}

/**
 * What is left of a path once its containing folder is taken off the front.
 *
 * Both sides composed, because the tail is taken by *offset* and the two arguments are
 * routinely strings from two different machines. A decomposed `á` is two code units where a
 * composed one is one, so slicing a raw path by the length of a folder written in the other
 * form cuts it in the wrong place - a character short, or through the middle of a character.
 */
function relativeUnder(path: string, folder: string): string {
  return pathKey(path).slice(trim(pathKey(folder)).length).replace(/^[\\/]+/, '')
}

const sameName = (a: string, b: string): boolean =>
  normalise(lastSegment(a)) === normalise(lastSegment(b))

/**
 * What one answer tells us about the others.
 *
 * Locating `Z:\SAMPLES\Drums` at `/Volumes/Ext/Drums` says more than where that one folder
 * went: the names agree, so `Z:\SAMPLES` is `/Volumes/Ext`, and every other folder from the
 * backup that sat beside Drums can be guessed from there. Each pair is a *possible*
 * ancestor correspondence - nothing is believed until the folder it produces is found on
 * disk.
 *
 * When the names *don't* agree the pick is ambiguous: the user either renamed the folder
 * or, far more often, pointed at the folder that contains it. Both readings are offered.
 */
export function anchorsFor(source: string, target: string): Array<[string, string]> {
  const anchors: Array<[string, string]> = [[source, target]]

  let here = source
  let there = target
  while (sameName(here, there)) {
    const up = parentOf(here)
    const upThere = parentOf(there)
    if (!up || !upThere) break
    anchors.push([up, upThere])
    here = up
    there = upThere
  }

  if (!sameName(source, target)) {
    // The container reading: they pointed at the folder this one lives in.
    const up = parentOf(source)
    if (up) anchors.push([up, target])
  }

  return anchors
}

/**
 * Where one backup folder might sit inside a folder on this machine, deepest match first.
 *
 * A folder is recognised by its own name, or by its name and the folders above it -
 * `Kicks` is a name half a library uses, `Drums/Kicks` much less so, so the longer tail is
 * tried first and a coincidence has to be a bigger one to win.
 */
export function candidatesUnder(folder: string, container: string, depth = 3): string[] {
  // `Z:` and the host of a UNC path are segments of the string but not folders anybody can
  // nest, and joining them on produces candidates like `D:\Music\Z:\SAMPLES` that can never
  // exist - noise in a list that is about to be checked against the disk.
  //
  // Composed, which is the one place a path built for the filesystem is deliberately not left
  // alone. These segments are the *other* machine's text, and a candidate is a guess about to
  // be proved against the disk rather than a path being held: an unfound one costs a row left
  // unanswered. Composed is the better guess in both directions - it is what NTFS stores, and
  // APFS opens either form - so a Mac's decomposed `Música` can be found on Windows, which
  // until now it could not be.
  const segments = segmentsOf(pathKey(folder)).filter((segment) => !/^[a-z]:$/i.test(segment))
  const out: string[] = []
  for (let take = Math.min(depth, segments.length); take >= 1; take--) {
    out.push(joinPath(container, ...segments.slice(segments.length - take)))
  }
  return out
}

/** A guess at where one backup folder lives here, to be confirmed against the disk. */
export interface FolderProposal {
  /** The folder as the backup names it. */
  source: string
  /** Places it might be now, most likely first. Take the first one that really exists. */
  candidates: string[]
}

/**
 * Guesses the rest of the mapping from the answers already given.
 *
 * Every confirmed pair is turned into ancestor correspondences (`anchorsFor`), the most
 * specific of which wins - a folder that sits under both a library root and a subfolder the
 * user pointed at should follow the subfolder, since that is the closer thing they actually
 * looked at. Anything the anchors can't place is looked for by name inside each folder
 * already chosen, which is the case of pointing at one folder that holds all of them.
 *
 * Pure: it proposes, and the caller checks which proposals exist.
 */
export function proposeMapping(folders: string[], confirmed: FolderMapping): FolderProposal[] {
  const pairs = Object.entries(confirmed).filter(([, target]) => Boolean(target))
  if (pairs.length === 0) return []

  const anchors = pairs.flatMap(([source, target]) => anchorsFor(source, target))
  anchors.sort((a, b) => trim(b[0]).length - trim(a[0]).length)
  const chosen = pairs.map(([, target]) => target)

  const proposals: FolderProposal[] = []
  for (const folder of folders) {
    if (confirmed[folder]) continue
    const candidates: string[] = []
    const add = (path: string): void => {
      if (path && !candidates.some((seen) => normalise(seen) === normalise(path)))
        candidates.push(path)
    }
    for (const [source, target] of anchors) {
      if (!isUnder(folder, source)) continue
      const rest = relativeUnder(folder, source)
      add(rest ? joinPath(target, ...rest.split(/[\\/]/)) : target)
    }
    for (const container of chosen) for (const guess of candidatesUnder(folder, container)) add(guess)
    if (candidates.length > 0) proposals.push({ source: folder, candidates })
  }
  return proposals
}

/**
 * What the folder the user picked most likely means.
 *
 * Choosing `D:\Samples` while being asked to locate `Drums` almost always means "it's in
 * here", not "this is it" - so the folder of that name inside the pick is tried first, and
 * the pick itself is the fallback when there is no such folder.
 */
export function resolvePick(source: string, picked: string): string[] {
  if (sameName(source, picked)) return [picked]
  return [joinPath(picked, lastSegment(source)), picked]
}

/**
 * The mapped folder that already accounts for this one, if any.
 *
 * Backup folders nest - a quick-access folder inside a library root is listed in its own
 * right - and once the root is placed there is nothing left to ask about the folders
 * beneath it. The longest match wins, so a subfolder the user placed by hand still beats
 * its parent.
 */
export function coveredBy(folder: string, mapping: FolderMapping): string | null {
  let best: string | null = null
  for (const [source, target] of Object.entries(mapping)) {
    if (!target || normalise(source) === normalise(folder)) continue
    if (!isUnder(folder, source)) continue
    if (!best || trim(source).length > trim(best).length) best = source
  }
  return best
}

/**
 * The folder a path belongs to - its library folder if it has one, otherwise the folder it
 * sits in. Something filed outside the library still has to be offered for mapping, or the
 * quick-access list silently loses half its entries.
 */
function folderFor(path: string, roots: string[]): string | null {
  const match = roots.find((root) => isUnder(path, root))
  if (match) return match
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : null
}

/** What a backup refers to, and how much of it hangs off each folder. */
export function summariseBackup(backup: SettingsBackup): BackupSummary {
  const libraryRoots = (backup.exportedRoots ?? []).map((root) => root.path)
  if (libraryRoots.length === 0 && backup.exportedRoot) libraryRoots.push(backup.exportedRoot)

  const keyed = [
    ...Object.keys(backup.tags ?? {}),
    ...Object.keys(backup.ratings ?? {}),
    ...Object.keys(backup.notes ?? {}),
    ...Object.keys(backup.detectedBpm ?? {}),
    ...Object.keys(backup.detectedKey ?? {})
  ]
  const extras = [
    ...(backup.settings.quickMove ?? []).map((target) => target.path),
    ...(backup.settings.stemOutputDir ? [backup.settings.stemOutputDir] : [])
  ]

  const sample = keyed[0] ?? extras[0] ?? libraryRoots[0] ?? ''
  const style = styleOf(sample)

  const folders = new Map<string, BackupFolder>()
  const remember = (path: string, library: boolean): BackupFolder => {
    const key = normalise(path)
    const existing = folders.get(key)
    if (existing) return existing
    const entry: BackupFolder = { path, label: lastSegment(path), library, entries: 0 }
    folders.set(key, entry)
    return entry
  }
  for (const root of libraryRoots) remember(root, true)

  let orphans = 0
  for (const path of keyed) {
    const folder = folderFor(path, libraryRoots)
    if (!folder) {
      orphans++
      continue
    }
    remember(folder, false).entries++
  }
  // Filing destinations are worth mapping even though nothing is keyed by them.
  for (const path of extras) remember(path, false)

  return {
    style,
    folders: [...folders.values()].sort((a, b) => b.entries - a.entries || a.path.localeCompare(b.path)),
    counts: {
      tags: Object.keys(backup.tags ?? {}).length,
      ratings: Object.keys(backup.ratings ?? {}).length,
      detectedBpm: Object.keys(backup.detectedBpm ?? {}).length,
      detectedKey: Object.keys(backup.detectedKey ?? {}).length,
      quickMove: (backup.settings.quickMove ?? []).length
    },
    orphans
  }
}

/**
 * The mapping as the rewriter wants it: longest source first, so the first folder a path
 * falls under is also the most specific one. Folders nest, and a subfolder placed by hand
 * has to beat the root it sits in - with the entries in whatever order the object happened
 * to hold them, which one won was luck.
 */
function prepare(mapping: FolderMapping): Array<[string, string]> {
  return Object.entries(mapping)
    .filter(([, target]) => Boolean(target))
    .sort((a, b) => b[0].replace(/[\\/]+$/, '').length - a[0].replace(/[\\/]+$/, '').length)
}

function rewrite(path: string, ordered: Array<[string, string]>): string | null {
  // Composed once, up here, because what follows is an offset: the matched folder's length is
  // sliced off the front of the path. `isUnder` now says yes across the two Unicode spellings,
  // which is the whole point of it, and slicing the raw string by a length measured on the
  // other form would cut a character short or straight through a character. The tail therefore
  // leaves composed too, which is the right form to leave in: it is what the keys these become
  // are looked up by, and for the two settings that end up at the filesystem instead
  // (`quickMove`, `stemOutputDir`) it is the better of two guesses about another machine's
  // text - NTFS stores composed and APFS opens either.
  const canonical = pathKey(path)
  for (const [source, target] of ordered) {
    if (!isUnder(path, source)) continue
    const base = pathKey(source).replace(/[\\/]+$/, '')
    const rest = canonical.slice(base.length).replace(/^[\\/]+/, '')
    if (!rest) return target
    const separator = separatorOf(target)
    return `${target.replace(/[\\/]+$/, '')}${separator}${rest.split(/[\\/]/).join(separator)}`
  }
  return null
}

/** Rewrites one path from a mapped folder onto this machine, or null when unmapped. */
export function remapPath(path: string, mapping: FolderMapping): string | null {
  return rewrite(path, prepare(mapping))
}

export interface RemapCounts {
  tags: number
  ratings: number
  notes: number
  detectedBpm: number
  detectedKey: number
  quickMove: number
}

export interface RemapResult {
  backup: SettingsBackup
  kept: RemapCounts
  dropped: RemapCounts
}

/**
 * Translates a backup through a folder mapping.
 *
 * Everything keyed by a path under a mapped folder is rewritten; everything else is left
 * out. The result is a backup that only refers to places that exist here.
 */
export function remapBackup(backup: SettingsBackup, mapping: FolderMapping): RemapResult {
  const kept: RemapCounts = { tags: 0, ratings: 0, notes: 0, detectedBpm: 0, detectedKey: 0, quickMove: 0 }
  const dropped: RemapCounts = { tags: 0, ratings: 0, notes: 0, detectedBpm: 0, detectedKey: 0, quickMove: 0 }
  // Ordered once rather than per path: the wizard runs this over every key in the backup
  // on each answer, to show what the answer would bring across.
  const ordered = prepare(mapping)

  const translate = <T>(
    source: Record<string, T> | undefined,
    counter: 'tags' | 'ratings' | 'notes' | 'detectedBpm' | 'detectedKey'
  ): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [path, value] of Object.entries(source ?? {})) {
      const next = rewrite(path, ordered)
      if (next === null) dropped[counter]++
      else {
        // Composed on the way out as well as on the way in. The tail already is, but the head
        // is a folder the user pointed at on *this* machine, and on a Mac the picker hands
        // back whatever APFS holds - so without this an import onto a Mac would write the very
        // decomposed keys that made the export unreadable there in the first place.
        out[pathKey(next)] = value
        kept[counter]++
      }
    }
    return out
  }

  const settings: Partial<Settings> = { ...backup.settings }

  if (settings.quickMove) {
    const moved = settings.quickMove.flatMap((target) => {
      const next = rewrite(target.path, ordered)
      if (next === null) {
        dropped.quickMove++
        return []
      }
      kept.quickMove++
      return [{ ...target, path: next }]
    })
    settings.quickMove = moved
  }

  if (settings.stemOutputDir) {
    // A folder that isn't here would have stems written into a path that can't be created;
    // better to fall back to this machine's default than to fail on the first split.
    const next = rewrite(settings.stemOutputDir, ordered)
    if (next === null) delete settings.stemOutputDir
    else settings.stemOutputDir = next
  }

  return {
    backup: {
      ...backup,
      settings,
      tags: translate(backup.tags, 'tags'),
      ratings: translate(backup.ratings, 'ratings'),
      notes: translate(backup.notes, 'notes'),
      detectedBpm: translate(backup.detectedBpm, 'detectedBpm'),
      detectedKey: translate(backup.detectedKey, 'detectedKey')
    },
    kept,
    dropped
  }
}

/**
 * Whether the backup's paths and this machine's agree.
 *
 * The wizard leads with this: a backup from the same kind of machine usually needs no
 * mapping at all, and one from a different kind always does.
 */
export function needsMapping(summary: BackupSummary, here: PathStyle): boolean {
  return summary.style !== here
}
