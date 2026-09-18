/**
 * OAuth Agent Connections, node half: registers the Gemini Code Assist
 * authorization flow and LLM adapter, the connect and status model tools, and
 * the `/connect` command. ChatGPT and Grok ride the `llm-pi-ai` adapter's own
 * authorization flows; this plugin only drives their attempts. The browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 * @module @deepseek-ai/dsh-oauth-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: resolves the service declarations this plugin consumes.
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import { Http } from './http.ts'
import { GeminiAdapter } from './gemini-adapter.ts'
import * as googleCallback from './google-callback.ts'
import * as googleOAuth from './google-oauth.ts'
import { GEMINI_KEY, GEMINI_PROVIDER, PROVIDERS } from './providers.ts'
import { connectProvider, collectStatus, startCardConnect, finishCardConnect, cancelCardConnect } from './connect.ts'

/** Stable plugin name the Loader registers the node half under. */
export const name = 'oauth-agents'

/**
 * Required services: the authorization registry this plugin's and pi-ai's
 * flows register into, the LLM runtime, the credential store, the subprocess
 * provider behind the Google HTTP client, the user-question ask surface, the
 * command registry, the timer service behind the prompt waits, and the tools
 * registry.
 */
export const inject = [
  'authorization', 'llm', 'credentials', 'subprocess', 'userQuestions', 'commands', 'timer', 'tools',
]

/**
 * Register the Gemini flow and adapter, the connect/status tools, and the
 * `/connect` command.
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  const http = new Http(ctx.subprocess)

  ctx.effect(() => ctx.authorization.registerFlow({
    key: GEMINI_KEY,
    label: 'Gemini (Google account)',
    methods: [{ id: 'oauth', label: 'Sign in with Google' }],
    run: async (session) => {
      const challenge = googleOAuth.authChallenge()
      // The callback receiver rides the attempt's lifetime: bound before the
      // auth URL goes out, closed in the finally no matter how the flow ends.
      const callback = await googleCallback.startGoogleCallbackServer()
      const redirectUri = `http://127.0.0.1:${callback.port}/oauth2callback`
      const url = googleOAuth.authUrl(challenge, redirectUri)
      session.notify({ message: 'Continue in your browser to sign in with Google.', url })
      try {
        const code = await Promise.race([
          callback.waitForAuthorizationCode(challenge.state),
          session.prompt({
            kind: 'text',
            message: 'Sign-in page:\n\n' + url
              + '\n\nAfter you choose an account, the sign-in completes on its own.'
              + ' If the browser cannot reach the redirect (for example this page runs on'
              + ' another machine), paste the code from the address bar here.',
            placeholder: 'authorization code',
          }),
        ])
        const tokens = await googleOAuth.exchangeCode(http, googleOAuth.codeFromCallbackInput(code), challenge, redirectUri)
        const email = await googleOAuth.userEmail(http, tokens.access_token)
        await ctx.credentials.modifyRecord(GEMINI_KEY, () => Promise.resolve({
          kind: 'grant',
          payload: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
            ...(email === undefined ? {} : { email }),
            provider: GEMINI_PROVIDER,
          },
        }))
        session.notify({ message: email === undefined ? 'Gemini connected.' : `Gemini connected for ${email}.` })
      } finally {
        callback.close()
      }
    },
  }), 'oauth-agents:gemini-flow')

  ctx.effect(() => ctx.llm.registerAdapter([GEMINI_PROVIDER], new GeminiAdapter(ctx, http)),
    'oauth-agents:gemini-adapter')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'oauth_agent_connect',
    description: 'Connect an external AI provider account through OAuth. Providers: chatgpt (ChatGPT/Codex sign-in),'
      + ' grok (xAI device sign-in), gemini (Google account sign-in). On success the provider models become usable'
      + ' as harness model routes.',
    parameters: {
      provider: {
        type: 'string',
        required: true,
        enum: ['chatgpt', 'grok', 'gemini'],
        description: 'Which provider to connect.',
      },
      setAsDefault: {
        type: 'boolean',
        description: 'Also select this provider as the default model for the session.',
      },
      model: {
        type: 'string',
        description: 'Model id to select when setAsDefault is true; defaults to the provider recommended model.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          connected: { type: 'boolean', required: true },
          provider: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (args, value) => [connectRenderLine(args, value)],
    },
    execute: (args, exec) => connectProvider(
      ctx, ctx.authorization, args.provider, args, exec.agent, exec.signal,
    ),
  })), 'oauth-agents:connect-tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'oauth_agent_status',
    description: 'Report the OAuth connection status of ChatGPT/Codex, Grok (xAI) and Gemini, and which of their'
      + ' model routes are live.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          providers: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: ((value as { providers?: { label: string; connected: boolean; routeLive?: boolean }[] }).providers ?? [])
          .map(row => `${row.label}: ${row.connected ? 'connected' : 'not connected'}${row.routeLive === true ? ' (route live)' : ''}`)
          .join('\n'),
      }],
    },
    execute: () => collectStatus(ctx),
  })), 'oauth-agents:status-tool')

  ctx.effect(() => ctx.commands.register({
    name: 'connect',
    description: 'Connect an AI provider via OAuth: /connect chatgpt, grok, or gemini',
    handler: invocation => runConnectCommand(ctx, invocation),
  }), 'oauth-agents:connect-command')

  ctx.effect(() => ctx.commands.register({
    name: 'oauth-status',
    description: 'Show the OAuth connection status of chatgpt, grok, and gemini',
    handler: () => runStatusCommand(ctx),
  }), 'oauth-agents:status-command')

  ctx.effect(() => ctx.commands.register({
    name: 'connect-start',
    description: 'Start an OAuth sign-in and return the page to open: /connect-start chatgpt, grok, or gemini',
    handler: invocation => runConnectStartCommand(ctx, invocation),
  }), 'oauth-agents:connect-start-command')

  ctx.effect(() => ctx.commands.register({
    name: 'connect-finish',
    description: 'Complete a started OAuth sign-in: /connect-finish <provider> [authorization-code]',
    handler: invocation => runConnectFinishCommand(ctx, invocation),
  }), 'oauth-agents:connect-finish-command')

  ctx.effect(() => ctx.commands.register({
    name: 'connect-cancel',
    description: 'Cancel a started OAuth sign-in: /connect-cancel chatgpt, grok, or gemini',
    handler: invocation => runConnectCancelCommand(ctx, invocation),
  }), 'oauth-agents:connect-cancel-command')
}

/** Execute one `/oauth-status` invocation. */
async function runStatusCommand(ctx: Context): Promise<CommandResult> {
  const status = await collectStatus(ctx)
  const lines = status.providers.map(row => `${row.label}: ${row.connected ? 'connected' : 'not connected'}`
    + (row.routeLive ? ' (route live)' : ''))
  return { kind: 'success', text: lines.join('\n') }
}

