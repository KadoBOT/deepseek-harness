/**
 * OAuth Agent Connections, browser half: the Models-page footer card with
 * per-provider connect buttons, an inline authorization-code field, and the
 * status block. Connect rides the `connect-start` / `connect-finish` commands
 * through the mounted commands Remote, so no new RPC machinery is introduced;
 * the current session id is read at click time.
 * @module @deepseek-ai/dsh-oauth-agents/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and the
// renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Models page's SlotMap merge (settings.models.footer).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { OAuthAgentsFooter, type OAuthAgentsInjected } from './card.tsx'
import { en, zh, type OAuthAgentsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The OAuth agents footer card's copy. */
    'oauth-agents': OAuthAgentsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'oauth-agents'

/** Required services: Agent scopes, the Remote mount with the commands namespace, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'remote.commands', 'slots', 'locale']

/**
 * Client plugin body: register the `oauth-agents` dictionaries and the
 * Models-page footer card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-oauth-agents: dictionaries')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'oauth-agents',
    locale: NS,
    inject: (): OAuthAgentsInjected => ({
      start: provider => startThroughCommand(ctx, provider),
      finish: (provider, code) => finishThroughCommand(ctx, provider, code),
      status: () => statusThroughCommand(ctx),
    }),
  }, OAuthAgentsFooter))
}

/** What one `connect-start` command surfaced to the card. */
interface OAuthAgentsStartOutcome {
  /** The provider's sign-in page, when the flow reached its browser step. */
  url?: string
  /** A user code the provider page asks to be entered, when the flow issued one. */
  code?: string
  /** The failure line, when the start did not reach a browser step. */
  error?: string
}

/** Start the sign-in for one provider and return its page URL and optional user code. */
async function startThroughCommand(ctx: ClientContext, provider: string): Promise<OAuthAgentsStartOutcome> {
  const sessionId = currentSessionId(ctx)
  if (sessionId === undefined) return { error: 'no active session' }
  const result = await ctx.remote.commands.execute(sessionId, `/connect-start ${provider}`, [])
  if (!result.ok) return { error: `${result.error.message} (${result.error.code})` }
  if (result.value === undefined) return { error: `unknown command: /connect-start ${provider}` }
  const execution = result.value
  const text = execution.result.kind === 'success'
    ? (execution.result.text ?? '')
    : (execution.result.text || 'connect failed')
  if (execution.result.kind !== 'success') return { error: text }
  try {
    const parsed = JSON.parse(text) as { status?: string; url?: string; code?: string }
    if (typeof parsed.url === 'string' && parsed.url !== '') {
      return typeof parsed.code === 'string' && parsed.code !== ''
        ? { url: parsed.url, code: parsed.code }
        : { url: parsed.url }
    }
  } catch {
    // The result text was not the JSON payload; fall through to URL scraping.
  }
  const match = text.match(/https?:\/\/\S+/u)
  if (match !== null) return { url: match[0] }
  return { error: text }
}

/** Complete the started sign-in for one provider, optionally submitting a pasted code. */
async function finishThroughCommand(ctx: ClientContext, provider: string, code: string): Promise<string> {
  const sessionId = currentSessionId(ctx)
  if (sessionId === undefined) return 'no active session'
  const trimmed = code.trim()
  const line = trimmed === '' ? `/connect-finish ${provider}` : `/connect-finish ${provider} ${trimmed}`
  const result = await ctx.remote.commands.execute(sessionId, line, [])
  if (!result.ok) return `${result.error.message} (${result.error.code})`
  if (result.value === undefined) return `unknown command: ${line}`
  return result.value.result.kind === 'success'
    ? (result.value.result.text ?? 'connected')
    : (result.value.result.text || 'sign-in failed')
}

/** Run `/oauth-status` on the current session and return its text. */
async function statusThroughCommand(ctx: ClientContext): Promise<string | undefined> {
  const sessionId = currentSessionId(ctx)
  if (sessionId === undefined) return undefined
  const result = await ctx.remote.commands.execute(sessionId, '/oauth-status', [])
  if (!result.ok) return undefined
  return result.value?.result.kind === 'success' ? (result.value.result.text ?? '') : undefined
}

/** The current session id, or `undefined` while none is active. */
function currentSessionId(ctx: ClientContext): SessionId | undefined {
  return (ctx.sessions as ISessions).list.getSnapshot().current
}
