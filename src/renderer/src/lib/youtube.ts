/**
 * The half of a download that has to happen in the renderer.
 *
 * yt-dlp can write an MP3 itself, but only by handing the stream to ffmpeg - and a packed
 * Electron app cannot count on a system binary, which is the rule that shaped contracts (no
 * pandoc) and the video exporter (no ffmpeg) before it. Fetching a *second* 80MB binary to
 * transcode a file the app can already decode is the answer nobody would defend.
 *
 * What is already here is a Chromium decoder that reads AAC and Opus, and LAME, which the
 * trim tool encodes through. So main leaves the stream on disk, this decodes it through the
 * protocol handler the waveforms already fetch over, and hands the bytes back to be placed.
 */

import { encodeMp3, nearestBitrate, toInt16 } from '@/lib/mp3'

/**
 * One context for the feature, built lazily.
 *
 * `peaks.ts` keeps its own for the same reason - a context is a real audio device and a
 * handful of them costs more than the decode - and this deliberately does not reach for
 * that one: it is a download, not a row scrolling past, and it must not sit behind the
 * decode queue that browsing keeps busy.
 */
let context: AudioContext | null = null
function audioContext(): AudioContext {
  context ??= new AudioContext()
  return context
}

/**
 * Reads the downloaded stream and re-encodes it as an MP3.
 *
 * A second lossy generation over what is already a lossy stream, which is the honest cost of
 * asking for an MP3 at all - `youtubeFormat: 'source'` is the way to avoid it, and the
 * Settings row says so. The bitrate is the user's, not the source's: unlike a trim, where
 * matching the source is the whole point, there is no bitrate to match here that the
 * container reliably declares.
 */
export async function transcodeToMp3(
  tempPath: string,
  kbps: number,
  onProgress?: (fraction: number) => void
): Promise<Uint8Array> {
  const response = await fetch(window.umakbang.fileUrl(tempPath))
  if (!response.ok) throw new Error('The downloaded file could not be read back.')

  const buffer = await audioContext().decodeAudioData(await response.arrayBuffer())
  const pcm = toInt16(buffer)

  return encodeMp3(
    pcm,
    buffer.numberOfChannels,
    buffer.sampleRate,
    nearestBitrate(kbps),
    onProgress
  )
}

/** Whether a string is worth handing to the extractor at all. */
export function looksLikeLink(value: string): boolean {
  const text = value.trim()
  if (!text || /\s/.test(text)) return false
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
