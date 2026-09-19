/** Authenticated read-only HTTP access to a second DSH host. */
import { randomUUID } from 'node:crypto'

/** Explicit target and resource limits for a caller-owned connection. */
export interface RemoteConnectionOptions {
  readonly loginUrl: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

/** Probe result and lifecycle owned by the calling plugin. */
export interface RemoteConnection {
  /** Read provider metadata without starting a model request. */
  listProviders(): Promise<unknown[]>
  /** Read the remote's visible Session summaries. */
  listSessions(): Promise<{ items: readonly unknown[] }>
  /** Abort requests and wait for their bodies to finish closing. */
  dispose(): Promise<void>
}

/**
 * Exchange an owner-supplied launch URL for an authority-bound session cookie.
 * Redirects are never followed and credentials remain private to this instance.
 * @param options - root login URL and positive request limits.
 * @returns authenticated connection; the caller must dispose it on unload.
 */
export async function connectRemote(options: RemoteConnectionOptions): Promise<RemoteConnection> {
  const target = new URL(options.loginUrl)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.pathname !== '/' || target.hash
    || [...target.searchParams.keys()].some(key => key !== 'token')
    || target.searchParams.getAll('token').length !== 1 || !target.searchParams.get('token')) {
    throw new Error('Remote connection requires a root HTTP(S) login URL with one token')
  }
  for (const limit of [options.timeoutMs, options.maxResponseBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Remote request limits must be positive safe integers')
  }
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let cookie = ''
  const origin = target.origin

  async function request<T>(url: URL, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted()
    const operation = (async () => {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.timeoutMs)]),
      })
      try {
        return await read(response)
      } finally {
        if (!response.bodyUsed) await response.body?.cancel()
      }
    })()
    pending.add(operation)
    try {
      return await operation
    } finally {
      pending.delete(operation)
    }
  }

  await request(target, { method: 'GET' }, async (response) => {
    if (response.status !== 303 || response.headers.get('location') !== '/') {
      throw new Error(`Remote login failed (HTTP ${response.status}); supply the remote's current login URL`)
    }
    const cookies = response.headers.getSetCookie()
    const [onlyCookie] = cookies
    if (cookies.length !== 1 || onlyCookie === undefined) {
      throw new Error('Remote login did not return one session cookie')
    }
    cookie = onlyCookie.split(';', 1)[0] ?? ''
    if (!/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/u.test(cookie)) {
      throw new Error('Remote login returned an invalid session cookie')
    }
  })

  return {
    async listProviders() {
      const rpcId = randomUUID()
      const endpoint = 'llm/listProviders'
      return request(new URL(`/api/${endpoint}`, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: {} } }),
      }, async (response) => {
        if (response.status !== 200) throw new Error(`Remote provider read failed (HTTP ${response.status})`)
        const body = await boundedJson(response, options.maxResponseBytes)
        if (!isObject(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isObject(body.result)) {
          throw new Error('Remote provider read returned an incompatible response')
        }
        if (body.result.ok !== true || !Array.isArray(body.result.value)) {
          throw new Error('Remote provider read was rejected or returned invalid metadata')
        }
        return body.result.value
      })
    },
    async listSessions() {
      const rpcId = randomUUID()
      const endpoint = 'session/list'
      return request(new URL(`/api/${endpoint}`, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: {} } }),
      }, async (response) => {
        if (response.status !== 200) throw new Error(`Remote session list failed (HTTP ${response.status})`)
        const body = await boundedJson(response, options.maxResponseBytes)
        if (!isObject(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isObject(body.result)) {
          throw new Error('Remote session list returned an incompatible response')
        }
        const value = body.result.value
        if (body.result.ok !== true || !isSessionList(value)) {
          throw new Error('Remote session list was rejected or returned invalid metadata')
        }
        return value
      })
    },
    async dispose() {
      lifetime.abort()
      cookie = ''
      await Promise.allSettled([...pending])
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionList(value: unknown): value is { items: readonly unknown[] } {
  return isObject(value) && Array.isArray((value as { items?: readonly unknown[] }).items)
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new Error('Remote response body is missing')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('Remote response exceeds the configured byte limit')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
