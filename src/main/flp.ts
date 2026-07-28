/**
 * Reads what FL Studio records about a project inside the .flp itself.
 *
 * An FLP is a header chunk (`FLhd`) followed by a data chunk (`FLdt`) holding a stream
 * of events. Event 237 (FLP_ProjectTime) carries two OLE automation dates as little
 * endian doubles: when the project was created, and the cumulative time it has been
 * open. That second figure is what makes a real "hours spent producing" number possible.
 *
 * Event 156 is the project tempo in milli-BPM, which is the number the audio tempo
 * detector spends a full decode guessing at and gets wrong a third of the time. Older
 * projects carry event 66 instead, a word holding whole BPM.
 *
 * Ported from the standalone flp_time_report.py / flp_dashboard.py tools.
 */

import { open, readFile } from 'node:fs/promises'
import { plausibleBpm } from '../shared/tempo'

/** OLE automation dates count days from 1899-12-30. */
const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000

const EVENT_TEMPO = 66
const EVENT_FINE_TEMPO = 156
const EVENT_PROJECT_TIME = 237

/** FL Studio 3 shipped in 2003; anything outside this window is a corrupt record. */
const SANE_MIN_MS = Date.UTC(1998, 0, 1)

/**
 * How much of a project is read when only the tempo is wanted.
 *
 * Measured over 200 projects in this library the tempo event never sits further than a few
 * hundred bytes in, while the files themselves run to tens of megabytes. A folder's worth
 * of projects read whole, to recover one number from each, is gigabytes of I/O for nothing.
 */
const TEMPO_HEAD_BYTES = 256 * 1024

/**
 * How far into the event stream the tempo is looked for when the walk cannot reach it.
 *
 * Measured over every project in this library, the deepest the event has ever sat is 150
 * bytes in. The window is small on purpose: this is a byte pattern rather than a parse, and
 * the fewer bytes it is offered the fewer chances it has to find one by accident.
 */
const TEMPO_SCAN_BYTES = 4096

export interface FlpProject {
  /** Epoch millis the project was created, when the stored date is plausible. */
  createdMs?: number
  /** Cumulative seconds the project has been open in FL Studio. */
  seconds?: number
  /**
   * Project tempo in BPM. Whatever the file holds - the caller still decides whether to
   * believe it, the same as for a tempo off a tag or an ACID chunk.
   */
  bpm?: number
}

export interface FlpProjectTime {
  /** Epoch millis the project was created, when the stored date is plausible. */
  createdMs?: number
  /** Cumulative seconds the project has been open in FL Studio. */
  seconds: number
}

/**
 * Converts an OLE automation date to an epoch timestamp.
 *
 * FL Studio writes the machine's *local* wall-clock reading, with no zone attached. So
 * the raw value is decoded as UTC to recover the calendar fields, then rebuilt in the
 * local zone so it renders back as the same clock time. Skipping this shifts every
 * timestamp by the UTC offset, which would quietly rotate the hour-of-day heatmap.
 */
function oleDateToLocalMs(days: number): number {
  const utc = new Date(OLE_EPOCH_MS + days * MS_PER_DAY)
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds(),
    utc.getUTCMilliseconds()
  ).getTime()
}

/**
 * Reads a variable-length integer, returning the value and the position after it.
 *
 * Accumulated by multiplication rather than `<<`: JavaScript's shift operators are 32-bit
 * *signed*, so a fifth continuation byte pushes bits into the sign bit and the result
 * comes back negative. A negative size then rewinds the event cursor and the parser spins
 * forever. (The Python original is immune because its integers are arbitrary precision.)
 */
function readVarint(buf: Buffer, start: number): { value: number; next: number } {
  let value = 0
  let scale = 1
  let pos = start
  while (pos < buf.length) {
    const byte = buf[pos]
    pos++
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return { value, next: pos }
    scale *= 128
    // A sane event size never needs more than five continuation bytes.
    if (scale > 0x10000000) break
  }
  return { value, next: pos }
}

/**
 * Walks the event stream once, collecting everything worth having out of it.
 *
 * One pass rather than one per field: the tempo and the time record sit at opposite ends of
 * the stream in some projects and in the same handful of bytes in others, and walking twice
 * to find out which would double the cost of the pass that already reads every project in
 * the library. The walk stops as soon as both have been found.
 */
