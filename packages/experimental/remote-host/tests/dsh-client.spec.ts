import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DshGatewayClient, isRemoteAbsolute, normalizeBaseUrl } from '../src/dsh-client.ts'
import { validateHosts } from '../src/config.ts'
import { MachineId } from '../src/types.ts'

describe('isRemoteAbsolute', () => {
  it('accepts POSIX and Windows drive paths', () => {
    expect(isRemoteAbsolute('/home/app')).toBe(true)
    expect(isRemoteAbsolute('C:\\Users\\ricar\\ComfyUI')).toBe(true)
    expect(isRemoteAbsolute('C:/Users/ricar/ComfyUI')).toBe(true)
    expect(isRemoteAbsolute('ComfyUI')).toBe(false)
  })
})

describe('validateHosts', () => {
  it('rejects duplicate ids and empty fields', () => {
    expect(() => validateHosts([{ id: MachineId('a'), label: '', url: 'http://127.0.0.1:3081' }]))
      .toThrow(RemoteError)
    expect(() => validateHosts([
      { id: MachineId('a'), label: 'one', url: 'http://127.0.0.1:3081' },
      { id: MachineId('a'), label: 'two', url: 'http://127.0.0.1:3082' },
    ])).toThrow(/duplicate host id/)
  })

  it('rejects non-http URLs and normalizes trailing slashes', () => {
    expect(() => validateHosts([
      { id: MachineId('a'), label: 'one', url: 'gpu-box' },
    ])).toThrow(/http\(s\) DSH base URL/)
    const [host] = validateHosts([
      { id: MachineId('a'), label: 'one', url: 'http://127.0.0.1:3081///' },
    ])
    expect(host?.url).toBe('http://127.0.0.1:3081')
  })
})

describe('normalizeBaseUrl', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeBaseUrl('  http://127.0.0.1:3081///  ')).toBe('http://127.0.0.1:3081')
    expect(normalizeBaseUrl('')).toBe('')
  })
})

describe('DshGatewayClient.call', () => {
  const savedFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = savedFetch
    vi.restoreAllMocks()
  })

  function stubFetch(handler: (url: string, init: RequestInit) => unknown): void {
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => handler(url, init)) as never
  }

  function response(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }

  it('posts the gateway envelope without auth or Origin', async () => {
    let seenUrl = ''
    let seenInit: RequestInit = {}
    stubFetch((url, init) => {
      seenUrl = url
      seenInit = init
      return response({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { home: '/root' } } })
    })
    const client = new DshGatewayClient('http://127.0.0.1:3081')
    const value = await client.call('remoteHosts/localHome', { a: 1 })
    expect(value).toEqual({ home: '/root' })
    expect(seenUrl).toBe('http://127.0.0.1:3081/api/remoteHosts/localHome')
    const headers = seenInit.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBeUndefined()
    expect('Origin' in headers).toBe(false)
    const body = JSON.parse(seenInit.body as string) as { type: string; rpcId: string; method: string; payload: unknown }
    expect(body.type).toBe('client-request')
    expect(typeof body.rpcId).toBe('string')
    expect(body.method).toBe('remoteHosts/localHome')
    expect(body.payload).toEqual({ args: { a: 1 } })
    expect(seenInit.method).toBe('POST')
  })

  it('sends the bearer credential when configured and forwards the signal', async () => {
    let seenInit: RequestInit = {}
    stubFetch((_url, init) => {
      seenInit = init
      return response({ type: 'server-response', rpcId: 'x', result: { ok: true, value: null } })
    })
    const controller = new AbortController()
    await new DshGatewayClient('http://127.0.0.1:3081', 'tok').call('remoteHosts/listMachines', {}, controller.signal)
    expect((seenInit.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
    expect(seenInit.signal).toBe(controller.signal)
  })

  it('maps network failures to unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never
    const failure = await new DshGatewayClient('http://127.0.0.1:3081').call('remoteHosts/listMachines', {}).catch(e => e)
    expect(failure).toBeInstanceOf(RemoteError)
    expect(failure.code).toBe('remote-host/unreachable')
  })

  it('maps HTTP errors and invalid envelopes to unreachable', async () => {
    stubFetch(() => response({}, 403))
    await expect(new DshGatewayClient('http://127.0.0.1:3081').call('x', {})).rejects.toMatchObject({
      code: 'remote-host/unreachable',
    })
    stubFetch(() => response({ type: 'nope' }))
    await expect(new DshGatewayClient('http://127.0.0.1:3081').call('x', {})).rejects.toMatchObject({
      code: 'remote-host/unreachable',
    })
  })

  it('passes remote error codes through', async () => {
    stubFetch(() => response({
      type: 'server-response',
      rpcId: 'x',
      result: { ok: false, error: { code: 'remote-host/invalid-path', message: 'nope' } },
    }))
    await expect(new DshGatewayClient('http://127.0.0.1:3081').call('x', {})).rejects.toMatchObject({
      code: 'remote-host/invalid-path',
    })
    stubFetch(() => response({
      type: 'server-response',
      rpcId: 'x',
      result: { ok: false, error: { code: 'remote-host/not-found', message: 'gone' } },
    }))
    await expect(new DshGatewayClient('http://127.0.0.1:3081').call('x', {})).rejects.toMatchObject({
      code: 'remote-host/not-found',
    })
    stubFetch(() => response({
      type: 'server-response',
      rpcId: 'x',
      result: { ok: false, error: { code: 'other/boom', message: 'kaput' } },
    }))
    const failure = await new DshGatewayClient('http://127.0.0.1:3081').call('x', {}).catch(e => e)
    expect(failure.code).toBe('remote-host/unreachable')
    expect(failure.message).toContain('kaput')
  })
})

describe('validateHosts auth and url edges', () => {
  it('normalizes auth and rejects empty urls', () => {
    const [kept] = validateHosts([{ id: 'a', label: 'one', url: 'http://127.0.0.1:3081', auth: '  tok  ' }])
    expect(kept?.auth).toBe('tok')
    const [dropped] = validateHosts([{ id: 'a', label: 'one', url: 'http://127.0.0.1:3081', auth: '   ' }])
    expect(dropped).not.toHaveProperty('auth')
    expect(() => validateHosts([{ id: 'a', label: 'one', url: '   ' }])).toThrow(/must be non-empty/)
    expect(() => validateHosts([{ id: '', label: 'one', url: 'http://127.0.0.1:3081' }])).toThrow(/must be non-empty/)
  })
})

describe('DshGatewayClient.call edges', () => {
  const savedFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = savedFetch
  })

  it('stringifies non-Error failures', async () => {
    globalThis.fetch = vi.fn(async () => { throw 'boom-string' }) as never
    const failure = await new DshGatewayClient('http://127.0.0.1:3081').call('x', {}).catch(e => e)
    expect(failure.code).toBe('remote-host/unreachable')
    expect(failure.message).toContain('boom-string')
  })

  it('defaults missing error details', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ type: 'server-response', rpcId: 'x', result: { ok: false } }),
    })) as never
    const failure = await new DshGatewayClient('http://127.0.0.1:3081').call('x', {}).catch(e => e)
    expect(failure.code).toBe('remote-host/unreachable')
    expect(failure.message).toContain('http://127.0.0.1:3081')
  })
})

describe('validateHosts protocol edges', () => {
  it('rejects parseable non-http URLs', () => {
    expect(() => validateHosts([{ id: 'a', label: 'one', url: 'ftp://files/x' }])).toThrow(/http\(s\) DSH base URL/)
  })
})
