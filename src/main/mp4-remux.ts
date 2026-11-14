/**
 * Turning a fragmented MP4 into an ordinary one.
 *
 * `MediaRecorder` only ever writes fragmented MP4: a `moov` whose sample tables are empty,
 * followed by a run of `moof`/`mdat` pairs that each carry their own timing. Chromium reads
 * that back happily, which is why the editor can scrub a recording. Nothing else does.
 * Measured on a real 33MB capture from this app: `mvhd` duration **0**, `stts`/`stsc`/`stsz`/
 * `stco` with **zero entries**, no `sidx`, no `mfra`. There is no index mapping a time to a
 * byte offset and no declared length, so Windows Media Player plays it start to finish and
 * cannot seek at all - which is exactly what was reported.
 *
 * So the fragments are read once, folded into the flat sample tables a normal MP4 carries,
 * and the file is rewritten as `ftyp` + `moov` + one `mdat`. The `moov` goes first, which is
 * what "faststart" means and what lets a player seek before it has the whole file.
 *
 * The sample *bytes* are copied verbatim, fragment by fragment, and never decoded - this
 * re-indexes a file, it does not re-encode one. That matters twice over: it is I/O bound
 * rather than CPU bound, and the picture is bit-for-bit what was recorded.
 *
 * No ffmpeg, for the same reason the rest of this feature has none: a packed Electron app
 * cannot count on a system binary.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

/** Sample flag bit meaning "this is not a random-access point". */
const NON_SYNC = 0x0001_0000

interface BoxRef {
  type: string
  /** Offset of the box's own size field. */
  start: number
  size: number
  /** Bytes of header before the payload: 8, or 16 for a 64-bit size. */
  header: number
}

interface Sample {
  /** Absolute offset in the source file. */
  offset: number
  size: number
  /** In the track's own media timescale. */
  duration: number
  /** Composition offset, for streams with B-frames. Zero for everything this app writes. */
  compositionOffset: number
  sync: boolean
  /** Which fragment's `mdat` it came out of, so its new offset can be worked out. */
  fragment: number
}

interface TrackDefaults {
  duration: number
  size: number
  flags: number
}

interface TrackBuild {
  id: number
  samples: Sample[]
  /** The original `trak` box, which supplies everything that is not a sample table. */
  trak: Buffer
}

export interface RemuxResult {
  ok: boolean
  /** Why it was left alone. Absent on success. */
  reason?: string
  samples?: number
  bytes?: number
}

/* --- box reading -------------------------------------------------------------------- */

function boxesIn(buf: Buffer, from = 0, to = buf.length): BoxRef[] {
  const found: BoxRef[] = []
  let at = from
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) break
      size = Number(buf.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      size = to - at
    }
    if (size < header || at + size > to) break
    found.push({ type, start: at, size, header })
    at += size
  }
  return found
}

function child(buf: Buffer, parent: BoxRef, type: string): BoxRef | null {
  const kids = boxesIn(buf, parent.start + parent.header, parent.start + parent.size)
  return kids.find((box) => box.type === type) ?? null
}

function childrenOf(buf: Buffer, parent: BoxRef): BoxRef[] {
  return boxesIn(buf, parent.start + parent.header, parent.start + parent.size)
}

function slice(buf: Buffer, box: BoxRef): Buffer {
  return buf.subarray(box.start, box.start + box.size)
}

/** Reads the top-level boxes without pulling the file into memory. */
async function topLevel(handle: FileHandle, total: number): Promise<BoxRef[]> {
  const found: BoxRef[] = []
  const head = Buffer.alloc(16)
  let at = 0
  while (at + 8 <= total) {
    const { bytesRead } = await handle.read(head, 0, 16, at)
    if (bytesRead < 8) break
    let size = head.readUInt32BE(0)
    const type = head.toString('latin1', 4, 8)
    let header = 8
    if (size === 1) {
      if (bytesRead < 16) break
      size = Number(head.readBigUInt64BE(8))
      header = 16
    } else if (size === 0) {
      size = total - at
    }
    if (size < header || at + size > total) break
    found.push({ type, start: at, size, header })
    at += size
  }
  return found
}

/* --- box writing -------------------------------------------------------------------- */

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt8(version, 0)
  head.writeUIntBE(flags, 1, 3)
  return box(type, head, ...payload)
}

function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4)
  values.forEach((value, at) => out.writeUInt32BE(value >>> 0, at * 4))
  return out
}

/* --- the sample tables --------------------------------------------------------------- */

/** Run-length encodes the per-sample durations. */
function buildStts(samples: Sample[]): Buffer {
  const runs: number[] = []
  let count = 0
  let delta = -1
  for (const sample of samples) {
    if (sample.duration === delta) {
      count += 1
    } else {
      if (count > 0) runs.push(count, delta)
      count = 1
      delta = sample.duration
    }
  }
  if (count > 0) runs.push(count, delta)
  return fullBox('stts', 0, 0, u32(runs.length / 2), u32(...runs))
}

