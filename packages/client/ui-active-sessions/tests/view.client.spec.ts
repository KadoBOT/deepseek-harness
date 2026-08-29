import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  basenameLabel, byRecencyDesc, deriveSearchRows, deriveView, isActiveSummary,
  isVisibleSummary, relativeTime, sessionStatus, type SessionPendingInteractions,
} from '../src/client/view.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** Fixture overrides exclude `id` so literals never face the branded slot. */
function summary(overrides: Partial<Omit<SessionSummary, 'id'>> & { id: string }): SessionSummary {
  const { id, ...rest } = overrides
  return {
    displayTitle: id, running: false, blank: false, updatedAt: 0,
    ...rest,
    id: sid(id),
  }
}

function list(items: SessionSummary[], current?: string): SessionListState {
  return {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: current === undefined ? undefined : sid(current),
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  } as never
}

function workspaces(
  items: { id: string; title?: string; sessionIds: string[] }[],
  archived: string[] = [],
): WorkspaceSnapshot {
  return {
    items: items.map(item => ({
      workspaceId: wid(item.id), path: `/projects/${item.id}`, title: item.title ?? item.id,
      sessionIds: item.sessionIds.map(sid), createdAt: '0', updatedAt: '0',
    })),
    archivedSessionIds: archived.map(sid),
    phase: 'ready',
    state: 'idle',
    error: null,
  }
}

const pending = (id: string): SessionPendingInteractions =>
  new Map([[sid(id), { key: `${id}:1`, kind: 'question', sessionId: sid(id) }]])

describe('relativeTime', () => {
  it('buckets elapsed time with the shipped boundaries', () => {
    const now = 10 * 86_400_000
    expect(relativeTime(now - 30_000, now)).toEqual({ unit: 'now', n: 0 })
    expect(relativeTime(now - 5 * 60_000, now)).toEqual({ unit: 'minutes', n: 5 })
    expect(relativeTime(now - 3 * 3_600_000, now)).toEqual({ unit: 'hours', n: 3 })
    expect(relativeTime(now - 2 * 86_400_000, now)).toEqual({ unit: 'days', n: 2 })
    expect(relativeTime(now - 60 * 86_400_000, now)).toEqual({ unit: 'months', n: 2 })
    expect(relativeTime(now - 400 * 86_400_000, now)).toEqual({ unit: 'years', n: 1 })
  })

  it('clamps future timestamps to now', () => {
    expect(relativeTime(5_000, 1_000)).toEqual({ unit: 'now', n: 0 })
  })
})

describe('basenameLabel', () => {
  it('returns the basename across separators and trims trailing slashes', () => {
    expect(basenameLabel('/home/u/project/')).toBe('project')
    expect(basenameLabel('C:\\home\\u\\project')).toBe('project')
    expect(basenameLabel('/')).toBe('/')
    expect(basenameLabel(undefined)).toBeUndefined()
    expect(basenameLabel('')).toBeUndefined()
  })
})

describe('byRecencyDesc', () => {
  it('orders newest first with a stable id tie-break', () => {
    const older = summary({ id: 'b', updatedAt: 1 })
    const newer = summary({ id: 'a', updatedAt: 2 })
    const tiedA = summary({ id: 'a', updatedAt: 2 })
    expect(byRecencyDesc(newer, older)).toBeLessThan(0)
    expect(byRecencyDesc(tiedA, newer)).toBe(0)
    // Equal recency falls through to the identity comparison both ways.
    const left = summary({ id: 'x', updatedAt: 5 })
    const right = summary({ id: 'y', updatedAt: 5 })
    expect(byRecencyDesc(left, right)).toBeLessThan(0)
    expect(byRecencyDesc(right, left)).toBeGreaterThan(0)
  })
})

describe('isActiveSummary', () => {
  it('covers running, blocked-on-user, and finished-unseen sessions', () => {
    expect(isActiveSummary(summary({ id: 'r', running: true }))).toBe(true)
    expect(isActiveSummary(summary({ id: 'c', completed: true }))).toBe(true)
    expect(isActiveSummary(summary({ id: 'p' }), pending('p'))).toBe(true)
    expect(isActiveSummary(summary({ id: 'i' }))).toBe(false)
  })
})

