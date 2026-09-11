/**
 * Zero-config peer discovery for DSH instances on the same LAN or Tailscale
 * tailnet. Every instance beacons its reachable base URLs and auto-registers
 * beacons it can reach, so two `dsh web` processes with this plugin find each
 * other with no pasted URLs.
 *
 * Tailscale never forwards multicast, so one transport cannot cover both
 * worlds: LAN peers are reached by UDP multicast, Tailscale peers by unicast
 * to the tailnet IPs listed by `tailscale status --json`, and a second
 * instance on the same machine by loopback unicast. All three carry the same
 * beacon; receivers vet each advertised URL with a gateway call before
 * registering anything.
 * @module @deepseek-ai/dsh-experimental-remote-host/discovery
 */

import { execFile } from 'node:child_process'
import { createSocket, type Socket } from 'node:dgram'
import { hostname, networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import { DshGatewayClient, normalizeBaseUrl } from './dsh-client.ts'
import type { DiscoveryConfig, MachineView } from './types.ts'

/** Beacon magic identifying a DSH remote-host announcement. */
export const DISCOVERY_MAGIC = 'dsh-remote-host/1'

/**
 * Organization-local multicast group for LAN beacons. Multicast never leaves
 * the local network segment at TTL 1, which is exactly the discovery scope.
 */
export const DISCOVERY_GROUP = '239.94.71.11'

/** Default UDP discovery port shared by all peers. */
export const DEFAULT_DISCOVERY_PORT = 43771

/** Default beacon interval in milliseconds. */
export const DEFAULT_DISCOVERY_INTERVAL_MS = 5000

/**
 * Per-URL vetting budget in milliseconds. A beacon URL that does not answer a
 * gateway call within this budget is skipped for this round; the next beacon
 * tries again. Fixed wire constant, not deployment tuning.
 */
export const PROBE_TIMEOUT_MS = 2000

/**
 * `tailscale status` cache lifetime in milliseconds. The tailnet membership
 * changes rarely; re-listing it on every beacon would spawn a child process
 * several times a second under short test intervals.
 */
export const TAILSCALE_REFRESH_MS = 60000

/** One decoded peer announcement. */
export interface DiscoveryBeacon {
  /** Peer instance identity (per-process uuid, for self-skip). */
  readonly instanceId: string
  /** Human label, normally the peer's hostname. */
  readonly label: string
  /** Reachable base URLs in the peer's preference order. */
  readonly urls: readonly string[]
}

/** Fully-resolved discovery settings (explicit resolve step, no hidden defaults). */
export interface ResolvedDiscovery {
  /** Whether to beacon and listen. */
  readonly enabled: boolean
  /** UDP discovery port shared by all peers. */
  readonly port: number
  /** Beacon interval in milliseconds. */
  readonly intervalMs: number
}

/**
 * Resolve discovery settings from composition.
 * @param config - Raw discovery config (absent enables discovery with defaults).
 * @returns fully-specified settings.
 */
export function resolveDiscovery(config: DiscoveryConfig | undefined): ResolvedDiscovery {
  return {
    enabled: config?.enabled ?? true,
    port: config?.port ?? DEFAULT_DISCOVERY_PORT,
    intervalMs: config?.intervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS,
  }
}

/**
 * This instance's label for beacons.
 * @returns the OS hostname.
 */
export function discoveryLabel(): string {
  return hostname()
}

/**
 * Candidate base URLs for this instance's web server.
 * @param webPort - Bound webserver port (OS-assigned value when config used 0).
 * @param bindHost - Configured bind literal (`127.0.0.1` or `0.0.0.0`).
 * @returns reachable URLs, loopback first.
 */
export function ownCandidateUrls(webPort: number, bindHost: '127.0.0.1' | '0.0.0.0'): string[] {
  const urls = new Set<string>()
  urls.add(`http://127.0.0.1:${String(webPort)}`)
  if (bindHost !== '0.0.0.0') return [...urls]
  for (const addresses of Object.values(networkInterfaces())) {
    for (const iface of addresses ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.add(`http://${iface.address}:${String(webPort)}`)
    }
  }
  return [...urls]
}

/**
 * Encode a beacon payload.
 * @param beacon - Beacon fields.
 * @returns JSON bytes.
 */
export function buildBeacon(beacon: DiscoveryBeacon): string {
  return JSON.stringify({ magic: DISCOVERY_MAGIC, ...beacon, urls: [...beacon.urls] })
}

/**
 * Decode and validate a received datagram.
 * @param data - Raw datagram bytes.
 * @returns the beacon, or undefined when the datagram is not a valid beacon.
 */
export function parseBeacon(data: Buffer): DiscoveryBeacon | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(data.toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined
  const record = decoded as Record<string, unknown>
  if (record['magic'] !== DISCOVERY_MAGIC) return undefined
  if (typeof record['instanceId'] !== 'string' || record['instanceId'].trim() === '') return undefined
  if (typeof record['label'] !== 'string' || record['label'].trim() === '') return undefined
  if (!Array.isArray(record['urls']) || record['urls'].length === 0) return undefined
  const urls = record['urls']
    .filter((url): url is string => typeof url === 'string')
    .map(url => normalizeBaseUrl(url))
    .filter((url) => {
      try {
        const parsed = new URL(url)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    })
  if (urls.length === 0) return undefined
  return { instanceId: record['instanceId'] as string, label: (record['label'] as string).trim(), urls }
}

/**
 * Extract dotted-quad tailnet IPs from `tailscale status --json`.
 * @param status - Parsed status document (untrusted shape).
 * @returns unique IPv4 addresses.
 */
export function extractTailscaleIps(status: unknown): string[] {
  if (typeof status !== 'object' || status === null) return []
  const ips = new Set<string>()
  const collect = (value: unknown): void => {
    const ip = tailscaleIp(value)
    if (ip !== undefined) ips.add(ip)
  }
  const record = status as Record<string, unknown>
  const self = record['Self'] as Record<string, unknown> | undefined
  for (const ip of (self?.['TailscaleIPs'] as unknown[] | undefined) ?? []) collect(ip)
  const peers = record['Peer'] as Record<string, unknown> | undefined
  for (const peer of Object.values(peers ?? {})) {
    for (const ip of ((peer as Record<string, unknown>)['TailscaleIPs'] as unknown[] | undefined) ?? []) collect(ip)
  }
  return [...ips]
}

/** Narrow one `TailscaleIPs` entry to a dotted-quad address. */
function tailscaleIp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?$/.exec(value)
  return match?.[1]
}

const execFileAsync = promisify(execFile)

/** Runs `tailscale status --json` and resolves its stdout. */
export type TailscaleRunner = (timeoutMs: number) => Promise<string>

/**
 * Default runner shelling out to the local Tailscale client.
 * @param timeoutMs - Child-process budget.
 * @returns raw stdout.
 */
export async function defaultTailscaleRunner(timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: timeoutMs })
  return stdout
}

