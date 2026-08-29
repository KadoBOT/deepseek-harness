import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { ActiveSessionsBrowser } from '../src/client/ActiveSessionsBrowser.tsx'
import type { ActiveSessionsInjected, SessionSearchResultSet } from '../src/client/contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sid = (id: string): SessionId => id as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const open = vi.fn()
  const startSession = vi.fn()
  const search = vi.fn(async (): Promise<
    { ok: true; value: SessionSearchResultSet } | { ok: false; error: { code: string; message: string } }
  > => ({
    ok: true,
    value: { items: [{ sessionId: sid('session'), snippet: 'match' }], hasMore: false },
  }))
  ctx.provide('sessions', { open, search, searchResultLimit: 20 } as never)
  ctx.provide('uiWorkspace', { startSession } as never)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, open, startSession, search, sid }
}

/** Declare the browsing-region hole with a single root registration. */
function declareHole(slots: SlotRegistry): void {
  slots.register({ name: 'root', children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } } as never, () => null)
}

describe('ui-active-sessions apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'sessions', 'uiWorkspace', 'locale'])
  })

  it('shadows the declared cell at priority -1 with its own dictionaries', async () => {
    const b = await bench()
    declareHole(b.slots)
    // A stock-like occupant at the default priority stays mounted underneath.
    b.slots.register({ name: 'sidebar.workspaces' }, () => null)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = [...b.slots.entries('sidebar.workspaces')]
    expect(entries).toHaveLength(2)
    const mine = entries.find(entry => entry.component === ActiveSessionsBrowser)
    expect(mine).toBeDefined()
    expect(mine!.options.priority).toBe(-1)
    expect(mine!.locale).toBe('activeSessions')
    // The cell's lowest live entry renders: this package's browser, not stock.
    const winners = entries.toSorted((a, z) => (a.options.priority ?? 0) - (z.options.priority ?? 0))
    expect(winners[0]!.component).toBe(ActiveSessionsBrowser)
    expect(b.locale.bind('activeSessions')('section.active')).toBe('进行中')
  })

  it('wires the inject face to the provided sessions service', async () => {
    const b = await bench()
    declareHole(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = [...b.slots.entries('sidebar.workspaces')]
      .find(candidate => candidate.options.priority === -1)!
    const face = (entry.inject as unknown as () => ActiveSessionsInjected)()
    face.openSession('target' as never)
    expect(b.open).toHaveBeenCalledWith('target')
    face.startSession('proj' as never)
    expect(b.startSession).toHaveBeenCalledWith('proj')
    await expect(face.searchSessions('needle', new AbortController().signal)).resolves.toEqual({
      items: [{ sessionId: 'session', snippet: 'match' }],
      hasMore: false,
    })
  })

  it('surfaces wire errors through the injected search callback', async () => {
    const b = await bench()
    b.search.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'index unavailable' } })
    declareHole(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = [...b.slots.entries('sidebar.workspaces')]
      .find(candidate => candidate.options.priority === -1)!
    const face = (entry.inject as unknown as () => ActiveSessionsInjected)()
    await expect(face.searchSessions('needle', new AbortController().signal)).rejects.toThrow('index unavailable')
  })

  it('unregisters its entry on teardown and leaves foreign occupants mounted', async () => {
    const b = await bench()
    declareHole(b.slots)
    b.slots.register({ name: 'sidebar.workspaces' }, () => null)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    const entries = [...b.slots.entries('sidebar.workspaces')]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).not.toBe(ActiveSessionsBrowser)
  })
})
