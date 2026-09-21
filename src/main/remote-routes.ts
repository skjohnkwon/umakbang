/**
 * Resolving a path that arrived over a socket, which is the one piece of security Tailscale
 * cannot do for us.
 *
 * Tailscale authenticates the *device*. It says nothing about what that device asked for, so
 * a traversal bug here hands the whole filesystem to anything that can reach the port - and
 * inside a tailnet, that is every machine the user owns plus anything running on them. This
 * is the file to be paranoid in.
 *
 * Kept apart from the server so the check can be read, and reasoned about, without the
 * request plumbing around it.
 */

import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { RemoteLibrary } from '../shared/types'

/**
 * An absolute path inside `library`, or null if the request has no business being answered.
 *
 * Null covers every refusal on purpose - traversal, a missing file, a symlink pointing out
 * of the tree, a NUL byte - because the caller answers all of them with the same 404. A
 * response that distinguished "outside the library" from "not there" would let anyone on the
 * tailnet map the disk one request at a time.
 */
export function resolveInLibrary(library: RemoteLibrary, rel: string): string | null {
  // A NUL truncates the path at the syscall boundary, so `a\0../../etc` can pass a string
  // check and open something else entirely.
  if (!rel || rel.includes('\0')) return null

  /**
   * The path is within the root, with no label on it.
   *
   * It used to strip a leading label, which was wrong twice over. A label is the *local*
   * name for a folder - the same library is `SECRET SAUCE` here and `SECRET SAUCE (jkpc)`
   * on the machine that mounted it - so it could never be agreed on across the wire. And
   * stripping one made a real subfolder of that name unreachable: `SECRET SAUCE/x.wav`
   * under a root labelled `SECRET SAUCE` resolved to the file one level up.
   */
  const within = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const candidate = resolve(library.path, within)

  try {
    // Both sides resolved, because the check has to hold against symlinks. A link inside the
    // library pointing at `/etc` is a real path out of the tree, and comparing the *asked
    // for* path would never see it.
    const root = realpathSync(library.path)
    const real = realpathSync(candidate)
    if (real !== root && !real.startsWith(root + sep)) return null
    return real
  } catch {
    // Missing, unreadable, or a broken link. Not there is not there.
    return null
  }
}

/**
 * A path the project recorded, as a path within the library - or null if it is not in it.
 *
 * Case-insensitively, and with separators folded, because a project records whatever FL
 * happened to write: `z:\SECRET SAUCE\...` against a root of `Z:\SECRET SAUCE`. Windows
 * disagrees with itself about both, and refusing a sample over the case of a drive letter
 * would drop files out of a package for no reason.
 *
 * Null is the ordinary answer for factory content and for anything living outside the
 * library - it is not an error, it just cannot be served from here.
 */
export function relativeToLibrary(library: RemoteLibrary, absolute: string): string | null {
  const fold = (value: string): string =>
    value.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
  const root = fold(library.path)
  const target = fold(absolute)
  const slashed = absolute.split('\\').join('/')
  if (target === root) return ''
  if (target.startsWith(`${root}/`)) {
    // The tail keeps its own spelling; only the root's prefix was matched loosely.
    return slashed.slice(library.path.length).replace(/^\/+/, '')
  }

  /*
   * The library has moved since the project was saved.
   *
   * Projects here record `A:\SECRET SAUCE\...` against a library now at `Z:\SECRET SAUCE` -
   * a drive letter that was reassigned years ago, or a whole different machine. The files
   * are the same files; only the road to them changed, and refusing them would mean packing
   * worked for nothing older than the last time the drive was re-lettered.
   *
   * So the root's own folder name is looked for inside the recorded path, and whatever
   * follows it is tried as a path within the library. `resolveInLibrary` still has to agree
   * the file is there, so a wrong guess costs nothing but a `stat`.
   *
   * Folding neither changes a string's length nor moves its separators, so an index found
   * in the folded copy is the same index in the original.
   */
  const base = root.split('/').pop()
  if (base) {
    const marker = `/${base}/`
    const at = target.indexOf(marker)
    if (at !== -1) return slashed.slice(at + marker.length)
  }
  return null
}

/**
 * The path inside FL's user data folder, or null when this is not one of those.
 *
 * FL records `%FLStudioUserData%\Audio\Rendered\...` for consolidated tracks - a variable
 * rather than a path, because the folder moves and FL knows where it put it. Everything
 * under it is the project's own audio, so it has to come with a package, and it is the one
 * place outside a library that does.
 */
export function flRelative(recorded: string): string | null {
  const match = /^%FLStudioUserData%[\\/]*(.*)$/i.exec(recorded)
  if (!match) return null
  return match[1].split('\\').join('/')
}

/**
 * A path within a given root, or null - the same containment `resolveInLibrary` does.
 *
 * Both sides realpath'd, because the check has to hold against symlinks: a link inside the
 * folder pointing at `/etc` is a real path out of it, and comparing what was asked for
 * would never see that.
 */
export function resolveUnder(root: string, rel: string): string | null {
  if (!root || !rel || rel.includes('\0')) return null
  const within = rel.split('\\').join('/').replace(/^\/+/, '')
  const candidate = resolve(root, within)
  try {
    const base = realpathSync(root)
    const real = realpathSync(candidate)
    if (real !== base && !real.startsWith(base + sep)) return null
    return real
  } catch {
    return null
  }
}

/**
 * The byte range a request asked for, clamped to the file.
 *
 * Only the single `bytes=a-b` form, which is what a media element sends. Multipart ranges
 * are a different response shape for no gain here, and an unsatisfiable range is a 416
 * rather than a silent whole-file reply, because a player that seeks past the end should
 * learn that rather than start again from the top.
 */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'invalid'

  // `bytes=-500` is the last 500 bytes, not a range starting at zero.
  if (!rawStart) {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return 'invalid'
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(start) || start >= size || end < start) return 'invalid'
  return { start, end }
}
