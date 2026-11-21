/**
 * Browsing this machine's library from another one without copying its index (protocol 3).
 *
 * A peer used to pull `/index` - the whole saved index and the journal, ~327,000 rows and
 * ~250MB - and browse its own copy. The pull was meant to be rare, keyed on the index file's
 * mtime, but every full scan rewrites that file, so in practice the phone re-downloaded the
 * library on most launches. It never needed it: a row it cannot play while this machine is
 * asleep is no use, and this machine already holds the rows and the search code. So a peer
 * asks for the folder it is looking at (`/list`), the results of a query (`/search`), one
 * random file (`/random`) or whether its saved copies still match (`/stat`), and nothing else.
 * `/index` stays for the desktop's own remote roots.
 *
 * The rows live in the server process, which never held any before. A second copy of the
 * index beside the scanner's and the window's, so it is:
 *
 *   - loaded on first use, not at startup - a machine nobody browses pays nothing;
 *   - kept current from the disk, not from the window: a replaced index file is reloaded, and
 *     a journal that has only grown has just its new lines folded in, since the folder watch
 *     appends to it on every export and reloading 328k rows for one file would be absurd;
 *   - dropped after ten idle minutes, because since 0.4.0 this process lives in the tray from
 *     login onwards and ~190MB held for ever in the background is not a cost to impose.
 *
 * Paths on the wire are within the library folder with no label (`''` is the folder itself) -
 * the same rule `/file` follows, since a label is only this machine's name for the folder.
 * Nothing here opens a file by a string from the request: everything is answered from memory.
 *
 * The rows themselves are `Track`s exactly as `/index` sends them, which means their `rel` and
 * `relDir` *do* carry this machine's label in front (`SECRET SAUCE/Stems`). So the two forms
 * meet at the peer: `/list?dir=Stems` answers with rows whose `relDir` is `SECRET SAUCE/Stems`,
 * and a peer turning a row back into a `dir` takes the first segment off. The response's own
 * `dir` echoes the label-free form it was asked for. `/stat` is the one route that takes a
 * file path, and it accepts either form, since echoing a row's `rel` is the obvious thing to
 * send it.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteLibrary, SortKey, Track } from '../shared/types'
import { indexFileFor, loadIndex, patchFileFor, takeIndexReplay } from './index-store'
import { compareTracks, isEmptyQuery, matchesQuery, parseQuery, scoreMatch } from '../shared/search'

/** How long a loaded index outlives the last request that used it. */
const IDLE_MS = 10 * 60_000

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const SORT_KEYS: readonly SortKey[] = [
  'name',
  'kind',
  'duration',
  'size',
  'mtimeMs',
  'bpm',
  'musicalKey',
  'sampleRate',
  'rating'
]

interface Folder {
  files: number
  audio: number
  children: Set<string>
}

interface Browse {
  library: RemoteLibrary
  /** The index file this was read from: its mtime is also the `generation` peers see. */
  indexMtimeMs: number
  indexSize: number
  /** How many bytes of the journal have been folded in. */
  journalBytes: number
  byPath: Map<string, Track>
  /** Files by their folder within the library, `''` for the library folder itself. */
  byDir: Map<string, Track[]>
  /** Every folder, with counts through all its descendants and its direct children. */
  folders: Map<string, Folder>
  idle: NodeJS.Timeout | null
}

const loaded = new Map<string, Browse>()
/** Libraries with a reload queued behind the request that noticed the change. */
const reloading = new Set<string>()

export interface Answer {
  status: number
  body?: unknown
}

/* ------------------------------------------------------------------ the index in memory */

/** The folder a row sits in, within its library: its `relDir` with the label taken off. */
function dirOf(track: Track): string {
  const cut = track.relDir.indexOf('/')
  return cut === -1 ? '' : track.relDir.slice(cut + 1)
}

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf('/')
  return cut === -1 ? '' : dir.slice(0, cut)
}

