/**
 * The parent's half of the tailnet: deciding whether to serve, and knocking on peers.
 *
 * The serving itself is a utility process (`remote-process.ts`). What stays here is what
 * only the browser process can answer - what the settings say and where Tailscale is - and
 * the client side, which is outbound, tiny, and wanted on demand by the UI.
 *
 * Tailscale carries the security: it is the authentication boundary and WireGuard is the
 * encryption, which deletes pairing codes, token management and TLS. The one thing it cannot
 * cover is *which interface* gets listened on, and that decision is made here: no tailnet
 * address means no server, not a fallback. There is deliberately no way to ask for one.
 */

import { app, utilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { join } from 'node:path'
import type {
  RemoteDevice,
  RemoteHello,
  RemoteLibrary,
  RemoteServerState,
  RemoteStats
} from '../shared/types'
import type { RemoteCommand, RemoteConfig, RemoteEvent } from './remote-process'
import type { SettingsBackup } from '../shared/backup'
import { MACHINE_PATH_SETTINGS, exportBackup, getDataDir, getUserData } from './store'
import { readTailnet } from './tailscale'
import { defaultFlUserData, type PluginInventory } from './plugins'

/**
 * The port both ends agree on.
 *
 * Fixed rather than announced: inside a tailnet there is nothing to collide with, and a
 * negotiated port would need a discovery channel of its own - which is the thing MagicDNS
 * and a knock on a known port exist to avoid.
 */
export const REMOTE_PORT = 47828

/** Bumped when the wire format changes in a way an older build would mis-read. */
export const REMOTE_PROTOCOL = 1

/** Long enough for a busy machine to answer, short enough to sweep a tailnet briskly. */
const PROBE_TIMEOUT_MS = 1_500

/** How long the child gets to bind before the attempt is called failed. */
const START_TIMEOUT_MS = 5_000

/**
 * How often the server is checked on while the app is open.
 *
 * Half a minute is chosen against what is actually being waited for. A crashed server is
 * invisible from this end - the window carries on, and the only sign is another machine
 * quietly failing to reach this one, which nobody notices until they try. Thirty seconds
 * is a bound on how long that can last, and it costs one `tailscale status` when something
 * is wrong and a property read when it is not.
 */
const WATCH_INTERVAL_MS = 30_000

let child: Electron.UtilityProcess | null = null
let state: RemoteServerState = { listening: false, port: REMOTE_PORT }
/**
 * The last counters the server pushed up.
 *
 * Cached rather than fetched on demand: asking the child would mean correlating a reply,
 * and the child already sends a snapshot whenever anything changes. A read is then a
 * property access, which is what a panel polling every couple of seconds should cost.
 */
let stats: RemoteStats | null = null

export function remoteStats(): RemoteStats | null {
  return stats
}

export function remoteServerState(): RemoteServerState {
  return state
}

/** A stable id for a library on this device. Scoped by device so two roots never collide. */
function libraryId(deviceId: string, path: string): string {
  return createHash('sha1').update(`${deviceId}:${path}`).digest('hex').slice(0, 16)
}

function librariesFromSettings(deviceId: string): RemoteLibrary[] {
  return getUserData().settings.roots.map((root) => ({
    id: libraryId(deviceId, root.path),
    label: root.label,
    path: root.path
  }))
}

/**
 * Starts answering on the tailnet, or explains why it is not.
 *
 * Safe to call repeatedly - a second call replaces the first, which is what a change to
 * `shareLibrary`, a new library root, or a tailnet that has just come up all want.
 */
export async function startRemoteServer(): Promise<RemoteServerState> {
  stopRemoteServer()

  const { settings } = getUserData()
  if (!settings.shareLibrary) {
    state = { listening: false, port: REMOTE_PORT, reason: 'Sharing is turned off.' }
    return state
  }

  const tailnet = await readTailnet()
  if (tailnet.state !== 'running') {
    state = {
      listening: false,
      port: REMOTE_PORT,
      reason: tailnet.reason ?? 'Tailscale is not running.'
    }
    return state
  }

  const address = tailnet.self?.ipv4
  if (!address) {
    // Fail closed. See the note at the top of this file: the fallback is the dangerous case.
    state = {
      listening: false,
      port: REMOTE_PORT,
      reason: 'Tailscale is running but has no address on this machine.'
    }
    return state
  }

  const config: RemoteConfig = {
    address,
    port: REMOTE_PORT,
    protocol: REMOTE_PROTOCOL,
    device: {
      id: settings.deviceId,
      name: tailnet.self?.name ?? '',
      os: tailnet.self?.os ?? process.platform,
      version: app.getVersion()
    },
    libraries: librariesFromSettings(settings.deviceId),
    dataDir: getDataDir(),
    flUserData: settings.flUserData || defaultFlUserData(),
    // Without the keys that describe this install, and without the ones naming folders on
    // its disk - see `MACHINE_PATH_SETTINGS`. Stripped here as well as on arrival, so an
    // older peer asking this one never receives a path it would then act on.
    settings: shareableSettings()
  }

  const forked = utilityProcess.fork(join(__dirname, 'remote-server.js'), [], {
    serviceName: 'umakbang-remote'
  })
  child = forked

  return await new Promise<RemoteServerState>((resolve) => {
    let settled = false
    const settle = (next: RemoteServerState): void => {
      if (settled) return
      settled = true
      state = next
      resolve(next)
    }

    const timer = setTimeout(() => {
      settle({ listening: false, port: REMOTE_PORT, reason: 'The server did not start.' })
    }, START_TIMEOUT_MS)

    forked.on('message', (event: RemoteEvent) => {
      if (event.type === 'ready') {
        forked.postMessage({ type: 'init', config } satisfies RemoteCommand)
        return
      }
      if (event.type === 'stats') {
        stats = event.stats
        return
      }
      clearTimeout(timer)
      if (event.type === 'listening') {
        settle({ listening: true, address: event.address, port: event.port })
      } else {
        settle({ listening: false, port: REMOTE_PORT, reason: event.reason })
      }
    })

    forked.on('exit', (code) => {
      clearTimeout(timer)
      // `stopRemoteServer` clears `child` before it kills, so a mismatch here means this
      // exit was asked for - and the state it left behind is the right one to keep.
      if (child !== forked) return
      child = null
      /**
       * An exit *after* a successful bind is the interesting one.
       *
       * The promise resolved long ago, so `settle` would drop this on the floor and leave
       * the state claiming to be listening on an address nothing is bound to any more. The
       * app carries on either way - that is the point of serving from a child - but it has
       * quietly stopped answering, and the Devices section has to be able to say so.
       */
      const stopped: RemoteServerState = {
        listening: false,
        port: REMOTE_PORT,
        reason: `The server stopped unexpectedly (code ${code}).`
      }
      if (settled) state = stopped
      else settle(stopped)
    })
  })
}

let watchdog: NodeJS.Timeout | null = null

/**
 * Keeps the server up for as long as the app is.
 *
 * It exists because there was nothing to bring one back: the child is a separate process
 * precisely so a fault in it costs a respawn rather than the app, and then nothing ever
 * respawned it - the app carried on, silently unreachable, until somebody restarted it.
 *
 * It doubles as the answer to a tailnet that was not there at startup. A machine that opens
 * umakbang before Tailscale finishes connecting failed to bind once and stayed failed; now
 * it simply starts serving when the address turns up.
 *
 * Deliberately not a retry with a backoff. There is nothing to back off from - the check is
 * cheap and the thing it is waiting for is an address appearing - and a backoff would mean
 * the longest waits happen exactly when a machine has been unreachable longest.
 */
export function watchRemoteServer(): void {
  if (watchdog) return
  watchdog = setInterval(() => {
    void (async () => {
      // Sharing being off is not a failure to recover from; it is the setting doing its job.
      if (!getUserData().settings.shareLibrary) return
      if (child && state.listening) return
      const before = state.reason
      const next = await startRemoteServer()
      // Said only when it changes, or a machine with Tailscale off writes a line every
      // thirty seconds for as long as it is open.
      if (next.listening) console.log(`umakbang: serving again on ${next.address}:${next.port}`)
      else if (next.reason !== before) console.log(`umakbang: not serving (${next.reason})`)
    })()
  }, WATCH_INTERVAL_MS)
  // Nothing here should hold the process open on its own.
  watchdog.unref?.()
}

export function stopWatchingRemoteServer(): void {
  if (watchdog) clearInterval(watchdog)
  watchdog = null
}

export function stopRemoteServer(): void {
  const current = child
  child = null
  // Counters describe a running server. Left behind, they would read as live traffic on a
  // machine that has stopped answering.
  stats = null
  if (!current) return
  current.postMessage({ type: 'stop' } satisfies RemoteCommand)
  current.kill()
  state = { listening: false, port: REMOTE_PORT }
}

/**
 * What FL has found on a peer.
 *
 * The peer answers about its own machine - its own FL data folder, its own scan - which is
 * the only way this can work: a plugin list is a fact about an install, and nothing here
 * could infer it from the other side of a socket.
 */
export function remotePlugins(host: string): Promise<PluginInventory | null> {
  return new Promise((resolve) => {
    const request = httpGet(
      { host, port: REMOTE_PORT, path: '/plugins', timeout: 10_000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(null)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (body.length > 4 * 1024 * 1024) request.destroy()
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body) as PluginInventory)
          } catch {
            resolve(null)
          }
        })
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.on('error', () => resolve(null))
  })
}

