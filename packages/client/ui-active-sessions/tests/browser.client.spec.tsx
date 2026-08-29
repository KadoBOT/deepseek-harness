// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ActiveSessionsBrowser } from '../src/client/ActiveSessionsBrowser.tsx'
import { zh } from '../src/client/locales.ts'
import type { ActiveSessionsBrowserProps } from '../src/client/contract/slots.ts'
import css from '../src/client/Browser.module.css'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as never

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** Fixture overrides exclude `id` so literals never face the branded slot. */
function summary(overrides: Partial<Omit<SessionSummary, 'id'>> & { id: string }): SessionSummary {
  const { id, ...rest } = overrides
  return {
    displayTitle: id, running: false, blank: false,
    updatedAt: Date.now() - 5 * 60_000,
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

function workspaces(items: { id: string; sessionIds: string[] }[]): WorkspaceSnapshot {
  return {
    items: items.map(item => ({
      workspaceId: wid(item.id), path: `/projects/${item.id}`, title: item.id,
      sessionIds: item.sessionIds.map(sid), createdAt: '0', updatedAt: '0',
    })),
    archivedSessionIds: [], phase: 'ready', state: 'idle', error: null,
  }
}

/** Framework-faithful stub: the renderer calls hooks with a selector. */
function bind<T>(snapshot: T): (selector: (value: T) => unknown) => unknown {
  return selector => selector(snapshot)
}

function browserProps(overrides: Record<string, unknown> = {}): ActiveSessionsBrowserProps {
  return {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: bind(FIXTURE_LIST),
    useWorkspaces: bind(FIXTURE_WORKSPACES),
    useSessionPendingInteraction: bind(new Map<SessionId, SessionPendingInteractionBase>()),
    openSession: vi.fn(),
    searchSessions: async () => ({ items: [], hasMore: false }),
    searchResultLimit: 20,
    t,
    ...overrides,
  } as unknown as ActiveSessionsBrowserProps
}

const FIXTURE_LIST = list([
  summary({ id: 'done', displayTitle: 'Finished report', completed: true, updatedAt: Date.now() - 3_600_000 }),
  summary({ id: 'run', displayTitle: 'Running build', running: true }),
], 'run')
const FIXTURE_WORKSPACES = workspaces([{ id: 'proj', sessionIds: ['done', 'run'] }])

function rowFor(title: string): HTMLButtonElement {
  return screen.getByText(title).closest('button') as HTMLButtonElement
}

async function settleSearch(ms = 300): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('ActiveSessionsBrowser', () => {
  it('renders the unified Active section above the workspace groups, newest first', () => {
    const { container } = render(<ActiveSessionsBrowser {...browserProps()} />)
    const header = container.querySelector(`.${css.sectionLabel}`)
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('进行中')
    const titles = [...container.querySelectorAll(`.${css.title}`)].map(el => el.textContent)
    // Newest first inside the Active section...
    expect(titles.indexOf('Running build')).toBeLessThan(titles.indexOf('Finished report'))
    // ...and active rows are never duplicated under their workspace group.
    expect(titles.filter(text => text === 'Running build')).toHaveLength(1)
    expect(container.querySelector(`.${css.groupTitle}`)).not.toBeNull()
  })

  it('marks the current row and opens the clicked session', () => {
    const props = browserProps()
    render(<ActiveSessionsBrowser {...props} />)
    expect(rowFor('Running build').getAttribute('aria-current')).toBe('true')
    fireEvent.click(rowFor('Finished report'))
    expect(props.openSession).toHaveBeenCalledWith('done')
  })

  it('renders the status dot per row state', () => {
    const { container } = render(<ActiveSessionsBrowser {...browserProps()} />)
    expect(container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(container.querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('renders the localized placeholder for the provisional blank session', () => {
    render(<ActiveSessionsBrowser {...browserProps({
      useSessions: bind(list([summary({ id: 'draft', blank: true })], 'draft')),
      useWorkspaces: bind(workspaces([])),
    })} />)
    expect(screen.getByText('新会话')).not.toBeNull()
  })

  it('turns the section header amber while a session waits on the user', () => {
    const { container } = render(<ActiveSessionsBrowser {...browserProps({
      useSessions: bind(list([
        summary({
          id: 'wait', displayTitle: 'Needs answer',
          updatedAt: Date.now() - 60_000,
        }),
      ])),
      useWorkspaces: bind(workspaces([])),
      useSessionPendingInteraction: bind(new Map([[
        sid('wait'),
        { key: 'q:1', kind: 'question', sessionId: sid('wait') },
      ]])),
    })} />)
    expect(container.querySelector(`.${css.sectionLabel}`)!.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(rowFor('Needs answer').querySelector('[data-state="warning"]')).not.toBeNull()
  })
  it('collapses a group when its header is toggled', () => {
    const props = browserProps({
      useSessions: bind(list([
        summary({ id: 'done', displayTitle: 'Finished report', completed: true }),
        summary({ id: 'idle', displayTitle: 'Idle note', updatedAt: Date.now() - 7_200_000 }),
        summary({ id: 'fresh', displayTitle: 'Fresh note', updatedAt: Date.now() - 5_000 }),
      ], 'idle')),
      useWorkspaces: bind(workspaces([{ id: 'proj', sessionIds: ['done', 'idle', 'fresh'] }])),
    })
    const { container } = render(<ActiveSessionsBrowser {...props} />)
    const head = container.querySelector(`.${css.groupHead}`)!.querySelector('button')!
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Idle note')).toBeNull()
    fireEvent.click(head)
    expect(screen.getByText('Idle note')).not.toBeNull()
    // A just-touched row renders the localized "now" label.
    expect(rowFor('Fresh note').textContent).toContain('刚刚')
    // Group member rows open their session too.
    fireEvent.click(rowFor('Idle note'))
    expect(props.openSession).toHaveBeenCalledWith('idle')
  })

  it('swaps the workspace group count for a New Session plus under hover', () => {
    const startSession = vi.fn()
    const { container } = render(<ActiveSessionsBrowser {...browserProps({
      startSession,
      useSessions: bind(list([
        summary({ id: 'done', displayTitle: 'Finished report', completed: true }),
        summary({ id: 'idle', displayTitle: 'Idle note', updatedAt: Date.now() - 7_200_000 }),
        summary({ id: 'older', displayTitle: 'Older note', updatedAt: Date.now() - 8_200_000 }),
      ], 'idle')),
      useWorkspaces: bind(workspaces([{ id: 'proj', sessionIds: ['done', 'idle', 'older'] }])),
    })} />)
    const head = container.querySelector(`.${css.groupHead}`)!
    // The count renders for the two rows hoisted nowhere else; the plus is
    // present and hover-revealed by CSS, so behavior is the visible contract.
    expect(head.querySelector(`.${css.groupCount}`)!.textContent).toBe('2')
    fireEvent.click(screen.getByLabelText('在“proj”中新建会话'))
    expect(startSession).toHaveBeenCalledWith('proj')
  })

  it('expands a collapsed group and targets its workspace when the plus is used', () => {
    const startSession = vi.fn()
    const props = browserProps({
      startSession,
      useSessions: bind(list([
        summary({ id: 'idle', displayTitle: 'Idle note', updatedAt: Date.now() - 7_200_000 }),
        summary({ id: 'older', displayTitle: 'Older note', updatedAt: Date.now() - 8_200_000 }),
      ], 'idle')),
      useWorkspaces: bind(workspaces([{ id: 'proj', sessionIds: ['idle', 'older'] }])),
    })
    const { container } = render(<ActiveSessionsBrowser {...props} />)
    const head = container.querySelector(`.${css.groupHead}`)!
    fireEvent.click(head.querySelector('button')!)
    expect(screen.queryByText('Idle note')).toBeNull()
    fireEvent.click(screen.getByLabelText('在“proj”中新建会话'))
    expect(startSession).toHaveBeenCalledWith('proj')
    // Creating in the group reveals it again so the new row is visible.
    expect(screen.getByText('Idle note')).not.toBeNull()
  })

  it('keeps the Ungrouped count under hover with no plus', () => {
    const startSession = vi.fn()
    const { container } = render(<ActiveSessionsBrowser {...browserProps({
      startSession,
      useSessions: bind(list([
        summary({ id: 'stray', displayTitle: 'Stray note', updatedAt: Date.now() - 7_200_000 }),
      ])),
      useWorkspaces: bind(workspaces([])),
    })} />)
    const heads = container.querySelectorAll(`.${css.groupHead}`)
    expect(heads).toHaveLength(1)
    expect(heads[0]!.querySelector(`.${css.groupCount}`)!.textContent).toBe('1')
    expect(heads[0]!.querySelector(`.${css.groupAdd}`)).toBeNull()
  })

  it('debounces the host request and merges local matches with content snippets', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => ({
        items: [{ sessionId: sid('remote'), snippet: 'deep needle match' }],
        hasMore: false,
      }))
      const props = browserProps({
        searchSessions,
        useSessions: bind(list([
          summary({ id: 'local', displayTitle: 'Local needle', updatedAt: Date.now() - 120_000 }),
          summary({ id: 'remote', displayTitle: 'Remote hit' }),
        ])),
        useWorkspaces: bind(workspaces([])),
      })
      render(<ActiveSessionsBrowser {...props} />)
      fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'needle' } })
      await settleSearch(249)
      expect(searchSessions).not.toHaveBeenCalled()
      await settleSearch(2)
      expect(searchSessions).toHaveBeenCalledWith('needle', expect.any(AbortSignal))
      // Local match first, then the content-only hit with its snippet.
      const titles = [...document.querySelectorAll(`.${css.title}`)].map(el => el.textContent)
      expect(titles.indexOf('Local needle')).toBeLessThan(titles.indexOf('Remote hit'))
      expect(screen.getByText('deep needle match')).not.toBeNull()

      fireEvent.click(screen.getByText('Local needle'))
      expect(props.openSession).toHaveBeenCalledWith('local')
      const input = document.querySelector<HTMLInputElement>('input')
      expect(input?.value).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the previous page visible when the host search fails', async () => {
    vi.useFakeTimers()
    try {
      const props = browserProps({
        searchSessions: async () => { throw new Error('index unavailable') },
        useSessions: bind(list([summary({ id: 'kept', displayTitle: 'Kept needle' })])),
        useWorkspaces: bind(workspaces([])),
      })
      render(<ActiveSessionsBrowser {...props} />)
      fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'needle' } })
      await settleSearch(300)
      expect(screen.getByText('Kept needle')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a stale response that lands after its query was replaced', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst: (value: { items: { sessionId: SessionId; snippet: string }[]; hasMore: boolean }) => void = () => {}
      const searchSessions = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
        .mockResolvedValue({ items: [{ sessionId: sid('second'), snippet: 'fresh page' }], hasMore: false })
      const props = browserProps({
        searchSessions,
        useSessions: bind(list([])),
        useWorkspaces: bind(workspaces([])),
      })
      render(<ActiveSessionsBrowser {...props} />)
      fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'first' } })
      await settleSearch(260)
      // Replace the query before the first response lands; the cleanup marks
      // that request dead, so its late resolution must not paint.
      fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'second' } })
      resolveFirst({ items: [{ sessionId: sid('stale'), snippet: 'stale page' }], hasMore: false })
      await settleSearch(1)
      expect(screen.queryByText('Stale ghost')).toBeNull()
      await settleSearch(300)
      expect(searchSessions).toHaveBeenLastCalledWith('second', expect.any(AbortSignal))
      expect(screen.queryByText('Stale ghost')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the no-match copy when nothing matches', async () => {
    vi.useFakeTimers()
    try {
      render(<ActiveSessionsBrowser {...browserProps()} />)
      fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'zzz' } })
      await settleSearch(300)
      expect(screen.getByText('无匹配会话')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the collapsed rail with an expand affordance and active badge', () => {
    const expandSidebar = vi.fn()
    const { container } = render(<ActiveSessionsBrowser {...browserProps({ wide: false, expandSidebar })} />)
    expect(container.querySelector('input')).toBeNull()
    fireEvent.click(screen.getByLabelText('搜索会话'))
    expect(expandSidebar).toHaveBeenCalledOnce()
    expect(container.querySelector(`.${css.railCount}`)!.textContent).toContain('2')
  })

  it('renders the collapsed rail without a badge when nothing is active', () => {
    const { container } = render(<ActiveSessionsBrowser {...browserProps({
      wide: false,
      useSessions: bind(list([])),
      useWorkspaces: bind(workspaces([])),
    })} />)
    expect(container.querySelector(`.${css.railCount}`)).toBeNull()
  })

  it('shows the ongoing rail badge while only running sessions are active', () => {
    const { container } = render(<ActiveSessionsBrowser {...browserProps({
      wide: false,
      useSessions: bind(list([summary({ id: 'run', displayTitle: 'Only running', running: true })])),
      useWorkspaces: bind(workspaces([])),
    })} />)
    const badge = container.querySelector(`.${css.railCount}`)
    expect(badge).not.toBeNull()
    expect(badge!.querySelector('[data-state="ongoing"]')).not.toBeNull()
  })
})
