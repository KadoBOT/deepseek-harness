import { createSocket } from 'node:dgram'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  buildBeacon,
  DEFAULT_DISCOVERY_INTERVAL_MS,
  DEFAULT_DISCOVERY_PORT,
  DISCOVERY_MAGIC,
  discoveryLabel,
  extractTailscaleIps,
  ownCandidateUrls,
  parseBeacon,
  probePeer,
  resolveDiscovery,
  startDiscovery,
  tailscalePeerIps,
  type DiscoveryBeacon,
} from '../src/discovery.ts'
import { RemoteHostService } from '../src/service.ts'

// Deterministic interfaces: an absent entry, a loopback, and one LAN address.
// `networkInterfaces` is nondeterministic host input, so the suite pins it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const lan: NetworkInterfaceInfo = {
    address: '192.168.9.9',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
  }
  const loopback: NetworkInterfaceInfo = { ...lan, address: '127.0.0.1', internal: true }
  return { ...actual, networkInterfaces: () => ({ tap0: undefined, lo: [loopback], eth0: [lan] }) }
})

const TEST_PORT = 43779

function beacon(overrides: Partial<DiscoveryBeacon> = {}): DiscoveryBeacon {
  return {
    instanceId: 'peer-a',
    label: 'peer-a-host',
    urls: ['http://192.168.1.20:3080'],
    ...overrides,
  }
}

describe('beacon codec', () => {
  it('round-trips a valid beacon', () => {
    const parsed = parseBeacon(Buffer.from(buildBeacon(beacon()), 'utf8'))
    expect(parsed).toEqual(beacon())
  })

  it('rejects garbage, wrong magic, and invalid urls', () => {
    expect(parseBeacon(Buffer.from('not json', 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from('[1,2]', 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(JSON.stringify({ magic: 'other/1' }), 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(buildBeacon(beacon({ instanceId: '' })), 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(buildBeacon(beacon({ label: '  ' })), 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(buildBeacon(beacon({ urls: [] })), 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(buildBeacon(beacon({ urls: ['gpu-box', 'ftp://x/'] })), 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(JSON.stringify({
      magic: DISCOVERY_MAGIC,
      instanceId: 'a',
      label: 'b',
      urls: ['http://127.0.0.1:3081/', 'https://gpu.tailnet.ts.net:3080'],
    }), 'utf8'))).toEqual({ instanceId: 'a', label: 'b', urls: ['http://127.0.0.1:3081', 'https://gpu.tailnet.ts.net:3080'] })
  })
})

describe('resolveDiscovery', () => {
  it('enables with defaults when absent', () => {
    expect(resolveDiscovery(undefined)).toEqual({
      enabled: true,
      port: DEFAULT_DISCOVERY_PORT,
      intervalMs: DEFAULT_DISCOVERY_INTERVAL_MS,
    })
  })

  it('honors explicit settings', () => {
    expect(resolveDiscovery({ enabled: false, port: TEST_PORT, intervalMs: 100 })).toEqual({
      enabled: false,
      port: TEST_PORT,
      intervalMs: 100,
    })
  })
})

describe('ownCandidateUrls', () => {
  it('advertises loopback for a loopback bind', () => {
    expect(ownCandidateUrls(3080, '127.0.0.1')).toEqual(['http://127.0.0.1:3080'])
  })

  it('always includes loopback for an all-interfaces bind', () => {
    expect(ownCandidateUrls(3081, '0.0.0.0')).toEqual([
      'http://127.0.0.1:3081',
      'http://192.168.9.9:3081',
    ])
  })
})

describe('tailscale status', () => {
  it('labels this instance with its hostname', () => {
    expect(discoveryLabel().length).toBeGreaterThan(0)
  })

  it('extracts dotted-quad IPs and ignores everything else', () => {
    expect(extractTailscaleIps(undefined)).toEqual([])
    expect(extractTailscaleIps(null)).toEqual([])
    expect(extractTailscaleIps({ Self: { TailscaleIPs: ['100.64.1.2/32', 'fd7a::1/128'] } })).toEqual(['100.64.1.2'])
    expect(extractTailscaleIps({
      Self: { TailscaleIPs: ['100.64.1.2'] },
      Peer: {
        a: { TailscaleIPs: ['100.64.1.3', 42] },
        b: {},
      },
    }).sort()).toEqual(['100.64.1.2', '100.64.1.3'])
  })

  it('lists peers through an injected runner and tolerates failures', async () => {
    const status = { Self: { TailscaleIPs: ['100.64.1.2'] }, Peer: { a: { TailscaleIPs: ['100.64.1.9'] } } }
    await expect(tailscalePeerIps(100, async () => JSON.stringify(status))).resolves.toEqual(['100.64.1.2', '100.64.1.9'])
    await expect(tailscalePeerIps(100, async () => 'not json')).resolves.toEqual([])
    await expect(tailscalePeerIps(100, async () => { throw new Error('no binary') })).resolves.toEqual([])
  })

  it('resolves without throwing when no tailnet is present', async () => {
    const ips = await tailscalePeerIps(1000)
    expect(Array.isArray(ips)).toBe(true)
  })
})

describe('probePeer', () => {
  const savedFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = savedFetch
  })

  it('vets URLs through the gateway', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ type: 'server-response', rpcId: 'x', result: { ok: true, value: [] } }),
    })) as never
    await expect(probePeer('http://127.0.0.1:38099')).resolves.toBe(true)
    globalThis.fetch = (async () => { throw new Error('down') }) as never
    await expect(probePeer('http://127.0.0.1:38099')).resolves.toBe(false)
  })
})