/** Only written when something is actually out of order; baseline H.264 never is. */
function buildCtts(samples: Sample[]): Buffer | null {
  if (!samples.some((sample) => sample.compositionOffset !== 0)) return null
  const runs: number[] = []
  let count = 0
  let offset = Number.NaN
  for (const sample of samples) {
    if (sample.compositionOffset === offset) {
      count += 1
    } else {
      if (count > 0) runs.push(count, offset)
      count = 1
      offset = sample.compositionOffset
    }
  }
  if (count > 0) runs.push(count, offset)
  // Version 1, so a negative offset is legal rather than wrapping to four billion.
  const body = Buffer.alloc(runs.length * 4)
  for (let at = 0; at < runs.length; at += 2) {
    body.writeUInt32BE(runs[at], at * 4)
    body.writeInt32BE(runs[at + 1], (at + 1) * 4)
  }
  return fullBox('ctts', 1, 0, u32(runs.length / 2), body)
}

function buildStsz(samples: Sample[]): Buffer {
  const body = Buffer.alloc(samples.length * 4)
  samples.forEach((sample, at) => body.writeUInt32BE(sample.size, at * 4))
  // sample_size 0 means "the table below", which is the only honest answer for video.
  return fullBox('stsz', 0, 0, u32(0, samples.length), body)
}

/**
 * One sample per chunk.
 *
 * That makes `stsc` a single entry and `stco` one offset per sample, which costs four bytes
 * a sample - about 350KB across both tracks for a twenty minute capture - and removes every
 * chance of getting chunk grouping wrong against data that was laid out by somebody else.
 * The samples are copied where they already sit, so there are no real chunks to describe.
 */
function buildStsc(): Buffer {
  return fullBox('stsc', 0, 0, u32(1), u32(1, 1, 1))
}

function buildStco(offsets: number[], large: boolean): Buffer {
  if (large) {
    const body = Buffer.alloc(offsets.length * 8)
    offsets.forEach((offset, at) => body.writeBigUInt64BE(BigInt(offset), at * 8))
    return fullBox('co64', 0, 0, u32(offsets.length), body)
  }
  const body = Buffer.alloc(offsets.length * 4)
  offsets.forEach((offset, at) => body.writeUInt32BE(offset, at * 4))
  return fullBox('stco', 0, 0, u32(offsets.length), body)
}

/** Absent means every sample is a sync sample, which is the truth for audio. */
function buildStss(samples: Sample[]): Buffer | null {
  if (samples.every((sample) => sample.sync)) return null
  const keys: number[] = []
  samples.forEach((sample, at) => {
    if (sample.sync) keys.push(at + 1)
  })
  return fullBox('stss', 0, 0, u32(keys.length), u32(...keys))
}

/* --- header patching ----------------------------------------------------------------- */

/**
 * Writes a duration into an `mvhd`, `mdhd` or `tkhd` copied from the source.
 *
 * They are patched rather than rebuilt because everything else in them - matrices, volume,
 * language, creation dates, track ids - is already right and rebuilding it by hand is a way
 * to get one field subtly wrong.
 */
function patchDuration(buf: Buffer, type: 'mvhd' | 'mdhd' | 'tkhd', duration: number): Buffer {
  const out = Buffer.from(buf)
  const payload = 8
  const version = out.readUInt8(payload)
  let at: number
  if (type === 'tkhd') at = version === 1 ? payload + 4 + 8 + 8 + 4 + 4 : payload + 4 + 4 + 4 + 4 + 4
  else at = version === 1 ? payload + 4 + 8 + 8 + 4 : payload + 4 + 4 + 4 + 4
  if (version === 1) out.writeBigUInt64BE(BigInt(Math.round(duration)), at)
  else out.writeUInt32BE(Math.min(0xffff_fffe, Math.round(duration)), at)
  return out
}

function readTimescale(buf: Buffer, boxStart: number): number {
  const payload = boxStart + 8
  const version = buf.readUInt8(payload)
  return version === 1 ? buf.readUInt32BE(payload + 4 + 8 + 8) : buf.readUInt32BE(payload + 4 + 4 + 4)
}

/* --- fragment parsing ---------------------------------------------------------------- */

function parseTrex(moov: Buffer): Map<number, TrackDefaults> {
  const defaults = new Map<number, TrackDefaults>()
  const root = boxesIn(moov)[0]
  const mvex = child(moov, root, 'mvex')
  if (!mvex) return defaults
  for (const trex of childrenOf(moov, mvex)) {
    if (trex.type !== 'trex') continue
    const p = trex.start + trex.header + 4
    defaults.set(moov.readUInt32BE(p), {
      duration: moov.readUInt32BE(p + 8),
      size: moov.readUInt32BE(p + 12),
      flags: moov.readUInt32BE(p + 16)
    })
  }
  return defaults
}

