/**
 * `activeSessions` namespace dictionaries: the unified Active section header,
 * the search box, the Ungrouped bucket, the blank-session placeholder, and
 * relative-time labels. Wire error strings pass through untranslated by policy.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'browser.aria': '会话',
  'section.active': '进行中',
  'group.ungrouped': '未分组',
  'session.new': '新会话',
  'actions.newSession.aria': '在“{name}”中新建会话',
  'status.running': '进行中',
  'status.waitingApproval': '等待审批',
  'status.planReview': '计划待审',
  'status.waitingAnswer': '等待回答',
  'status.waitingInput': '等待输入',
  'status.completed': '已完成',
  'search.placeholder': '搜索会话…',
  'search.aria': '搜索会话',
  'search.results.aria': '搜索结果',
  'search.noMatches': '无匹配会话',
  'time.now': '刚刚',
  'time.minutes': '{n}分钟',
  'time.hours': '{n}小时',
  'time.days': '{n}天',
  'time.months': '{n}个月',
  'time.years': '{n}年',
  'time.ago': '{t}前',
} satisfies Record<string, string>

/** The activeSessions namespace key union. */
export type ActiveSessionsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'browser.aria': 'Sessions',
  'section.active': 'Active',
  'group.ungrouped': 'Ungrouped',
  'session.new': 'New Session',
  'actions.newSession.aria': 'New session in {name}',
  'status.running': 'Running',
  'status.waitingApproval': 'Waiting for approval',
  'status.planReview': 'Plan awaiting review',
  'status.waitingAnswer': 'Waiting for answer',
  'status.waitingInput': 'Waiting for input',
  'status.completed': 'Completed',
  'search.placeholder': 'Search sessions…',
  'search.aria': 'Search sessions',
  'search.results.aria': 'Search results',
  'search.noMatches': 'No matches',
  'time.now': 'now',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
  'time.ago': '{t} ago',
} satisfies Record<ActiveSessionsKey, string>
