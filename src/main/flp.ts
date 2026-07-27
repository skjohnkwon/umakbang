/**
 * Reads the time-tracking record FL Studio keeps inside every .flp.
 *
 * An FLP is a header chunk (`FLhd`) followed by a data chunk (`FLdt`) holding a stream
 * of events. Event 237 (FLP_ProjectTime) carries two OLE automation dates as little
 * endian doubles: when the project was created, and the cumulative time it has been
 * open. That second figure is what makes a real "hours spent producing" number possible.
 *
 * Ported from the standalone flp_time_report.py / flp_dashboard.py tools.
 */

import { readFile } from 'node:fs/promises'

/** OLE automation dates count days from 1899-12-30. */
const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000

const EVENT_PROJECT_TIME = 237

/** FL Studio 3 shipped in 2003; anything outside this window is a corrupt record. */
const SANE_MIN_MS = Date.UTC(1998, 0, 1)

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

export function parseFlpProjectTime(data: Buffer): FlpProjectTime | null {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'FLhd') return null

  const headerLength = data.readUInt32LE(4)
  let pos = 8 + headerLength
  if (pos + 8 > data.length) return null
  if (data.toString('ascii', pos, pos + 4) !== 'FLdt') return null

  const dataLength = data.readUInt32LE(pos + 4)
  pos += 8
  const end = Math.min(pos + dataLength, data.length)

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
      pos += 2
    } else if (eventId < 192) {
      pos += 4
    } else {
      const { value: size, next } = readVarint(data, pos)
      pos = next
      if (!Number.isFinite(size) || size < 0) return null
      if (eventId === EVENT_PROJECT_TIME && size >= 16 && pos + 16 <= data.length) {
        const createdDays = data.readDoubleLE(pos)
        const spanDays = data.readDoubleLE(pos + 8)

        let createdMs: number | undefined
        if (createdDays > 0 && createdDays < 100_000) {
          const candidate = oleDateToLocalMs(createdDays)
          // Reject nonsense dates rather than letting them skew every chart.
          if (candidate >= SANE_MIN_MS && candidate <= Date.now() + 365 * MS_PER_DAY) {
            createdMs = candidate
          }
        }

        const seconds = Number.isFinite(spanDays) ? Math.max(0, spanDays) * 86_400 : 0
        return { createdMs, seconds: Math.round(seconds) }
      }
      pos += size
    }

    if (pos <= cursorBefore) return null
  }

  return null
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