/** Folds one `moof` into per-track sample lists. */
function parseMoof(
  moof: Buffer,
  moofStart: number,
  fragment: number,
  defaults: Map<number, TrackDefaults>,
  into: Map<number, Sample[]>
): void {
  const root = boxesIn(moof)[0]
  for (const traf of childrenOf(moof, root)) {
    if (traf.type !== 'traf') continue

    const tfhd = child(moof, traf, 'tfhd')
    if (!tfhd) continue
    let p = tfhd.start + tfhd.header
    const tfhdFlags = moof.readUIntBE(p + 1, 3)
    p += 4
    const trackId = moof.readUInt32BE(p)
    p += 4

    // The base every `trun` offset is measured from. `default-base-is-moof` is what Chromium
    // sets, and it is why a fragmented file can be moved around without its offsets rotting.
    let base = moofStart
    if (tfhdFlags & 0x000001) {
      base = Number(moof.readBigUInt64BE(p))
      p += 8
    }
    if (tfhdFlags & 0x000002) p += 4
    const fallback = defaults.get(trackId) ?? { duration: 0, size: 0, flags: 0 }
    let defaultDuration = fallback.duration
    let defaultSize = fallback.size
    let defaultFlags = fallback.flags
    if (tfhdFlags & 0x000008) {
      defaultDuration = moof.readUInt32BE(p)
      p += 4
    }
    if (tfhdFlags & 0x000010) {
      defaultSize = moof.readUInt32BE(p)
      p += 4
    }
    if (tfhdFlags & 0x000020) {
      defaultFlags = moof.readUInt32BE(p)
      p += 4
    }

    const samples = into.get(trackId) ?? []
    into.set(trackId, samples)

    let running = 0
    for (const trun of childrenOf(moof, traf)) {
      if (trun.type !== 'trun') continue
      let t = trun.start + trun.header
      const version = moof.readUInt8(t)
      const trunFlags = moof.readUIntBE(t + 1, 3)
      t += 4
      const count = moof.readUInt32BE(t)
      t += 4

      let dataOffset = running
      if (trunFlags & 0x000001) {
        dataOffset = moof.readInt32BE(t)
        t += 4
      }
      let firstFlags = defaultFlags
      let hasFirstFlags = false
      if (trunFlags & 0x000004) {
        firstFlags = moof.readUInt32BE(t)
        hasFirstFlags = true
        t += 4
      }

      let at = base + dataOffset
      for (let i = 0; i < count; i += 1) {
        let duration = defaultDuration
        let size = defaultSize
        let flags = i === 0 && hasFirstFlags ? firstFlags : defaultFlags
        let composition = 0
        if (trunFlags & 0x000100) {
          duration = moof.readUInt32BE(t)
          t += 4
        }
        if (trunFlags & 0x000200) {
          size = moof.readUInt32BE(t)
          t += 4
        }
        if (trunFlags & 0x000400) {
          flags = moof.readUInt32BE(t)
          t += 4
        }
        if (trunFlags & 0x000800) {
          composition = version === 0 ? moof.readUInt32BE(t) : moof.readInt32BE(t)
          t += 4
        }
        samples.push({
          offset: at,
          size,
          duration,
          compositionOffset: composition,
          sync: (flags & NON_SYNC) === 0,
          fragment
        })
        at += size
      }
      running = at - base
    }
  }
}

/* --- the rebuild --------------------------------------------------------------------- */

/** Replaces a `trak`'s empty sample tables with real ones. */
function rebuildTrak(
  source: Buffer,
  trak: BoxRef,
  samples: Sample[],
  offsets: number[],
  large: boolean,
  movieTimescale: number
): Buffer {
  const mdia = child(source, trak, 'mdia')
  if (!mdia) return slice(source, trak)
  const mdhd = child(source, mdia, 'mdhd')
  const minf = child(source, mdia, 'minf')
  if (!mdhd || !minf) return slice(source, trak)
  const stbl = child(source, minf, 'stbl')
  if (!stbl) return slice(source, trak)
  const stsd = child(source, stbl, 'stsd')
  if (!stsd) return slice(source, trak)

  const mediaTimescale = readTimescale(source, mdhd.start)
  const mediaDuration = samples.reduce((total, sample) => total + sample.duration, 0)

  const parts: Buffer[] = [
    slice(source, stsd),
    buildStts(samples),
    buildStsc(),
    buildStsz(samples),
    buildStco(offsets, large)
  ]
  const ctts = buildCtts(samples)
  if (ctts) parts.splice(2, 0, ctts)
  const stss = buildStss(samples)
  if (stss) parts.push(stss)
  const newStbl = box('stbl', ...parts)

  // Everything else in `minf` - the media header and the data reference - is already right.
  const minfParts = childrenOf(source, minf).map((kid) =>
    kid.type === 'stbl' ? newStbl : slice(source, kid)
  )
  const newMinf = box('minf', ...minfParts)

  const mdiaParts = childrenOf(source, mdia).map((kid) => {
    if (kid.type === 'minf') return newMinf
    if (kid.type === 'mdhd') return patchDuration(slice(source, kid), 'mdhd', mediaDuration)
    return slice(source, kid)
  })
  const newMdia = box('mdia', ...mdiaParts)

  const trackDuration = (mediaDuration / mediaTimescale) * movieTimescale
  const trakParts: Buffer[] = []
  for (const kid of childrenOf(source, trak)) {
    if (kid.type === 'mdia') trakParts.push(newMdia)
    else if (kid.type === 'tkhd') trakParts.push(patchDuration(slice(source, kid), 'tkhd', trackDuration))
    // An edit list written for a fragmented file describes fragment timing, and carrying it
    // onto a flat one shifts the whole track. There is nothing to edit here: the samples are
    // being written in the order they were recorded.
    else if (kid.type !== 'edts') trakParts.push(slice(source, kid))
  }
  return box('trak', ...trakParts)
}