function folderAt(browse: Browse, dir: string): Folder {
  let folder = browse.folders.get(dir)
  if (!folder) {
    folder = { files: 0, audio: 0, children: new Set() }
    browse.folders.set(dir, folder)
  }
  return folder
}

function add(browse: Browse, track: Track): void {
  if (browse.byPath.has(track.path)) return
  browse.byPath.set(track.path, track)
  const dir = dirOf(track)
  const list = browse.byDir.get(dir)
  if (list) list.push(track)
  else browse.byDir.set(dir, [track])
  // The folder and every one above it count the file; each one is its parent's child.
  for (let at = dir; ; at = parentOf(at)) {
    const folder = folderAt(browse, at)
    folder.files++
    if (track.kind === 'audio') folder.audio++
    if (at === '') break
    folderAt(browse, parentOf(at)).children.add(at.slice(at.lastIndexOf('/') + 1))
  }
}

function remove(browse: Browse, path: string): void {
  const track = browse.byPath.get(path)
  if (!track) return
  browse.byPath.delete(path)
  const dir = dirOf(track)
  const list = browse.byDir.get(dir)
  if (list) {
    const at = list.indexOf(track)
    if (at !== -1) list.splice(at, 1)
  }
  // Counts come down; the folder itself stays listed, as an empty folder on disk would.
  for (let at = dir; ; at = parentOf(at)) {
    const folder = browse.folders.get(at)
    if (folder) {
      folder.files--
      if (track.kind === 'audio') folder.audio--
    }
    if (at === '') break
  }
}

function load(library: RemoteLibrary): Browse | null {
  const file = indexFileFor(library.path)
  let info: { mtimeMs: number; size: number }
  try {
    info = statSync(file)
  } catch {
    return null
  }
  const journal = sizeOf(patchFileFor(library.path))
  const tracks = loadIndex(library.path)
  // `loadIndex` parks the rows for the scanner's next walk. There is no walk in this process,
  // and a parked reference would keep them alive after the idle drop below let them go.
  takeIndexReplay(library.path)
  if (!tracks) return null
  const browse: Browse = {
    library,
    indexMtimeMs: info.mtimeMs,
    indexSize: info.size,
    journalBytes: journal,
    byPath: new Map(),
    byDir: new Map(),
    folders: new Map([['', { files: 0, audio: 0, children: new Set() }]]),
    idle: null
  }
  for (const track of tracks) add(browse, track)
  return browse
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Folds in whatever has been appended to the journal since it was last read.
 *
 * Whole lines only: a line still being written is left for the next request rather than read
 * torn. Removals before additions within a line, the order `applyPatches` uses.
 */
function foldJournal(browse: Browse, size: number): void {
  const file = patchFileFor(browse.library.path)
  const length = size - browse.journalBytes
  if (length <= 0) return
  const buffer = Buffer.alloc(length)
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    readSync(fd, buffer, 0, length, browse.journalBytes)
  } catch {
    return
  } finally {
    if (fd !== null) closeSync(fd)
  }
  const end = buffer.lastIndexOf(10)
  if (end === -1) return
  for (const line of buffer.toString('utf8', 0, end).split('\n')) {
    if (!line) continue
    try {
      const patch = JSON.parse(line) as { removed?: string[]; added?: Track[] }
      for (const path of patch.removed ?? []) remove(browse, path)
      for (const track of patch.added ?? []) {
        if (typeof track.path !== 'string' || typeof track.relDir !== 'string') continue
        remove(browse, track.path)
        add(browse, track)
      }
    } catch {
      // A torn or foreign line costs that line.
    }
  }
  browse.journalBytes += end + 1
}

/**
 * The library's rows, current with the disk, or null when it has never been scanned.
 *
 * A replaced index file - a full scan finished - is reloaded, but not in front of the request
 * that noticed it: that request is answered from the copy already held, and the reload runs
 * right after. Measured on the real library a load is about a second and a half, and a peer
 * browsing a folder would rather see this machine's state from a minute ago than wait for it.
 * The first load has nothing older to answer from, so it is waited for.
 */
