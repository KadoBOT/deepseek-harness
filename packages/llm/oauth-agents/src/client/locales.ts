/** `oauth-agents` namespace dictionaries for the Models-page footer card. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.title': '外部 AI 服务商 OAuth 登录',
  'card.hint': '点击"连接"：登录页面会在新标签页自动打开（若被拦截请点击链接）。完成登录后粘贴授权码（如有），点击"完成登录"。连接后，对应模型会出现在模型选择器中。',
  'status.unavailable': '状态不可用。',
  'connect.button': '连接',
  'connect.running': '连接中…',
  'connect.starting': '准备中…',
  'connect.open': '打开登录页面',
  'connect.enterCode': '在该页面输入此代码：',
  'connect.codePlaceholder': '粘贴授权码（如页面要求）',
  'connect.finish': '完成登录',
  'connect.finishing': '正在完成…',
  'connect.refresh': '刷新状态',
  'status.connected': '已连接',
  'status.notConnected': '未连接',
  'status.routeLive': '路由可用',
}

/** The oauth-agents namespace key union. */
export type OAuthAgentsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.title': 'External AI provider OAuth sign-in',
  'card.hint': 'Click Connect: the sign-in page opens in a new tab automatically (if blocked, use the link).'
    + ' After signing in, paste the authorization code (if asked) and click Finish sign-in.'
    + ' Connected models become selectable in the model picker.',
  'status.unavailable': 'Status is unavailable.',
  'connect.button': 'Connect',
  'connect.running': 'Connecting…',
  'connect.starting': 'Preparing…',
  'connect.open': 'Open sign-in page',
  'connect.enterCode': 'Enter this code on the page:',
  'connect.codePlaceholder': 'Paste the code (if asked)',
  'connect.finish': 'Finish sign-in',
  'connect.finishing': 'Finishing…',
  'connect.refresh': 'Refresh status',
  'status.connected': 'connected',
  'status.notConnected': 'not connected',
  'status.routeLive': 'route live',
} satisfies Record<OAuthAgentsKey, string>
