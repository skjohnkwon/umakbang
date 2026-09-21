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
import type { RemoteDevice, RemoteHello, RemoteLibrary, RemoteServerState } from '../shared/types'
import type { RemoteCommand, RemoteConfig, RemoteEvent } from './remote-process'
import { getDataDir, getUserData } from './store'
import { readTailnet } from './tailscale'

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

let child: Electron.UtilityProcess | null = null
let state: RemoteServerState = { listening: false, port: REMOTE_PORT }

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
    dataDir: getDataDir()
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

export function stopRemoteServer(): void {
  const current = child
  child = null
  if (!current) return
  current.postMessage({ type: 'stop' } satisfies RemoteCommand)
  current.kill()
  state = { listening: false, port: REMOTE_PORT }
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
