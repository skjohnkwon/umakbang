/**
 * The `.umak` bundle: everything umakbang remembers, in one file.
 *
 * A settings export (`.json`) carries the part nobody can reproduce - tags, ratings,
 * analysed tempo and key, preferences. What it deliberately leaves out is everything the
 * app can work out again: the file index, the probe results, the cached waveforms. On a
 * machine that already has the library that is the right trade, because those three are
 * derived data and re-deriving them is a scan.
 *
 * It is the wrong trade when the scan is the expensive part. Measured on this library the
 * index is 223MB, the metadata cache 69MB and the peaks 11MB, and a first launch spends
 * the better part of a minute rebuilding them. Gzipped together they are 22MB, so the whole
 * profile fits in a file small enough to keep beside a project.
 *
 * ## Format
 *
 * One gzip stream over NDJSON. The first line is the header; after that a line carrying a
 * `section` key opens a section and every line until the next one is a record of it:
 *
 * ```
 * {"kind":"umakbang-bundle","version":1,...}
 * {"section":"settings"}
 * {...the same object a .json export writes...}
 * {"section":"index","root":"Z:\\SAMPLES"}
 * {...one Track per line, verbatim from the index...}
 * {"section":"metadata"}
 * {...one probe result per line, verbatim from the cache...}
 * {"section":"peaks"}
 * {"p":"Z:\\SAMPLES\\kick.wav","d":"<base64>"}
 * ```
 *
 * Not a zip and not a hand-rolled container with an offset table. Three of the four
 * sections are already NDJSON on disk, so writing is a copy through a gzip stream and
 * reading is a line reader; nothing is ever held whole in memory at either end. Random
 * access would buy nothing, because there is no case for reading one section and not the
 * rest - except the header, and the header is first precisely so the import screen can
 * describe the file after reading a few hundred bytes of it.
 *
 * Records may not carry a `section` key. Tracks and cache entries don't, and the peaks
 * lines are written here, so that is a constraint on this file rather than a risk.
 */

import type { LibraryRoot } from './types'

/** gzip's magic number, which is how an import tells a bundle from a `.json` export. */
export const GZIP_MAGIC = [0x1f, 0x8b]

export const BUNDLE_EXTENSION = 'umak'

export type BundleSection = 'settings' | 'index' | 'indexPatch' | 'metadata' | 'peaks'

/** Opens a section. `root` is set on `index` and `indexPatch`, naming which library folder. */
export interface SectionMarker {
  section: BundleSection
  root?: string
}

/**
 * The first line, and everything the import screen needs to describe the file.
 *
 * The counts are what could be known without a pre-pass: the settings side is already in
 * memory and the caches are described by their size on disk rather than by a line count,
 * since counting lines would mean reading 300MB before writing the first byte of a file
 * whose whole point is that it streams.
 */
export interface BundleHeader {
  kind: 'umakbang-bundle'
  version: 1
  exportedAt: string
  /** The umakbang that wrote it, for a person reading the file rather than for the code. */
  app: string
  /** Which platform's paths are inside, so an import can say the folders won't match. */
  style: 'windows' | 'posix'
  /** Every library folder, with the labels that `Track.rel` is built from. */
  exportedRoots: LibraryRoot[]
  counts: {
    tags: number
    ratings: number
    detectedBpm: number
    detectedKey: number
    peaks: number
    /** Uncompressed bytes of index and metadata, summed. Zero when they weren't included. */
    cacheBytes: number
  }
}

export function isSectionMarker(line: unknown): line is SectionMarker {
  return typeof (line as SectionMarker)?.section === 'string'
}

export function isBundleHeader(value: unknown): value is BundleHeader {
  const header = value as BundleHeader
  return header?.kind === 'umakbang-bundle' && header.version === 1
}

/**
 * What a bundle can be restored into on this machine.
 *
 * Everything in the caches is keyed by absolute path, and unlike tags and ratings there is
 * no point asking the user where those folders went: the index and the probe cache are
 * derived data, so a folder that moved is a folder whose cache is worth exactly one rescan.
 * The settings still go through the mapping wizard as they always did; only the caches are
 * all-or-nothing on the paths matching.
 */
export interface BundleFit {
  /** Roots from the bundle that exist here at the same absolute path. */
  present: LibraryRoot[]
  /** Roots that don't. Their index and metadata are skipped. */
  missing: LibraryRoot[]
}

export function describeFit(fit: BundleFit): string {
  if (fit.missing.length === 0) return ''
  const names = fit.missing.map((root) => root.label).join(', ')
  return fit.present.length === 0
    ? `None of the library folders in this file are on this machine (${names}), so the index and probe cache will be skipped and rebuilt by a scan.`
    : `${names} ${fit.missing.length === 1 ? 'is' : 'are'} not on this machine, so ${
        fit.missing.length === 1 ? 'its' : 'their'
      } index and probe cache will be skipped and rebuilt by a scan.`
}