/**
 * Rewrites a fragmented MP4 in place as a progressive one.
 *
 * Leaves the file exactly as it was and reports why if anything is unexpected - a recording
 * that can be played but not scrubbed beats one that has been half-rewritten.
 */
export async function remuxToProgressive(file: string): Promise<RemuxResult> {
  const temporary = `${file}.remux`
  let handle: FileHandle | null = null

  try {
    const info = await stat(file)
    handle = await open(file, 'r')
    const boxes = await topLevel(handle, info.size)

    const ftypRef = boxes.find((b) => b.type === 'ftyp')
    const moovRef = boxes.find((b) => b.type === 'moov')
    const moofRefs = boxes.filter((b) => b.type === 'moof')
    if (!ftypRef || !moovRef) return { ok: false, reason: 'not an MP4' }
    if (moofRefs.length === 0) return { ok: false, reason: 'already progressive' }

    const ftyp = Buffer.alloc(ftypRef.size)
    await handle.read(ftyp, 0, ftypRef.size, ftypRef.start)
    const moov = Buffer.alloc(moovRef.size)
    await handle.read(moov, 0, moovRef.size, moovRef.start)

    const defaults = parseTrex(moov)

    // Each `moof` describes the `mdat` that follows it.
    const payloads: { start: number; length: number }[] = []
    const perTrack = new Map<number, Sample[]>()
    for (let at = 0; at < boxes.length; at += 1) {
      const boxRef = boxes[at]
      if (boxRef.type !== 'moof') continue
      const mdatRef = boxes[at + 1]
      if (!mdatRef || mdatRef.type !== 'mdat') continue

      const buf = Buffer.alloc(boxRef.size)
      await handle.read(buf, 0, boxRef.size, boxRef.start)
      parseMoof(buf, boxRef.start, payloads.length, defaults, perTrack)
      payloads.push({
        start: mdatRef.start + mdatRef.header,
        length: mdatRef.size - mdatRef.header
      })
    }
    if (payloads.length === 0) return { ok: false, reason: 'no fragment data' }

    const moovRoot = boxesIn(moov)[0]
    const traks = childrenOf(moov, moovRoot).filter((b) => b.type === 'trak')
    const mvhdRef = child(moov, moovRoot, 'mvhd')
    if (!mvhdRef || traks.length === 0) return { ok: false, reason: 'no tracks' }
    const movieTimescale = readTimescale(moov, mvhdRef.start)

    const builds: TrackBuild[] = []
    for (const trak of traks) {
      const tkhd = child(moov, trak, 'tkhd')
      if (!tkhd) continue
      const version = moov.readUInt8(tkhd.start + tkhd.header)
      const idAt = tkhd.start + tkhd.header + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4)
      const id = moov.readUInt32BE(idAt)
      builds.push({ id, samples: perTrack.get(id) ?? [], trak: Buffer.alloc(0) })
    }
    const totalSamples = builds.reduce((sum, build) => sum + build.samples.length, 0)
    if (totalSamples === 0) return { ok: false, reason: 'no samples found' }

    const dataBytes = payloads.reduce((sum, payload) => sum + payload.length, 0)
    // Two headers' worth of slack: the decision only has to be safe, not tight.
    const large = dataBytes > 0xffff_0000

    // Where each fragment's payload lands, which every sample offset is measured from. The
    // `moov` has to be built once to learn its own size before the offsets can be known, and
    // again with them - the second build is the same size, because only the values change.
    const buildMoov = (offsetsByTrack: Map<number, number[]>): Buffer => {
      const parts: Buffer[] = []
      for (const kid of childrenOf(moov, moovRoot)) {
        if (kid.type === 'mvhd') {
          // Copied as-is here and patched once at the end, where the finished box's own
          // position is known rather than guessed at mid-build.
          parts.push(slice(moov, kid))
        } else if (kid.type === 'trak') {
          const tkhd = child(moov, kid, 'tkhd')
          const version = tkhd ? moov.readUInt8(tkhd.start + tkhd.header) : 0
          const idAt = tkhd ? tkhd.start + tkhd.header + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4) : 0
          const id = tkhd ? moov.readUInt32BE(idAt) : 0
          const samples = perTrack.get(id) ?? []
          parts.push(
            rebuildTrak(moov, kid, samples, offsetsByTrack.get(id) ?? [], large, movieTimescale)
          )
        } else if (kid.type !== 'mvex') {
          // `mvex` announces fragments that will no longer be there.
          parts.push(slice(moov, kid))
        }
      }
      return box('moov', ...parts)
    }

    const blank = new Map<number, number[]>()
    for (const build of builds) blank.set(build.id, build.samples.map(() => 0))
    const sized = buildMoov(blank)

    const mdatHeader = large ? 16 : 8
    const dataStart = ftyp.length + sized.length + mdatHeader

    // Fragment payloads are copied in file order, so a sample keeps its position inside its
    // own fragment and only the fragment moves.
    const fragmentBase: number[] = []
    let running = dataStart
    for (const payload of payloads) {
      fragmentBase.push(running)
      running += payload.length
    }

    const offsetsByTrack = new Map<number, number[]>()
    for (const build of builds) {
      const offsets = build.samples.map(
        (sample) => fragmentBase[sample.fragment] + (sample.offset - payloads[sample.fragment].start)
      )
      offsetsByTrack.set(build.id, offsets)
    }
    let longestSeconds = 0

    // The movie duration is the longest track's, in the movie timescale.
    for (const trak of traks) {
      const mdhd = child(moov, trak, 'mdia') ? child(moov, child(moov, trak, 'mdia')!, 'mdhd') : null
      const tkhd = child(moov, trak, 'tkhd')
      if (!mdhd || !tkhd) continue
      const version = moov.readUInt8(tkhd.start + tkhd.header)
      const idAt = tkhd.start + tkhd.header + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4)
      const id = moov.readUInt32BE(idAt)
      const timescale = readTimescale(moov, mdhd.start)
      const media = (perTrack.get(id) ?? []).reduce((sum, sample) => sum + sample.duration, 0)
      longestSeconds = Math.max(longestSeconds, media / timescale)
    }

    let finalMoov = buildMoov(offsetsByTrack)
    // Patch the movie header's duration on the finished box, where its position is known.
    const finalRoot = boxesIn(finalMoov)[0]
    const finalMvhd = child(finalMoov, finalRoot, 'mvhd')
    if (finalMvhd) {
      const patched = patchDuration(
        slice(finalMoov, finalMvhd),
        'mvhd',
        longestSeconds * movieTimescale
      )
      patched.copy(finalMoov, finalMvhd.start)
    }

    if (finalMoov.length !== sized.length) {
      return { ok: false, reason: 'header size moved between passes' }
    }

    const out = createWriteStream(temporary)
    const write = (chunk: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        out.write(chunk, (error) => (error ? reject(error) : resolve()))
      })

    await write(ftyp)
    await write(finalMoov)
    const header = Buffer.alloc(mdatHeader)
    if (large) {
      header.writeUInt32BE(1, 0)
      header.write('mdat', 4, 'latin1')
      header.writeBigUInt64BE(BigInt(dataBytes + mdatHeader), 8)
    } else {
      header.writeUInt32BE(dataBytes + mdatHeader, 0)
      header.write('mdat', 4, 'latin1')
    }
    await write(header)

    /**
     * Streamed rather than read into memory: a twenty minute capture is well over a gigabyte
     * and holding it would undo the point of writing the recording in chunks to begin with.
     *
     * Copied by hand rather than with `pipeline(..., { end: false })`, which attaches a fresh
     * set of error/close/finish listeners to the *same* write stream on every call and never
     * takes them off - thirteen fragments already trips Node's leak warning, and a long
     * session has hundreds.
     */
    for (const payload of payloads) {
      if (payload.length === 0) continue
      const input = createReadStream(file, {
        start: payload.start,
        end: payload.start + payload.length - 1,
        highWaterMark: 1 << 20
      })
      for await (const chunk of input) await write(chunk as Buffer)
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })

    await handle.close()
    handle = null
    await rename(temporary, file)
    return { ok: true, samples: totalSamples, bytes: dataBytes }
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch {
      // Nothing depends on the leftover going away.
    }
    return { ok: false, reason: (error as Error).message }
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Closing a handle that is already gone is not a failure worth reporting.
      }
    }
  }
}

