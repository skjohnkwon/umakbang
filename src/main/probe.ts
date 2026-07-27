/**
 * Dependency-free audio metadata probing.
 *
 * Each format is parsed straight from its container headers, which means we only ever
 * read a small window from the head and tail of a file instead of decoding it. That
 * keeps a full-library pass over tens of thousands of files cheap, and gives exact
 * sample rate / bit depth for the uncompressed formats that matter most in a
 * production library (WAV, AIFF, FLAC).
 */

import { open } from 'node:fs/promises'
import type { TrackMetadata } from '../shared/types'
import { readFlpProjectTime } from './flp'
import { normaliseKey } from '../shared/keys'

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024

interface Windows {
  head: Buffer
  tail: Buffer
  /** Absolute offset in the file at which `tail` begins. */
  tailOffset: number
  size: number
}

export async function probeFile(path: string, ext: string): Promise<TrackMetadata> {
  // FL Studio projects carry their own time-tracking record rather than audio headers.
  if (ext === 'flp') {
    const project = await readFlpProjectTime(path)
    if (!project) return {}
    return { projectCreatedMs: project.createdMs, projectSeconds: project.seconds }
  }

  let windows: Windows | null = null
  try {
    windows = await readWindows(path)
  } catch {
    return {}
  }
  if (!windows || windows.size === 0) return {}

  let meta: TrackMetadata = {}
  try {
    switch (ext) {
      case 'wav':
      case 'wave':
        meta = parseWav(windows)
        break
      case 'aif':
      case 'aiff':
      case 'aifc':
        meta = parseAiff(windows)
        break
      case 'flac':
        meta = parseFlac(windows)
        break
      case 'mp3':
        meta = parseMp3(windows)
        break
      case 'm4a':
      case 'mp4':
      case 'aac':
        meta = parseMp4(windows)
        break
      case 'ogg':
      case 'oga':
      case 'opus':
        meta = parseOgg(windows)
        break
      default:
        meta = {}
    }
  } catch {
    meta = {}
  }

  // Filenames in sample libraries carry tempo/key far more often than tags do, so they
  // fill the gaps rather than override anything the container actually declared.
  const fromName = parseNameHints(path)
  if (meta.bpm === undefined && fromName.bpm !== undefined) meta.bpm = fromName.bpm
  if (meta.musicalKey === undefined && fromName.musicalKey !== undefined) {
    meta.musicalKey = fromName.musicalKey
  }

  return meta
}

async function readWindows(path: string): Promise<Windows | null> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    const size = stat.size
    if (size === 0) return null

    const headLen = Math.min(HEAD_BYTES, size)
    const head = Buffer.allocUnsafe(headLen)
    await handle.read(head, 0, headLen, 0)

    // When the file fits entirely in the head window there is nothing extra to read.
    let tail = head
    let tailOffset = 0
    if (size > headLen) {
      const tailLen = Math.min(TAIL_BYTES, size)
      tailOffset = size - tailLen
      tail = Buffer.allocUnsafe(tailLen)
      await handle.read(tail, 0, tailLen, tailOffset)
    }

    return { head, tail, tailOffset, size }
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ WAV / RIFF */

