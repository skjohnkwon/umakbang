import { useMemo } from 'react'
import type { SortKey, Track, TrackKind } from '@shared/types'
import { useLibrary } from '@/state/library'
import { compareTracks, isEmptyQuery, matchesQuery, parseQuery, scoreMatch } from '@/lib/search'
import { isUnderAnyDir, relativePath, samePath } from '@/lib/paths'
// The same rule the stats page folds by, imported rather than restated - see `workOf`.
import { workOf } from '@/lib/stats'

export interface FolderNode {
  name: string
  /** Path relative to the library root, forward slashes. '' is the root itself. */
  path: string
  children: FolderNode[]
  /** Files sitting directly in this folder - lets folder view skip scanning the index. */
  files: Track[]
  /** Files in this folder and everything below it. */
  totalCount: number
  /** Newest mtime anywhere beneath this folder, so folder rows can show a date. */
  latestMtime: number
}

export interface FolderTree {
  root: FolderNode
  /** Every folder by its relative path, for O(1) lookup when navigating. */
  index: Map<string, FolderNode>
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function makeNode(name: string, path: string): FolderNode {
  return { name, path, children: [], files: [], totalCount: 0, latestMtime: 0 }
}

/**
 * The tree is built incrementally and cached across renders.
 *
 * A scan appends to a stable `tracks` array, so folding in only the newly-arrived tail is
 * enough. Rebuilding from scratch each tick meant re-walking every path and re-sorting
 * every folder - at 250k files that blocked the main thread long enough for Windows to
 * declare the window unresponsive.
 */
interface TreeCache extends FolderTree {
  tracks: Track[]
  /** How many entries of `tracks` have been folded in. */
  processed: number
  /** The set of hand-held folders this cache was built against. */
  extras: Set<string>
}

let cache: TreeCache | null = null

function buildTree(tracks: Track[], extraDirs: Set<string>): FolderTree {
  let fresh = false
  // Nodes can be grafted on but not pruned, so a folder leaving the hand-held set - a
  // deleted or renamed empty folder - means starting the tree over. That only happens on
  // an explicit action, never during a scan.
  const pruned = cache !== null && cache.extras !== extraDirs && !covers(extraDirs, cache.extras)

  if (!cache || cache.tracks !== tracks || cache.processed > tracks.length || pruned) {
    const root = makeNode('', '')
    cache = { tracks, processed: 0, root, index: new Map([['', root]]), extras: extraDirs }
    fresh = true
  }

  if (!fresh && cache.processed === tracks.length && cache.extras === extraDirs) return cache

  // Only folders that gained a child need re-sorting.
  const dirty = new Set<FolderNode>()

  for (let i = cache.processed; i < tracks.length; i++) {
    const track = tracks[i]
    const root = cache.root
    root.totalCount++
    if (track.mtimeMs > root.latestMtime) root.latestMtime = track.mtimeMs

    if (!track.relDir) {
      root.files.push(track)
      continue
    }

    let parent = root
    let accumulated = ''
    let start = 0
    const relDir = track.relDir

    // Manual segment walk; split() would allocate an array per file.
    while (start <= relDir.length) {
      let slash = relDir.indexOf('/', start)
      if (slash === -1) slash = relDir.length
      const segment = relDir.slice(start, slash)
      accumulated = accumulated ? `${accumulated}/${segment}` : segment

      let node = cache.index.get(accumulated)
      if (!node) {
        node = makeNode(segment, accumulated)
        cache.index.set(accumulated, node)
        parent.children.push(node)
        dirty.add(parent)
      }
      node.totalCount++
      if (track.mtimeMs > node.latestMtime) node.latestMtime = track.mtimeMs

      parent = node
      start = slash + 1
      if (slash === relDir.length) break
    }

    parent.files.push(track)
  }

  cache.processed = tracks.length

  // Folders holding nothing indexable - a new one, or one you just pasted - have no file
  // to put them in the tree, so they're grafted on by hand.
  if (fresh || cache.extras !== extraDirs) {
    for (const dir of extraDirs) ensureDir(cache, dir, dirty)
    cache.extras = extraDirs
  }

  for (const node of dirty) node.children.sort((a, b) => COLLATOR.compare(a.name, b.name))

  return cache
}

/** True if `next` holds everything `previous` did. */
function covers(next: Set<string>, previous: Set<string>): boolean {
  for (const entry of previous) if (!next.has(entry)) return false
  return true
}

/** Creates whatever nodes a folder path needs, and returns nothing it didn't already have. */
function ensureDir(tree: TreeCache, rel: string, dirty: Set<FolderNode>): void {
  if (!rel || tree.index.has(rel)) return
  let parent = tree.root
  let accumulated = ''
  for (const segment of rel.split('/')) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    let node = tree.index.get(accumulated)
    if (!node) {
      node = makeNode(segment, accumulated)
      tree.index.set(accumulated, node)
      parent.children.push(node)
      dirty.add(parent)
    }
    parent = node
  }
}