/* --- joining a video file and an audio file ----------------------------------------- */

/** One track lifted out of a file, with its samples where they sit in that file. */
interface SourceTrack {
  file: string
  /** The source's `moov`, which the track's `trak` box is a range of. */
  moov: Buffer
  trak: BoxRef
  mvhd: BoxRef
  samples: Sample[]
  timescale: number
}

/** The four-letter handler of a `trak`: `vide`, `soun`, or something neither. */
function handlerOf(moov: Buffer, trak: BoxRef): string {
  const mdia = child(moov, trak, 'mdia')
  const hdlr = mdia ? child(moov, mdia, 'hdlr') : null
  if (!hdlr) return ''
  return moov.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12)
}

/**
 * Samples out of an ordinary MP4's sample tables, for an input that is already progressive.
 *
 * YouTube's streams arrive fragmented and go through `parseMoof` instead; this is here so an
 * input that happens to be flat - a re-muxed file, a different site - is read rather than
 * refused.
 */
function samplesFromTables(moov: Buffer, trak: BoxRef): Sample[] | null {
  const mdia = child(moov, trak, 'mdia')
  const minf = mdia ? child(moov, mdia, 'minf') : null
  const stbl = minf ? child(moov, minf, 'stbl') : null
  if (!stbl) return null
  // Where each table's entries start: past the box header and the version/flags word.
  const table = (type: string): number | null => {
    const found = child(moov, stbl, type)
    return found ? found.start + found.header + 4 : null
  }

  const stsz = table('stsz')
  const stsc = table('stsc')
  const stts = table('stts')
  const stco = table('stco')
  const co64 = table('co64')
  if (stsz === null || stsc === null || stts === null || (stco === null && co64 === null)) return null

  const fixed = moov.readUInt32BE(stsz)
  const count = moov.readUInt32BE(stsz + 4)
  const sizes: number[] = []
  for (let i = 0; i < count; i += 1) {
    sizes.push(fixed !== 0 ? fixed : moov.readUInt32BE(stsz + 8 + i * 4))
  }

  const chunkOffsets: number[] = []
  if (co64 !== null) {
    const n = moov.readUInt32BE(co64)
    for (let i = 0; i < n; i += 1) chunkOffsets.push(Number(moov.readBigUInt64BE(co64 + 4 + i * 8)))
  } else if (stco !== null) {
    const n = moov.readUInt32BE(stco)
    for (let i = 0; i < n; i += 1) chunkOffsets.push(moov.readUInt32BE(stco + 4 + i * 4))
  }

  // stsc: runs of (first chunk, samples per chunk), each lasting until the next run starts.
  const runs: { first: number; per: number }[] = []
  const runCount = moov.readUInt32BE(stsc)
  for (let i = 0; i < runCount; i += 1) {
    runs.push({
      first: moov.readUInt32BE(stsc + 4 + i * 12),
      per: moov.readUInt32BE(stsc + 8 + i * 12)
    })
  }
  const offsets: number[] = []
  for (let chunk = 0; chunk < chunkOffsets.length && offsets.length < count; chunk += 1) {
    let per = runs[0]?.per ?? 0
    for (const run of runs) if (run.first <= chunk + 1) per = run.per
    let at = chunkOffsets[chunk]
    for (let i = 0; i < per && offsets.length < count; i += 1) {
      offsets.push(at)
      at += sizes[offsets.length - 1]
    }
  }

  const durations: number[] = []
  const sttsCount = moov.readUInt32BE(stts)
  for (let i = 0; i < sttsCount; i += 1) {
    const n = moov.readUInt32BE(stts + 4 + i * 8)
    const delta = moov.readUInt32BE(stts + 8 + i * 8)
    for (let k = 0; k < n; k += 1) durations.push(delta)
  }

  const compositions: number[] = []
  const ctts = table('ctts')
  if (ctts !== null) {
    const version = moov.readUInt8(ctts - 4)
    const n = moov.readUInt32BE(ctts)
    for (let i = 0; i < n; i += 1) {
      const repeat = moov.readUInt32BE(ctts + 4 + i * 8)
      const value =
        version === 0 ? moov.readUInt32BE(ctts + 8 + i * 8) : moov.readInt32BE(ctts + 8 + i * 8)
      for (let k = 0; k < repeat; k += 1) compositions.push(value)
    }
  }

  const stss = table('stss')
  let sync: Set<number> | null = null
  if (stss !== null) {
    sync = new Set<number>()
    const n = moov.readUInt32BE(stss)
    for (let i = 0; i < n; i += 1) sync.add(moov.readUInt32BE(stss + 4 + i * 4) - 1)
  }

  return sizes.map((size, i) => ({
    offset: offsets[i] ?? 0,
    size,
    duration: durations[i] ?? durations[durations.length - 1] ?? 0,
    compositionOffset: compositions[i] ?? 0,
    sync: sync === null || sync.has(i),
    fragment: 0
  }))
}

