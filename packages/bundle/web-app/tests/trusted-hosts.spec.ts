/** Single-sample network trust and authentication resolution (`resolveLanTrust`). */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLanTrust } from '../src/index.ts'

const { networkInterfacesMock } = vi.hoisted(() => ({
  networkInterfacesMock: vi.fn(),
}))

vi.mock('node:os', () => ({
  networkInterfaces: networkInterfacesMock,
}))

beforeEach(() => {
  networkInterfacesMock.mockReturnValue({
    lo0: [
      { family: 'IPv4', internal: true, address: '127.0.0.1', cidr: '127.0.0.1/8' },
    ],
    tailscale0: [
      { family: 'IPv4', internal: false, address: '100.99.132.53', cidr: '100.99.132.53/32' },
    ],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1', cidr: 'fe80::1/64' },
      { family: 'IPv4', internal: false, address: '192.168.1.5', cidr: '192.168.1.5/24' },
    ],
    en1: [
      { family: 'IPv4', internal: false, address: '10.0.0.7', cidr: '10.0.0.7/8' },
    ],
    public0: [
      { family: 'IPv4', internal: false, address: '203.0.113.9', cidr: '203.0.113.9/24' },
    ],
    malformed0: [
      { family: 'IPv4', internal: false, address: '172.20.0.8', cidr: '172.20.0.8/not-a-prefix' },
    ],
    unsafe0: [
      { family: 'IPv4', internal: false, address: '192.168.2.5', cidr: '192.168.2.5/8' },
    ],
    utun0: undefined,
  })
})

describe('resolveLanTrust', () => {
  it('samples every non-internal IPv4 Host literal without enabling authentication bypass', () => {
    const runtime = resolveLanTrust('0.0.0.0', ['harness.internal:3080'], false)
    expect(runtime.lanAddresses).toEqual([
      '100.99.132.53',
      '192.168.1.5',
      '10.0.0.7',
      '203.0.113.9',
      '172.20.0.8',
      '192.168.2.5',
    ])
    expect(runtime.trustedHosts).toEqual([
      ...runtime.lanAddresses,
      'harness.internal:3080',
    ])
    expect(runtime.unauthenticatedNetworkRules).toEqual([])
  })

  it('derives contained RFC 1918 rules before the fixed Tailscale source range', () => {
    const runtime = resolveLanTrust('0.0.0.0', ['harness.internal'], true)
    expect(runtime.unauthenticatedNetworkRules).toEqual([
      {
        localAddress: '192.168.1.5',
        sourceAddress: '192.168.1.5',
        sourcePrefixLength: 24,
      },
      {
        localAddress: '10.0.0.7',
        sourceAddress: '10.0.0.7',
        sourcePrefixLength: 8,
      },
      {
        localAddress: '100.99.132.53',
        sourceAddress: '100.64.0.0',
        sourcePrefixLength: 10,
      },
    ])
  })

  it('derives nothing for a loopback bind', () => {
    expect(resolveLanTrust('127.0.0.1', [], true)).toEqual({
      lanAddresses: [],
      trustedHosts: [],
      unauthenticatedNetworkRules: [],
    })
    expect(resolveLanTrust('127.0.0.1', ['lab.internal'], false)).toEqual({
      lanAddresses: [],
      trustedHosts: ['lab.internal'],
      unauthenticatedNetworkRules: [],
    })
  })

  it('fails enabled startup when no interface can produce a private rule', () => {
    networkInterfacesMock.mockReturnValue({
      public0: [
        { family: 'IPv4', internal: false, address: '203.0.113.9', cidr: '203.0.113.9/24' },
      ],
    })
    expect(() => resolveLanTrust('0.0.0.0', [], true))
      .toThrow(/no eligible RFC 1918 or Tailscale IPv4 interface/u)
  })
})
