/**
 * The small amount of signal processing the analysis passes share.
 *
 * Lives on its own because tempo and key both need a transform and neither should own the
 * other's copy of it. No dependencies and no DOM, so this is equally usable from a worker.
 */

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return w
}

/** In-place iterative radix-2 Cooley-Tukey FFT. `size` must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + half] = aRe - bRe
        im[i + k + half] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/** Anything with enough of an AudioBuffer surface to analyse. */
export interface AudioBufferLike {
  numberOfChannels: number
  length: number
  sampleRate: number
  duration: number
  getChannelData(channel: number): Float32Array
}

/**
 * Downmix to mono and decimate by an integer factor. The boxcar average over each output
 * sample doubles as the anti-alias filter: crude, but both analyses care about broad
 * spectral movement rather than fidelity.
 */
export function toMonoDecimated(
  buffer: AudioBufferLike,
  targetRate: number,
  maxSeconds: number
): { signal: Float32Array; rate: number } {
  const sampleRate = buffer.sampleRate
  const usable = Math.min(buffer.length, Math.floor(sampleRate * maxSeconds))
  const factor = Math.max(1, Math.floor(sampleRate / targetRate))
  const outLength = Math.floor(usable / factor)
  const out = new Float32Array(outLength)

  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  const channelCount = channels.length
  const invChannels = 1 / channelCount

  for (let i = 0; i < outLength; i++) {
    const start = i * factor
    let acc = 0
    for (let k = 0; k < factor; k++) {
      const idx = start + k
      let sum = 0
      for (let c = 0; c < channelCount; c++) sum += channels[c][idx]
      acc += sum * invChannels
    }
    out[i] = acc / factor
  }

  return { signal: out, rate: sampleRate / factor }
}
