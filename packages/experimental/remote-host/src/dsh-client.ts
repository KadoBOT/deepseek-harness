/**
 * Minimal Node HTTP client for secondary `dsh web` gateways. Primary `dsh web`
 * fans out server-side to a secondary over same-machine loopback or Tailscale
 * LAN; the browser keeps a single connection to the primary. No `Origin`
 * header is sent so the secondary's socket-peer trust (loopback, LAN,
 * Tailscale interface rules) authenticates the peer. No ssh binary, Python
 * helper, or ControlMaster state is involved.
 * @module @deepseek-ai/dsh-experimental-remote-host/dsh-client
 */

import { randomUUID } from 'node:crypto'
import { RemoteError } from './errors.ts'

/**
 * Gateway client for one secondary DSH base URL.
 */
export class DshGatewayClient {
  /**
   * @param baseUrl - Secondary `dsh web` base URL with no trailing slash.
   * @param auth - Optional credential sent as `Authorization: Bearer`.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly auth?: string,
  ) {}

  /**
   * Call one Typert gateway endpoint on the secondary.
   * @param endpoint - Gateway endpoint, for example `remoteHosts/listMachines`.
   * @param args - Remote args object.
   * @param signal - Abort the HTTP request.
   * @returns the remote `value`.
   */
  async call<T>(endpoint: string, args: unknown, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID()
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.auth === undefined || this.auth.length === 0
            ? {}
            : { Authorization: `Bearer ${this.auth}` },
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: endpoint,
          payload: { args },
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      throw new RemoteError(
        'remote-host/unreachable',
        `cannot reach "${this.baseUrl}": ${error instanceof Error ? error.message : String(error)}`,
        { id: this.baseUrl },
      )
    }
    if (!response.ok) {
      throw new RemoteError(
        'remote-host/unreachable',
        `cannot reach "${this.baseUrl}": HTTP ${response.status}`,
        { id: this.baseUrl },
      )
    }
    const body = await response.json() as {
      type?: string
      rpcId?: string
      result?: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }
    }
    if (body.type !== 'server-response' || body.result === undefined) {
      throw new RemoteError(
        'remote-host/unreachable',
        `cannot reach "${this.baseUrl}": invalid gateway response`,
        { id: this.baseUrl },
      )
    }
    if (body.result.ok !== true) {
      const code = body.result.error?.code ?? ''
      const message = body.result.error?.message ?? `cannot reach "${this.baseUrl}"`
      if (code === 'remote-host/invalid-path' || code === 'remote-host/not-found') {
        throw new RemoteError(code, message, code === 'remote-host/not-found' ? { id: message } : { path: message })
      }
      throw new RemoteError('remote-host/unreachable', message, { id: this.baseUrl })
    }
    return body.result.value as T
  }
}

/**
 * Check an absolute path on any OS (POSIX, drive, or UNC prefix).
 * @param path - Candidate remote path.
 * @returns true when the path is absolute.
 */
export function isRemoteAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Trim a DSH base URL and strip trailing slashes.
 * @param url - Candidate base URL.
 * @returns normalized URL string (possibly empty).
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