export function useFolderTree(): FolderTree {
  const tracks = useLibrary((s) => s.tracks)
  // Structure only - metadata arriving for 250k files must not touch the tree.
  const structureRevision = useLibrary((s) => s.structureRevision)
  const extraDirs = useLibrary((s) => s.extraDirs)
  const roots = useLibrary((s) => s.roots)

  // Every library folder is held in the tree by hand, on the same footing as an empty
  // folder somebody just created. The tree is derived from files, so a folder that holds
  // no audio at all - or one whose scan hasn't reached it yet - would otherwise not be in
  // the sidebar, and a folder you just added appearing to do nothing is indistinguishable
  // from it having failed.
  const held = useMemo(() => {
    const next = new Set(extraDirs)
    for (const root of roots) next.add(root.label)
    return next
  }, [extraDirs, roots])

  return useMemo(
    () => buildTree(tracks, held),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, structureRevision, held]
  )
}

/**
 * A row in the main table. Browsing a folder shows its subfolders first and then its own
 * files, the way a file manager does; searching or a saved view flattens to files only.
 *
 * `renders` is set only when `Settings.collapseRenders` folded siblings into this row, and
 * only when there was more than one: it is how many files the row stands for, itself
 * included. The row is still one real file at one real path, so `rowId` and everything
 * built on it - selection, drag, the menu, playback - are untouched.
 */
export type Row =
  | { type: 'folder'; node: FolderNode }
  | { type: 'file'; track: Track; renders?: number }

/** The sort in force for what's on screen - per folder, with a library-wide fallback. */
export function useSort(): { key: SortKey; dir: 'asc' | 'desc' } {
  const view = useLibrary((s) => s.view)
  const key = useLibrary((s) => s.settings.sortKey)
  const dir = useLibrary((s) => s.settings.sortDir)
  const folderSort = useLibrary((s) => s.settings.folderSort)

  const remembered = view.mode === 'folder' ? folderSort[view.dir] : undefined
  return remembered ?? { key, dir }
}

