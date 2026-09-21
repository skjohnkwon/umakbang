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

  // The index prefixes every relative path with the root's *label*, which the user can
  // rename - so it is stripped by agreement rather than derived from the folder name.
  let within = rel.replace(/\\/g, '/')
  if (within === library.label) within = ''
  else if (within.startsWith(`${library.label}/`)) within = within.slice(library.label.length + 1)

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
