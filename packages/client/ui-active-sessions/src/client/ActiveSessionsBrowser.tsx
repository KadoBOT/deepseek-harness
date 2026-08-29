/**
 * The browsing-region occupant shadowing the stock WorkspaceBrowser cell:
 * one unified Active section (running, waiting on the user, or
 * finished-unseen) above collapsible workspace groups, both strictly newest
 * first. Search replaces the body with local title/workspace matches merged
 * with a debounced Host content search. All actions arrive through the inject
 * face; live data arrives through the global standard hooks.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { StateDot, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActiveSessionsBrowserProps, SessionSearchResultSet } from './contract/slots.ts'
import type { ActiveSessionsKey } from './locales.ts'
import type { RelativeTimeBucket } from './view.ts'
import { deriveSearchRows, deriveView, relativeTime, sessionStatus } from './view.ts'
import css from './Browser.module.css'

/** Pause between the latest keystroke and a Host content-search request. */
const SEARCH_DEBOUNCE_MS = 250

const EMPTY_RESULT = { items: [], hasMore: false } as const

/** Locale key per relative-time magnitude (`now` renders without an ago wrap). */
const TIME_KEY: Record<Exclude<RelativeTimeBucket['unit'], 'now'>, ActiveSessionsKey> = {
  minutes: 'time.minutes',
  hours: 'time.hours',
  days: 'time.days',
  months: 'time.months',
  years: 'time.years',
}

/**
 * Localized trailing time label.
 * @param t - namespace-bound translate seat.
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms.
 * @returns the label, or `null` before the first prompt (no timestamp yet).
 */
function timeAgo(
  t: (key: ActiveSessionsKey, params?: Record<string, string | number>) => string,
  updatedAt: number,
  now: number,
): string | null {
  const bucket = relativeTime(updatedAt, now)
  if (bucket.unit === 'now') return t('time.now')
  return t('time.ago', { t: t(TIME_KEY[bucket.unit], { n: bucket.n }) })
}

/**
 * Render the active-first browsing region.
 * @param props - composed slot props (runtime share + inject face + locale).
 * @returns the region element tree.
 */
