// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function fail(message: string): { ok: false; error: { message: string } } {
  return { ok: false, error: { message } }
}

function remoteHostsStub(overrides: Record<string, unknown> = {}) {
  return {
    listMachines: vi.fn(async () => ok([])),
    upsertMachine: vi.fn(async (input: unknown) => ok({ id: 'm', ...(input as object) })),
    listDirectory: vi.fn(async () => ok({ path: '/', entries: [] })),
    createWorkspace: vi.fn(async () => ok({ workspaceId: 'ws', title: 'ws' })),
    probe: vi.fn(async () => ok({ id: 'm' })),
    removeMachine: vi.fn(async () => ok(undefined)),
    ...overrides,
  }
}

interface HarnessCtx {
  remote: { $mount: Mock; remoteHosts: Record<string, Mock> }
  locale: { register: Mock }
  effect: (setup: () => unknown) => unknown
  slots: { inject: Mock; register: Mock }
  inject: Mock
  get: (name: string) => unknown
}

interface Harness {
  ctx: HarnessCtx
  injected: Array<{ name: string; render: () => unknown }>
  registered: Array<{ key?: string; id?: string; inject?: () => Record<string, unknown> }>
  disposed: string[]
}

/** Minimal ClientContext double: inject invokes its callback like a resolved fiber. */
function harness(overrides: Partial<HarnessCtx> = {}): Harness {
  const injected: Array<{ name: string; render: () => unknown }> = []
  const registered: Array<{ key?: string; id?: string; inject?: () => Record<string, unknown> }> = []
  const disposed: string[] = []
  const ctx: HarnessCtx = {
    remote: {
      $mount: vi.fn(async () => async () => { disposed.push('remote') }),
      remoteHosts: remoteHostsStub() as Record<string, Mock>,
    },
    locale: { register: vi.fn() },
    effect: vi.fn((setup: () => unknown) => setup()),
    slots: {
      inject: vi.fn((name: string, render: () => unknown) => {
        injected.push({ name, render })
        return Promise.resolve()
      }),
      register: vi.fn((def: { key?: string; id?: string; inject?: () => Record<string, unknown> }, component: unknown) => {
        expect(component).toBeDefined()
        registered.push(def)
        return { key: def.key ?? def.id }
      }),
    },
    inject: vi.fn((_deps: unknown, callback: (scoped: HarnessCtx) => unknown) => {
      const fiber = { dispose: vi.fn(async () => { disposed.push('ui') }) }
      callback(ctx)
      return fiber
    }),
    get: () => undefined,
    ...overrides,
  }
  return { ctx, injected, registered, disposed }
}