describe('upsertDiscovered', () => {
  it('deduplicates by URL and rejects invalid URLs', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService, { hosts: [] })
    const first = await ctx.remoteHosts.upsertDiscovered({ label: 'gpu', url: 'http://127.0.0.1:3081/' })
    const second = await ctx.remoteHosts.upsertDiscovered({ label: 'renamed', url: 'http://127.0.0.1:3081' })
    expect(first.id).toBe(second.id)
    expect(ctx.remoteHosts.listMachines()).toHaveLength(1)
    await expect(ctx.remoteHosts.upsertDiscovered({ label: 'bad', url: 'gpu-box' })).rejects.toThrow(/http\(s\) DSH base URL/)
    await expect(ctx.remoteHosts.upsertDiscovered({ label: '', url: 'http://127.0.0.1:3082' })).rejects.toThrow()
  })
})

describe('startDiscovery socket round-trip', () => {
  it('two instances find each other and ignore their own beacons', async () => {
    const seenA: Array<{ label: string; url: string }> = []
    const seenB: Array<{ label: string; url: string }> = []
    const stopA = await startDiscovery({
      service: { upsertDiscovered: async (input) => { seenA.push(input); return input as never } },
      self: beacon({ instanceId: 'a', label: 'host-a', urls: ['http://127.0.0.1:38081'] }),
      port: TEST_PORT,
      intervalMs: 50,
      probe: async () => true,
      listTailscaleIps: async () => [],
    })
    const stopB = await startDiscovery({
      service: { upsertDiscovered: async (input) => { seenB.push(input); return input as never } },
      self: beacon({ instanceId: 'b', label: 'host-b', urls: ['http://127.0.0.1:38082'] }),
      port: TEST_PORT,
      intervalMs: 50,
      probe: async () => true,
      listTailscaleIps: async () => [],
    })
    try {
      await vi.waitFor(() => {
        expect(seenA.some(entry => entry.url === 'http://127.0.0.1:38082')).toBe(true)
        expect(seenB.some(entry => entry.url === 'http://127.0.0.1:38081')).toBe(true)
      }, { timeout: 5000 })
      expect(seenA.some(entry => entry.url === 'http://127.0.0.1:38081')).toBe(false)
      expect(seenB.some(entry => entry.url === 'http://127.0.0.1:38082')).toBe(false)
    } finally {
      await stopA()
      await stopB()
      await stopA()
    }
  })

  it('tries beacon URLs in order and registers the first reachable one', async () => {
    const seen: string[] = []
    const probed: string[] = []
    const stop = await startDiscovery({
      service: { upsertDiscovered: async (input) => { seen.push(input.url); return input as never } },
      self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38083'] }),
      port: TEST_PORT + 1,
      intervalMs: 50,
      probe: async (url) => {
        probed.push(url)
        return url.endsWith(':38085')
      },
      listTailscaleIps: async () => [],
    })
    const stopPeer = await startDiscovery({
      service: { upsertDiscovered: async () => { throw new Error('peer should not register self-loopback') } },
      self: beacon({ instanceId: 'peer', label: 'peer', urls: ['http://127.0.0.1:38084', 'http://127.0.0.1:38085'] }),
      port: TEST_PORT + 1,
      intervalMs: 50,
      probe: async () => false,
      listTailscaleIps: async () => [],
    })
    try {
      await vi.waitFor(() => {
        expect(seen).toContain('http://127.0.0.1:38085')
      }, { timeout: 5000 })
      expect(probed[0]).toBe('http://127.0.0.1:38084')
    } finally {
      await stop()
      await stopPeer()
    }
  })
})