function parseWav({ head, size }: Windows): TrackMetadata {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF') return {}
  if (head.toString('ascii', 8, 12) !== 'WAVE') return {}

  const meta: TrackMetadata = {}
  let byteRate = 0
  let dataSize = 0
  let sampleFrames = 0

  let off = 12
  while (off + 8 <= head.length) {
    const id = head.toString('ascii', off, off + 4)
    const chunkSize = head.readUInt32LE(off + 4)
    const body = off + 8

    if (id === 'fmt ' && body + 16 <= head.length) {
      let format = head.readUInt16LE(body)
      meta.channels = head.readUInt16LE(body + 2)
      meta.sampleRate = head.readUInt32LE(body + 4)
      byteRate = head.readUInt32LE(body + 8)
      const bits = head.readUInt16LE(body + 14)

      // WAVE_FORMAT_EXTENSIBLE hides the real codec in the extension block.
      if (format === 0xfffe && body + 40 <= head.length) {
        format = head.readUInt16LE(body + 24)
      }
      // Bit depth is only meaningful for PCM (1) and IEEE float (3).
      if (format === 1 || format === 3) meta.bitDepth = bits
      if (byteRate > 0) meta.bitrate = byteRate * 8
    } else if (id === 'data') {
      // The declared size is authoritative, but files truncated mid-write (or streamed
      // with a 0xFFFFFFFF placeholder) need the real file size as a ceiling.
      const remaining = size - body
      dataSize = Math.min(chunkSize, Math.max(0, remaining))
    } else if (id === 'fact' && body + 4 <= head.length) {
      sampleFrames = head.readUInt32LE(body)
    } else if (id === 'acid' && body + 24 <= head.length) {
      // ACID loop chunk: tempo lives at a fixed offset and is the most reliable BPM
      // source in any loop library.
      const tempo = head.readFloatLE(body + 20)
      if (Number.isFinite(tempo) && tempo > 20 && tempo < 400) meta.bpm = round2(tempo)
      const rootNote = head.readUInt16LE(body + 4)
      const isOneShot = (head.readUInt32LE(body) & 0x01) !== 0
      if (!isOneShot && rootNote >= 0 && rootNote <= 127) {
        meta.musicalKey = midiNoteToKey(rootNote)
      }
    } else if (id === 'ID3 ' || id === 'id3 ') {
      applyId3(head.subarray(body, Math.min(body + chunkSize, head.length)), meta)
    }

    // RIFF chunks are word-aligned; odd sizes are followed by a pad byte.
    off = body + chunkSize + (chunkSize % 2)
    if (chunkSize <= 0) break
  }

  if (meta.sampleRate && byteRate > 0 && dataSize > 0) {
    meta.duration = round3(dataSize / byteRate)
  } else if (meta.sampleRate && sampleFrames > 0) {
    meta.duration = round3(sampleFrames / meta.sampleRate)
  }

  return meta
}

/* ------------------------------------------------------------------ AIFF / AIFC */

function parseAiff({ head }: Windows): TrackMetadata {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'FORM') return {}
  const formType = head.toString('ascii', 8, 12)
  if (formType !== 'AIFF' && formType !== 'AIFC') return {}

  const meta: TrackMetadata = {}
  let off = 12
  while (off + 8 <= head.length) {
    const id = head.toString('ascii', off, off + 4)
    const chunkSize = head.readUInt32BE(off + 4)
    const body = off + 8

    if (id === 'COMM' && body + 18 <= head.length) {
      meta.channels = head.readUInt16BE(body)
      const frames = head.readUInt32BE(body + 2)
      meta.bitDepth = head.readUInt16BE(body + 6)
      const rate = readExtendedFloat80(head, body + 8)
      if (rate > 0) {
        meta.sampleRate = Math.round(rate)
        meta.duration = round3(frames / rate)
        if (meta.channels && meta.bitDepth) {
          meta.bitrate = Math.round(rate * meta.channels * meta.bitDepth)
        }
      }
    } else if (id === 'ID3 ') {
      applyId3(head.subarray(body, Math.min(body + chunkSize, head.length)), meta)
    }

    off = body + chunkSize + (chunkSize % 2)
    if (chunkSize <= 0) break
  }
  return meta
}

/** Decodes the 80-bit IEEE 754 extended precision float AIFF uses for sample rate. */
function readExtendedFloat80(buf: Buffer, off: number): number {
  if (off + 10 > buf.length) return 0
  const sign = buf[off] & 0x80 ? -1 : 1
  const exponent = ((buf[off] & 0x7f) << 8) | buf[off + 1]
  let mantissa = 0
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + buf[off + 2 + i]
  if (exponent === 0 && mantissa === 0) return 0
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63)
}

/* ------------------------------------------------------------------ FLAC */

