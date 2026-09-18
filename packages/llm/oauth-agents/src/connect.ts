/**
 * The connect surface shared by the model tool and the Models-page command:
 * bridges the authorization seam's interaction vocabulary onto the user
 * questions surface, runs one attempt per provider, and converges the route
 * and default-model state after a successful grant.
 * @module @deepseek-ai/dsh-oauth-agents/connect
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the timer service's Context merge (ctx.timeout).
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { AuthorizationInteraction, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { requestError } from './http.ts'
import { PROVIDERS, PROVIDER_IDS, type ProviderEntry } from './providers.ts'

/** One notice held by the bridge until the ask surface can present it. */
interface HeldNotice {
  readonly message: string
  readonly url?: string
  readonly code?: string
}

/** The interaction half of one running attempt, bridged to user questions. */
export interface InteractionBridge {
  /** The authorization interaction supplied to `begin()`. */
  readonly interaction: AuthorizationInteraction
  /**
   * Wait up to `timeoutMs` for the flow's first notice.
   * @returns the first notice, or `undefined` when none arrived in time.
   */
  waitForNotice(timeoutMs: number): Promise<HeldNotice | undefined>
}

/** One pending card-driven attempt: a flow running in the background with its sign-in state exposed. */
interface PendingAttempt {
  /** The sign-in URL once published by the flow. */
  url?: string
  /** Optional user code the flow asks to be entered on the provider page. */
  code?: string
  /** Resolves the flow's code prompt with a value submitted from the card. */
  resolveCode?: (value: string) => void
  /** The running authorization attempt; awaited by `/connect-finish`. */
  readonly beginPromise: Promise<{ status: 'authorized' | 'cancelled' }>
  /** Monotonic start time, used to expire abandoned attempts. */
  readonly startedAt: number
}

/** All pending card-driven attempts, keyed by `${sessionId}|${provider}`. */
const PENDING = new Map<string, PendingAttempt>()

/** Drop pending attempts older than 30 minutes; abandoned flows expire quietly. */
function expirePending(): void {
  const now = Date.now()
  for (const [key, attempt] of PENDING) {
    if (now - attempt.startedAt > 1800000) PENDING.delete(key)
  }
}

/**
 * Bridge one attempt's interaction onto the ask-user surface: notices queue
 * until observed, and prompts render as one question with a cancel option.
 * @param ctx - host context carrying the user-questions service.
 * @param agent - the agent the questions attribute to, when known.
 * @param signal - cancellation for the whole attempt.
 * @returns the bridge carrying the interaction and the notice wait.
 */
