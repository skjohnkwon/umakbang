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

/** What a trim produced, ready to be written. */
export interface TrimResult {
  bytes: Uint8Array
  /** The extension the bytes actually are, which is not always the source's. */
  ext: 'wav' | 'mp3'
  seconds: number
}

/** Extensions we can write back in their own format. Everything else becomes a WAV. */
const MP3_SOURCES = new Set(['mp3'])

/**
 * Interleaved 16-bit PCM, which is what both writers below want.
 *
 * Float samples outside -1..1 are clipped rather than wrapped: a mastered beat sits at 0dBFS
 * and the odd sample lands a hair over, and wrapping turns that into a click.
 */
function toInt16(buffer: AudioBuffer, from: number, to: number): Int16Array {
  const channels = buffer.numberOfChannels
  const length = to - from
  const out = new Int16Array(length * channels)
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, data[from + i]))
      out[i * channels + channel] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
  }
  return out
}

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
 * MP3 through LAME.
 *
 * Imported dynamically so the encoder is a code-split chunk rather than something every
 * launch parses - it is only ever wanted at the moment somebody saves a trim of an MP3. It is
 * LGPL-3.0, which this app can carry because it is already AGPL-3.0 for Essentia's sake.
 */
async function encodeMp3(
  pcm: Int16Array,
  channels: number,
  sampleRate: number,
  kbps: number
): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const encoder = new Mp3Encoder(channels, sampleRate, kbps)

  // A block per 1152 frames, which is the MP3 frame size LAME wants fed to it.
  const BLOCK = 1152
  const chunks: Uint8Array[] = []
  const left = new Int16Array(BLOCK)
  const right = new Int16Array(BLOCK)

  for (let offset = 0; offset < pcm.length / channels; offset += BLOCK) {
    const frames = Math.min(BLOCK, pcm.length / channels - offset)
    for (let i = 0; i < frames; i++) {
      left[i] = pcm[(offset + i) * channels]
      right[i] = channels > 1 ? pcm[(offset + i) * channels + 1] : left[i]
    }
    const block =
      channels > 1
        ? encoder.encodeBuffer(left.subarray(0, frames), right.subarray(0, frames))
        : encoder.encodeBuffer(left.subarray(0, frames))
    if (block.length > 0) chunks.push(new Uint8Array(block))
  }

  const tail = encoder.flush()
  if (tail.length > 0) chunks.push(new Uint8Array(tail))

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
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
    const source = track.bitrate ? Math.round(track.bitrate / 1000) : 192
    const rate = [320, 256, 192, 160, 128, 112, 96, 64].find((r) => r <= source) ?? 128
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
