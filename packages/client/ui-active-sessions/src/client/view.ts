/**
 * Pure derivation of the active-first browsing region from the global session
 * and workspace list snapshots. Every section orders strictly by last
 * activity, newest first — the stock browser's manual account order is
 * deliberately not honored. Active rows (running, blocked on the user, or
 * finished-unseen) are hoisted into one unified section and never duplicated
 * below; visibility mirrors the shipped rules: no subagent-origin rows, no
 * archived rows, blank sessions only while current.
 */
import type {
  SessionListState, SessionSearchResultItem, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Map of active pending interactions keyed by SessionId. */
export type SessionPendingInteractions = ReadonlyMap<SessionId, SessionPendingInteractionBase>

/** Primary status for a row's leading dot; `null` renders no dot. */
export type SessionActivityState = 'warning' | 'ongoing' | 'done'

/** One renderable row: the summary plus its workspace display label. */
export interface VisibleRow {
  summary: SessionSummary
  /** Owning workspace title, else the cwd basename; `undefined` when neither exists. */
  workspaceLabel: string | undefined
}

/** One collapsible workspace section (or the Ungrouped bucket). */
export interface WorkspaceGroupSection {
  /** Workspace id, or `''` for the Ungrouped bucket. */
  key: string
  label: string
  rows: readonly VisibleRow[]
}

/** The complete region body derived in one pass. */
export interface DerivedView {
  active: readonly VisibleRow[]
  groups: readonly WorkspaceGroupSection[]
}

/** One merged search result row. */
export interface SearchResultRow {
  summary: SessionSummary
  workspaceLabel: string | undefined
  snippet?: string
}

/** Relative-time bucket consumed by the `time.*` locale keys. */
export interface RelativeTimeBucket {
  unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  n: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Directory display label: the basename of the path (both separators accepted).
 * @param path - host-side directory path.
 * @returns the basename, or `undefined` for a blank path.
 */
export function basenameLabel(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  const trimmed = path.replace(/[/\\]+$/, '')
  const base = trimmed.split(/[/\\]/).pop()
  return base === undefined || base === '' ? path : base
}

/**
 * Time bucket for a row's trailing cell.
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the localized-label bucket.
 */
export function relativeTime(updatedAt: number, now: number): RelativeTimeBucket {
  const diff = Math.max(0, now - updatedAt)
  if (diff < MINUTE_MS) return { unit: 'now', n: 0 }
  if (diff < HOUR_MS) return { unit: 'minutes', n: Math.floor(diff / MINUTE_MS) }
  if (diff < DAY_MS) return { unit: 'hours', n: Math.floor(diff / HOUR_MS) }
  if (diff < 30 * DAY_MS) return { unit: 'days', n: Math.floor(diff / DAY_MS) }
  if (diff < 365 * DAY_MS) return { unit: 'months', n: Math.floor(diff / (30 * DAY_MS)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY_MS)) }
}

/** Newest first with stable session identity as the tie-break. */
export function byRecencyDesc(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  if (a.id < b.id) return -1
  return a.id > b.id ? 1 : 0
}

/**
 * Whether the session belongs in the unified Active section: live activity,
 * an interaction awaiting this user, or a completion reminder not yet cleared.
 */
export function isActiveSummary(
  summary: SessionSummary,
  pendingInteractions?: SessionPendingInteractions,
): boolean {
  return summary.running
    || summary.completed === true
    || (pendingInteractions !== undefined && pendingInteractions.has(summary.id))
}

/**
 * Shipped visibility rule: subagent-origin rows surface only through their
 * parent's catalog, archived rows hide everywhere, and blank sessions stay
 * hidden unless they are the provisional current one.
 */
export function isVisibleSummary(
  summary: SessionSummary,
  currentId: SessionId | undefined,
  archivedSessionIds: ReadonlySet<SessionId>,
): boolean {
  return summary.origin !== 'subagent'
    && !archivedSessionIds.has(summary.id)
    && (!summary.blank || summary.id === currentId)
}

/**
 * Primary row status; pending user interaction outranks running, which
 * outranks the unviewed-completion reminder.
 * @param summary - the listed session summary.
 * @param pendingInteractions - current pending interactions map.
 * @returns the dot state, or `null` when the row shows no dot.
 */
export function sessionStatus(
  summary: SessionSummary,
  pendingInteractions?: SessionPendingInteractions,
): SessionActivityState | null {
  if (pendingInteractions !== undefined && pendingInteractions.has(summary.id)) return 'warning'
  if (summary.running) return 'ongoing'
  if (summary.completed === true) return 'done'
  return null
}

function workspaceTitleIndex(workspaces: WorkspaceSnapshot): Map<SessionId, string> {
  const titles = new Map<SessionId, string>()
  for (const workspace of workspaces.items) {
    for (const id of workspace.sessionIds) {
      if (!titles.has(id)) titles.set(id, workspace.title)
    }
  }
  return titles
}

function toRow(
  summary: SessionSummary,
  titles: Map<SessionId, string>,
): VisibleRow {
  return {
    summary,
    workspaceLabel: titles.get(summary.id) ?? basenameLabel(summary.cwd),
  }
}

/**
 * Derive the full region body: the unified Active section plus one section per
 * workspace account (and Ungrouped for strays). Groups whose remaining rows
 * are empty stay hidden unless they hold the current session, so hoisting
 * cannot leave a visibly empty group behind.
 * @param sessions - the global session list snapshot.
 * @param workspaces - the global workspace list snapshot (order + archive set).
 * @returns active rows and group sections, each newest first.
 */
export function deriveView(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
  pendingInteractions?: SessionPendingInteractions,
): DerivedView {
  const currentId = sessions.current
  const byId = sessions.byId
  const archived = new Set(workspaces.archivedSessionIds)
  const titles = workspaceTitleIndex(workspaces)

  const active: VisibleRow[] = []
  const activeIds = new Set<SessionId>()
  for (const id of sessions.ids) {
    const summary = byId[id]
    if (summary === undefined || activeIds.has(id)) continue
    if (!isVisibleSummary(summary, currentId, archived) || !isActiveSummary(summary, pendingInteractions)) continue
    activeIds.add(id)
    active.push(toRow(summary, titles))
  }
  active.sort((a, b) => byRecencyDesc(a.summary, b.summary))

  const accounted = new Set<SessionId>()
  for (const workspace of workspaces.items) {
    for (const id of workspace.sessionIds) accounted.add(id)
  }

  const groups: WorkspaceGroupSection[] = []
  for (const workspace of workspaces.items) {
    const rows: VisibleRow[] = []
    for (const id of workspace.sessionIds) {
      const summary = byId[id]
      if (summary === undefined || activeIds.has(id)) continue
      if (!isVisibleSummary(summary, currentId, archived)) continue
      rows.push(toRow(summary, titles))
    }
    const containsCurrent = currentId !== undefined && workspace.sessionIds.includes(currentId)
    if (rows.length === 0 && !containsCurrent) continue
    rows.sort((a, b) => byRecencyDesc(a.summary, b.summary))
    groups.push({ key: workspace.workspaceId, label: workspace.title, rows })
  }

  const strays: VisibleRow[] = []
  for (const id of sessions.ids) {
    const summary = byId[id]
    if (summary === undefined || accounted.has(id) || activeIds.has(id)) continue
    if (!isVisibleSummary(summary, currentId, archived)) continue
    strays.push(toRow(summary, titles))
  }
  strays.sort((a, b) => byRecencyDesc(a.summary, b.summary))
  if (strays.length > 0) groups.push({ key: '', label: '', rows: strays })

  return { active, groups }
}

/**
 * Merge local title/workspace matches with Host content hits. Local matches
 * come first in recency order, then content-only rows in wire order; snippets
 * fold into matching local rows; every class of invisible row stays excluded,
 * and the merged list is capped at the caller's bound.
 * @param sessions - the global session list snapshot.
 * @param workspaces - the global workspace list snapshot (labels + archive set).
 * @param query - the raw input query; blank yields no rows.
 * @param content - the Host content-search page for the same query.
 * @param limit - maximum number of returned rows.
 * @returns merged rows, newest first within the local segment.
 */
export function deriveSearchRows(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
  query: string,
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const byId = sessions.byId
  const archived = new Set(workspaces.archivedSessionIds)
  const titles = workspaceTitleIndex(workspaces)

  const rows: SearchResultRow[] = []
  const seen = new Set<SessionId>()
  for (const id of sessions.ids) {
    const summary = byId[id]
    if (summary === undefined || summary.blank) continue
    if (!isVisibleSummary(summary, sessions.current, archived)) continue
    const title = summary.displayTitle.toLowerCase()
    const label = (titles.get(summary.id) ?? basenameLabel(summary.cwd) ?? '').toLowerCase()
    if (!title.includes(needle) && !label.includes(needle)) continue
    seen.add(id)
    rows.push({ summary, workspaceLabel: titles.get(id) ?? basenameLabel(summary.cwd) })
  }
  rows.sort((a, b) => byRecencyDesc(a.summary, b.summary))

  for (const item of content.items) {
    const existing = seen.has(item.sessionId)
      ? rows.find(row => row.summary.id === item.sessionId)
      : undefined
    if (existing !== undefined) {
      existing.snippet = item.snippet
      continue
    }
    const summary = byId[item.sessionId]
    if (summary === undefined || summary.blank) continue
    if (!isVisibleSummary(summary, sessions.current, archived)) continue
    rows.push({
      summary,
      workspaceLabel: titles.get(item.sessionId) ?? basenameLabel(summary.cwd),
      snippet: item.snippet,
    })
  }
  return rows.slice(0, limit)
}