function current(library: RemoteLibrary): Browse | null {
  let browse = loaded.get(library.id) ?? null
  let info: { mtimeMs: number; size: number } | null = null
  try {
    info = statSync(indexFileFor(library.path))
  } catch {
    // Gone. Whatever is held describes an index that no longer exists.
  }
  if (!info) {
    if (browse) drop(library.id)
    return null
  }

  if (!browse) {
    browse = load(library)
    if (!browse) return null
    loaded.set(library.id, browse)
  } else if (browse.indexMtimeMs !== info.mtimeMs || browse.indexSize !== info.size) {
    if (!reloading.has(library.id)) {
      reloading.add(library.id)
      setImmediate(() => {
        reloading.delete(library.id)
        const fresh = load(library)
        const held = loaded.get(library.id)
        if (held?.idle) clearTimeout(held.idle)
        if (fresh) loaded.set(library.id, fresh)
        else loaded.delete(library.id)
        if (fresh) touch(fresh)
      })
    }
  } else {
    const journal = sizeOf(patchFileFor(library.path))
    // A journal that shrank was replaced, which only happens beside a new index - caught above
    // on the next request. One that grew has new lines.
    if (journal > browse.journalBytes) foldJournal(browse, journal)
  }
  touch(browse)
  return browse
}

function touch(browse: Browse): void {
  if (browse.idle) clearTimeout(browse.idle)
  browse.idle = setTimeout(() => drop(browse.library.id), IDLE_MS)
  browse.idle.unref?.()
}

function drop(id: string): void {
  const held = loaded.get(id)
  if (held?.idle) clearTimeout(held.idle)
  loaded.delete(id)
}

/** Lets go of everything, for a server that is stopping or being reconfigured. */
export function dropAllBrowsing(): void {
  for (const id of [...loaded.keys()]) drop(id)
}

/* ------------------------------------------------------------------ annotations */

interface Annotations {
  ratings: Record<string, number>
  tags: Record<string, string[]>
  detectedBpm: Record<string, number>
  detectedKey: Record<string, string>
}

let annotations: { mtimeMs: number; value: Annotations } | null = null

/**
 * The ratings, tags and detected values, from the data file, read again only when it moves.
 * `/metadata` reads it per request; a listing every few hundred milliseconds would make that
 * a 500KB parse per tap.
 */
function annotationsOf(dataDir: string): Annotations {
  const file = join(dataDir, 'umakbang-data.json')
  const empty: Annotations = { ratings: {}, tags: {}, detectedBpm: {}, detectedKey: {} }
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return annotations?.value ?? empty
  }
  if (annotations && annotations.mtimeMs === mtimeMs) return annotations.value
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Annotations>
    const value: Annotations = {
      ratings: data.ratings ?? {},
      tags: data.tags ?? {},
      detectedBpm: data.detectedBpm ?? {},
      detectedKey: data.detectedKey ?? {}
    }
    annotations = { mtimeMs, value }
    return value
  } catch {
    // Mid-write: answer with what was read last time rather than with nothing.
    return annotations?.value ?? empty
  }
}

const keyOf = (track: Track): string => track.pathKey ?? track.path

/** What the window knows about these rows beyond the index, so the phone needs no `/metadata`. */
function metaFor(rows: Track[], notes: Annotations): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  for (const track of rows) {
    const key = keyOf(track)
    const entry: Record<string, unknown> = {}
    if (notes.ratings[key] !== undefined) entry.rating = notes.ratings[key]
    if (notes.tags[key] !== undefined) entry.tags = notes.tags[key]
    if (notes.detectedBpm[key] !== undefined) entry.detectedBpm = notes.detectedBpm[key]
    if (notes.detectedKey[key] !== undefined) entry.detectedKey = notes.detectedKey[key]
    if (Object.keys(entry).length > 0) meta[key] = entry
  }
  return meta
}