describe('isVisibleSummary', () => {
  const archived = new Set([sid('archived')])

  it('hides subagent-origin rows and archived rows', () => {
    expect(isVisibleSummary(summary({ id: 's', origin: 'subagent' }), undefined, archived)).toBe(false)
    expect(isVisibleSummary(summary({ id: 'archived' }), undefined, archived)).toBe(false)
  })

  it('keeps blanks only while they are current', () => {
    const blank = summary({ id: 'blank', blank: true })
    expect(isVisibleSummary(blank, undefined, archived)).toBe(false)
    expect(isVisibleSummary(blank, sid('blank'), archived)).toBe(true)
  })
})

describe('sessionStatus', () => {
  it('ranks pending interaction over running over completion', () => {
    expect(sessionStatus(summary({ id: 'p', running: true }), pending('p'))).toBe('warning')
    expect(sessionStatus(summary({ id: 'r', running: true, completed: true }))).toBe('ongoing')
    expect(sessionStatus(summary({ id: 'c', completed: true }))).toBe('done')
    expect(sessionStatus(summary({ id: 'i' }))).toBeNull()
  })
})

describe('deriveView', () => {
  it('hoists active rows into one recency-ordered section with workspace labels', () => {
    const view = deriveView(
      list([
        summary({ id: 'done-old', completed: true, updatedAt: 100 }),
        summary({ id: 'running-new', running: true, updatedAt: 300 }),
        summary({ id: 'waiting', updatedAt: 200 }),
      ]),
      workspaces([{ id: 'ws', sessionIds: ['done-old', 'running-new', 'waiting'] }]),
      pending('waiting'),
    )
    expect(view.active.map(row => row.summary.id)).toEqual(['running-new', 'waiting', 'done-old'])
    expect(view.active.every(row => row.workspaceLabel === 'ws')).toBe(true)
    // Active rows are never duplicated below.
    expect(view.groups.flatMap(group => group.rows.map(row => row.summary.id)))
      .not.toContain('running-new')
  })

  it('sorts group members by last activity, not account order', () => {
    const view = deriveView(
      list([
        summary({ id: 'fresh', updatedAt: 500 }),
        summary({ id: 'old-14h', updatedAt: 100 }),
        summary({ id: 'old-15h', updatedAt: 50 }),
      ]),
      // Account order puts the fresh session last; recency must win.
      workspaces([{ id: 'ws', sessionIds: ['old-14h', 'old-15h', 'fresh'] }]),
    )
    expect(view.groups[0]!.rows.map(row => row.summary.id)).toEqual(['fresh', 'old-14h', 'old-15h'])
  })

  it('falls back to the cwd basename for unaccounted labels and buckets strays under Ungrouped', () => {
    const view = deriveView(
      list([summary({ id: 'stray', cwd: '/home/u/branch', updatedAt: 5 })]),
      workspaces([]),
    )
    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]!.key).toBe('')
    expect(view.groups[0]!.rows[0]!.workspaceLabel).toBe('branch')
  })

  it('keeps the first workspace title when accounts overlap and hides invisible strays', () => {
    const view = deriveView(
      list([
        summary({ id: 'shared', updatedAt: 9 }),
        summary({ id: 'archived-stray', running: true }),
        summary({ id: 'sub-stray', origin: 'subagent' }),
      ]),
      workspaces(
        [
          { id: 'first-ws', sessionIds: ['shared'] },
          { id: 'second-ws', sessionIds: ['shared'] },
        ],
        ['archived-stray'],
      ),
    )
    // Both groups list the shared row, but its label comes from the first.
    expect(view.groups.map(group => group.key)).toEqual(['first-ws', 'second-ws'])
    expect(view.groups.every(group => group.rows[0]!.workspaceLabel === 'first-ws')).toBe(true)
    expect(view.active).toHaveLength(0)
    expect(view.groups.at(-1)!.key).not.toBe('')
  })

  it('keeps a current blank in its group and hides empty groups without it', () => {
    const view = deriveView(
      list([summary({ id: 'blank', blank: true })], 'blank'),
      workspaces([
        { id: 'empty-ws', sessionIds: [] },
        { id: 'holder', sessionIds: ['blank'] },
      ]),
    )
    expect(view.groups.map(group => group.key)).toEqual(['holder'])
    expect(view.groups[0]!.rows.map(row => row.summary.id)).toEqual(['blank'])
  })

  it('drops archived rows everywhere', () => {
    const view = deriveView(
      list([
        summary({ id: 'archived-active', running: true }),
        summary({ id: 'kept', updatedAt: 9 }),
      ]),
      workspaces([{ id: 'ws', sessionIds: ['archived-active', 'kept'] }], ['archived-active']),
    )
    expect(view.active).toHaveLength(0)
    expect(view.groups[0]!.rows.map(row => row.summary.id)).toEqual(['kept'])
  })
})

