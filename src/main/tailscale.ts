/**
 * What the tailnet looks like from this machine.
 *
 * Tailscale is umakbang's whole networking substrate rather than one transport among
 * several: it is the authentication boundary, the encryption, and - through MagicDNS - the
 * discovery. A peer that is in the tailnet is a machine the user has already added to it, so
 * there is no pairing flow to build, and `typhoon-pc` resolves the same on the sofa as on
 * cellular. The cost is an outside dependency, which is a fair trade for two personal
 * machines and is stated plainly in the UI when it is missing.
 *
 * The CLI rather than the local API socket: `tailscale status --json` is the documented,
 * stable interface, and the socket's path and protocol are neither.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { TailnetNode, TailnetStatus } from '../shared/types'

const run = promisify(execFile)

/**
 * Where the binary sits, per platform.
 *
 * `PATH` is tried last rather than first because a GUI app on macOS does not inherit the
 * shell's `PATH` - launched from Finder, `which tailscale` would fail on a machine where it
 * works perfectly in a terminal, and the feature would look broken to the one user who had
 * done nothing wrong.
 */
const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  ],
  win32: [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale']
}

/** How long the CLI gets before it is treated as absent. */
const STATUS_TIMEOUT_MS = 5_000

let cachedBinary: string | null | undefined

function findBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    if (existsSync(candidate)) {
      cachedBinary = candidate
      return cachedBinary
    }
  }
  // Nothing at a known path: let the shell resolve it, which covers an install somewhere
  // unusual on a machine whose PATH this process did inherit.
  cachedBinary = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
  return cachedBinary
}

/** Strips MagicDNS's trailing dot: `jkpc.tail1234.ts.net.` is not a hostname a URL wants. */
function dnsName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\.$/, '') : ''
}

/** The first 100.64/10 address, which is the one to bind and to dial. */
function ipv4Of(ips: unknown): string | undefined {
  if (!Array.isArray(ips)) return undefined
  return ips.find((ip): ip is string => typeof ip === 'string' && ip.includes('.'))
}

function toNode(id: string, raw: Record<string, unknown>): TailnetNode {
  return {
    id,
    name: dnsName(raw.DNSName),
    hostName: typeof raw.HostName === 'string' ? raw.HostName : '',
    os: typeof raw.OS === 'string' ? raw.OS : '',
    online: raw.Online === true,
    ipv4: ipv4Of(raw.TailscaleIPs),
    lastSeen: typeof raw.LastSeen === 'string' ? raw.LastSeen : undefined
  }
}

/**
 * The tailnet as it stands, or why it cannot be read.
 *
 * Never throws. Every failure is a state the Devices section can explain - Tailscale not
 * installed, installed but logged out, the daemon not running - because "the list is empty"
 * is the one answer that leaves somebody with nothing to do about it.
 */
export async function readTailnet(): Promise<TailnetStatus> {
  const binary = findBinary()
  if (!binary) return { state: 'missing', reason: 'Tailscale is not installed.', peers: [] }

  let stdout: string
  try {
    const result = await run(binary, ['status', '--json'], {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    })
    stdout = result.stdout
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { state: 'missing', reason: 'Tailscale is not installed.', peers: [] }
    }
    // `tailscale status` exits non-zero when the backend is down, and still prints usable
    // JSON on stdout - so a failed call is only fatal when there is nothing to read.
    const output = (error as { stdout?: string }).stdout
    if (!output) {
      return { state: 'error', reason: 'Tailscale did not respond.', peers: [] }
    }
    stdout = output
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return { state: 'error', reason: 'Tailscale returned something unreadable.', peers: [] }
  }

  const backend = typeof raw.BackendState === 'string' ? raw.BackendState : ''
  const self = raw.Self ? toNode('self', raw.Self as Record<string, unknown>) : undefined
  const peers = Object.entries((raw.Peer ?? {}) as Record<string, Record<string, unknown>>)
    .map(([key, value]) => toNode(key, value))
    // Newest-seen first would reorder the list under you as machines wake; name is stable.
    .sort((a, b) => (a.hostName || a.name).localeCompare(b.hostName || b.name))

  if (backend !== 'Running') {
    return {
      state: backend === 'NeedsLogin' ? 'stopped' : 'stopped',
      reason:
        backend === 'NeedsLogin'
          ? 'Tailscale is installed but not signed in.'
          : 'Tailscale is not running.',
      self,
      peers
    }
  }

  return { state: 'running', self, peers }
}

/** Forgets where the binary was, for a machine where it is installed mid-session. */
export function forgetTailscaleBinary(): void {
  cachedBinary = undefined
}
