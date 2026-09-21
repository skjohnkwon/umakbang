/**
 * Pulling a peer's index, for a root that lives on another machine.
 *
 * A remote root is not walked - there is nothing here to walk. Its rows come from the
 * machine that owns them, already carrying everything a scan would have worked out: sizes,
 * tempos, keys, what has been probed. So this is a download and a parse where a local root
 * has a filesystem walk, and it lands in the same saved index, so a second launch opens the
 * remote library from cache exactly as a local one does.
 *
 * It runs in the scanner process for the reason everything else does: it is a 240MB gunzip
 * and a third of a million `JSON.parse` calls, which is not work for the thread that paints
 * the window.
 */

import { get as httpGet } from 'node:http'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import type { LibraryRoot, Track } from '../shared/types'

/** Kept in step with `REMOTE_PORT` in `remote.ts`, which owns the number. */
const REMOTE_PORT = 47828

/** Rows per message, matching what the cached-index replay sends. */
const BATCH = 1000

export interface RemoteIndexResult {
  tracks: Track[]
  /** Set when nothing could be fetched. The caller reports it and keeps any cached rows. */
  error?: string
}

/**
 * Fetches and parses a remote library's index, handing rows over in batches as they arrive.
 *
 * Streamed rather than buffered: the response is a quarter of a gigabyte uncompressed, and
 * the point of streaming it is that the first folder is on screen long before the last row
 * has been parsed.
 *
 * A row that will not parse is skipped rather than fatal. One torn line in the middle of a
 * transfer should cost that file, not the library.
 */
export function fetchRemoteIndex(
  root: LibraryRoot,
  onBatch: (tracks: Track[]) => void
): Promise<RemoteIndexResult> {
  const remote = root.remote
  if (!remote) return Promise.resolve({ tracks: [], error: 'not a remote root' })

  return new Promise<RemoteIndexResult>((resolve) => {
    const path = `/index?library=${encodeURIComponent(remote.libraryId)}`
    const request = httpGet({ host: remote.host, port: REMOTE_PORT, path }, (response) => {
      if (response.statusCode === 204) {
        // The peer has no index yet: it is running, it just has not scanned. Not an error.
        response.resume()
        resolve({ tracks: [] })
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        resolve({ tracks: [], error: `${remote.deviceName} answered ${response.statusCode}.` })
        return
      }

      const encoded = response.headers['content-encoding'] === 'gzip'
      const source = encoded ? response.pipe(createGunzip()) : response
      const lines = createInterface({ input: source, crlfDelay: Infinity })

      const all: Track[] = []
      let batch: Track[] = []
      lines.on('line', (line) => {
        if (!line) return
        try {
          const track = JSON.parse(line) as Track
          if (!track.path) return
          all.push(track)
          batch.push(track)
          if (batch.length >= BATCH) {
            onBatch(batch)
            batch = []
          }
        } catch {
          // One unreadable row is one missing file, not a failed library.
        }
      })
      lines.on('close', () => {
        if (batch.length) onBatch(batch)
        resolve({ tracks: all })
      })
      source.on('error', (error: Error) =>
        resolve({ tracks: all, error: `${remote.deviceName}: ${error.message}` })
      )
    })
    request.on('error', (error) =>
      resolve({ tracks: [], error: `${remote.deviceName} is not reachable (${error.message}).` })
    )
  })
}