function parseFlac({ head }: Windows): TrackMetadata {
  if (head.length < 8 || head.toString('ascii', 0, 4) !== 'fLaC') return {}

  const meta: TrackMetadata = {}
  let off = 4
  while (off + 4 <= head.length) {
    const isLast = (head[off] & 0x80) !== 0
    const blockType = head[off] & 0x7f
    const blockSize = (head[off + 1] << 16) | (head[off + 2] << 8) | head[off + 3]
    const body = off + 4
    if (body + blockSize > head.length) break

    if (blockType === 0 && blockSize >= 34) {
      // STREAMINFO is a tightly bit-packed record; read it as a bit stream.
      const bits = new BitReader(head, body)
      bits.skip(16 + 16 + 24 + 24) // min/max block size, min/max frame size
      meta.sampleRate = bits.read(20)
      meta.channels = bits.read(3) + 1
      meta.bitDepth = bits.read(5) + 1
      // totalSamples is 36 bits, which exceeds a 32-bit read.
      const hi = bits.read(4)
      const lo = bits.read(32)
      const totalSamples = hi * 2 ** 32 + lo
      if (meta.sampleRate > 0 && totalSamples > 0) {
        meta.duration = round3(totalSamples / meta.sampleRate)
      }
    } else if (blockType === 4) {
      applyVorbisComment(head.subarray(body, body + blockSize), meta)
    }

    off = body + blockSize
    if (isLast) break
  }
  return meta
}

class BitReader {
  private bitPos = 0
  constructor(
    private readonly buf: Buffer,
    private readonly byteOffset: number
  ) {}

  skip(bits: number): void {
    this.bitPos += bits
  }

  read(bits: number): number {
    let value = 0
    for (let i = 0; i < bits; i++) {
      const byte = this.buf[this.byteOffset + (this.bitPos >> 3)] ?? 0
      const bit = (byte >> (7 - (this.bitPos & 7))) & 1
      // Multiply rather than shift so 32-bit reads don't overflow into negatives.
      value = value * 2 + bit
      this.bitPos++
    }
    return value
  }
}

function applyVorbisComment(buf: Buffer, meta: TrackMetadata): void {
  if (buf.length < 4) return
  let off = 0
  const vendorLen = buf.readUInt32LE(off)
  off += 4 + vendorLen
  if (off + 4 > buf.length) return
  const count = buf.readUInt32LE(off)
  off += 4
  for (let i = 0; i < count && off + 4 <= buf.length; i++) {
    const len = buf.readUInt32LE(off)
    off += 4
    if (off + len > buf.length) break
    const entry = buf.toString('utf8', off, off + len)
    off += len
    const eq = entry.indexOf('=')
    if (eq === -1) continue
    applyTag(entry.slice(0, eq).toUpperCase(), entry.slice(eq + 1), meta)
  }
}

/* ------------------------------------------------------------------ MP3 */

const MPEG_BITRATES: Record<string, number[]> = {
  // MPEG 1 Layer III
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  // MPEG 1 Layer II
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1],
  // MPEG 1 Layer I
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1],
  // MPEG 2 / 2.5 Layer II & III
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1]
}

const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  0: [11025, 12000, 8000, 0] // MPEG 2.5
}

function parseMp3(windows: Windows): TrackMetadata {
  const { head, size } = windows
  const meta: TrackMetadata = {}

  let audioStart = 0
  if (head.length > 10 && head.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = readSynchsafe(head, 6)
    applyId3(head.subarray(0, Math.min(10 + tagSize, head.length)), meta)
    audioStart = 10 + tagSize
  }

  const frameOffset = findFrameSync(head, audioStart)
  if (frameOffset === -1) return meta

  const header = parseFrameHeader(head, frameOffset)
  if (!header) return meta

  meta.sampleRate = header.sampleRate
  meta.channels = header.channels

  // Xing/Info (or VBRI) carries the exact frame count, which is the only accurate
  // duration source for a VBR file.
  const xingOffset = frameOffset + header.sideInfoSize + 4
  let frameCount = 0
  let streamBytes = 0
  if (xingOffset + 16 <= head.length) {
    const tag = head.toString('ascii', xingOffset, xingOffset + 4)
    if (tag === 'Xing' || tag === 'Info') {
      const flags = head.readUInt32BE(xingOffset + 4)
      let cursor = xingOffset + 8
      if (flags & 0x0001) {
        frameCount = head.readUInt32BE(cursor)
        cursor += 4
      }
      if (flags & 0x0002) {
        streamBytes = head.readUInt32BE(cursor)
      }
    }
  }
  const vbriOffset = frameOffset + 36
  if (!frameCount && vbriOffset + 26 <= head.length) {
    if (head.toString('ascii', vbriOffset, vbriOffset + 4) === 'VBRI') {
      streamBytes = head.readUInt32BE(vbriOffset + 10)
      frameCount = head.readUInt32BE(vbriOffset + 14)
    }
  }

  if (frameCount > 0) {
    meta.duration = round3((frameCount * header.samplesPerFrame) / header.sampleRate)
    if (streamBytes > 0 && meta.duration > 0) {
      meta.bitrate = Math.round((streamBytes * 8) / meta.duration)
    } else {
      meta.bitrate = header.bitrate
    }
  } else {
    // Constant bitrate: derive from the audio payload size.
    const audioBytes = size - audioStart - trailingId3v1Size(windows)
    meta.bitrate = header.bitrate
    if (header.bitrate > 0 && audioBytes > 0) {
      meta.duration = round3((audioBytes * 8) / header.bitrate)
    }
  }

  return meta
}

