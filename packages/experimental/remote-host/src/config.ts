/** Settings schema and loud validation for configured DSH hosts. */

import z from '@deepseek-ai/schemastery'
import { normalizeBaseUrl } from './dsh-client.ts'
import { RemoteError } from './errors.ts'
import { MachineId } from './types.ts'
import type { HostRecord } from './types.ts'

/** Settings namespace joined to the Plugins card. */
export const REMOTE_HOSTS_NS = 'remote-hosts'

/** Loader and settings schema for configured machines. */
export const Config = z.object({
  hosts: z.array(z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    auth: z.string(),
  })).default([]),
  discovery: z.object({
    enabled: z.boolean().default(true),
    port: z.number().step(1).min(1).max(65535).default(43771),
    intervalMs: z.number().step(1).min(50).max(3600000).default(5000),
  }),
})

/**
 * Reject duplicate ids, empty labels, and empty or invalid DSH URLs.
 * @param hosts - Candidate host records.
 * @returns branded records in the same order.
 * @throws {RemoteError} `remote-host/invalid-config` when a field is empty or an id repeats.
 */
export function validateHosts(hosts: readonly { id: string; label: string; url: string; auth?: string }[]): HostRecord[] {
  const seen = new Set<string>()
  const result: HostRecord[] = []
  for (const host of hosts) {
    const id = host.id.trim()
    const label = host.label.trim()
    const url = normalizeBaseUrl(host.url)
    const auth = host.auth?.trim() === '' ? undefined : host.auth?.trim()
    if (id.length === 0) {
      throw new RemoteError('remote-host/invalid-config', 'host id must be non-empty', { reason: 'empty-id' })
    }
    if (seen.has(id)) {
      throw new RemoteError(
        'remote-host/invalid-config',
        `duplicate host id "${id}"`,
        { reason: `duplicate-id:${id}` },
      )
    }
    if (label.length === 0) {
      throw new RemoteError('remote-host/invalid-config', 'host label must be non-empty', { reason: 'empty-label' })
    }
    if (url.length === 0) {
      throw new RemoteError(
        'remote-host/invalid-config',
        'host url must be non-empty',
        { reason: 'empty-url' },
      )
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
    } catch {
      throw new RemoteError(
        'remote-host/invalid-config',
        `host url must be an http(s) DSH base URL, got "${url}"`,
        { reason: 'invalid-url' },
      )
    }
    seen.add(id)
    result.push({ id: MachineId(id), label, url, ...auth === undefined ? {} : { auth } })
  }
  return result
}