export function parseFlp(data: Buffer): FlpProject | null {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'FLhd') return null

  const headerLength = data.readUInt32LE(4)
  let pos = 8 + headerLength
  if (pos + 8 > data.length) return null
  if (data.toString('ascii', pos, pos + 4) !== 'FLdt') return null

  const dataLength = data.readUInt32LE(pos + 4)
  pos += 8
  const events = pos
  const end = Math.min(pos + dataLength, data.length)

  const found: FlpProject = {}
  /** Whole-BPM event 66, kept only until the milli-BPM event proves it has a better one. */
  let coarseBpm: number | undefined

  while (pos < end) {
    // Belt and braces: a malformed file must never be able to stall the scan, whatever
    // the cause. The cursor has to move forward on every iteration.
    const cursorBefore = pos

    const eventId = data[pos]
    pos++

    // Event size is encoded by id range: byte, word, dword, then variable.
    if (eventId < 64) {
      pos += 1
    } else if (eventId < 128) {
      if (eventId === EVENT_TEMPO && coarseBpm === undefined && pos + 2 <= data.length) {
        coarseBpm = data.readUInt16LE(pos)
      }
      pos += 2
    } else if (eventId < 192) {
      // First one wins, here and for the time record below: the walk used to stop at the
      // event it was looking for, and continuing past it must not let a later write of the
      // same event supersede the one that answer used to come from.
      if (eventId === EVENT_FINE_TEMPO && found.bpm === undefined && pos + 4 <= data.length) {
        found.bpm = round2(data.readUInt32LE(pos) / 1000)
      }
      pos += 4
    } else {
      const { value: size, next } = readVarint(data, pos)
      pos = next
      // A size that makes no sense is the end of anything trustworthy in this file, but
      // whatever was read before it still stands.
      if (!Number.isFinite(size) || size < 0) break
      if (
        eventId === EVENT_PROJECT_TIME &&
        found.seconds === undefined &&
        size >= 16 &&
        pos + 16 <= data.length
      ) {
        const createdDays = data.readDoubleLE(pos)
        const spanDays = data.readDoubleLE(pos + 8)

        if (createdDays > 0 && createdDays < 100_000) {
          const candidate = oleDateToLocalMs(createdDays)
          // Reject nonsense dates rather than letting them skew every chart.
          if (candidate >= SANE_MIN_MS && candidate <= Date.now() + 365 * MS_PER_DAY) {
            found.createdMs = candidate
          }
        }

        const seconds = Number.isFinite(spanDays) ? Math.max(0, spanDays) * 86_400 : 0
        found.seconds = Math.round(seconds)
      }
      pos += size
    }

    if (found.bpm !== undefined && found.seconds !== undefined) break
    if (pos <= cursorBefore) break
  }

  // The old event is the answer only where the precise one never appeared.
  if (found.bpm === undefined && coarseBpm !== undefined) found.bpm = coarseBpm
  // And the byte pattern is the answer only where the walk came back with no tempo at all,
  // or with one no music is played at, which is what a lost stream reads as.
  if (!plausibleBpm(found.bpm)) {
    const scanned = scanForTempo(data, events)
    if (scanned !== undefined) found.bpm = scanned
  }
  return found
}

/**
 * Finds the tempo event by its bytes, for the projects the walk cannot reach it in.
 *
 * FL Studio 25.2.4 writes four bytes between the loop flag and the registration string that
 * the id-range sizing rule gets wrong, and the walk loses the stream there - permanently,
 * two bytes before the tempo. It is 162 of the 2,784 projects in this library and every one
 * of them is a recent save, so it is the newest work that would go without.
 *
 * The event is unmistakable enough to find directly: the id byte, then a dword that has to
 * be a tempo music is actually played at and a whole tenth of a BPM. Measured over every
 * project here, that agreed with the walk 2,583 times, contradicted it none, and answered
 * all 162 the walk had lost - never further than 150 bytes into the stream.
 */
function scanForTempo(data: Buffer, from: number): number | undefined {
  const limit = Math.min(data.length - 5, from + TEMPO_SCAN_BYTES)
  for (let i = from; i < limit; i++) {
    if (data[i] !== EVENT_FINE_TEMPO) continue
    const milli = data.readUInt32LE(i + 1)
    if (milli % 100 !== 0) continue
    const bpm = round2(milli / 1000)
    if (plausibleBpm(bpm)) return bpm
  }
  return undefined
}

export function parseFlpProjectTime(data: Buffer): FlpProjectTime | null {
  const project = parseFlp(data)
  if (!project || project.seconds === undefined) return null
  return { createdMs: project.createdMs, seconds: project.seconds }
}

/** Whole-file read: the record sits early, but FLPs are small enough not to bother seeking. */
export async function readFlpProjectTime(path: string): Promise<FlpProjectTime | null> {
  try {
    const data = await readFile(path)
    return parseFlpProjectTime(data)
  } catch {
    return null
  }
}

/**
 * The project's tempo, from as little of the file as it takes to find it.
 *
 * The whole file is only read when the head window came back without one, so a project that
 * buries its tempo behind a large early event still answers rather than silently going
 * unmatched. Errors are swallowed per file for the usual reason: one unreadable project must
 * never stop the pass.
 */
export async function readFlpTempo(path: string): Promise<number | undefined> {
  try {
    const head = await readHead(path, TEMPO_HEAD_BYTES)
    const fromHead = parseFlp(head)?.bpm
    if (fromHead !== undefined) return fromHead
    // A short read means the head window already held the whole file.
    if (head.length < TEMPO_HEAD_BYTES) return undefined
    return parseFlp(await readFile(path))?.bpm
  } catch {
    return undefined
  }
}

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buf, 0, length, 0)
    // Trimmed, not returned whole: allocUnsafe leaves recycled heap behind a short read and
    // the parser would walk it as though it were file content.
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