function trailingId3v1Size({ tail }: Windows): number {
  if (tail.length >= 128 && tail.toString('ascii', tail.length - 128, tail.length - 125) === 'TAG') {
    return 128
  }
  return 0
}

function findFrameSync(buf: Buffer, from: number): number {
  const limit = Math.min(buf.length - 4, from + 128 * 1024)
  for (let i = Math.max(0, from); i < limit; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      if (parseFrameHeader(buf, i)) return i
    }
  }
  return -1
}

interface FrameHeader {
  sampleRate: number
  bitrate: number
  channels: number
  samplesPerFrame: number
  sideInfoSize: number
}

function parseFrameHeader(buf: Buffer, off: number): FrameHeader | null {
  if (off + 4 > buf.length) return null
  const b1 = buf[off + 1]
  const b2 = buf[off + 2]
  const b3 = buf[off + 3]

  const versionBits = (b1 >> 3) & 0x03 // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (b1 >> 1) & 0x03 // 3 = Layer I, 2 = Layer II, 1 = Layer III
  if (versionBits === 1 || layerBits === 0) return null

  const layer = 4 - layerBits
  const versionGroup = versionBits === 3 ? 1 : 2
  const bitrateTable = MPEG_BITRATES[`${versionGroup}-${layer}`]
  const rateTable = MPEG_SAMPLE_RATES[versionBits]
  if (!bitrateTable || !rateTable) return null

  const bitrateKbps = bitrateTable[(b2 >> 4) & 0x0f]
  const sampleRate = rateTable[(b2 >> 2) & 0x03]
  if (!bitrateKbps || bitrateKbps < 0 || !sampleRate) return null

  const channelMode = (b3 >> 6) & 0x03
  const channels = channelMode === 3 ? 1 : 2

  let samplesPerFrame: number
  if (layer === 1) samplesPerFrame = 384
  else if (layer === 2) samplesPerFrame = 1152
  else samplesPerFrame = versionBits === 3 ? 1152 : 576

  // Distance from the frame header to the Xing tag depends on version and channel mode.
  let sideInfoSize: number
  if (versionBits === 3) sideInfoSize = channels === 1 ? 17 : 32
  else sideInfoSize = channels === 1 ? 9 : 17

  return { sampleRate, bitrate: bitrateKbps * 1000, channels, samplesPerFrame, sideInfoSize }
}

/* ------------------------------------------------------------------ MP4 / M4A */

