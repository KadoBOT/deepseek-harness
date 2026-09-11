/**
 * Browser half: mount the generated Remote namespace, then the settings card
 * and sidebar footer action for remote machines.
 */

import remoteHostsRemote from '@deepseek-ai/dsh-experimental-remote-host/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AddRemoteProject, type AddRemoteProjectInjected } from './AddRemoteProject.tsx'
import { en, NS, zh, type RemoteHostKey } from './locales.ts'
import { RemoteHostsCard } from './RemoteHostsCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    remoteHosts: RemoteHostKey
  }
}

/** Required browser services after the Remote namespace is mounted. */
export const inject = ['slots', 'locale', 'remote', 'workspaces']

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Account a Session on the client Workspace row so grouped view keeps it.
 * Host attach can lag the sidebar list, which would leave a blank session
 * in Ungrouped — those rows hide when unselected.
 * @param workspaces - client Workspace service.
 * @param workspaceId - workspace that owns the session.
 * @param sessionId - session to pin.
 */
function pinSession(
  workspaces: IWorkspaces,
  workspaceId: WorkspaceView['workspaceId'],
  sessionId: SessionId,
): void {
  const listed = workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
  if (listed === undefined || listed.sessionIds.includes(sessionId)) return
  const view: WorkspaceView = { ...listed, sessionIds: [...listed.sessionIds, sessionId] }
  if (typeof workspaces.upsert === 'function') {
    workspaces.upsert(view)
    return
  }
  const list = workspaces.list as { upsertView?: (workspace: WorkspaceView) => void }
  list.upsertView?.(view)
}

function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-remote-host: dictionaries')

  const actions = (): AddRemoteProjectInjected => ({
    listMachines: async () => unwrap(await ctx.remote.remoteHosts.listMachines()),
    upsertMachine: async input => unwrap(await ctx.remote.remoteHosts.upsertMachine(input)),
    listDirectory: async input => unwrap(await ctx.remote.remoteHosts.listDirectory(input)),
    createWorkspace: async (input) => {
      const created = unwrap(await ctx.remote.remoteHosts.createWorkspace(input))
      const workspaces = ctx.get('workspaces') as unknown as IWorkspaces | undefined
      if (workspaces === undefined) throw new Error('workspaces service is not mounted')
      // rename is a unary Workspace command that upserts the client list.
      // workspaces.create cannot be used: its schema has no machineId and
      // realpaths the Windows path on this Mac.
      const title = input.title?.trim() || created.title
      await workspaces.rename(created.workspaceId, title)
      const sessions = ctx.get('sessions') as unknown as ISessions | undefined
      if (sessions === undefined) throw new Error('sessions service is not mounted')
      const sessionId = await sessions.create({ workspaceId: created.workspaceId })
      pinSession(workspaces, created.workspaceId, sessionId)
      sessions.open(sessionId)
    },
  })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'remote-hosts',
    locale: NS,
    inject: () => ({
      ...actions(),
      probe: async (id: string) => { unwrap(await ctx.remote.remoteHosts.probe(id)) },
      removeMachine: async (id: string) => { unwrap(await ctx.remote.remoteHosts.removeMachine({ id })) },
    }),
  }, RemoteHostsCard))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'remote-host-add-project',
    locale: NS,
    inject: actions,
  }, AddRemoteProject))
}

/**
 * Mount the generated remoteHosts contribution, then register its browser UI.
 * @param ctx - client root context.
 * @returns disposer for the Remote namespace and UI registrations.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remoteHostsRemote)
  const ui = ctx.inject(['slots', 'locale', 'remote.remoteHosts', 'workspaces'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
