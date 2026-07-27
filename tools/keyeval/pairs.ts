/**
 * Finding the same music twice.
 *
 * A library that holds both a master and its MP3 is a labelled set nobody had to label: the
 * two files are one performance, so any disagreement between them is a detector
 * contradicting itself. Shared by `consistency.ts` and `variants.ts`, which both need the
 * pairs and neither should own the other's copy of finding them.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join, extname, basename, dirname } from 'node:path'
import type { AudioBufferLike } from '../../src/renderer/src/lib/dsp'

const AUDIO = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3'])
/** The suffix a bounce picks up on the way to being finished. */
const TRAILING = /[ _-]*(master(ed)?|final|mixdown|mix|bounce|v\d+)$/i

export const LOSSLESS = /\.(wav|aiff?|flac)$/i
export const LOSSY = /\.mp3$/i

/**
 * Files that are the same music under two extensions, grouped.
 *
 * Only files in the same folder are grouped: the same name in two folders is usually two
 * different beats rather than one track twice. Anything under a megabyte is a one-shot or a
 * loop, which has no key to disagree about.
 */
export function findGroups(root: string): string[][] {
  const by = new Map<string, string[]>()

  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // An unreadable folder is not worth stopping a sweep of a whole library for.
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!AUDIO.has(extname(entry.name).toLowerCase())) continue
      try {
        if (statSync(full).size < 1_000_000) continue
      } catch {
        continue
      }
      const stem = basename(entry.name, extname(entry.name))
        .toLowerCase()
        .replace(TRAILING, '')
        .trim()
      const key = `${dirname(full).toLowerCase()} ${stem}`
      const list = by.get(key)
      if (list) list.push(full)
      else by.set(key, [full])
    }
  }
  walk(root)

  const groups: string[][] = []
  for (const files of by.values()) {
    if (files.length < 2) continue
    if (new Set(files.map((f) => extname(f).toLowerCase())).size < 2) continue
    groups.push(files.sort())
  }
  return groups
}

/** Spread the sample across the library, not the first N from one production run. */
export function sampleGroups(groups: string[][], limit: number): string[][] {
  const step = Math.max(1, Math.floor(groups.length / limit))
  return groups.filter((_, i) => i % step === 0).slice(0, limit)
}

/** Decodes through ffmpeg into the shape the renderer hands the detector. */
export function load(path: string, seconds = 65): AudioBufferLike | null {
  try {
    const raw = execFileSync(
      'ffmpeg',
      // eslint-disable-next-line
      ['-v', 'error', '-i', path, '-t', String(seconds), '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', '44100', '-'],
      { maxBuffer: 1 << 30, timeout: 60000 }
    )
    const inter = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const frames = Math.floor(inter.length / 2)
    if (frames < 44100 * 5) return null
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = inter[i * 2]
      right[i] = inter[i * 2 + 1]
    }
    return {
      numberOfChannels: 2,
      length: frames,
      sampleRate: 44100,
      duration: frames / 44100,
      getChannelData: (c: number) => (c === 0 ? left : right)
    }
  } catch {
    return null
  }
}

/** One lossless and one lossy file of the same length, or nothing. */
export function pairOf(group: string[]): [string, string] | null {
  const lossless = group.find((f) => LOSSLESS.test(f))
  const lossy = group.find((f) => LOSSY.test(f))
  return lossless && lossy ? [lossless, lossy] : null
}