/** The one track of a given kind in a file, fragmented or not. */
async function readTrack(file: string, kind: 'vide' | 'soun'): Promise<SourceTrack | null> {
  const info = await stat(file)
  const handle = await open(file, 'r')
  try {
    const boxes = await topLevel(handle, info.size)
    const moovRef = boxes.find((b) => b.type === 'moov')
    if (!moovRef) return null
    const moov = Buffer.alloc(moovRef.size)
    await handle.read(moov, 0, moovRef.size, moovRef.start)
    const root = boxesIn(moov)[0]
    const mvhd = child(moov, root, 'mvhd')
    const trak = childrenOf(moov, root).find((b) => b.type === 'trak' && handlerOf(moov, b) === kind)
    if (!mvhd || !trak) return null

    const tkhd = child(moov, trak, 'tkhd')
    const mdia = child(moov, trak, 'mdia')
    const mdhd = mdia ? child(moov, mdia, 'mdhd') : null
    if (!tkhd || !mdhd) return null
    const version = moov.readUInt8(tkhd.start + tkhd.header)
    const id = moov.readUInt32BE(tkhd.start + tkhd.header + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4))

    let samples: Sample[]
    const moofs = boxes.filter((b) => b.type === 'moof')
    if (moofs.length > 0) {
      const defaults = parseTrex(moov)
      const perTrack = new Map<number, Sample[]>()
      for (const moofRef of moofs) {
        const buf = Buffer.alloc(moofRef.size)
        await handle.read(buf, 0, moofRef.size, moofRef.start)
        parseMoof(buf, moofRef.start, 0, defaults, perTrack)
      }
      samples = perTrack.get(id) ?? []
    } else {
      samples = samplesFromTables(moov, trak) ?? []
    }
    if (samples.length === 0) return null

    return { file, moov, trak, mvhd, samples, timescale: readTimescale(moov, mdhd.start) }
  } finally {
    await handle.close()
  }
}