/**
 * List tailnet IPs via the local Tailscale client. Best-effort: an absent
 * `tailscale` binary or daemon (plain LAN hosts) resolves to no peers.
 * @param timeoutMs - Child-process budget.
 * @param run - Injectable status runner (tests stub the child process).
 * @returns unique IPv4 tailnet addresses, possibly empty.
 */
export async function tailscalePeerIps(timeoutMs: number, run: TailscaleRunner = defaultTailscaleRunner): Promise<string[]> {
  try {
    return extractTailscaleIps(JSON.parse(await run(timeoutMs)) as unknown)
  } catch {
    return []
  }
}

/** Minimal registry surface discovery needs (the full service satisfies it). */
export interface DiscoveryRegistry {
  /**
   * Register one vetted peer URL.
   * @param request - Peer label and URL.
   * @returns the stored view.
   */
  upsertDiscovered(request: { label: string; url: string }): Promise<MachineView>
}

/** Discovery runtime options. */
export interface StartDiscoveryOptions {
  /** Registry receiving vetted peers. */
  readonly service: DiscoveryRegistry
  /** This instance's beacon identity. */
  readonly self: DiscoveryBeacon
  /** UDP discovery port shared by all peers. */
  readonly port: number
  /** Beacon interval in milliseconds. */
  readonly intervalMs: number
  /**
   * Vet one advertised URL.
   * @param url - Candidate base URL.
   * @returns true when the peer answers as a DSH gateway.
   */
  readonly probe?: (url: string) => Promise<boolean>
  /**
   * List tailnet IPs for unicast beacons.
   * @returns IPv4 addresses.
   */
  readonly listTailscaleIps?: () => Promise<string[]>
}

