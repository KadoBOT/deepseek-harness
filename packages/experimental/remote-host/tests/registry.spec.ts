import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { DshGatewayClient } from '../src/dsh-client.ts'
import { RemoteHostService } from '../src/service.ts'
import { MachineId } from '../src/types.ts'

function stubClient(handler: (endpoint: string) => unknown): DshGatewayClient {
  return { call: async <T>(endpoint: string): Promise<T> => handler(endpoint) as T } as DshGatewayClient
}

describe('RemoteHostService', () => {
  it('lists and upserts machines without touching the local filesystem', async () => {
    const ctx = new Context()
    const mkdir = vi.fn()
    ctx.provide('workspaceRegistry', { createAt: vi.fn(), mkdir } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    const listed = ctx.remoteHosts.listMachines()
    expect(listed).toEqual([
      { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' },
    ])
    const added = await ctx.remoteHosts.upsertMachine({ label: 'mac', url: 'http://mac.tailnet.ts.net:3080' })
    expect(added.label).toBe('mac')
    expect(ctx.remoteHosts.listMachines()).toHaveLength(2)
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('registers two workspaces for the same remote path on different machines', async () => {
    const ctx = new Context()
    const createAt = vi.fn(async (input: { path: string; machineId: string; machineLabel: string }) => ({
      id: `${input.machineId}-ws`,
      path: input.path,
      title: 'app',
      machineId: input.machineId,
      machineLabel: input.machineLabel,
    }))
    ctx.provide('workspaceRegistry', { createAt } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [
        { id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' },
        { id: 'mac', label: 'mac-studio', url: 'http://127.0.0.1:3082' },
      ],
    })
    ctx.remoteHosts.internals.clientFactory = () => stubClient((endpoint) => {
      if (endpoint === 'remoteHosts/localRealpath') return '/home/app'
      return { type: 'directory', version: '1' }
    })
    const first = await ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: '/home/app' })
    const second = await ctx.remoteHosts.createWorkspace({ machineId: 'mac', path: '/home/app' })
    expect(first.workspaceId).not.toBe(second.workspaceId)
    expect(createAt).toHaveBeenCalledTimes(2)
    expect(createAt.mock.calls[0]?.[0]).toMatchObject({ path: '/home/app', machineId: 'gpu' })
    expect(createAt.mock.calls[1]?.[0]).toMatchObject({ path: '/home/app', machineId: 'mac' })
  })

  it('maps a failed probe to remote-host/unreachable', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    ctx.remoteHosts.internals.clientFactory = () => stubClient(() => {
      throw new Error('fetch failed')
    })
    const failure = await ctx.remoteHosts.probe('gpu').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'remote-host/unreachable',
      details: { id: 'gpu' },
    })
  })

  it('probes via the secondary gateway listMachines endpoint', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    const seen: string[] = []
    ctx.remoteHosts.internals.clientFactory = () => stubClient((endpoint) => {
      seen.push(endpoint)
      return []
    })
    await ctx.remoteHosts.probe('gpu')
    expect(seen).toEqual(['remoteHosts/listMachines'])
  })
})

