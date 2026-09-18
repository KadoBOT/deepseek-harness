/** Connector option validation and scripted-server rejection behavior. */
import { describe, expect, it } from 'vitest'
import { connectRemote } from '../src/connection.ts'
import { startScriptedServer } from './http-fixture.ts'

describe('connectRemote validation', () => {
  it('rejects invalid options before any network activity', async () => {
    const base = { timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const invalid = [
      { loginUrl: 'http://127.0.0.1:1/path' },
      { loginUrl: 'http://user:pass@127.0.0.1:1/?token=x' },
      { loginUrl: 'http://127.0.0.1:1/?token=x&extra=y' },
      { loginUrl: 'ftp://127.0.0.1/?token=x' },
      { loginUrl: 'http://127.0.0.1:1/?token=' },
    ]
    for (const option of invalid) {
      await expect(connectRemote({ ...base, ...option })).rejects.toThrow('root HTTP(S) login URL')
    }
    await expect(connectRemote({ loginUrl: 'http://127.0.0.1:1/?token=x', timeoutMs: 0, maxResponseBytes: 1 }))
      .rejects.toThrow('limits')
    await expect(connectRemote({ loginUrl: 'http://127.0.0.1:1/?token=x', timeoutMs: 1_000, maxResponseBytes: -1 }))
      .rejects.toThrow('limits')
  })

  it('does not follow an expired-token redirect and reports the login failure', async () => {
    const remote = await startScriptedServer(() => ({ status: 302, headers: { location: '/relogin' } }))
    try {
      await expect(connectRemote({ loginUrl: `http://127.0.0.1:${String(remote.port)}/?token=stale`, timeoutMs: 1_000, maxResponseBytes: 1_024 }))
        .rejects.toThrow('login failed')
      expect(remote.requests).toEqual([{ method: 'GET', path: '/?token=stale' }])
    } finally {
      await remote.close()
    }
  })

  it('rejects an oversized provider response at the configured byte limit', async () => {
    const remote = await startScriptedServer((request) => {
      if (new URL(request.path, 'http://dsh.invalid').pathname !== '/api/llm/listProviders') {
        return { status: 303, headers: { location: '/', 'set-cookie': 'dsh-web-session=v1.payload.sig; Path=/' } }
      }
      return { status: 200, body: 'x'.repeat(2_048) }
    })
    try {
      const connection = await connectRemote({ loginUrl: `http://127.0.0.1:${String(remote.port)}/?token=x`, timeoutMs: 1_000, maxResponseBytes: 1_024 })
      try {
        await expect(connection.listProviders()).rejects.toThrow('byte limit')
      } finally {
        await connection.dispose()
      }
    } finally {
      await remote.close()
    }
  })

  it('lists remote sessions with an empty argument envelope', async () => {
    const remote = await startScriptedServer((request) => {
      if (new URL(request.path, 'http://dsh.invalid').pathname !== '/api/session/list') {
        return { status: 303, headers: { location: '/', 'set-cookie': 'dsh-web-session=v1.payload.sig; Path=/' } }
      }
      const envelope = JSON.parse(request.body ?? '{}') as { rpcId?: string; payload?: { args?: unknown } }
      return {
        status: 200,
        body: JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [{ sessionId: 'remote-1' }] } } }),
      }
    })
    try {
      const connection = await connectRemote({ loginUrl: `http://127.0.0.1:${String(remote.port)}/?token=x`, timeoutMs: 1_000, maxResponseBytes: 65_536 })
      try {
        await expect(connection.listSessions()).resolves.toEqual({ items: [{ sessionId: 'remote-1' }] })
      } finally {
        await connection.dispose()
      }
      expect(remote.requests).toHaveLength(2)
      const [, list] = remote.requests
      expect(list?.method).toBe('POST')
      expect(list?.body !== undefined && JSON.parse(list.body)).toMatchObject({
        type: 'client-request',
        method: 'session/list',
        payload: { args: {} },
      })
    } finally {
      await remote.close()
    }
  })
})
