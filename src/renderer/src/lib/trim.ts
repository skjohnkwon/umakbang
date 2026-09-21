/**
 * Cutting a piece out of a track and writing it back as a file.
 *
 * The only place in the app that produces audio rather than reading it, so it is deliberately
 * explicit end to end: a region the user dragged, a name the user typed, a file written
 * beside the original. Nothing here ever overwrites the source.
 *
 * Format follows the source where it can. A WAV in gives a WAV out, bit for bit the samples
 * that were already there; an MP3 in gives an MP3 out, which costs one more lossy generation
 * and is still the answer, because a 4MB beat that trims into a 40MB WAV is not a trim
 * anybody wanted. Everything else - FLAC, Ogg, M4A - comes out as WAV: those decode fine, and
 * shipping an encoder for each of them to avoid one honest format change is not a trade worth
 * making.
 */

import type { Track } from '@shared/types'
import { encodeMp3, nearestBitrate, toInt16 } from '@/lib/mp3'

/** What a trim produced, ready to be written. */
export interface TrimResult {
  bytes: Uint8Array
  /** The extension the bytes actually are, which is not always the source's. */
  ext: 'wav' | 'mp3'
  seconds: number
}

/** Extensions we can write back in their own format. Everything else becomes a WAV. */
const MP3_SOURCES = new Set(['mp3'])

/** A RIFF/WAVE container around the samples. */
function encodeWav(pcm: Int16Array, channels: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true) // byte rate
  view.setUint16(32, channels * 2, true) // block align
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44)
  return bytes
}

/**
 * Cuts `from`..`to` (seconds) out of a decoded track.
 *
 * The bitrate for an MP3 is taken from the source rather than assumed, so trimming a 320k
 * beat does not quietly hand back a 128k one. Rounded to the nearest rate LAME accepts.
 */
export async function trimBuffer(
  buffer: AudioBuffer,
  track: Track,
  from: number,
  to: number
): Promise<TrimResult> {
  const start = Math.max(0, Math.floor(from * buffer.sampleRate))
  const end = Math.min(buffer.length, Math.ceil(to * buffer.sampleRate))
  if (end <= start) throw new Error('That selection is empty.')

  const pcm = toInt16(buffer, start, end)
  const seconds = (end - start) / buffer.sampleRate

  if (MP3_SOURCES.has(track.ext)) {
    const rate = nearestBitrate(track.bitrate ? Math.round(track.bitrate / 1000) : 192)
    return { bytes: await encodeMp3(pcm, buffer.numberOfChannels, buffer.sampleRate, rate), ext: 'mp3', seconds }
  }

  return {
    bytes: encodeWav(pcm, buffer.numberOfChannels, buffer.sampleRate),
    ext: 'wav',
    seconds
  }
}

/** "beat.wav" trimmed 8.0s-16.2s becomes "beat (trim 8.0-16.2).wav". */
export function trimName(name: string, from: number, to: number, ext: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem} (trim ${from.toFixed(1)}-${to.toFixed(1)}).${ext}`
}