describe('deriveSearchRows', () => {
  const content = (items: { sessionId: string; snippet: string }[]) => ({
    items: items.map(item => ({ ...item, sessionId: sid(item.sessionId) })),
    hasMore: false,
  })

  it('merges local matches first with snippets folded into matching rows', () => {
    const rows = deriveSearchRows(
      list([
        summary({ id: 'alpha', displayTitle: 'Alpha plan', updatedAt: 200 }),
        summary({ id: 'beta', displayTitle: 'Beta build', cwd: '/w/alpha', updatedAt: 100 }),
        summary({ id: 'plain', displayTitle: 'Plain doc', updatedAt: 50 }),
      ]),
      workspaces([]),
      'alpha',
      content([
        { sessionId: 'beta', snippet: 'beta snippet' },
        // A content hit on an already locally matched row folds its snippet in;
        // a content-only hit carries the wire-required snippet through.
        { sessionId: 'alpha', snippet: 'alpha snippet' },
        { sessionId: 'plain', snippet: 'plain snippet' },
      ]),
      20,
    )
    expect(rows.map(row => row.summary.id)).toEqual(['alpha', 'beta', 'plain'])
    expect(rows.map(row => row.snippet)).toEqual(['alpha snippet', 'beta snippet', 'plain snippet'])
  })

  it('skips ids whose summaries have not arrived yet', () => {
    const sessions = list([summary({ id: 'kept', updatedAt: 9 })])
    sessions.ids = [...sessions.ids, 'ghost' as never]
    const view = deriveView(sessions, workspaces([{ id: 'ws', sessionIds: ['kept'] }]))
    expect(view.groups[0]!.rows.map(row => row.summary.id)).toEqual(['kept'])
  })

  it('appends content-only rows and caps the merged list at the limit', () => {
    const rows = deriveSearchRows(
      list([summary({ id: 'local', displayTitle: 'Local hit', updatedAt: 1 })]),
      workspaces([]),
      'needle',
      content([{ sessionId: 'remote', snippet: 'deep match' }, { sessionId: 'local', snippet: 'dup' }]),
      1,
    )
    expect(rows.map(row => row.summary.id)).toEqual(['local'])
    expect(rows[0]!.snippet).toBe('dup')
  })

  it('excludes blank, subagent-origin, and archived sessions from either segment', () => {
    const rows = deriveSearchRows(
      list([
        summary({ id: 'blank-hit', blank: true, displayTitle: 'alpha blank' }),
        summary({ id: 'sub-hit', origin: 'subagent', displayTitle: 'alpha sub' }),
        summary({ id: 'visible', displayTitle: 'alpha visible' }),
      ]),
      workspaces([], []),
      'alpha',
      content([{ sessionId: 'sub-hit', snippet: 'sub snippet' }]),
      20,
    )
    expect(rows.map(row => row.summary.id)).toEqual(['visible'])
  })

  it('returns no rows for a blank query', () => {
    expect(deriveSearchRows(list([]), workspaces([]), '   ', content([]), 20)).toEqual([])
  })
})