export function useVisibleRows(): Row[] {
  const tracks = useLibrary((s) => s.tracks)
  const revision = useLibrary((s) => s.revision)
  const view = useLibrary((s) => s.view)
  const query = useLibrary((s) => s.query)
  const recursive = useLibrary((s) => s.recursive)
  const tags = useLibrary((s) => s.tags)
  const { key: sortKey, dir: sortDir } = useSort()
  const typeFilter = useLibrary((s) => s.typeFilter)
  const tagFilter = useLibrary((s) => s.tagFilter)
  const ratings = useLibrary((s) => s.ratings)
  const downloads = useLibrary((s) => s.downloads)
  const roots = useLibrary((s) => s.roots)
  const collapseRenders = useLibrary((s) => s.settings.collapseRenders)
  // Only so a folded group can be represented by the file that was revealed into it. Read
  // even when collapsing is off, because a hook cannot be called conditionally.
  const selectedPath = useLibrary((s) => s.selectedPath)
  const { index } = useFolderTree()

  return useMemo(() => {
    const parsed = parseQuery(query)
    const searching = !isEmptyQuery(parsed)
    const context = { ratings, tags }

    // A tag filter has to apply to folders too, or the answer to "show me the flips" is a
    // list of flips underneath a full set of folders that hold none. Rather than walking
    // the subtree per folder - which on a 300k library is a scan per row - this works from
    // the tagged paths themselves, of which there are only ever as many as were typed by
    // hand. A folder survives if it is tagged, or if anything tagged lives beneath it.
    const taggedUnder: string[] | null =
      tagFilter.length === 0 || roots.length === 0
        ? null
        : Object.entries(tags).flatMap(([path, applied]) => {
            if (!applied.some((tag) => tagFilter.includes(tag))) return []
            const rel = relativePath(roots, path)
            return rel === null ? [] : [rel]
          })
    // Which of those are folders: anything the tree knows by that path. A tagged file's
    // relative path is never a node, so this separates the two without a second lookup.
    const taggedDirs = (taggedUnder ?? []).filter((path) => index.has(path))
    const keepFolder = (path: string): boolean =>
      taggedUnder === null ||
      taggedUnder.some((hit) => samePath(hit, path) || hit.toLowerCase().startsWith(`${path.toLowerCase()}/`)) ||
      // A folder *inside* a tagged folder inherits the tag the same way its files do in
      // `narrowed` below - without this the tagged folder opened onto its files and none
      // of its subfolders, making their contents unreachable.
      isUnderAnyDir(path, taggedDirs)


    const { kinds, exts } = typeFilter
    // Within a list the entries are ORed; the lists are ANDed with each other, so
    // "audio" + "wav/aiff" + tagged "keeper" narrows the way you'd expect.
    const narrowed = (files: Track[]): Track[] => {
      if (kinds.length === 0 && exts.length === 0 && tagFilter.length === 0) return files
      return files.filter(
        (t) =>
          (kinds.length === 0 || kinds.includes(t.kind)) &&
          (exts.length === 0 || exts.includes(t.ext)) &&
          (tagFilter.length === 0 ||
            tagFilter.some((tag) => tags[t.pathKey ?? t.path]?.includes(tag)) ||
            // A tag on a folder is a statement about what's in it, so its files answer to
            // it too. Without this, filtering by a tag you only ever put on a folder
            // showed the folder and then nothing at all once you opened it.
            isUnderAnyDir(t.relDir, taggedDirs))
      )
    }

    const sortFiles = (files: Track[]): Track[] => {
      const result = files.slice()
      // Relevance beats the column sort while a text search is active - that's the whole
      // point of typing one. Field-only filters (kind:, bpm>) keep the chosen sort.
      if (parsed.terms.length > 0) {
        // Scored once per row, not inside the comparator: scoring lowercases and scans
        // the name and path, and a comparator recomputes both sides log(n) times each.
        const scores = new Map<Track, number>()
        for (const track of result) scores.set(track, scoreMatch(track, parsed))
        result.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
      } else if (sortKey === 'rating') {
        // Ratings live in the store rather than on the track, so they sort here.
        const sign = sortDir === 'asc' ? 1 : -1
        result.sort((a, b) => {
          // The field rather than a `pathKey` call: this is a comparator, so it runs
          // n log n times, and the composed spelling is already sitting on the track.
          const diff = (ratings[a.pathKey ?? a.path] ?? 0) - (ratings[b.pathKey ?? b.path] ?? 0)
          return diff !== 0 ? sign * diff : compareTracks(a, b, 'name', 'asc')
        })
      } else {
        result.sort((a, b) => compareTracks(a, b, sortKey, sortDir))
      }
      return result
    }

    /**
     * Turns the files that are going to be shown into rows, folding a track's renders into
     * one row first when the setting asks for it.
     *
     * The fold runs here rather than over the index: by this point the list has already been
     * cut down to one folder, or to what a search matched, so the pass is over what is about
     * to be drawn rather than over 326k tracks. With the setting off it is a single boolean
     * and the work below is exactly what it always was.
     *
     * The fold is by name, so `X.wav` and `X.mp3` that are genuinely two different
     * recordings come out as one row. That is a known and accepted false positive: nothing
     * is hidden that the toggle doesn't put straight back, and the alternative - comparing
     * audio - costs a decode per file to answer a question about a naming habit.
     */
    const fileRows = (files: Track[]): Row[] => {
      if (!collapseRenders) return sortFiles(files).map((track) => ({ type: 'file', track }))

      // One pass, and the two Maps are sized by the number of *works* rather than by the
      // number of files. The largest render represents its work - the master rather than the
      // MP3 beside it - which is the choice `computeMusicStats` makes; a later, bigger render
      // replaces the one already standing in `out` in place, so the folder's own order
      // survives for the sort below to break ties on.
      //
      // Audio only. The `.flp` a bounce came from shares its name and would fold into it, and
      // hiding the project behind the render is the opposite of what the explorer is for.
      const out: Track[] = []
      const at = new Map<string, number>()
      const counts = new Map<Track, number>()
      for (const track of files) {
        if (track.kind !== 'audio') {
          out.push(track)
          continue
        }
        const id = workOf(track)
        const seen = at.get(id)
        if (seen === undefined) {
          at.set(id, out.length)
          out.push(track)
          counts.set(track, 1)
          continue
        }
        const held = out[seen]
        const total = (counts.get(held) ?? 1) + 1
        /**
         * The selected file always represents its own group, whatever its size.
         *
         * Otherwise revealing one - which is what the random button does - selects a path
         * that this fold has just taken off the screen, and the row that stands in its place
         * is a different file with a different name. Nothing looks selected, the scroll has
         * nothing to scroll to, and the beat you were handed is invisible.
         */
        if (track.path === selectedPath || (held.path !== selectedPath && track.size > held.size)) {
          counts.delete(held)
          out[seen] = track
          counts.set(track, total)
        } else {
          counts.set(held, total)
        }
      }

      return sortFiles(out).map((track) => {
        const renders = counts.get(track) ?? 1
        // Only when it stands for more than itself, so a folder where nothing folded is
        // indistinguishable from the setting being off - which is what it should look like.
        return renders > 1 ? { type: 'file', track, renders } : { type: 'file', track }
      })
    }

    const flat = (files: Track[]): Row[] =>
      fileRows(narrowed(searching ? files.filter((t) => matchesQuery(t, parsed, context)) : files))

    // Stats and settings replace the table entirely.
    // The pages that are not a list of files have no rows of their own.
    if (
      view.mode === 'stats' ||
      view.mode === 'settings' ||
      view.mode === 'contracts' ||
      view.mode === 'videos'
    ) {
      return []
    }
    if (view.mode === 'downloads') return flat(downloads)
    if (view.mode === 'rated') {
      return flat(
        tracks.filter((t) => {
          // Field read, not a `pathKey` call: this walks the whole index.
          const rating = ratings[t.pathKey ?? t.path] ?? 0
          return rating >= view.min && rating <= view.max
        })
      )
    }
    if (view.mode === 'all') return flat(tracks)

    const dir = view.dir
    const node = index.get(dir)

    // Searching, or the explicit "include subfolders" toggle, flattens the subtree.
    if (searching || recursive) {
      const collected: Track[] = []
      if (node) collectFiles(node, collected)
      const files = flat(collected)

      // Folders match too, by name, so searching finds the drum kit as well as what is in
      // it. Only on a text search: `bpm>120` and `ext:wav` are questions about files, and
      // answering them with a folder would be answering a different question.
      if (!searching || parsed.terms.length === 0 || !node) return files

      const matched: FolderNode[] = []
      collectFolders(node, matched, parsed.terms)
      // Best match first, the way the files below them are ordered. A search across a
      // library this size can match hundreds of folders, and unsorted they are a wall.
      matched.sort((a, b) => folderScore(b, parsed.terms) - folderScore(a, parsed.terms))
      return [
        ...matched
          .filter((node) => keepFolder(node.path))
          .map((node): Row => ({ type: 'folder', node })),
        ...files
      ]
    }

    const folders: Row[] = (node?.children ?? [])
      .filter((child) => keepFolder(child.path))
      .map((child) => ({ type: 'folder', node: child }))
    // Folders stay alphabetical and always sort above files, as in every file manager.
    // Only the name column flips them, since the other columns don't apply to a folder.
    if (sortKey === 'name' && sortDir === 'desc') folders.reverse()

    // Straight from the tree - no scan of the whole index, which is what makes browsing
    // a 250k-file library stay responsive while it's still being scanned.
    const files = fileRows(narrowed(node?.files ?? []))

    return [...folders, ...files]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tracks,
    revision,
    view,
    query,
    recursive,
    tags,
    sortKey,
    sortDir,
    index,
    typeFilter,
    tagFilter,
    ratings,
    downloads,
    roots,
    collapseRenders,
    // Only matters while collapsing, where it decides which render stands for its group.
    selectedPath
  ])
}