/**
 * A row as the search sees it: with the tempo and key the window would show for it.
 *
 * The desktop folds detected values into its rows on arrival (`addTracks`), so its search box
 * finds `bpm>140` on a file whose tempo came from analysis. The rows here come off the index,
 * which holds only what the file declared, so the same query has to see the same values or the
 * two would disagree about what matches. A shallow copy, so nothing held is changed.
 */
function asSearched(track: Track, notes: Annotations): Track {
  const key = keyOf(track)
  const bpm = track.bpm ?? notes.detectedBpm[key]
  const musicalKey = track.musicalKey ?? notes.detectedKey[key]
  if (bpm === track.bpm && musicalKey === track.musicalKey) return track
  return { ...track, bpm, musicalKey }
}

/* ------------------------------------------------------------------ the routes */

/**
 * A folder path from the request, as the index spells it: forward slashes, no leading or
 * trailing slash, `''` for the library folder. Null for anything that tries to climb or that
 * carries a NUL - nothing here opens files, but the answer should never depend on how loosely
 * a path was spelled.
 */
function folderParam(raw: string | null): string | null {
  const value = (raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (value.includes('\0')) return null
  if (value.split('/').some((segment) => segment === '..')) return null
  return value
}

function within(dir: string, scope: string): boolean {
  return scope === '' || dir === scope || dir.startsWith(`${scope}/`)
}

function count(raw: string | null, fallback: number, max: number): number {
  const value = raw === null ? fallback : Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(value, max)
}

export function listFolder(library: RemoteLibrary, params: URLSearchParams, dataDir: string): Answer {
  const dir = folderParam(params.get('dir'))
  if (dir === null) return { status: 400 }
  const browse = current(library)
  if (!browse) return { status: 404 }
  // A folder that is not there is a 404 rather than an empty listing, so the phone knows it
  // is standing somewhere that has gone and walks back up.
  const folder = browse.folders.get(dir)
  if (!folder) return { status: 404 }

  const audioOnly = params.get('audioOnly') === '1'
  const sortParam = params.get('sort') as SortKey | null
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : 'mtimeMs'
  const order = params.get('order') === 'asc' ? 'asc' : 'desc'
  const offset = count(params.get('offset'), 0, Number.MAX_SAFE_INTEGER)
  const limit = count(params.get('limit'), 500, 2000)
  const notes = annotationsOf(dataDir)

  const files = (browse.byDir.get(dir) ?? []).filter((track) => !audioOnly || track.kind === 'audio')
  if (sort === 'rating') {
    // `compareTracks` has no rating case - ratings are not on the row - so highest first here,
    // then by name, which is what the desktop does with the same column.
    const sign = order === 'asc' ? 1 : -1
    files.sort((a, b) => {
      const diff = (notes.ratings[keyOf(a)] ?? 0) - (notes.ratings[keyOf(b)] ?? 0)
      return diff !== 0 ? sign * diff : compareTracks(a, b, 'name', 'asc')
    })
  } else {
    files.sort((a, b) => compareTracks(a, b, sort, order))
  }
  const page = files.slice(offset, offset + limit)

  const prefix = dir === '' ? '' : `${dir}/`
  const folders = [...folder.children]
    .sort((a, b) => COLLATOR.compare(a, b))
    .map((name) => {
      const child = browse.folders.get(prefix + name)
      return { name, files: child?.files ?? 0, audio: child?.audio ?? 0 }
    })

  return {
    status: 200,
    body: {
      dir,
      folders,
      files: page,
      total: files.length,
      meta: metaFor(page, notes),
      generation: browse.indexMtimeMs
    }
  }
}

export function searchLibrary(library: RemoteLibrary, params: URLSearchParams, dataDir: string): Answer {
  const q = (params.get('q') ?? '').trim()
  if (!q) return { status: 400 }
  const scope = folderParam(params.get('within'))
  if (scope === null) return { status: 400 }
  const parsed = parseQuery(q)
  if (isEmptyQuery(parsed)) return { status: 400 }
  const browse = current(library)
  if (!browse) return { status: 404 }

  const audioOnly = params.get('audioOnly') === '1'
  const limit = count(params.get('limit'), 300, 1000)
  const notes = annotationsOf(dataDir)
  const context = { ratings: notes.ratings, tags: notes.tags }

  // One pass, as the desktop's search box does on every keystroke.
  const hits: Array<{ track: Track; score: number }> = []
  for (const track of browse.byPath.values()) {
    if (audioOnly && track.kind !== 'audio') continue
    if (!within(dirOf(track), scope)) continue
    const seen = asSearched(track, notes)
    if (!matchesQuery(seen, parsed, context)) continue
    hits.push({ track: seen, score: parsed.terms.length > 0 ? scoreMatch(seen, parsed) : 0 })
  }
  hits.sort((a, b) => b.score - a.score || compareTracks(a.track, b.track, 'name', 'asc'))
  const files = hits.slice(0, limit).map((hit) => hit.track)

  return {
    status: 200,
    body: {
      files,
      matched: hits.length,
      truncated: hits.length > limit,
      meta: metaFor(files, notes),
      generation: browse.indexMtimeMs
    }
  }
}

export function randomFile(library: RemoteLibrary, params: URLSearchParams): Answer {
  const scope = folderParam(params.get('within'))
  if (scope === null) return { status: 400 }
  const browse = current(library)
  if (!browse) return { status: 404 }
  const pool: Track[] = []
  for (const track of browse.byPath.values()) {
    if (track.playable && track.kind === 'audio' && within(dirOf(track), scope)) pool.push(track)
  }
  if (pool.length === 0) return { status: 404 }
  return { status: 200, body: pool[Math.floor(Math.random() * pool.length)] }
}

/** Most `rel`s one `/stat` answers, so a request cannot ask for the whole index at once. */
const STAT_LIMIT = 200

export function statFiles(library: RemoteLibrary, params: URLSearchParams): Answer {
  const rels = params.getAll('rel').slice(0, STAT_LIMIT)
  const browse = current(library)
  if (!browse) return { status: 404 }
  const files: Record<string, { size: number; mtimeMs: number }> = {}
  // From the index, not the disk: the index is what the phone was shown, and a stat per
  // saved file per launch is not worth what it would tell it.
  const lookup = (path: string): Track | undefined => {
    const dir = parentOf(path)
    const name = path.slice(path.lastIndexOf('/') + 1)
    return browse.byDir.get(dir)?.find((row) => row.name === name)
  }
  for (const rel of rels) {
    const clean = folderParam(rel)
    if (!clean) continue
    /*
     * Either spelling of the path. The wire form is within the library with no label, but
     * every row a listing hands out carries `rel` *with* this machine's label in front - so a
     * peer echoing back the `rel` it was given was told nothing matched, which reads exactly
     * like "gone on that machine". The label-free form is tried first, so a real subfolder that
     * happens to share the label's name still resolves to itself.
     */
    let track = lookup(clean)
    const cut = clean.indexOf('/')
    if (!track && cut !== -1 && clean.slice(0, cut) === labelOf(browse)) track = lookup(clean.slice(cut + 1))
    if (track) files[rel] = { size: track.size, mtimeMs: track.mtimeMs }
  }
  return { status: 200, body: { files } }
}

/**
 * The label the index's rows carry in front of their `rel` and `relDir`. Taken from the rows
 * rather than from the settings, since the rows are what a peer was shown.
 */
function labelOf(browse: Browse): string {
  for (const track of browse.byPath.values()) {
    const cut = track.relDir.indexOf('/')
    return cut === -1 ? track.relDir : track.relDir.slice(0, cut)
  }
  return browse.library.label
}
