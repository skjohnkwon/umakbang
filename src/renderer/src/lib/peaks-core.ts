/**
 * The parts of the peaks format that both sides need.
 *
 * Split out of `peaks.ts` because the worker cannot import that file: it reaches for
 * `window.umakbang` and an AudioContext, neither of which exists in a worker.
 */

/** Buckets per file. Enough detail for any realistic on-screen width. */
export const PEAK_BUCKETS = 1024

/**
 * Bytes per bucket: floor, ceiling, and where the bucket's energy sits.
 *
 * Entries cached before the third byte existed are two bytes per bucket. `peakStride`
 * tells them apart; they are decoded again rather than tinted differently from everything
 * else on screen.
 */
export const PEAK_STRIDE = 3

/** Samples the tone estimate is measured over, whatever a bucket happens to be worth. */
export const TONE_WINDOW = 2048

const BRIGHTNESS_FLOOR = 40
const BRIGHTNESS_TOP = 8000

/**
 * Where a bucket's energy sits, 0 (low) to 1 (high), from its zero-crossing rate.
 *
 * The rate is roughly twice the dominant frequency, and pitch is heard logarithmically, so
 * the mapping is log-scaled across the range music actually occupies. Below 40Hz and above
 * 8kHz there is nothing left to distinguish.
 */
export function brightnessOf(crossings: number, samples: number, sampleRate: number): number {
  if (samples <= 1 || crossings === 0) return 0
  const frequency = ((crossings / samples) * sampleRate) / 2
  const span = Math.log(BRIGHTNESS_TOP / BRIGHTNESS_FLOOR)
  return Math.max(0, Math.min(1, Math.log(frequency / BRIGHTNESS_FLOOR) / span))
}

/** 2 for peaks cached before brightness existed, 3 for everything since. */
export function peakStride(peaks: Uint8Array): number {
  return peaks.length >= PEAK_BUCKETS * PEAK_STRIDE ? PEAK_STRIDE : 2
}

/** How many buckets a blob actually holds, whichever format it is in. */
export function peakCount(peaks: Uint8Array): number {
  return Math.floor(peaks.length / peakStride(peaks))
}

/** How loud a bucket is, 0 to 1 - the fallback tint when a bucket has no brightness byte. */
export function peakLoudness(peaks: Uint8Array, bucket: number): number {
  const stride = peakStride(peaks)
  const min = peaks[bucket * stride] / 127.5 - 1
  const max = peaks[bucket * stride + 1] / 127.5 - 1
  return Math.min(1, Math.max(Math.abs(min), Math.abs(max)))
}

/** Where this bucket's energy sits, or null for peaks that predate the third byte. */
export function peakBrightness(peaks: Uint8Array, bucket: number): number | null {
  if (peakStride(peaks) < PEAK_STRIDE) return null
  return peaks[bucket * PEAK_STRIDE + 2] / 255
}
