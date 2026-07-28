/**
 * AIFF -> WAV rewrapping.
 *
 * Chromium ships no AIFF decoder, but AIFF and WAV are both raw PCM in different
 * containers. Rewrapping the sample data (and byte-swapping it, since AIFF is
 * big-endian) lets an ordinary <audio> element play the AIFF files that Logic and
 * Pro Tools scatter through a production library. Only uncompressed variants are
 * handled - compressed AIFC would need a real codec.
 */

import { readFile } from 'node:fs/promises'

export interface RewrapResult {
  buffer: Buffer
  mimeType: 'audio/wav'
}

export async function aiffToWav(path: string): Promise<RewrapResult | null> {
  const input = await readFile(path)
  if (input.length < 12 || input.toString('ascii', 0, 4) !== 'FORM') return null

  const formType = input.toString('ascii', 8, 12)
  if (formType !== 'AIFF' && formType !== 'AIFC') return null

  let channels = 0
  let sampleRate = 0
  let bitDepth = 0
  let frames = 0
  /** 'NONE' and 'twos' are big-endian; 'sowt' is little-endian. */
  let compression = 'NONE'
  let soundData: Buffer | null = null

  let off = 12
  while (off + 8 <= input.length) {
    const id = input.toString('ascii', off, off + 4)
    const chunkSize = input.readUInt32BE(off + 4)
    const body = off + 8
    if (chunkSize < 0 || body + chunkSize > input.length + 1) break

    if (id === 'COMM' && body + 18 <= input.length) {
      channels = input.readUInt16BE(body)
      frames = input.readUInt32BE(body + 2)
      bitDepth = input.readUInt16BE(body + 6)
      sampleRate = Math.round(readExtendedFloat80(input, body + 8))
      if (formType === 'AIFC' && body + 22 <= input.length) {
        compression = input.toString('ascii', body + 18, body + 22)
      }
    } else if (id === 'SSND' && body + 8 <= input.length) {
      // SSND begins with offset and blockSize fields before the sample data.
      const dataOffset = input.readUInt32BE(body)
      const start = body + 8 + dataOffset
      const end = Math.min(body + chunkSize, input.length)
      if (start < end) soundData = input.subarray(start, end)
    }

    // A zero-size chunk (an empty ANNO or APPL, say) still advances `off` by its 8-byte
    // header, so the loop makes progress; breaking on it would abandon a COMM or SSND
    // sitting right behind it.
    off = body + chunkSize + (chunkSize % 2)
  }

  if (!soundData || !channels || !sampleRate || !bitDepth) return null
  if (bitDepth !== 8 && bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) return null

  const normalised = compression.toLowerCase()
  const isFloat = normalised === 'fl32' || normalised === 'fl64'
  if (isFloat && bitDepth !== 32) return null
  if (!isFloat && normalised !== 'none' && normalised !== 'twos' && normalised !== 'sowt') {
    return null
  }

  const bytesPerSample = bitDepth / 8
  // Trim any padding past the declared frame count.
  const declaredBytes = frames * channels * bytesPerSample
  const pcm = Buffer.from(
    declaredBytes > 0 && declaredBytes <= soundData.length
      ? soundData.subarray(0, declaredBytes)
      : soundData
  )

  // 'sowt' is already little-endian; everything else needs swapping into WAV order.
  if (normalised !== 'sowt' && bitDepth > 8) swapEndianness(pcm, bytesPerSample)

  return { buffer: buildWav(pcm, channels, sampleRate, bitDepth, isFloat), mimeType: 'audio/wav' }
}

function swapEndianness(buf: Buffer, bytesPerSample: number): void {
  if (bytesPerSample === 2) {
    buf.swap16()
    return
  }
  if (bytesPerSample === 4) {
    buf.swap32()
    return
  }
  if (bytesPerSample === 3) {
    for (let i = 0; i + 2 < buf.length; i += 3) {
      const first = buf[i]
      buf[i] = buf[i + 2]
      buf[i + 2] = first
    }
  }
}

function buildWav(
  pcm: Buffer,
  channels: number,
  sampleRate: number,
  bitDepth: number,
  isFloat: boolean
): Buffer {
  const blockAlign = channels * (bitDepth / 8)
  const byteRate = sampleRate * blockAlign
  const header = Buffer.allocUnsafe(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(isFloat ? 3 : 1, 20) // 1 = PCM, 3 = IEEE float
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

function readExtendedFloat80(buf: Buffer, off: number): number {
  if (off + 10 > buf.length) return 0
  const sign = buf[off] & 0x80 ? -1 : 1
  const exponent = ((buf[off] & 0x7f) << 8) | buf[off + 1]
  let mantissa = 0
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + buf[off + 2 + i]
  if (exponent === 0 && mantissa === 0) return 0
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63)
}