export function ActiveSessionsBrowser(props: ActiveSessionsBrowserProps) {
  const list = props.useSessions(state => state)
  const workspaces = props.useWorkspaces(state => state)
  const pendingInteractions = props.useSessionPendingInteraction(state => state)
  const [query, setQuery] = useState('')
  const [content, setContent] = useState<SessionSearchResultSet>(EMPTY_RESULT)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setContent(EMPTY_RESULT)
      return undefined
    }
    let alive = true
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      props.searchSessions(trimmed, controller.signal)
        .then((result) => {
          if (alive) setContent(result)
        })
        .catch(() => {
          // Superseded or failed searches keep the previous page visible.
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
      controller.abort()
    }
    // searchSessions identity rides the entry-level inject cache; the effect
    // keys on the query alone by design.
  }, [query])

  const view = deriveView(list, workspaces, pendingInteractions)
  const currentId = list.current
  const searching = query.trim() !== ''

  const openSession = (sessionId: string): void => {
    props.openSession(sessionId as never)
  }

  const renderRow = (
    summary: { id: string; displayTitle: string; blank: boolean; updatedAt: number },
    status: 'warning' | 'ongoing' | 'done' | null,
    selected: boolean,
    workspaceLabel: string | undefined,
    showTime: boolean,
    onClick: () => void,
    snippet?: string,
  ) => {
    const title = <span className={css.title}>{summary.blank ? props.t('session.new') : summary.displayTitle}</span>
    return (
      <button
        key={summary.id}
        type='button'
        className={clsx(css.row, snippet === undefined ? null : css.hit, selected && css.rowSelected)}
        aria-current={selected ? 'true' : undefined}
        onClick={onClick}
      >
        <span className={css.slot}>
          {status === null ? null : <StateDot state={status} />}
        </span>
        {snippet === undefined ? (
          <>
            {title}
            {workspaceLabel === undefined ? null : <span className={css.meta}>{workspaceLabel}</span>}
            {!showTime || summary.blank ? null : (
              <span className={css.time}>{timeAgo(props.t, summary.updatedAt, Date.now())}</span>
            )}
          </>
        ) : (
          <span className={css.hitBody}>
            <span className={css.hitTop}>
              {title}
              {/* Snippet rows come only from search hits, which always carry
                  a visible title and a known update time. */}
              <span className={css.time}>{timeAgo(props.t, summary.updatedAt, Date.now())}</span>
            </span>
            <span className={css.snippet}>{snippet}</span>
          </span>
        )}
      </button>
    )
  }

  if (!props.wide) {
    return (
      <div className={css.rail}>
        <button
          type='button'
          className={css.railBtn}
          title={props.t('search.aria')}
          aria-label={props.t('search.aria')}
          onClick={() => { props.expandSidebar() }}
        >
          <svg width={16} height={16} viewBox='0 0 16 16' fill='none' aria-hidden='true'>
            <circle cx='7' cy='7' r='4.5' stroke='currentColor' strokeWidth='1.4' />
            <path d='M10.5 10.5L14 14' stroke='currentColor' strokeWidth='1.4' strokeLinecap='round' />
          </svg>
        </button>
        {view.active.length === 0 ? null : (
          <span className={css.railCount}>
            <StateDot state={view.active.some(row => row.summary.completed) ? 'done' : 'ongoing'} />
            {view.active.length}
          </span>
        )}
      </div>
    )
  }

  let body
  if (searching) {
    const rows = deriveSearchRows(list, workspaces, query, content, props.searchResultLimit)
    body = rows.length === 0
      ? <div className={css.empty}>{props.t('search.noMatches')}</div>
      : rows.map(row => renderRow(
        row.summary,
        sessionStatus(row.summary, pendingInteractions),
        row.summary.id === currentId,
        row.workspaceLabel,
        true,
        () => {
          openSession(row.summary.id)
          setQuery('')
        },
        row.snippet,
      ))
  } else {
    const parts = []
    if (view.active.length > 0) {
      parts.push(
        <div key='active-header' className={css.sectionLabel}>
          {props.t('section.active')}
          <StateDot state={view.active.some(row => pendingInteractions.has(row.summary.id)) ? 'warning' : 'ongoing'} />
          {view.active.length}
        </div>,
      )
      for (const row of view.active) {
        parts.push(renderRow(
          row.summary,
          sessionStatus(row.summary, pendingInteractions),
          row.summary.id === currentId,
          row.workspaceLabel,
          false,
          () => { openSession(row.summary.id) },
        ))
      }
    }
    for (const group of view.groups) {
      const collapsed = collapsedGroups.has(group.key)
      parts.push(
        <div key={`g-${group.key}`} className={css.group}>
          <div className={css.groupHead}>
            <button
              type='button'
              className={clsx(css.row, css.groupExpand)}
              aria-expanded={collapsed ? 'false' : 'true'}
              onClick={() => {
                setCollapsedGroups((previous) => {
                  const next = new Set(previous)
                  if (next.has(group.key)) next.delete(group.key)
                  else next.add(group.key)
                  return next
                })
              }}
            >
              <span className={clsx(css.chevron, collapsed && css.chevronCollapsed)} aria-hidden='true'>
                <svg width={10} height={10} viewBox='0 0 10 10' fill='none'>
                  <path d='M2 3.5L5 6.5L8 3.5' stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' strokeLinejoin='round' />
                </svg>
              </span>
              <span className={css.groupTitle}>
                {group.key === '' ? props.t('group.ungrouped') : group.label}
              </span>
            </button>
            <span className={css.groupCount}>{group.rows.length}</span>
            {/* The Ungrouped bucket has no Workspace to target, so it keeps
                its plain count under hover instead of a dead plus. */}
            {group.key === '' ? null : (
              <button
                type='button'
                className={css.groupAdd}
                aria-label={props.t('actions.newSession.aria', { name: group.label })}
                onClick={() => {
                  setCollapsedGroups((previous) => {
                    if (!previous.has(group.key)) return previous
                    const next = new Set(previous)
                    next.delete(group.key)
                    return next
                  })
                  props.startSession(group.key as never)
                }}
              >
                <IconPlusOutline16 />
              </button>
            )}
          </div>
          {collapsed ? null : group.rows.map(row => renderRow(
            row.summary,
            sessionStatus(row.summary, pendingInteractions),
            row.summary.id === currentId,
            undefined,
            true,
            () => { openSession(row.summary.id) },
          ))}
        </div>,
      )
    }
    body = parts
  }

  return (
    <div className={css.browser}>
      <div className={css.searchWrap}>
        <input
          className={css.input}
          value={query}
          placeholder={props.t('search.placeholder')}
          aria-label={props.t('search.aria')}
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      <div className={css.scroll}>{body}</div>
    </div>
  )
}