function parseMp4({ head }: Windows): TrackMetadata {
  const meta: TrackMetadata = {}
  const moov = findAtom(head, 0, head.length, 'moov')
  if (!moov) return meta

  const mvhd = findAtom(head, moov.body, moov.end, 'mvhd')
  if (mvhd) {
    const version = head[mvhd.body]
    if (version === 1 && mvhd.body + 28 <= head.length) {
      const timescale = head.readUInt32BE(mvhd.body + 20)
      // 64-bit duration; the high word is effectively always 0 for real audio files.
      const durHi = head.readUInt32BE(mvhd.body + 24)
      const durLo = head.readUInt32BE(mvhd.body + 28)
      const duration = durHi * 2 ** 32 + durLo
      if (timescale > 0) meta.duration = round3(duration / timescale)
    } else if (mvhd.body + 20 <= head.length) {
      const timescale = head.readUInt32BE(mvhd.body + 12)
      const duration = head.readUInt32BE(mvhd.body + 16)
      if (timescale > 0) meta.duration = round3(duration / timescale)
    }
  }

  // Sample rate and channels live in the audio sample description.
  const trak = findAtom(head, moov.body, moov.end, 'trak')
  if (trak) {
    const stsd = findPath(head, trak.body, trak.end, ['mdia', 'minf', 'stbl', 'stsd'])
    if (stsd && stsd.body + 8 <= head.length) {
      // stsd: version+flags (4), entry count (4), then the first entry.
      const entry = stsd.body + 8
      if (entry + 36 <= head.length) {
        meta.channels = head.readUInt16BE(entry + 24)
        const bits = head.readUInt16BE(entry + 26)
        if (bits > 0 && bits <= 32) meta.bitDepth = bits
        // 16.16 fixed-point sample rate.
        meta.sampleRate = head.readUInt32BE(entry + 32) >>> 16
      }
    }
  }

  const ilst = findPath(head, moov.body, moov.end, ['udta', 'meta', 'ilst'])
  if (ilst) applyIlst(head, ilst.body, ilst.end, meta)

  return meta
}

interface Atom {
  /** Offset of the atom's payload. */
  body: number
  /** Offset one past the atom's last byte. */
  end: number
}

function findAtom(buf: Buffer, from: number, to: number, type: string): Atom | null {
  let off = from
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off)
    const atomType = buf.toString('ascii', off + 4, off + 8)
    let body = off + 8
    if (size === 1) {
      // 64-bit extended size.
      if (off + 16 > to) return null
      const hi = buf.readUInt32BE(off + 8)
      const lo = buf.readUInt32BE(off + 12)
      size = hi * 2 ** 32 + lo
      body = off + 16
    } else if (size === 0) {
      size = to - off
    }
    if (size < 8) return null
    const end = Math.min(off + size, to)
    if (atomType === type) return { body, end }
    off += size
  }
  return null
}

/** Walks a chain of nested atoms, tolerating the 4-byte version field on `meta`. */
function findPath(buf: Buffer, from: number, to: number, path: string[]): Atom | null {
  let current: Atom = { body: from, end: to }
  for (const type of path) {
    const next = findAtom(buf, current.body, current.end, type)
    if (!next) return null
    // `meta` is a full atom (version + flags) rather than a plain container.
    current = type === 'meta' ? { body: next.body + 4, end: next.end } : next
  }
  return current
}

function applyIlst(buf: Buffer, from: number, to: number, meta: TrackMetadata): void {
  let off = from
  while (off + 8 <= to) {
    const size = buf.readUInt32BE(off)
    if (size < 8) return
    const name = buf.toString('latin1', off + 4, off + 8)
    const data = findAtom(buf, off + 8, Math.min(off + size, to), 'data')
    if (data && data.body + 8 <= buf.length) {
      const payload = buf.subarray(data.body + 8, data.end)
      if (name === 'tmpo' && payload.length >= 2) {
        const bpm = payload.readUInt16BE(0)
        if (bpm > 20 && bpm < 400) meta.bpm = bpm
      } else if (name === '©key' || name === 'keyy') {
        applyTag('KEY', payload.toString('utf8'), meta)
      }
    }
    off += size
  }
}

/* ------------------------------------------------------------------ OGG / Opus */