/**
 * Default URL vetting: one gateway call with a fixed budget.
 * @param url - Candidate base URL.
 * @returns true when `remoteHosts/listMachines` answers.
 */
export async function probePeer(url: string): Promise<boolean> {
  try {
    await new DshGatewayClient(url).call('remoteHosts/listMachines', {}, AbortSignal.timeout(PROBE_TIMEOUT_MS))
    return true
  } catch {
    return false
  }
}

/**
 * Beacon this instance and register reachable peers until stopped.
 * @param opts - Runtime options.
 * @returns stopper closing the timer and socket.
 */
export async function startDiscovery(opts: StartDiscoveryOptions): Promise<() => Promise<void>> {
  const probe = opts.probe ?? probePeer
  const listTailscaleIps = opts.listTailscaleIps ?? (() => tailscalePeerIps(opts.intervalMs))
  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true })
  const ownUrls = new Set(opts.self.urls)
  let tailscaleIps: string[] = []
  let tailscaleAt = 0
  let stopped = false

  const payload = (): Buffer => Buffer.from(buildBeacon(opts.self), 'utf8')

  const sendTo = (target: string): void => {
    try {
      socket.send(payload(), opts.port, target, () => {
        // Best-effort beacon: unreachable targets drop silently.
      })
    } /* v8 ignore -- close-race sends surface only under shutdown timing and cannot be produced deterministically */ catch {
      // The socket closed during shutdown; the beacon is already obsolete.
    }
  }

  const beacon = async (): Promise<void> => {
    if (Date.now() - tailscaleAt >= TAILSCALE_REFRESH_MS) {
      tailscaleAt = Date.now()
      tailscaleIps = await listTailscaleIps()
    }
    sendTo(DISCOVERY_GROUP)
    sendTo('127.0.0.1')
    for (const ip of new Set(tailscaleIps)) sendTo(ip)
  }

  const onMessage = (data: Buffer): void => {
    const beacon = parseBeacon(data)
    if (beacon === undefined) return
    if (beacon.instanceId === opts.self.instanceId) return
    if (beacon.urls.some(url => ownUrls.has(url))) return
    void (async () => {
      try {
        for (const url of beacon.urls) {
          if (stopped) return
          if (await probe(url)) {
            await opts.service.upsertDiscovered({ label: beacon.label, url })
            return
          }
        }
      } catch {
        // Registration failures retry on the next beacon round.
      }
    })()
  }

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(opts.port, () => {
      socket.removeListener('error', reject)
      /* v8 ignore next -- post-bind socket errors are OS-dependent */
      socket.on('error', () => {
        // Keep listening through transient socket errors.
      })
      try {
        socket.setMulticastLoopback(true)
        for (const addresses of Object.values(networkInterfaces())) {
          for (const iface of addresses ?? []) {
            if (iface.family !== 'IPv4' || iface.internal) continue
            try {
              socket.addMembership(DISCOVERY_GROUP, iface.address)
            } /* v8 ignore next -- join failure is host-network dependent */ catch {
              // One unjoinable interface must not block the others.
            }
          }
        }
        try {
          socket.addMembership(DISCOVERY_GROUP)
        } /* v8 ignore next -- multicast join failure is host-network dependent */ catch {
          // Membership through the default interface is a bonus when per-interface joins worked.
        }
      } /* v8 ignore next -- multicast setup failure is host-network dependent */ catch {
        // Multicast setup is best-effort; loopback unicast still discovers same-machine peers.
      }
      socket.on('message', onMessage)
      socket.unref()
      resolve()
    })
  })
  const timer = setInterval(() => {
    void beacon()
  }, opts.intervalMs)
  timer.unref()
  await beacon()
  let closed = false
  return async () => {
    stopped = true
    clearInterval(timer)
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => {
      socket.removeAllListeners('message')
      socket.close(() => {
        resolve()
      })
    })
  }
}