describe('RemoteHostService settings and removal', () => {
  it('probes reachable peers and removes machines', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    ctx.remoteHosts.internals.clientFactory = () => stubClient(() => [])
    const view = await ctx.remoteHosts.probe('gpu')
    expect(view).toMatchObject({ status: 'reachable' })
    expect(ctx.remoteHosts.listMachines()).toMatchObject([{ status: 'reachable' }])
    await ctx.remoteHosts.removeMachine({ id: 'gpu' })
    expect(ctx.remoteHosts.listMachines()).toEqual([])
    await ctx.remoteHosts.removeMachine({ id: 'gpu' })
  })

  it('syncs the settings section triple and persists writes', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    let stored: { hosts?: Array<{ id: string; label: string; url: string; auth?: string }> } | undefined
    let hooks: {
      validate: (value: { hosts?: Array<{ id?: string; label?: string; url?: string; auth?: string }> }) => void
      setSource: (source: () => { hosts?: Array<{ id: string; label: string; url: string; auth?: string }> }) => void
      onChange: () => void
    } | undefined
    ctx.provide('settings', {
      installSection: (_ctx: unknown, _ns: string, _schema: unknown, _config: unknown, sectionHooks: never) => {
        hooks = sectionHooks as never
      },
      get: () => stored,
      replace: async (_ns: string, doc: never) => {
        stored = doc as never
      },
    } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    expect(hooks).toBeDefined()
    hooks?.validate({ hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }] })
    expect(() => hooks?.validate({ hosts: [{ id: 'gpu', label: '', url: 'http://127.0.0.1:3081' }] })).toThrow()
    hooks?.setSource(() => ({ hosts: [{ id: 'mac', label: 'mac', url: 'http://127.0.0.1:3082', auth: 'tok' }] }))
    expect(ctx.remoteHosts.listMachines()).toMatchObject([{ id: 'mac', auth: 'tok' }])
    stored = { hosts: [{ id: 'solo', label: 'solo', url: 'http://127.0.0.1:3083' }] }
    hooks?.onChange()
    expect(ctx.remoteHosts.listMachines()).toMatchObject([{ id: 'solo' }])
    await ctx.remoteHosts.upsertMachine({ label: 'added', url: 'http://127.0.0.1:3084' })
    expect(stored?.hosts).toHaveLength(2)
  })
})

describe('RemoteHostService probe edges', () => {
  it('stringifies non-Error probe failures', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    ctx.remoteHosts.internals.clientFactory = () => stubClient(() => {
      throw 'boom-string'
    })
    const failure = await ctx.remoteHosts.probe('gpu').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'remote-host/unreachable' })
  })
})

describe('RemoteHostService settings edges', () => {
  it('validates empty and partial settings documents', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    let hooks: {
      validate: (value: { hosts?: Array<{ id?: string; label?: string; url?: string; auth?: string }> }) => void
    } | undefined
    ctx.provide('settings', {
      installSection: (_ctx: unknown, _ns: string, _schema: unknown, _config: unknown, sectionHooks: never) => {
        hooks = sectionHooks as never
      },
      get: () => undefined,
      replace: async () => {},
    } as never)
    await ctx.plugin(RemoteHostService, { hosts: [] })
    hooks?.validate({})
    hooks?.validate({ hosts: [{ id: 'a', label: 'b', url: 'http://127.0.0.1:3081', auth: 'tok' }] })
    expect(() => hooks?.validate({ hosts: [{}] })).toThrow(/non-empty/)
  })
})

describe('RemoteHostService constructor and stat edges', () => {
  it('defaults missing hosts and maps device files to other', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService)
    expect(ctx.remoteHosts.listMachines()).toEqual([])
    expect(await ctx.remoteHosts.localStat({ path: '/dev/null' })).toMatchObject({ type: 'other' })
  })

  it('covers settings source fallbacks', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    const box: { stored: { hosts?: Array<{ id: string; label: string; url: string }> } | undefined } = {
      stored: undefined,
    }
    let hooks: {
      setSource: (source: () => { hosts?: Array<{ id?: string; label?: string; url?: string }> }) => void
      onChange: () => void
    } | undefined
    ctx.provide('settings', {
      installSection: (_ctx: unknown, _ns: string, _schema: unknown, _config: unknown, sectionHooks: never) => {
        hooks = sectionHooks as never
      },
      get: () => box.stored,
      replace: async () => {},
    } as never)
    await ctx.plugin(RemoteHostService, { hosts: [] })
    hooks?.setSource(() => ({}))
    expect(ctx.remoteHosts.listMachines()).toEqual([])
    expect(() => hooks?.setSource(() => ({ hosts: [{}] }))).toThrow(/non-empty/)
    box.stored = undefined
    hooks?.onChange()
    expect(ctx.remoteHosts.listMachines()).toEqual([])
  })
})

describe('RemoteHostService direct construction', () => {
  it('defaults hosts without schema composition', () => {
    const bare = new RemoteHostService(new Context())
    expect(bare.listMachines()).toEqual([])
  })
})