/**
 * Every folder beneath `node` whose own name matches all the search terms.
 *
 * The name rather than the whole path: a path match would return every folder under
 * `Beats` for the term "beats", which is the tree you are already standing in rather than
 * a result.
 */
function collectFolders(node: FolderNode, out: FolderNode[], terms: string[]): void {
  for (const child of node.children) {
    const name = child.name.toLowerCase()
    if (terms.every((term) => name.includes(term))) out.push(child)
    collectFolders(child, out, terms)
  }
}

/**
 * Ranks a matching folder, on the same principle as the file scoring: a name that starts
 * with what you typed is likelier to be the one you meant than one that merely contains
 * it, and a shallow folder likelier than something buried eight levels down.
 */
function folderScore(node: FolderNode, terms: string[]): number {
  const name = node.name.toLowerCase()
  let score = 0
  for (const term of terms) {
    const at = name.indexOf(term)
    if (at === 0) score += 100
    else if (at > 0) score += 60 - Math.min(at, 40)
  }
  if (name.length === terms.join(' ').length) score += 40
  // Depth as a tie-break only.
  score -= Math.min(node.path.split('/').length, 10)
  return score
}

/**
 * Every file at or beneath a folder, appended to `out`.
 *
 * Exported because the delete confirmation describes what a folder is about to take with it,
 * and a second walk written beside this one would be a second answer to the same question.
 */
