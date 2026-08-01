/**
 * A minimal MP4 writer: one H.264 track, one AAC track, sample tables built by hand.
 *
 * This exists because `MediaRecorder` cannot be driven faster than real time. It looks as
 * though it can - it accepts frames from a `MediaStreamTrackGenerator` as fast as you push
 * them - but it muxes by *arrival*, not by the timestamps the frames carry, and it drops
 * whatever it cannot consume live. Measured on a 30 second project rendered in 12.6s of wall
 * clock: the audio track came out 29.932s and correct, the video track came out **12.576s**
 * with sample deltas from 6.5ms to 580ms. That is a video which plays at two and a half times
 * speed, stutters the whole way, and then freezes for seventeen seconds while the sound
 * carries on. A five second smoke test did not show it, because five seconds fits inside the
 * buffers that were being overrun.
 *
 * `VideoEncoder` and `AudioEncoder` have neither problem: they queue rather than drop,
 * `encodeQueueSize` is real backpressure, and the timestamp on a chunk is the one that was
 * put there. What they do not do is containerise, which is what this file is for.
 *
 * Deliberately not a general muxer. Two tracks, one sample description each, no edit lists,
 * no fragmentation - which is the whole of what an export from this app produces, and every
 * feature not written here is a box that cannot be wrong.
 */

export interface EncodedSample {
  data: Uint8Array
  /** Presentation time in the track's own timescale. */
  time: number
  /** Length in the track's own timescale. */
  duration: number
  key: boolean
}

export interface TrackData {
  timescale: number
  /** `avcC` for video, `AudioSpecificConfig` for audio, straight off the encoder. */
  description: Uint8Array
  samples: EncodedSample[]
}

export interface VideoTrackData extends TrackData {
  width: number
  height: number
}

export interface AudioTrackData extends TrackData {
  sampleRate: number
  channels: number
}

/** Milliseconds, which is what the movie header counts in here. */
const MOVIE_TIMESCALE = 1000

/* --- bytes --------------------------------------------------------------------------- */

function u8(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function u16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2)
  const view = new DataView(out.buffer)
  values.forEach((value, index) => view.setUint16(index * 2, value))
  return out
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  // `>>> 0` because a chunk offset past 2GB is a negative signed int otherwise.
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0))
  return out
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function zeros(count: number): Uint8Array {
  return new Uint8Array(count)
}

function join(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = join(payload)
  return join([u32(body.length + 8), ascii(type), body])
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload)
}

/* --- tables -------------------------------------------------------------------------- */

/** Run-length encoded sample durations. Uniform frame timing collapses to one entry. */
function stts(samples: EncodedSample[]): Uint8Array {
  const runs: number[] = []
  for (const sample of samples) {
    const at = runs.length - 2
    if (at >= 0 && runs[at + 1] === sample.duration) runs[at] += 1
    else runs.push(1, sample.duration)
  }
  return fullBox('stts', 0, 0, u32(runs.length / 2), u32(...runs))
}

function stsz(samples: EncodedSample[]): Uint8Array {
  return fullBox('stsz', 0, 0, u32(0, samples.length), u32(...samples.map((s) => s.data.length)))
}

/** One sample per chunk, so `stco` carries every offset and this stays a constant. */
function stsc(): Uint8Array {
  return fullBox('stsc', 0, 0, u32(1), u32(1, 1, 1))
}

function stco(offsets: number[]): Uint8Array {
  return fullBox('stco', 0, 0, u32(offsets.length), u32(...offsets))
}

/** Which samples are keyframes. Omitted entirely when every sample is one. */
function stss(samples: EncodedSample[]): Uint8Array | null {
  const keys: number[] = []
  samples.forEach((sample, index) => {
    if (sample.key) keys.push(index + 1)
  })
  if (keys.length === 0 || keys.length === samples.length) return null
  return fullBox('stss', 0, 0, u32(keys.length), u32(...keys))
}

/* --- sample descriptions -------------------------------------------------------------- */

function avc1(track: VideoTrackData): Uint8Array {
  return box(
    'avc1',
    zeros(6),
    u16(1), // data reference index
    u16(0, 0), // pre-defined, reserved
    zeros(12), // pre-defined
    u16(track.width, track.height),
    u32(0x0048_0000, 0x0048_0000), // 72dpi, as everything writes
    u32(0),
    u16(1), // one frame per sample
    zeros(32), // compressor name
    u16(0x0018), // depth
    new Uint8Array([0xff, 0xff]), // pre-defined -1
    box('avcC', track.description)
  )
}

/**
 * The AAC sample description, and the fiddly part of this file.
 *
 * `esds` carries nested MPEG-4 descriptors, each a tag, a length and a body. The lengths use
 * a variable-length encoding, but every descriptor here is well under 128 bytes - an
 * AudioSpecificConfig is two - so a single byte is both correct and the whole of it.
 */