/** A copy of a `trak` with its `tkhd` renumbered, since both inputs call their track 1. */
function withTrackId(trak: Buffer, id: number): Buffer {
  const out = Buffer.from(trak)
  const tkhd = child(out, boxesIn(out)[0], 'tkhd')
  if (!tkhd) return out
  const version = out.readUInt8(tkhd.start + tkhd.header)
  out.writeUInt32BE(id, tkhd.start + tkhd.header + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4))
  return out
}

/**
 * Moves the video's presentation to start at zero.
 *
 * A stream with B-frames presents its first frame some way after its first decode - YouTube's
 * H.264 carries composition offsets of a frame or two - and the fragmented original said
 * where presentation starts with an edit list that `rebuildTrak` deliberately does not carry.
 * Without one, the picture would run that far behind the sound. Pulling every composition
 * offset back by the earliest presentation time is the same correction made in the sample
 * table itself, which every player honours; `ctts` version 1 allows the negatives it makes.
 */
function presentFromZero(samples: Sample[]): Sample[] {
  let decode = 0
  let earliest = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    earliest = Math.min(earliest, decode + sample.compositionOffset)
    decode += sample.duration
  }
  if (!Number.isFinite(earliest) || earliest === 0) return samples
  return samples.map((sample) => ({
    ...sample,
    compositionOffset: sample.compositionOffset - earliest
  }))
}

/**
 * Joins a video-only MP4 and an audio-only MP4 into one ordinary, seekable MP4.
 *
 * This is what makes a downloaded video possible without ffmpeg. The site serves anything
 * sharper than 360p as two separate streams - pictures in one file, sound in another - and
 * joining them is normally ffmpeg's job, which is the binary this app does not carry. But
 * joining is not encoding: it is two sample tables in one `moov` and the samples copied into
 * one `mdat`, which is everything `remuxToProgressive` already knows how to do for a single
 * file. The bytes are copied verbatim, so the picture and the sound are exactly what came
 * down.
 *
 * Interleaved in half-second runs rather than all the video and then all the sound: a player
 * reading front to back would otherwise have to hold one track's data for the entire length
 * of the other, and an editor importing it would seek between two ends of the file at every
 * frame.
 */