/** Render one connect tool result as one line. */
function connectRenderLine(args: { provider?: string }, value: unknown): { type: 'text'; text: string } {
  const outcome = (value ?? {}) as { connected?: boolean; detail?: string }
  const state = outcome.connected === true ? 'connected' : 'not connected'
  return {
    type: 'text',
    text: `Connect ${String(args.provider ?? '')}: ${state}`
      + (typeof outcome.detail === 'string' ? ` - ${outcome.detail}` : ''),
  }
}

/** Execute one `/connect <provider>` invocation. */
async function runConnectCommand(ctx: Context, invocation: {
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}): Promise<CommandResult> {
  const provider = invocation.rawInput.trim().toLowerCase()
  if (provider === '') {
    return { kind: 'error', text: 'Name a provider: /connect chatgpt, grok, or gemini' }
  }
  try {
    const result = await connectProvider(ctx, ctx.authorization, provider, {}, invocation.agent, invocation.signal)
    return result.connected
      ? {
        kind: 'success',
        text: `${PROVIDERS[result.provider as keyof typeof PROVIDERS]?.label ?? result.provider} connected. ${result.detail}`,
      }
      : { kind: 'error', text: result.detail }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Execute one `/connect-start <provider>` invocation: begin the flow, hold it, return the sign-in URL. */
async function runConnectStartCommand(ctx: Context, invocation: {
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}): Promise<CommandResult> {
  const provider = invocation.rawInput.trim().toLowerCase()
  if (provider === '') {
    return { kind: 'error', text: 'Name a provider: /connect-start chatgpt, grok, or gemini' }
  }
  try {
    const started = await startCardConnect(
      ctx, ctx.authorization, provider, invocation.signal,
    )
    const payload = {
      status: 'waiting',
      url: started.url,
      ...(started.code === undefined ? {} : { code: started.code }),
    }
    return { kind: 'success', text: JSON.stringify(payload) }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Execute one `/connect-finish <provider> [code]` invocation: submit the pasted code, await the attempt. */
async function runConnectFinishCommand(ctx: Context, invocation: {
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}): Promise<CommandResult> {
  const parts = invocation.rawInput.trim().split(/\s+/u)
  const provider = (parts[0] ?? '').toLowerCase()
  const code = parts.slice(1).join(' ')
  if (provider === '') {
    return { kind: 'error', text: 'Name a provider: /connect-finish chatgpt, grok, or gemini [authorization-code]' }
  }
  try {
    const result = await finishCardConnect(ctx, provider, code || undefined)
    return result.connected
      ? {
        kind: 'success',
        text: `${PROVIDERS[result.provider as keyof typeof PROVIDERS]?.label ?? result.provider} connected. ${result.detail}`,
      }
      : { kind: 'error', text: result.detail }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Execute one `/connect-cancel <provider>` invocation. */
async function runConnectCancelCommand(ctx: Context, invocation: {
  readonly agent: Agent
  readonly rawInput: string
}): Promise<CommandResult> {
  const provider = invocation.rawInput.trim().toLowerCase()
  if (provider === '') {
    return { kind: 'error', text: 'Name a provider: /connect-cancel chatgpt, grok, or gemini' }
  }
  await cancelCardConnect(ctx.authorization, provider)
  return { kind: 'success', text: 'cancelled' }
}
