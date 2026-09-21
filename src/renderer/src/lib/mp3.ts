/**
 * Turning decoded audio back into bytes.
 *
 * This lived inside `trim.ts` while a trim was the only thing in the app that produced an
 * audio file. A download is the second, and two copies of an encoder is how the trim and the
 * download end up disagreeing about which bitrates LAME accepts, or about whether a sample a
 * hair over 0dBFS clips or wraps. One implementation, two callers.
 */

/**
 * Interleaved 16-bit PCM, which is what both writers want.
 *
 * Float samples outside -1..1 are clipped rather than wrapped: a mastered beat sits at 0dBFS
 * and the odd sample lands a hair over, and wrapping turns that into a click.
 */
export function toInt16(buffer: AudioBuffer, from = 0, to = buffer.length): Int16Array {
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

/** The rates LAME will take, loudest first, so a source can be rounded down to one. */
export const MP3_BITRATES = [320, 256, 192, 160, 128, 112, 96, 64] as const

/** The nearest rate at or below what was asked for. */
export function nearestBitrate(kbps: number): number {
  return MP3_BITRATES.find((rate) => rate <= kbps) ?? 64
}

/**
 * MP3 through LAME.
 *
 * Imported dynamically so the encoder is a code-split chunk rather than something every
 * launch parses - it is only ever wanted at the moment somebody saves a trim or finishes a
 * download. It is LGPL-3.0, which this app can carry because it is already AGPL-3.0 for
 * Essentia's sake.
 *
 * `onProgress` exists for the download, which encodes a whole track rather than a bar of one:
 * a five-minute stereo file is a few thousand blocks and several seconds of a busy main
 * thread, and a dialog that says nothing for that long reads as a hang. A trim passes nothing
 * and pays for one comparison per block.
 */
export async function encodeMp3(
  pcm: Int16Array,
  channels: number,
  sampleRate: number,
  kbps: number,
  onProgress?: (fraction: number) => void
): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const encoder = new Mp3Encoder(channels, sampleRate, kbps)

  // A block per 1152 frames, which is the MP3 frame size LAME wants fed to it.
  const BLOCK = 1152
  const chunks: Uint8Array[] = []
  const left = new Int16Array(BLOCK)
  const right = new Int16Array(BLOCK)
  const frames = pcm.length / channels

  for (let offset = 0; offset < frames; offset += BLOCK) {
    const count = Math.min(BLOCK, frames - offset)
    for (let i = 0; i < count; i++) {
      left[i] = pcm[(offset + i) * channels]
      right[i] = channels > 1 ? pcm[(offset + i) * channels + 1] : left[i]
    }
    const block =
      channels > 1
        ? encoder.encodeBuffer(left.subarray(0, count), right.subarray(0, count))
        : encoder.encodeBuffer(left.subarray(0, count))
    if (block.length > 0) chunks.push(new Uint8Array(block))
    onProgress?.(offset / frames)
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
  onProgress?.(1)
  return out
}