function mp4a(track: AudioTrackData, bitrate: number): Uint8Array {
  const specific = join([u8(0x05, track.description.length), track.description])
  const decoderConfig = join([
    u8(0x04, 13 + specific.length),
    u8(0x40), // MPEG-4 audio
    u8(0x15), // audio stream
    u8(0, 0, 0), // buffer size
    u32(bitrate, bitrate), // max and average bitrate
    specific
  ])
  const sl = u8(0x06, 0x01, 0x02)
  const es = join([u8(0x03, 3 + decoderConfig.length + sl.length), u16(1), u8(0), decoderConfig, sl])

  return box(
    'mp4a',
    zeros(6),
    u16(1), // data reference index
    u16(0, 0), // version, revision
    u32(0), // vendor
    u16(track.channels, 16), // channel count, sample size
    u16(0, 0), // pre-defined, reserved
    // 16.16 fixed point, and a rate above 65535 cannot be expressed - which is every rate
    // anyone uses, and why the real rate also lives in `mdhd`.
    u32(Math.min(65535, track.sampleRate) * 65536),
    fullBox('esds', 0, 0, es)
  )
}

/* --- the movie ------------------------------------------------------------------------ */

function duration(track: TrackData): number {
  let total = 0
  for (const sample of track.samples) total += sample.duration
  return total
}

function trak(
  id: number,
  track: TrackData,
  offsets: number[],
  handler: 'vide' | 'soun',
  description: Uint8Array,
  header: Uint8Array,
  movieDuration: number,
  width: number,
  height: number
): Uint8Array {
  const tables: Uint8Array[] = [box('stsd', u32(0, 1), description), stts(track.samples)]
  const sync = stss(track.samples)
  if (sync) tables.push(sync)
  tables.push(stsc(), stsz(track.samples), stco(offsets))

  return box(
    'trak',
    fullBox(
      'tkhd',
      0,
      3, // enabled, in movie
      u32(0, 0, id, 0, movieDuration),
      zeros(8),
      u16(0, 0), // layer, alternate group
      u16(handler === 'soun' ? 0x0100 : 0, 0), // volume
      // Unity matrix.
      u32(0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000),
      u32(width * 65536, height * 65536)
    ),
    box(
      'mdia',
      fullBox('mdhd', 0, 0, u32(0, 0, track.timescale, duration(track)), u16(0x55c4, 0)),
      fullBox('hdlr', 0, 0, u32(0), ascii(handler), zeros(12), ascii('umakbang\0')),
      box(
        'minf',
        header,
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        box('stbl', ...tables)
      )
    )
  )
}

/**
 * Lays the whole file out and hands back the parts to write, in order.
 *
 * Returned as a list rather than one buffer because the sample data is already sitting in
 * memory as the encoder produced it, and concatenating a 200MB video onto itself to hand it
 * over is a second copy of the whole export for no reason. The caller writes them in
 * sequence.
 *
 * `moov` comes before `mdat` - faststart - which means every chunk offset has to be known
 * before the header that carries them can be sized. The header is therefore built twice: the
 * first pass only exists to measure it, and because every offset is a fixed-width `u32` the
 * second pass is exactly the same length as the first.
 */
export function buildMp4(video: VideoTrackData, audio: AudioTrackData, audioBitrate: number): Uint8Array[] {
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'))

  const movieDuration = Math.round(
    (Math.max(duration(video) / video.timescale, duration(audio) / audio.timescale)) * MOVIE_TIMESCALE
  )

  const layout = (mdatStart: number): Uint8Array => {
    let at = mdatStart + 8
    const videoOffsets: number[] = []
    for (const sample of video.samples) {
      videoOffsets.push(at)
      at += sample.data.length
    }
    const audioOffsets: number[] = []
    for (const sample of audio.samples) {
      audioOffsets.push(at)
      at += sample.data.length
    }

    return box(
      'moov',
      fullBox('mvhd', 0, 0, u32(0, 0, MOVIE_TIMESCALE, movieDuration, 0x0001_0000), u16(0x0100, 0),
        zeros(8),
        u32(0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000),
        zeros(24),
        u32(3)),
      trak(1, video, videoOffsets, 'vide', avc1(video), box('vmhd', u32(0x0001_0000), u32(0)), movieDuration, video.width, video.height),
      trak(2, audio, audioOffsets, 'soun', mp4a(audio, audioBitrate), box('smhd', u32(0)), movieDuration, 0, 0)
    )
  }

  // Measure, then place. Same length both times - every offset is a fixed-width field.
  const measured = layout(0)
  const moov = layout(ftyp.length + measured.length)

  let payload = 0
  for (const sample of video.samples) payload += sample.data.length
  for (const sample of audio.samples) payload += sample.data.length

  const parts: Uint8Array[] = [ftyp, moov, join([u32(payload + 8), ascii('mdat')])]
  for (const sample of video.samples) parts.push(sample.data)
  for (const sample of audio.samples) parts.push(sample.data)
  return parts
}
