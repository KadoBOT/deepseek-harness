/**
 * ui-active-sessions contracts. One registration: `ActiveSessionsBrowser`
 * shadows the stock WorkspaceBrowser cell of the sidebar shell's
 * `sidebar.workspaces` hole (registration `priority: -1`, lowest renders). No
 * child slots are declared — the shadowed entry keeps its directory-flow
 * declaration while it stays mounted underneath.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merge into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Payload of the Host content-search call behind `searchSessions`. */
export interface SessionSearchResultSet {
  items: readonly SessionSearchResultItem[]
  hasMore: boolean
}

/**
 * The registration's inject face: plain callbacks over the apply closure's
 * sessions service. Components never see ctx.
 */
export interface ActiveSessionsInjected {
  /** Open a listed session as the current one. */
  openSession: (sessionId: SessionId) => void
  /**
   * The shared New Session action scoped to one Workspace: connect its blank
   * session and open it, which also selects the Workspace. Workspace groups
   * only; the Ungrouped bucket has no Workspace to target.
   */
  startSession: (workspaceId: WorkspaceId) => void
  /** Ranked current-conversation content matches for a non-blank query. */
  searchSessions: (query: string, signal: AbortSignal) => Promise<SessionSearchResultSet>
  /** Wire bound for capping the merged search list. */
  searchResultLimit: number
}

/** Composed props of the browsing-region occupant. */
export type ActiveSessionsBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & Omit<ActiveSessionsInjected, 'hooks'>
  & PropsLocale<'activeSessions'>