/** What this machine is willing to say about how it is set up. */
function shareableSettings(): Record<string, unknown> {
  const settings = { ...exportBackup().settings } as Record<string, unknown>
  for (const key of MACHINE_PATH_SETTINGS) delete settings[key]
  return settings
}

/** A peer's preferences, for adopting. Null when it will not say. */
export function remoteSettings(host: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const request = httpGet(
      { host, port: REMOTE_PORT, path: '/settings', timeout: 10_000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(null)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (body.length > 4 * 1024 * 1024) request.destroy()
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>)
          } catch {
            resolve(null)
          }
        })
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.on('error', () => resolve(null))
  })
}

/** How much of a peer's tags, ratings and analysis to accept before giving up on it. */
const METADATA_LIMIT = 128 * 1024 * 1024

/**
 * A peer's tags, ratings, notes and analysis, shaped as a backup.
 *
 * Deliberately the same shape a settings export has, so the folder-mapping wizard and
 * `importBackup` take it without knowing where it came from. Paths are the peer's, which is
 * exactly what that wizard exists to translate.
 *
 * A far bigger cap than `/settings`: a rated library is sparse, but a detected tempo and key
 * for a few hundred thousand files is tens of megabytes, and truncating that would hand the
 * wizard a half-file to merge.
 */