function parseOgg(windows: Windows): TrackMetadata {
  const { head, tail } = windows
  const meta: TrackMetadata = {}
  if (head.length < 4 || head.toString('ascii', 0, 4) !== 'OggS') return {}

  const firstPacket = readOggPacket(head, 0)
  if (!firstPacket) return {}

  let granuleRate = 0
  if (firstPacket.data.length >= 16 && firstPacket.data.toString('ascii', 1, 7) === 'vorbis') {
    meta.channels = firstPacket.data[11]
    meta.sampleRate = firstPacket.data.readUInt32LE(12)
    const nominal = firstPacket.data.length >= 24 ? firstPacket.data.readUInt32LE(20) : 0
    if (nominal > 0) meta.bitrate = nominal
    granuleRate = meta.sampleRate
  } else if (firstPacket.data.length >= 19 && firstPacket.data.toString('ascii', 0, 8) === 'OpusHead') {
    meta.channels = firstPacket.data[9]
    // Opus always reports granule positions on a 48 kHz clock regardless of input rate.
    meta.sampleRate = firstPacket.data.readUInt32LE(12) || 48000
    granuleRate = 48000
  } else {
    return {}
  }

  // The last page's granule position is the total decoded sample count.
  const lastGranule = findLastGranulePosition(tail)
  if (lastGranule > 0 && granuleRate > 0) {
    meta.duration = round3(lastGranule / granuleRate)
  }

  const comment = readOggPacket(head, firstPacket.nextPageOffset)
  if (comment && comment.data.length > 7) {
    const magic = comment.data.toString('ascii', 0, 8)
    if (magic === 'OpusTags') applyVorbisComment(comment.data.subarray(8), meta)
    else if (comment.data.toString('ascii', 1, 7) === 'vorbis') {
      applyVorbisComment(comment.data.subarray(7), meta)
    }
  }

  return meta
}

function readOggPacket(buf: Buffer, pageOffset: number): { data: Buffer; nextPageOffset: number } | null {
  if (pageOffset + 27 > buf.length) return null
  if (buf.toString('ascii', pageOffset, pageOffset + 4) !== 'OggS') return null
  const segmentCount = buf[pageOffset + 26]
  const tableOffset = pageOffset + 27
  if (tableOffset + segmentCount > buf.length) return null
  let payloadSize = 0
  for (let i = 0; i < segmentCount; i++) payloadSize += buf[tableOffset + i]
  const payloadOffset = tableOffset + segmentCount
  if (payloadOffset + payloadSize > buf.length) return null
  return {
    data: buf.subarray(payloadOffset, payloadOffset + payloadSize),
    nextPageOffset: payloadOffset + payloadSize
  }
}

function findLastGranulePosition(tail: Buffer): number {
  for (let i = tail.length - 27; i >= 0; i--) {
    if (
      tail[i] === 0x4f &&
      tail[i + 1] === 0x67 &&
      tail[i + 2] === 0x67 &&
      tail[i + 3] === 0x53
    ) {
      const lo = tail.readUInt32LE(i + 6)
      const hi = tail.readUInt32LE(i + 10)
      const granule = hi * 2 ** 32 + lo
      // 0xFFFFFFFFFFFFFFFF marks a page with no completed packet.
      if (granule > 0 && granule < 2 ** 53) return granule
    }
  }
  return 0
}

/* ------------------------------------------------------------------ ID3v2 */

function readSynchsafe(buf: Buffer, off: number): number {
  return (
    ((buf[off] & 0x7f) << 21) |
    ((buf[off + 1] & 0x7f) << 14) |
    ((buf[off + 2] & 0x7f) << 7) |
    (buf[off + 3] & 0x7f)
  )
}

function applyId3(buf: Buffer, meta: TrackMetadata): void {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return
  const majorVersion = buf[3]
  const flags = buf[5]
  const tagSize = readSynchsafe(buf, 6)

  let off = 10
  // Skip the extended header when present.
  if (flags & 0x40 && off + 4 <= buf.length) {
    off += majorVersion === 4 ? readSynchsafe(buf, off) : buf.readUInt32BE(off) + 4
  }

  const end = Math.min(10 + tagSize, buf.length)
  const frameHeaderSize = majorVersion === 2 ? 6 : 10
  const idLength = majorVersion === 2 ? 3 : 4

  while (off + frameHeaderSize <= end) {
    const id = buf.toString('ascii', off, off + idLength)
    if (id[0] === '\0') break

    let frameSize: number
    if (majorVersion === 2) {
      frameSize = (buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5]
    } else if (majorVersion === 4) {
      frameSize = readSynchsafe(buf, off + 4)
    } else {
      frameSize = buf.readUInt32BE(off + 4)
    }

    const body = off + frameHeaderSize
    if (frameSize <= 0 || body + frameSize > end) break

    if (id === 'TBPM' || id === 'TKEY' || id === 'TBP' || id === 'TKE') {
      const text = decodeId3Text(buf.subarray(body, body + frameSize))
      applyTag(id.startsWith('TB') ? 'BPM' : 'KEY', text, meta)
    }

    off = body + frameSize
  }
}

