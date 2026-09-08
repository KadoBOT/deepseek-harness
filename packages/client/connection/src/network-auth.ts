/** Direct socket-peer matching for explicitly unauthenticated IPv4 networks. */

import { BlockList, isIPv4 } from 'node:net'
import type {
  ConnectionTrustRequest,
  UnauthenticatedNetworkRule,
} from './rpc.ts'

export type { UnauthenticatedNetworkRule } from './rpc.ts'

interface CompiledRule {
  readonly localAddress: string
  readonly sources: BlockList
}

const IPV4_MAPPED_PREFIX = '::ffff:'
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')

function normalizeSocketIpv4(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isIPv4(value)) return value
  if (value.slice(0, IPV4_MAPPED_PREFIX.length).toLowerCase() !== IPV4_MAPPED_PREFIX) {
    return undefined
  }
  const mapped = value.slice(IPV4_MAPPED_PREFIX.length)
  return isIPv4(mapped) ? mapped : undefined
}

function invalidRule(reason: string): never {
  throw new Error(`client-connection: invalid unauthenticated network rule: ${reason}`)
}

function compileRule(rule: UnauthenticatedNetworkRule): CompiledRule {
  if (!isIPv4(rule.localAddress)) invalidRule('localAddress must be a plain IPv4 address')
  if (LOOPBACK.check(rule.localAddress, 'ipv4')) invalidRule('localAddress must not be loopback')
  if (!isIPv4(rule.sourceAddress)) invalidRule('sourceAddress must be a plain IPv4 address')
  if (!Number.isInteger(rule.sourcePrefixLength)
    || rule.sourcePrefixLength < 0
    || rule.sourcePrefixLength > 32) {
    invalidRule('sourcePrefixLength must be an integer from 0 through 32')
  }
  const sources = new BlockList()
  sources.addSubnet(rule.sourceAddress, rule.sourcePrefixLength, 'ipv4')
  return { localAddress: rule.localAddress, sources }
}

/**
 * Compile destination-specific source subnets into one synchronous socket matcher.
 * @param rules - validated-at-creation IPv4 destination and source-subnet rules.
 * @returns predicate accepting only direct non-loopback peers matching one complete rule.
 */
export function createUnauthenticatedNetworkMatcher(
  rules: readonly UnauthenticatedNetworkRule[],
): (request: ConnectionTrustRequest) => boolean {
  const compiled = rules.map(compileRule)
  return (request) => {
    const localAddress = normalizeSocketIpv4(request.socket?.localAddress)
    const remoteAddress = normalizeSocketIpv4(request.socket?.remoteAddress)
    if (localAddress === undefined || remoteAddress === undefined
      || LOOPBACK.check(remoteAddress, 'ipv4')) return false
    return compiled.some(rule =>
      rule.localAddress === localAddress && rule.sources.check(remoteAddress, 'ipv4'))
  }
}