describe('client-ui-remote-host apply', () => {
  it('declares browser services and mounts the remote namespace with UI', async () => {
    expect(inject).toContain('slots')
    const sessions = { create: vi.fn(async () => 'sess-1'), open: vi.fn() }
    const list = {
      getSnapshot: () => ({ items: [{ workspaceId: 'ws', sessionIds: [] as string[] }] }),
      upsertView: vi.fn(),
    }
    const workspaces = { list, rename: vi.fn(async () => {}), upsert: undefined as never }
    const harness1 = harness({
      get: (name: string) => {
        if (name === 'workspaces') return workspaces
        if (name === 'sessions') return sessions
        return undefined
      },
    })
    const { ctx, injected, disposed } = harness1
    const dispose = await apply(ctx as never)
    expect(ctx.remote.$mount).toHaveBeenCalled()
    expect(ctx.locale.register).toHaveBeenCalled()
    expect(injected.map(entry => entry.name).sort()).toEqual(['settings.plugin.item', 'sidebar.footer.action'])
    // Drive the settings card inject face: probe + remove through the mounted remote.
    const { registered } = harness1
    for (const entry of injected) entry.render()
    const cardDef = registered.find(def => def.key === 'remote-hosts')
    const cardProps = cardDef?.inject?.() as {
      probe: (id: string) => Promise<void>
      removeMachine: (id: string) => Promise<void>
      createWorkspace: (input: { machineId: string; path: string; title?: string }) => Promise<void>
    }
    await cardProps.probe('m')
    expect(ctx.remote.remoteHosts.probe).toHaveBeenCalledWith('m')
    await cardProps.removeMachine('m')
    expect(ctx.remote.remoteHosts.removeMachine).toHaveBeenCalledWith({ id: 'm' })
    // Drive workspace creation: rename, session pin through upsertView, open.
    await cardProps.createWorkspace({ machineId: 'm', path: '/home/app', title: '  app  ' })
    expect(workspaces.rename).toHaveBeenCalledWith('ws', 'app')
    expect(sessions.create).toHaveBeenCalledWith({ workspaceId: 'ws' })
    expect(list.upsertView).toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('sess-1')
    // Sidebar footer actions share the same remote calls.
    const sidebarDef = registered.find(def => def.id === 'remote-host-add-project')
    const sidebarProps = sidebarDef?.inject?.() as {
      listMachines: () => Promise<unknown>
      upsertMachine: (input: unknown) => Promise<unknown>
      listDirectory: (input: unknown) => Promise<unknown>
      createWorkspace: (input: unknown) => Promise<unknown>
    }
    await sidebarProps.listMachines()
    expect(ctx.remote.remoteHosts.listMachines).toHaveBeenCalled()
    await sidebarProps.upsertMachine({ label: 'x', url: 'http://127.0.0.1:9' })
    expect(ctx.remote.remoteHosts.upsertMachine).toHaveBeenCalled()
    await sidebarProps.listDirectory({ machineId: 'm' })
    expect(ctx.remote.remoteHosts.listDirectory).toHaveBeenCalled()
    await sidebarProps.createWorkspace({ machineId: 'm', path: '/' })
    expect(ctx.remote.remoteHosts.createWorkspace).toHaveBeenCalled()
    await dispose()
    expect(disposed).toEqual(expect.arrayContaining(['remote', 'ui']))
  })

  it('pins sessions through upsert and skips already-pinned ones', async () => {
    const sessions = { create: vi.fn(async () => 'sess-9'), open: vi.fn() }
    const workspaces = {
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws', sessionIds: [] as string[] }] }) },
      rename: vi.fn(async () => {}),
      upsert: vi.fn(),
    }
    const h2 = harness({
      get: (name: string) => {
        if (name === 'workspaces') return workspaces
        if (name === 'sessions') return sessions
        return undefined
      },
    })
    const { ctx } = h2
    await apply(ctx as never)
    for (const entry of h2.injected) entry.render()
    const cardDef = h2.registered.find(def => def.key === 'remote-hosts')
    const cardProps = cardDef?.inject?.() as {
      createWorkspace: (input: { machineId: string; path: string; title?: string }) => Promise<void>
    }
    await cardProps.createWorkspace({ machineId: 'm', path: '/home/app' })
    expect(workspaces.upsert).toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('sess-9')
    // A session the row already pins needs no upsert.
    workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: 'ws', sessionIds: ['sess-9'] }] })
    await cardProps.createWorkspace({ machineId: 'm', path: '/home/app' })
    expect(workspaces.upsert).toHaveBeenCalledTimes(1)
  })

  it('leaves unknown workspaces alone and surfaces remote failures', async () => {
    const sessions = { create: vi.fn(async () => 'sess-1'), open: vi.fn() }
    const workspaces = {
      list: { getSnapshot: () => ({ items: [] as Array<{ workspaceId: string; sessionIds: string[] }> }) },
      rename: vi.fn(async () => {}),
      upsert: vi.fn(),
    }
    const h3 = harness({
      remote: {
        $mount: vi.fn(async () => async () => {}),
        remoteHosts: remoteHostsStub({
          createWorkspace: vi.fn(async () => ok({ workspaceId: 'ghost', title: 'ghost' })),
          probe: vi.fn(async () => fail('nope')),
        }),
      },
      get: (name: string) => {
        if (name === 'workspaces') return workspaces
        if (name === 'sessions') return sessions
        return undefined
      },
    })
    const { ctx } = h3
    await apply(ctx as never)
    for (const entry of h3.injected) entry.render()
    const cardDef = h3.registered.find(def => def.key === 'remote-hosts')
    const cardProps = cardDef?.inject?.() as {
      probe: (id: string) => Promise<void>
      createWorkspace: (input: { machineId: string; path: string; title?: string }) => Promise<void>
    }
    await expect(cardProps.probe('m')).rejects.toThrow(/nope/)
    await cardProps.createWorkspace({ machineId: 'm', path: '/home/app', title: '' })
    expect(workspaces.rename).toHaveBeenCalledWith('ghost', 'ghost')
    expect(sessions.open).toHaveBeenCalledWith('sess-1')
  })

  it('rolls back a failed UI registration without leaking the remote mount', async () => {
    const remoteDispose = vi.fn()
    const fiber = Object.assign(Promise.reject(new Error('inject failed')), {
      dispose: vi.fn(async () => {}),
    })
    fiber.catch(() => {})
    const failing = {
      remote: {
        $mount: vi.fn(async () => remoteDispose),
        remoteHosts: {},
      },
      locale: { register: vi.fn() },
      slots: { inject: vi.fn(), register: vi.fn() },
      inject: vi.fn(() => fiber),
      get: () => undefined,
    }
    await expect(apply(failing as never)).rejects.toThrow(/inject failed/)
    expect(remoteDispose).toHaveBeenCalled()
  })
})

describe('client-ui-remote-host missing services', () => {
  it('fails loud without workspaces or sessions', async () => {
    const sessions = { create: vi.fn(async () => 'sess-1'), open: vi.fn() }
    const { ctx, registered } = harness({
      get: (name: string) => {
        if (name === 'sessions') return sessions
        return undefined
      },
    })
    await apply(ctx as never)
    const slotCalls = ctx.slots.inject.mock.calls as Array<[string, () => unknown]>
    for (const [, render] of slotCalls) render()
    const cardDef = registered.find(def => def.key === 'remote-hosts')
    const cardProps = cardDef?.inject?.() as {
      createWorkspace: (input: { machineId: string; path: string; title?: string }) => Promise<void>
    }
    await expect(cardProps.createWorkspace({ machineId: 'm', path: '/' })).rejects.toThrow(/workspaces service/)
  })

  it('fails loud without sessions', async () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [] as Array<{ workspaceId: string; sessionIds: string[] }> }) },
      rename: vi.fn(async () => {}),
      upsert: vi.fn(),
    }
    const { ctx, registered } = harness({
      get: (name: string) => {
        if (name === 'workspaces') return workspaces
        return undefined
      },
    })
    await apply(ctx as never)
    const calls = ctx.slots.inject.mock.calls as Array<[string, () => unknown]>
    for (const [, render] of calls) render()
    const cardDef = registered.find(def => def.key === 'remote-hosts')
    const cardProps = cardDef?.inject?.() as {
      createWorkspace: (input: { machineId: string; path: string; title?: string }) => Promise<void>
    }
    // The remote createWorkspace mock resolves a ghost row; sessions are absent.
    await expect(cardProps.createWorkspace({ machineId: 'm', path: '/' })).rejects.toThrow(/sessions service/)
  })
})
