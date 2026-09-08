/** Socket-peer authentication policy. */

import { describe, expect, it } from 'vitest'
import {
  createUnauthenticatedNetworkMatcher,
  type UnauthenticatedNetworkRule,
} from '../src/network-auth.ts'

const RULES = [
  {
    localAddress: '192.168.178.16',
    sourceAddress: '192.168.178.16',
    sourcePrefixLength: 24,
  },
  {
    localAddress: '100.99.132.53',
    sourceAddress: '100.64.0.0',
    sourcePrefixLength: 10,
  },
] as const satisfies readonly UnauthenticatedNetworkRule[]

function request(localAddress?: string, remoteAddress?: string) {
  return {
    headers: {},
    socket: { localAddress, remoteAddress },
  }
}

describe('unauthenticated network matcher', () => {
  it('accepts configured peers in native and IPv4-mapped socket forms', () => {
    const matches = createUnauthenticatedNetworkMatcher(RULES)

    expect(matches(request('192.168.178.16', '192.168.178.91'))).toBe(true)
    expect(matches(request('::ffff:192.168.178.16', '::ffff:192.168.178.91'))).toBe(true)
    expect(matches(request('100.99.132.53', '100.121.40.9'))).toBe(true)
    expect(matches(request('::ffff:100.99.132.53', '100.121.40.9'))).toBe(true)
  })

  it('requires one rule to match both the socket destination and peer source', () => {
    const matches = createUnauthenticatedNetworkMatcher(RULES)

    expect(matches(request('192.168.178.17', '192.168.178.91'))).toBe(false)
    expect(matches(request('192.168.178.16', '192.168.179.1'))).toBe(false)
    expect(matches(request('100.99.132.53', '192.168.178.91'))).toBe(false)
  })

  it('rejects missing, loopback, malformed, and non-IPv4 socket facts', () => {
    const matches = createUnauthenticatedNetworkMatcher(RULES)

    expect(matches({ headers: {} })).toBe(false)
    expect(matches(request(undefined, '192.168.178.91'))).toBe(false)
    expect(matches(request('192.168.178.16'))).toBe(false)
    expect(matches(request('192.168.178.16', '127.0.0.1'))).toBe(false)
    expect(matches(request('192.168.178.16', '::ffff:127.0.0.1'))).toBe(false)
    expect(matches(request('192.168.178.16', 'fe80::1'))).toBe(false)
    expect(matches(request('not-an-address', '192.168.178.91'))).toBe(false)
    expect(matches(request('192.168.178.16', 'not-an-address'))).toBe(false)
  })

  it('fails creation for malformed or loopback rules', () => {
    const valid = RULES[0]
    for (const rule of [
      { ...valid, localAddress: 'not-an-address' },
      { ...valid, localAddress: '::ffff:192.168.178.16' },
      { ...valid, localAddress: '127.0.0.1' },
      { ...valid, sourceAddress: 'not-an-address' },
      { ...valid, sourceAddress: '::ffff:192.168.178.16' },
      { ...valid, sourcePrefixLength: -1 },
      { ...valid, sourcePrefixLength: 33 },
      { ...valid, sourcePrefixLength: 1.5 },
    ]) {
      expect(() => createUnauthenticatedNetworkMatcher([rule]))
        .toThrow(/client-connection: invalid unauthenticated network rule/u)
    }
  })
})