export function collectFiles(node: FolderNode, out: Track[]): void {
  for (const file of node.files) out.push(file)
  for (const child of node.children) collectFiles(child, out)
}

/**
 * File types present in the library, for the Type filter menu.
 *
 * Only computed while the menu is open - it's a full pass over the index, and running it
 * on every scan tick was part of what made large libraries stall.
 */
export function useAvailableTypes(enabled: boolean): {
  kinds: Array<{ kind: TrackKind; count: number }>
  exts: Array<{ ext: string; count: number }>
} {
  const tracks = useLibrary((s) => s.tracks)
  const structureRevision = useLibrary((s) => s.structureRevision)

  return useMemo(() => {
    if (!enabled) return { kinds: [], exts: [] }

    const kindCounts = new Map<TrackKind, number>()
    const extCounts = new Map<string, number>()
    for (const track of tracks) {
      kindCounts.set(track.kind, (kindCounts.get(track.kind) ?? 0) + 1)
      extCounts.set(track.ext, (extCounts.get(track.ext) ?? 0) + 1)
    }
    return {
      kinds: [...kindCounts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count),
      // Most common first - that's the one you're most likely reaching for.
      exts: [...extCounts.entries()]
        .map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, structureRevision, enabled])
}

/**
 * Finds the FL Studio project a bounce came from, by matching file-name stems.
 *
 * A track and its project almost always share a name - `k.wav` next to `k.flp` - so the
 * project's recorded time is the closest thing to "how long this beat took". A match in
 * the same folder wins over one elsewhere, since the same stem gets reused across years.
 */
export function useProjectFor(track: Track | null): Track | null {
  const tracks = useLibrary((s) => s.tracks)
  const structureRevision = useLibrary((s) => s.structureRevision)
  const revision = useLibrary((s) => s.revision)

  const projectsByStem = useMemo(() => {
    const map = new Map<string, Track[]>()
    for (const candidate of tracks) {
      if (candidate.ext !== 'flp') continue
      const stem = stemOf(candidate.name)
      const list = map.get(stem)
      if (list) list.push(candidate)
      else map.set(stem, [candidate])
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, structureRevision])

  return useMemo(() => {
    if (!track || track.ext === 'flp') return track?.ext === 'flp' ? track : null
    const candidates = projectsByStem.get(stemOf(track.name))
    if (!candidates || candidates.length === 0) return null
    return candidates.find((c) => c.relDir === track.relDir) ?? candidates[0]
    // `revision` so a project's time appearing mid-scan refreshes the readout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, projectsByStem, revision])
}

/** File name without its extension, lower-cased for matching. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase().trim()
}

/**
 * Every tag in use, with counts, commonest first.
 *
 * Ordered by how much is under each rather than by name. Alphabetical reads well in the
 * abstract and is the wrong answer here: the strip is capped and scrolls, so the tags an
 * alphabetical sort puts on screen are whichever happen to start with an early letter, and
 * the one on half the library sits below the fold because it begins with S. Ties go to the
 * name, so the order is stable rather than shuffling as counts drift during a scan.
 */
export function useAllTags(): Array<{ tag: string; count: number }> {
  const tags = useLibrary((s) => s.tags)
  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const list of Object.values(tags)) {
      for (const tag of list) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || COLLATOR.compare(a.tag, b.tag))
  }, [tags])
}
