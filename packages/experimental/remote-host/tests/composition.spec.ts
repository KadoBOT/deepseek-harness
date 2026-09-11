import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

describe('remote-host composition', () => {
  it('fails loud when stock backends are already mounted', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', { currentInitiator: () => undefined })
    ctx.provide('sandboxPolicy', { overrideOf: () => undefined } as never)
    ctx.provide('sandbox', {})
    ctx.provide('fs', { kind: 'stock' } as never)
    await expect(apply(ctx, { hosts: [] })).rejects.toThrow(/stock fs\/subprocess\/shell rows must be disabled/)
  })

  it('mounts the registry, routers, and discovery, then disposes them', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', { currentInitiator: () => undefined })
    ctx.provide('sandboxPolicy', { overrideOf: () => undefined } as never)
    ctx.provide('sandbox', {})
    ctx.provide('webServer', { port: 38111, host: '127.0.0.1' } as never)
    await apply(ctx, { discovery: { port: 43811, intervalMs: 50 } })
    expect(ctx.get('remoteHosts').listMachines()).toEqual([])
    await vi.waitFor(() => {
      expect(ctx.get('fs')).toBeDefined()
      expect(ctx.get('subprocess')).toBeDefined()
      expect(ctx.get('shell')).toBeDefined()
    })
    await ctx.fiber.dispose()
    expect(ctx.get('remoteHosts')).toBeUndefined()
  })

  it('rejects invalid hosts at load', async () => {
    const ctx = new Context()
    await expect(apply(ctx, {
      hosts: [{ id: '', label: 'x', url: 'http://127.0.0.1:3081' }],
    })).rejects.toThrow()
  })

  it('confines remote sessions and ignores local ones on session-start', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', { currentInitiator: () => undefined })
    const appended: Array<{ event: string; payload: unknown }> = []
    ctx.provide('sandboxPolicy', { overrideOf: () => undefined } as never)
    ctx.provide('sandbox', {})
    ctx.provide('webServer', { port: 38113, host: '127.0.0.1' } as never)
    await apply(ctx, { hosts: [], discovery: { enabled: false } })
    // Local sessions pass through untouched.
    await ctx.emit('agent/session-start', { agent: { session: { header: {} } } } as never)
    // Remote sessions without an override are confined to danger-full-access.
    await ctx.emit('agent/session-start', {
      agent: { session: { header: { machineId: 'gpu' }, append: (event: string, payload: unknown) => { appended.push({ event, payload }) } } },
    } as never)
    expect(appended).toEqual([{ event: 'sandbox/mode', payload: { mode: 'danger-full-access' } }])
    await ctx.fiber.dispose()
  })

  it('keeps remote sessions already carrying the override', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', { currentInitiator: () => undefined })
    ctx.provide('sandboxPolicy', { overrideOf: () => 'danger-full-access' } as never)
    ctx.provide('sandbox', {})
    await apply(ctx, { hosts: [], discovery: { enabled: false } })
    let calls = 0
    await ctx.emit('agent/session-start', {
      agent: { session: { header: { machineId: 'gpu' }, append: () => { calls += 1 } } },
    } as never)
    expect(calls).toBe(0)
    await ctx.fiber.dispose()
  })

  it('skips discovery without a webserver and survives a blocked port', async () => {
    const plain = new Context()
    plain.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    plain.provide('agents', { currentInitiator: () => undefined })
    plain.provide('sandboxPolicy', { overrideOf: () => undefined } as never)
    plain.provide('sandbox', {})
    await apply(plain, { hosts: [] })
    await plain.fiber.dispose()

    const { createSocket } = await import('node:dgram')
    const blocker = createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.bind(43812, () => { resolve() })
    })
    try {
      const ctx = new Context()
      ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
      ctx.provide('agents', { currentInitiator: () => undefined })
      ctx.provide('sandboxPolicy', { overrideOf: () => undefined } as never)
      ctx.provide('sandbox', {})
      ctx.provide('webServer', { port: 38112, host: '127.0.0.1' } as never)
      await apply(ctx, { hosts: [], discovery: { port: 43812, intervalMs: 50 } })
      await vi.waitFor(() => {
        expect(ctx.get('fs')).toBeDefined()
      })
      await ctx.fiber.dispose()
    } finally {
      blocker.close()
    }
  })
})