function decodeId3Text(buf: Buffer): string {
  if (buf.length === 0) return ''
  const encoding = buf[0]
  const body = buf.subarray(1)
  let text: string
  switch (encoding) {
    case 1:
      text = body.toString('utf16le').replace(/^﻿/, '')
      break
    case 2:
      // UTF-16BE: swap byte pairs into LE before decoding.
      text = Buffer.from(body).swap16().toString('utf16le')
      break
    case 3:
      text = body.toString('utf8')
      break
    default:
      text = body.toString('latin1')
  }
  return text.replace(/\0+$/, '').trim()
}

/* ------------------------------------------------------------------ tag mapping */

function applyTag(name: string, rawValue: string, meta: TrackMetadata): void {
  const value = rawValue.replace(/\0+$/, '').trim()
  if (!value) return

  if (name === 'BPM' || name === 'TEMPO') {
    const bpm = Number.parseFloat(value)
    if (Number.isFinite(bpm) && bpm > 20 && bpm < 400) meta.bpm = round2(bpm)
    return
  }
  if (name === 'KEY' || name === 'INITIALKEY' || name === 'INITIAL KEY') {
    const key = normaliseKey(value)
    if (key) meta.musicalKey = key
  }
}

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiNoteToKey(note: number): string {
  return PITCH_CLASSES[note % 12]
}

/* ------------------------------------------------------------------ filename hints */

const BPM_EXPLICIT = /(\d{2,3}(?:\.\d+)?)\s*bpm\b/i
const BPM_PREFIXED = /\bbpm[\s_-]*(\d{2,3}(?:\.\d+)?)\b/i
const KEY_TOKEN = /(?:^|[\s_\-([])([A-G])([#b])?[\s_-]?(maj|major|min|minor|m)(?=$|[\s_\-)\].])/i
const KEY_ACCIDENTAL = /(?:^|[\s_\-([])([A-G])([#b])(?=$|[\s_\-)\].])/

/**
 * Extracts tempo and key from a file name. Deliberately conservative: a bare number is
 * only read as a tempo when it stands alone as a token and lands in a musical range,
 * otherwise sample rates and dates in file names would masquerade as BPM.
 */
export function parseNameHints(filePath: string): { bpm?: number; musicalKey?: string } {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const fileName = slash === -1 ? filePath : filePath.slice(slash + 1)
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName

  const result: { bpm?: number; musicalKey?: string } = {}

  const explicit = BPM_EXPLICIT.exec(stem) ?? BPM_PREFIXED.exec(stem)
  if (explicit) {
    const bpm = Number.parseFloat(explicit[1])
    if (bpm > 20 && bpm < 400) result.bpm = round2(bpm)
  } else {
    for (const token of stem.split(/[\s_\-()[\]]+/)) {
      if (!/^\d{2,3}$/.test(token)) continue
      const value = Number.parseInt(token, 10)
      // 60-200 covers essentially all produced music without catching years or
      // "16bit"/"24" style tokens.
      if (value >= 60 && value <= 200) {
        result.bpm = value
        break
      }
    }
  }

  const keyed = KEY_TOKEN.exec(stem)
  if (keyed) {
    result.musicalKey = normaliseKey(`${keyed[1]}${keyed[2] ?? ''}${keyed[3]}`)
  } else {
    const accidental = KEY_ACCIDENTAL.exec(stem)
    // A bare letter like "A" is far too common in file names to treat as a key, so an
    // accidental is required when there is no major/minor suffix.
    if (accidental) result.musicalKey = normaliseKey(`${accidental[1]}${accidental[2]}`)
  }

  return result
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
