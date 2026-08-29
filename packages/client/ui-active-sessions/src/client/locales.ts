/**
 * `activeSessions` namespace dictionaries: the unified Active section header,
 * the search box, the Ungrouped bucket, the blank-session placeholder, and
 * relative-time labels. Wire error strings pass through untranslated by policy.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.active': '进行中',
  'group.ungrouped': '未分组',
  'session.new': '新会话',
  'actions.newSession.aria': '在“{name}”中新建会话',
  'search.placeholder': '搜索会话…',
  'search.aria': '搜索会话',
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
  'section.active': 'Active',
  'group.ungrouped': 'Ungrouped',
  'session.new': 'New Session',
  'actions.newSession.aria': 'New session in {name}',
  'search.placeholder': 'Search sessions…',
  'search.aria': 'Search sessions',
  'search.noMatches': 'No matches',
  'time.now': 'now',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
  'time.ago': '{t} ago',
} satisfies Record<ActiveSessionsKey, string>
