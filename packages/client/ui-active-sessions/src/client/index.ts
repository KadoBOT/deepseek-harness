/**
 * Active-sessions plugin, browser half. One registration: the browsing-region
 * occupant that shadows the stock WorkspaceBrowser cell of
 * `sidebar.workspaces` (lowest priority renders), plus its locale
 * dictionaries. Export discipline: packages/client/AGENTS.md.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Session & Workspace Controller service merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the uiWorkspace service merge (ctx.uiWorkspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ActiveSessionsBrowser } from './ActiveSessionsBrowser.tsx'
import type { ActiveSessionsInjected } from './contract/slots.ts'
import { en, zh, type ActiveSessionsKey } from './locales.ts'

export type {
  ActiveSessionsBrowserProps, ActiveSessionsInjected, SessionSearchResultSet,
} from './contract/slots.ts'
export type { ActiveSessionsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The active-first sidebar region copy. */
    activeSessions: ActiveSessionsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'activeSessions'

/**
 * Required services (cordis fiber inject). The target slot is declared by the
 * ui-sidebar apply, whose activation order relative to this one is NOT
 * constrained; `slots.inject()` follows the declaration lifetime instead of
 * assuming order.
 */
export const inject = ['slots', 'sessions', 'uiWorkspace', 'locale']

/**
 * Register the active-first browser once its slot declaration is on the
 * ledger. The inject factory returns plain callbacks over this closure's
 * sessions service.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-active-sessions: dictionaries')

  const browserInjected = (): ActiveSessionsInjected => ({
    openSession: (sessionId) => { ctx.sessions.open(sessionId) },
    startSession: (workspaceId) => { ctx.uiWorkspace.startSession(workspaceId) },
    searchSessions: async (query, signal) => {
      const result = await ctx.sessions.search(query, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    searchResultLimit: ctx.sessions.searchResultLimit,
  })

  // Shadow the stock browser cell: the slot system renders a single-kind
  // cell's lowest live entry, so priority -1 wins while ui-workspace's default
  // registration (0) stays mounted underneath; disposing this entry hands the
  // seat straight back.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      priority: -1,
      inject: browserInjected,
      locale: NS,
    },
    ActiveSessionsBrowser,
  ))
}