describe('startDiscovery edges', () => {
  it('ignores non-beacon datagrams', async () => {
    const registered: string[] = []
    const stop = await startDiscovery({
      service: { upsertDiscovered: async (input) => { registered.push(input.url); return input as never } },
      self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38100'] }),
      port: TEST_PORT + 3,
      intervalMs: 50,
      probe: async () => true,
      listTailscaleIps: async () => [],
    })
    try {
      const raw = createSocket('udp4')
      await new Promise<void>((resolve) => { raw.send('junk-bytes', TEST_PORT + 3, '127.0.0.1', () => { raw.close(); resolve() }) })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(registered).toEqual([])
    } finally {
      await stop()
    }
  })

  it('stops vetting once the instance stops', async () => {
    const probed: string[] = []
    const holder: { stop?: () => Promise<void> } = {}
    const stop = await startDiscovery({
      service: { upsertDiscovered: async () => { throw new Error('must not register') } },
      self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38101'] }),
      port: TEST_PORT + 4,
      intervalMs: 50,
      probe: async (url) => {
        probed.push(url)
        await holder.stop?.()
        return false
      },
      listTailscaleIps: async () => [],
    })
    holder.stop = stop
    const stopPeer = await startDiscovery({
      service: { upsertDiscovered: async input => input as never },
      self: beacon({ instanceId: 'peer', label: 'peer', urls: ['http://127.0.0.1:38102', 'http://127.0.0.1:38103'] }),
      port: TEST_PORT + 4,
      intervalMs: 50,
      probe: async () => false,
      listTailscaleIps: async () => [],
    })
    try {
      await vi.waitFor(() => { expect(probed.length).toBeGreaterThan(0) }, { timeout: 5000 })
      await stopPeer()
      expect(probed).toEqual(['http://127.0.0.1:38102'])
    } finally {
      await stop()
      await stopPeer()
    }
  })

  it('stops cleanly under beacon churn', async () => {
    const stop = await startDiscovery({
      service: { upsertDiscovered: async input => input as never },
      self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38104'] }),
      port: TEST_PORT + 5,
      intervalMs: 10,
      probe: async () => false,
      listTailscaleIps: async () => [],
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    await stop()
    await stop()
  })

  it('rejects when the port is taken without reuse', async () => {
    const blocker = createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.bind(TEST_PORT + 6, () => { resolve() })
    })
    try {
      await expect(startDiscovery({
        service: { upsertDiscovered: async input => input as never },
        self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38105'] }),
        port: TEST_PORT + 6,
        intervalMs: 50,
        probe: async () => false,
        listTailscaleIps: async () => [],
      })).rejects.toThrow()
    } finally {
      blocker.close()
    }
  })

  it('keeps listening through unroutable unicast targets', async () => {
    const seen: string[] = []
    const stop = await startDiscovery({
      service: { upsertDiscovered: async (input) => { seen.push(input.url); return input as never } },
      self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38106'] }),
      port: TEST_PORT + 7,
      intervalMs: 50,
      probe: async () => true,
      // Invalid addresses fail sends into the ignored send callback.
      listTailscaleIps: async () => ['999.999.999.999'],
    })
    const stopPeer = await startDiscovery({
      service: { upsertDiscovered: async input => input as never },
      self: beacon({ instanceId: 'peer', label: 'peer', urls: ['http://127.0.0.1:38107'] }),
      port: TEST_PORT + 7,
      intervalMs: 50,
      probe: async () => false,
      listTailscaleIps: async () => [],
    })
    try {
      await vi.waitFor(() => { expect(seen).toContain('http://127.0.0.1:38107') }, { timeout: 5000 })
    } finally {
      await stop()
      await stopPeer()
    }
  })
})

describe('discovery codec extras', () => {
  it('rejects null and non-array url shapes', () => {
    expect(parseBeacon(Buffer.from('null', 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, instanceId: 'a', label: 'b' }), 'utf8'))).toBeUndefined()
    expect(parseBeacon(Buffer.from(JSON.stringify({
      magic: DISCOVERY_MAGIC,
      instanceId: 'a',
      label: 'b',
      urls: ['ftp://x/y'],
    }), 'utf8'))).toBeUndefined()
  })

  it('tolerates status documents without address lists', () => {
    expect(extractTailscaleIps({ Self: {}, Peer: { a: {} } })).toEqual([])
    expect(extractTailscaleIps({})).toEqual([])
  })

  it('uses default vetting and tailnet listing when not injected', async () => {
    const stop = await startDiscovery({
      service: { upsertDiscovered: async input => input as never },
      self: beacon({ instanceId: 'defaults', urls: ['http://127.0.0.1:38110'] }),
      port: TEST_PORT + 8,
      intervalMs: 50,
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    await stop()
  })

  it('skips beacons from restarted peers advertising known urls', async () => {
    const seen: string[] = []
    const stop = await startDiscovery({
      service: { upsertDiscovered: async (input) => { seen.push(input.url); return input as never } },
      self: beacon({ instanceId: 'self', urls: ['http://127.0.0.1:38111'] }),
      port: TEST_PORT + 9,
      intervalMs: 50,
      probe: async () => true,
      listTailscaleIps: async () => [],
    })
    const stopPeer = await startDiscovery({
      service: { upsertDiscovered: async input => input as never },
      self: beacon({ instanceId: 'peer-restarted', label: 'peer', urls: ['http://127.0.0.1:38111'] }),
      port: TEST_PORT + 9,
      intervalMs: 50,
      probe: async () => false,
      listTailscaleIps: async () => [],
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(seen).toEqual([])
    } finally {
      await stop()
      await stopPeer()
    }
  })
})