export async function mergeAudioVideo(
  videoFile: string,
  audioFile: string,
  outFile: string
): Promise<RemuxResult> {
  const temporary = `${outFile}.part`
  try {
    const video = await readTrack(videoFile, 'vide')
    if (!video) return { ok: false, reason: 'no video track in the picture stream' }
    const audio = await readTrack(audioFile, 'soun')
    if (!audio) return { ok: false, reason: 'no audio track in the sound stream' }
    video.samples = presentFromZero(video.samples)

    const movieTimescale = readTimescale(video.moov, video.mvhd.start)
    const tracks = [video, audio]

    // Walk both tracks by decode time, emitting about half a second at a time from whichever
    // is further behind, so neither runs ahead of the other in the file.
    type Run = { track: number; from: number; to: number }
    const runs: Run[] = []
    const cursor = [0, 0]
    const clock = [0, 0]
    const RUN_SECONDS = 0.5
    while (cursor[0] < video.samples.length || cursor[1] < audio.samples.length) {
      const next =
        cursor[1] >= audio.samples.length
          ? 0
          : cursor[0] >= video.samples.length
            ? 1
            : clock[0] / video.timescale <= clock[1] / audio.timescale
              ? 0
              : 1
      const track = tracks[next]
      const from = cursor[next]
      const until = clock[next] / track.timescale + RUN_SECONDS
      while (cursor[next] < track.samples.length && clock[next] / track.timescale < until) {
        clock[next] += track.samples[cursor[next]].duration
        cursor[next] += 1
      }
      runs.push({ track: next, from, to: cursor[next] })
    }

    const dataBytes = tracks.reduce(
      (sum, track) => sum + track.samples.reduce((total, sample) => total + sample.size, 0),
      0
    )
    const large = dataBytes > 0xffff_0000
    const mdatHeader = large ? 16 : 8

    // A brand of our own rather than either input's: YouTube's streams say `dash`, which
    // describes a fragment stream and not the flat file this is.
    const ftyp = box(
      'ftyp',
      Buffer.from('isom', 'latin1'),
      u32(0x200),
      Buffer.from('isomiso2avc1mp41', 'latin1')
    )

    const seconds = tracks.map(
      (track) => track.samples.reduce((sum, sample) => sum + sample.duration, 0) / track.timescale
    )

    const buildMoov = (offsets: number[][]): Buffer => {
      const mvhd = patchDuration(
        slice(video.moov, video.mvhd),
        'mvhd',
        Math.max(...seconds) * movieTimescale
      )
      // next_track_ID is the last field of the box, whichever version it is.
      mvhd.writeUInt32BE(3, mvhd.length - 4)
      const traks = tracks.map((track, index) =>
        withTrackId(
          rebuildTrak(track.moov, track.trak, track.samples, offsets[index], large, movieTimescale),
          index + 1
        )
      )
      return box('moov', mvhd, ...traks)
    }

    // Built once to learn its size, then again with real offsets - the same two passes
    // `remuxToProgressive` makes, and the same check that the size did not move.
    const sized = buildMoov(tracks.map((track) => track.samples.map(() => 0)))
    const dataStart = ftyp.length + sized.length + mdatHeader

    const offsets: number[][] = tracks.map((track) => new Array<number>(track.samples.length))
    let running = dataStart
    for (const run of runs) {
      const samples = tracks[run.track].samples
      for (let i = run.from; i < run.to; i += 1) {
        offsets[run.track][i] = running
        running += samples[i].size
      }
    }
    const moov = buildMoov(offsets)
    if (moov.length !== sized.length) return { ok: false, reason: 'header size moved between passes' }

    const out = createWriteStream(temporary)
    const write = (chunk: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        out.write(chunk, (error) => (error ? reject(error) : resolve()))
      })
    const handles = await Promise.all(tracks.map((track) => open(track.file, 'r')))
    try {
      await write(ftyp)
      await write(moov)
      const header = Buffer.alloc(mdatHeader)
      if (large) {
        header.writeUInt32BE(1, 0)
        header.write('mdat', 4, 'latin1')
        header.writeBigUInt64BE(BigInt(dataBytes + mdatHeader), 8)
      } else {
        header.writeUInt32BE(dataBytes + mdatHeader, 0)
        header.write('mdat', 4, 'latin1')
      }
      await write(header)

      // Samples that sit next to each other in the source are copied as one read, which in a
      // fragmented stream is nearly every run - a fragment's samples are contiguous.
      const copy = async (handle: FileHandle, start: number, length: number): Promise<void> => {
        let done = 0
        while (done < length) {
          const want = Math.min(1 << 20, length - done)
          const chunk = Buffer.alloc(want)
          const { bytesRead } = await handle.read(chunk, 0, want, start + done)
          if (bytesRead <= 0) throw new Error('a stream ended before its samples did')
          await write(bytesRead === want ? chunk : chunk.subarray(0, bytesRead))
          done += bytesRead
        }
      }
      for (const run of runs) {
        const samples = tracks[run.track].samples
        let i = run.from
        while (i < run.to) {
          const start = samples[i].offset
          let length = samples[i].size
          let j = i + 1
          while (j < run.to && samples[j].offset === start + length) {
            length += samples[j].size
            j += 1
          }
          await copy(handles[run.track], start, length)
          i = j
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((error?: Error | null) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      out.destroy()
      throw error
    } finally {
      await Promise.all(handles.map((handle) => handle.close().catch(() => {})))
    }

    await rename(temporary, outFile)
    return { ok: true, samples: video.samples.length + audio.samples.length, bytes: dataBytes }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    return { ok: false, reason: (error as Error).message }
  }
}