export function remoteMetadata(host: string): Promise<SettingsBackup | null> {
  return new Promise((resolve) => {
    const request = httpGet(
      { host, port: REMOTE_PORT, path: '/metadata', timeout: 60_000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(null)
          return
        }
        const chunks: string[] = []
        let size = 0
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          size += chunk.length
          if (size > METADATA_LIMIT) {
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(chunks.join('')) as SettingsBackup
            resolve(parsed?.kind === 'umakbang-settings' ? parsed : null)
          } catch {
            resolve(null)
          }
        })
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.on('error', () => resolve(null))
  })
}

/** Knocks on one peer. Resolves to its hello, or to why it did not answer. */
function knock(host: string): Promise<{ hello?: RemoteHello; reason?: string }> {
  return new Promise((resolve) => {
    const request = httpGet(
      { host, port: REMOTE_PORT, path: '/hello', timeout: PROBE_TIMEOUT_MS },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve({ reason: `Answered ${response.statusCode}.` })
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          // Whatever answers this port with something enormous is not umakbang.
          if (body.length > 1_000_000) request.destroy()
        })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as RemoteHello
            if (parsed.app !== 'umakbang') {
              resolve({ reason: 'Something else is on that port.' })
              return
            }
            resolve({ hello: parsed })
          } catch {
            resolve({ reason: 'Answered with something unreadable.' })
          }
        })
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve({ reason: 'umakbang is not running there.' })
    })
    request.on('error', () => resolve({ reason: 'umakbang is not running there.' }))
  })
}

/**
 * Every machine in the tailnet, with whichever of them are serving.
 *
 * All peers come back, not only the serving ones. An offline machine and a machine without
 * umakbang are different problems with different answers, and a list that quietly omits both
 * looks like the feature is broken rather than like the machine is asleep.
 *
 * Only online peers are knocked on: dialling a sleeping machine costs the full timeout to
 * learn what `Online` already said.
 */
export async function listRemoteDevices(): Promise<{
  tailnet: Awaited<ReturnType<typeof readTailnet>>
  devices: RemoteDevice[]
}> {
  const tailnet = await readTailnet()
  const devices = await Promise.all(
    tailnet.peers.map(async (node): Promise<RemoteDevice> => {
      if (!node.online) return { node, serving: false }
      const host = node.ipv4 ?? node.name
      if (!host) return { node, serving: false, reason: 'No address.' }
      const result = await knock(host)
      return result.hello
        ? { node, serving: true, hello: result.hello }
        : { node, serving: false, reason: result.reason }
    })
  )
  return { tailnet, devices }
}