export function makeBridge(ctx: Context, agent: Agent | undefined, signal: AbortSignal | undefined): InteractionBridge {
  const notices: HeldNotice[] = []
  let wake: (() => void) | null = null
  const interaction: AuthorizationInteraction = {
    notify(notice): void {
      const held: HeldNotice = {
        message: notice.message,
        ...(notice.url === undefined ? {} : { url: notice.url }),
        ...(notice.code === undefined ? {} : { code: notice.code }),
      }
      notices.push(held)
      if (wake !== null) {
        const release = wake
        wake = null
        release()
      }
    },
    async prompt(prompt): Promise<string> {
      if (prompt.kind === 'select') {
        // The seam's contract: a select answer carries the option's id, so the
        // rendered labels map back to the ids they were rendered from.
        const idByLabel = new Map(prompt.options.map(option => [option.label, option.id]))
        const question: AskUserQuestionItem = {
          id: 'oauth-agents-prompt',
          header: 'Authorization',
          question: prompt.message,
          options: prompt.options.map(option => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }
        const answer = await ctx.userQuestions.ask({
          questions: [question],
          ...(agent === undefined ? {} : { agent }),
          ...(signal === undefined ? {} : { signal }),
        })
        const item = answer.answers[0]
        const chosen = item?.custom ?? (item?.selected[0] ?? '')
        const id = idByLabel.get(chosen)
        if (id === undefined) throw requestError('the authorization prompt was declined', 'DECLINED')
        return id
      }
      const question: AskUserQuestionItem = {
        id: 'oauth-agents-prompt',
        header: 'Authorization',
        question: prompt.message,
        options: [{ label: 'Cancel sign-in' }],
        detail: 'Choose Other to type your answer.',
      }
      const answer = await ctx.userQuestions.ask({
        questions: [question],
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })
      const item = answer.answers[0]
      const value = item?.custom ?? (item?.selected[0] ?? '')
      if (value === '' || value === 'Cancel sign-in') {
        throw requestError('the authorization prompt was declined', 'DECLINED')
      }
      return value
    },
  }
  return {
    interaction,
    waitForNotice(timeoutMs: number): Promise<HeldNotice | undefined> {
      if (notices.length > 0) return Promise.resolve(notices[0])
      return Promise.race<HeldNotice | undefined>([
        new Promise<HeldNotice | undefined>((resolve) => {
          wake = () => resolve(notices[0])
        }),
        ctx.timeout(timeoutMs).then(() => undefined as HeldNotice | undefined),
      ])
    },
  }
}

/**
 * Bridge one attempt onto the card surface: notices expose the sign-in URL to
 * the card, and prompts wait for the code submitted from the card instead of
 * rendering a question in the session.
 * @param ctx - host context carrying the timer service.
 * @param pending - the pending attempt whose prompt the card resolves.
 * @returns the bridge carrying the interaction and the notice wait.
 */
function makeCardBridge(ctx: Context, pending: { resolveCode?: ((value: string) => void) | undefined }): InteractionBridge {
  const notices: HeldNotice[] = []
  let wake: (() => void) | null = null
  const interaction: AuthorizationInteraction = {
    notify(notice): void {
      const held: HeldNotice = {
        message: notice.message,
        ...(notice.url === undefined ? {} : { url: notice.url }),
        ...(notice.code === undefined ? {} : { code: notice.code }),
      }
      notices.push(held)
      if (wake !== null) {
        const release = wake
        wake = null
        release()
      }
    },
    async prompt(prompt): Promise<string> {
      if (prompt.kind === 'select') {
        // The card renders no choice surface; pi-ai orders its preferred login
        // method first ("(default)"), so the card answers with that option id.
        const first = prompt.options[0]
        if (first === undefined) throw requestError('the flow offered no choices', 'INVALID_INPUT')
        return first.id
      }
      const code = await new Promise<string>((resolve, reject) => {
        pending.resolveCode = resolve
        // A withdrawn prompt must settle instead of hanging to the timer.
        prompt.signal?.addEventListener('abort', () => {
          reject(requestError('the authorization prompt was withdrawn', 'DECLINED'))
        }, { once: true })
        ctx.timeout(600000).then(() => {
          reject(requestError('timed out waiting for the code; start the sign-in again', 'TIMEOUT'))
        })
      })
      const trimmed = code.trim()
      if (trimmed === '') throw requestError('the authorization prompt was declined', 'DECLINED')
      return trimmed
    },
  }
  return {
    interaction,
    waitForNotice(timeoutMs: number): Promise<HeldNotice | undefined> {
      if (notices.length > 0) return Promise.resolve(notices[0])
      return Promise.race<HeldNotice | undefined>([
        new Promise<HeldNotice | undefined>((resolve) => {
          wake = () => resolve(notices[0])
        }),
        ctx.timeout(timeoutMs).then(() => undefined as HeldNotice | undefined),
      ])
    },
  }
}

/** Resolve one pending attempt's wait key. One attempt per provider: the
 * authorization registry itself holds a single flow per key, so the attempt
 * cannot outlive that constraint, and keying by session would strand the
 * attempt whenever the page's current session changes between Connect and
 * Finish. */
function pendingKey(provider: string): string {
  return provider
}

/** The pending attempt for one provider, if any. */
export function pendingFor(provider: string): PendingAttempt | undefined {
  return PENDING.get(pendingKey(provider))
}

/** Route-convergence detail appended to the connect result. Type alias so the
 * tool output's JSON value contract accepts it without an index signature. */
export type ConnectOutcome = {
  /** Whether the provider is now authorized. */
  readonly connected: boolean
  /** The provider id. */
  readonly provider: string
  /** Human-readable result summary; `''` when the attempt converged nothing. */
  readonly detail: string
}

/** Owner-visible shape of one status row (type alias: JSON tool output). */
export type ProviderStatusRow = {
  readonly id: string
  readonly label: string
  readonly route: string
  readonly connected: boolean
  readonly routeLive: boolean
}

/**
 * After a successful grant: add the provider's settings profile when it rides
 * a settings-driven route family, preserving every unrelated profile.
 * @param ctx - host context carrying the optional settings service.
 * @param entry - the connected provider's catalog entry.
 * @returns a one-line convergence summary.
 */
export async function ensureRouteProfile(ctx: Context, entry: ProviderEntry): Promise<string> {
  if (entry.settingsNs === undefined || entry.settingsProfile === undefined) return 'own route'
  const settings = ctx.get('settings')
  if (settings === undefined) return 'settings service unavailable'
  const section = settings.get(entry.settingsNs)
  const existing = (section !== undefined && section !== null
    && typeof section === 'object' && typeof (section as { providers?: unknown }).providers === 'object')
    ? (section as { providers: Record<string, unknown> }).providers
    : {}
  if (existing[entry.settingsProfile] !== undefined) return 'route already configured'
  await settings.update(entry.settingsNs, { providers: { [entry.settingsProfile]: {} } })
  return 'route added'
}

/**
 * When the caller asked for it: save the provider's route and model as the
 * session default-model selection.
 * @param ctx - host context carrying the optional default-model service.
 * @param entry - the connected provider's catalog entry.
 * @param args - the connect call's arguments.
 * @returns a summary line, or `undefined` when not requested.
 */
export async function maybeSetDefault(
  ctx: Context,
  entry: ProviderEntry,
  args: { setAsDefault?: boolean; model?: string } | undefined,
): Promise<string | undefined> {
  if (args?.setAsDefault !== true) return undefined
  const selection = ctx.get('agentDefaultModel')
  if (selection === undefined) return 'default-model service unavailable'
  const model = args.model ?? entry.defaultModel
  await selection.saveSelection({ provider: entry.route, model })
  return `default model set to ${entry.route} / ${model}`
}

/**
 * Run one authorization attempt for a provider id, then converge routes and
 * the optional default selection.
 * @param ctx - host context carrying user questions, settings, and the default model.
 * @param authorization - the realm's authorization registry.
 * @param provider - one of the catalog's provider ids.
 * @param args - the connect call's arguments.
 * @param agent - the agent the prompts attribute to.
 * @param signal - cancellation for the whole attempt.
 * @returns the connect outcome.
 */
export async function connectProvider(
  ctx: Context,
  authorization: AuthorizationService,
  provider: string,
  args: { setAsDefault?: boolean; model?: string } | undefined,
  agent: Agent | undefined,
  signal: AbortSignal | undefined,
): Promise<ConnectOutcome> {
  const entry = PROVIDERS[provider as keyof typeof PROVIDERS]
  if (entry === undefined) {
    throw requestError(`unknown provider: ${String(provider)}. Use one of: chatgpt, grok, gemini.`, 'INVALID_INPUT')
  }
  const flowEntry = authorization.list().find(candidate => candidate.key === entry.key)
  if (flowEntry === undefined) {
    throw requestError(
      `no authorization flow is registered for key ${entry.key}.`
      + ' chatgpt and grok need the llm-pi-ai adapter mounted; gemini is provided by this plugin.',
      'NO_FLOW',
    )
  }
  const bridge = makeBridge(ctx, agent, signal)
  const beginPromise = authorization.begin({
    key: entry.key,
    interaction: bridge.interaction,
    ...(signal === undefined ? {} : { signal }),
  })
  let outcome: { status: 'authorized' | 'cancelled' }
  if (entry.own) {
    outcome = await beginPromise
  } else {
    const notice = await bridge.waitForNotice(30000)
    if (notice !== undefined && notice.url !== undefined) {
      let message = `Open this page to finish signing in:\n\n${notice.url}`
      if (notice.code !== undefined) message += `\n\nEnter this code there: ${notice.code}`
      message += '\n\nChoose Done once you have completed the sign-in in your browser.'
      const answer = await ctx.userQuestions.ask({
        questions: [{
          id: 'oauth-agents-wait',
          header: 'Sign in',
          question: message,
          options: [{ label: 'Done' }, { label: 'Cancel' }],
        }],
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })
      const picked = answer.answers[0]?.custom ?? (answer.answers[0]?.selected[0] ?? '')
      if (picked === 'Cancel') {
        authorization.cancel(entry.key)
        return { connected: false, provider, detail: 'cancelled by user' }
      }
    }
    outcome = await Promise.race([
      beginPromise,
      ctx.timeout(240000).then(() => {
        throw requestError('timed out waiting for the sign-in to complete; check connection status later', 'TIMEOUT')
      }),
    ])
  }
  if (outcome.status !== 'authorized') {
    return { connected: false, provider, detail: 'authorization cancelled' }
  }
  let routeDetail: string
  try {
    routeDetail = await ensureRouteProfile(ctx, entry)
  } catch (error) {
    routeDetail = `connected, but the route could not be configured: ${describe(error)}`
  }
  let defaultDetail: string | undefined
  try {
    defaultDetail = await maybeSetDefault(ctx, entry, args)
  } catch (error) {
    defaultDetail = `default model could not be set: ${describe(error)}`
  }
  return {
    connected: true,
    provider,
    detail: routeDetail + (defaultDetail === undefined ? '' : `; ${defaultDetail}`),
  }
}

/** Describe any thrown value as one readable line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Collect the connection status of every provider in the catalog.
 * @param ctx - host context carrying the LLM and credential services.
 * @returns one row per provider plus the live LLM route ids.
 */
export async function collectStatus(ctx: Context): Promise<{
  providers: ProviderStatusRow[]
  liveProviders: string[]
}> {
  let liveIds: string[] = []
  try {
    liveIds = ctx.llm.listProviders().map(provider => provider.id)
  } catch {
    liveIds = []
  }
  const providers: ProviderStatusRow[] = []
  for (const id of PROVIDER_IDS) {
    const entry = PROVIDERS[id]
    let configured = false
    try {
      configured = (await ctx.credentials.describeRecord(entry.key)).configured
    } catch {
      configured = false
    }
    providers.push({
      id,
      label: entry.label,
      route: entry.route,
      connected: configured,
      routeLive: liveIds.includes(entry.route),
    })
  }
  return { providers, liveProviders: liveIds }
}
/**
 * Start one card-driven authorization attempt: begin the flow with a
 * card-facing bridge and wait for the sign-in URL. The attempt keeps running;
 * `/connect-finish` later awaits it and submits the code pasted in the card.
 * @param ctx - host context carrying the timer service.
 * @param authorization - the realm's authorization registry.
 * @param sessionId - the session the card drives the attempt from.
 * @param provider - one of the catalog's provider ids.
 * @param signal - cancellation for the whole attempt.
 * @returns the sign-in URL and the optional user code for the provider page.
 */
export async function startCardConnect(
  ctx: Context,
  authorization: AuthorizationService,
  provider: string,
  signal: AbortSignal | undefined,
): Promise<{ url: string; code?: string }> {
  const entry = PROVIDERS[provider as keyof typeof PROVIDERS]
  if (entry === undefined) {
    throw requestError(`unknown provider: ${String(provider)}. Use one of: chatgpt, grok, gemini.`, 'INVALID_INPUT')
  }
  const flowEntry = authorization.list().find(candidate => candidate.key === entry.key)
  if (flowEntry === undefined) {
    throw requestError(
      `no authorization flow is registered for key ${entry.key}.`
      + ' chatgpt and grok need the llm-pi-ai adapter mounted; gemini is provided by this plugin.',
      'NO_FLOW',
    )
  }
  expirePending()
  const key = pendingKey(provider)
  const existing = PENDING.get(key)
  if (existing !== undefined) {
    // A kept attempt keeps serving the URL it was opened with, which may have
    // been generated by older flow code; this click cancels it and starts one
    // from the current build instead.
    PENDING.delete(key)
    authorization.cancel(entry.key)
    existing.resolveCode?.('')
  }
  const pending = {
    url: undefined as string | undefined,
    code: undefined as string | undefined,
    resolveCode: undefined as ((value: string) => void) | undefined,
    beginPromise: undefined as unknown as Promise<{ status: 'authorized' | 'cancelled' }>,
    startedAt: Date.now(),
  }
  const bridge = makeCardBridge(ctx, pending)
  const beginPromise = authorization.begin({
    key: entry.key,
    interaction: bridge.interaction,
    ...(signal === undefined ? {} : { signal }),
  })
  // The attempt's rejection surfaces when /connect-finish awaits it; this catch
  // only prevents an unhandled rejection while the user completes sign-in.
  beginPromise.catch(() => {})
  pending.beginPromise = beginPromise
  PENDING.set(key, pending as PendingAttempt)
  // Converge the provider's route profile the moment the flow authorizes, so
  // the route goes live even if the page's session changed and Finish never
  // lands on this attempt.
  beginPromise.then((outcome) => {
    if (outcome.status === 'authorized') void ensureRouteProfile(ctx, entry).catch(() => {})
  }, () => {})
  const notice = await bridge.waitForNotice(45000)
  if (notice === undefined || notice.url === undefined) {
    PENDING.delete(key)
    authorization.cancel(entry.key)
    throw requestError('the sign-in page link did not arrive in time; try again', 'TIMEOUT')
  }
  pending.url = notice.url
  if (notice.code !== undefined) pending.code = notice.code
  return notice.code === undefined ? { url: notice.url } : { url: notice.url, code: notice.code }
}

/**
 * Complete one card-driven attempt: submit the pasted code into the flow's
 * pending prompt, await the running attempt, and converge the provider route.
 * @param ctx - host context carrying the timer, settings, and LLM services.
 * @param sessionId - the session the card drives the attempt from.
 * @param provider - one of the catalog's provider ids.
 * @param pasted - the code pasted in the card, or `undefined` when none.
 * @returns the connect outcome.
 */
export async function finishCardConnect(
  ctx: Context,
  provider: string,
  pasted: string | undefined,
): Promise<ConnectOutcome> {
  const entry = PROVIDERS[provider as keyof typeof PROVIDERS]
  if (entry === undefined) {
    throw requestError(`unknown provider: ${String(provider)}. Use one of: chatgpt, grok, gemini.`, 'INVALID_INPUT')
  }
  const pending = PENDING.get(pendingKey(provider))
  if (pending === undefined) {
    // The attempt may have authorized through its own browser callback and
    // already been reaped (or a cancel replaced it); the credential state
    // decides whether this is a stale click or an actual miss.
    let configured = false
    try {
      configured = (await ctx.credentials.describeRecord(entry.key)).configured
    } catch {
      configured = false
    }
    if (!configured) {
      throw requestError('no sign-in is waiting for this provider; click Connect first', 'NO_PENDING')
    }
    let routeDetail: string
    try {
      routeDetail = await ensureRouteProfile(ctx, entry)
    } catch (error) {
      routeDetail = `connected, but the route could not be configured: ${describe(error)}`
    }
    return { connected: true, provider, detail: `already connected. ${routeDetail}` }
  }
  const trimmed = (pasted ?? '').trim()
  if (pending.resolveCode !== undefined && trimmed === '') {
    throw requestError('paste the authorization code shown on the sign-in page', 'CODE_REQUIRED')
  }
  if (pending.resolveCode !== undefined) pending.resolveCode(trimmed)
  let outcome: { status: 'authorized' | 'cancelled' }
  try {
    outcome = await Promise.race([
      pending.beginPromise,
      ctx.timeout(180000).then(() => {
        throw requestError('timed out waiting for the sign-in to complete', 'TIMEOUT')
      }),
    ])
  } finally {
    PENDING.delete(pendingKey(provider))
  }
  if (outcome.status !== 'authorized') {
    return { connected: false, provider, detail: 'authorization cancelled' }
  }
  let routeDetail: string
  try {
    routeDetail = await ensureRouteProfile(ctx, entry)
  } catch (error) {
    routeDetail = `connected, but the route could not be configured: ${describe(error)}`
  }
  return { connected: true, provider, detail: routeDetail }
}

/**
 * Cancel one card-driven attempt and unblock its prompt.
 * @param authorization - the realm's authorization registry.
 * @param sessionId - the session the attempt runs from.
 * @param provider - one of the catalog's provider ids.
 */
export async function cancelCardConnect(
  authorization: AuthorizationService,
  provider: string,
): Promise<void> {
  const pending = PENDING.get(pendingKey(provider))
  if (pending === undefined) return
  PENDING.delete(pendingKey(provider))
  const entry = PROVIDERS[provider as keyof typeof PROVIDERS]
  if (entry !== undefined) authorization.cancel(entry.key)
  pending.resolveCode?.('')
}
