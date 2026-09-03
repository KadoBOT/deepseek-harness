/**
 * Shared route, framing, timeout, assembly, and validation policy for
 * model-backed session-title providers.
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
  truncateTitleUtf8,
} from '@deepseek-ai/dsh-session-title'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  SessionTitleAutomaticMode,
  SessionTitleModelProvenance,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'

/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelProvenance
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary title requests. */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** Required deployment policy for one model-backed title plugin. */
export interface SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
  /** Maximum UTF-8 bytes in the final JSON-framed user prompt. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable model-provider policy. */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** Shared Loader field schemas with no library defaults. */
export const SessionTitleLlmConfigFields = {
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** Shared Loader schema with no library defaults. */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetWords',
  'targetCjkCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * Validate the shape every auxiliary-title policy shares — allowed keys,
 * positive-integer limits, the timer ceiling, and a complete optional route
 * pair — and detach an immutable copy.
 * @param config - untrusted plugin configuration.
 * @param allowedKeys - the exact key set of this policy variant.
 * @param integerFields - every numeric limit field of this policy variant.
 * @returns immutable shallow copy with optional route absence preserved.
 */
function detachValidatedLlmConfig<C extends object>(
  config: C,
  allowedKeys: ReadonlySet<string>,
  integerFields: readonly (keyof C & string)[],
): C {
  if ((config as unknown) === null || typeof config !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = config as unknown as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  for (const field of integerFields) assertPositiveInteger(field, value[field] as number)
  const record = value as Pick<SessionTitleLlmConfig, 'timeoutMs' | 'provider' | 'model'>
  if (record.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = record.provider !== undefined
  const hasModel = record.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof record.provider !== 'string' || record.provider.length === 0
      || typeof record.model !== 'string' || record.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  return deepFreeze({ ...config })
}

/** Numeric limit fields shared by every auxiliary-title policy variant. */
const COMMON_INTEGER_FIELDS = ['targetWords', 'targetCjkCharacters', 'maxInputBytes', 'maxOutputTokens', 'timeoutMs'] as const

/**
 * Validate and detach required model-provider configuration.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  return detachValidatedLlmConfig(config, CONFIG_KEYS, COMMON_INTEGER_FIELDS)
}

/** Select the provider-owned message subset from one fixed service revision. */
export type SessionTitleLlmMessageSelector = (
  messages: readonly SessionTitleUserMessage[],
) => readonly SessionTitleUserMessage[]

/**
 * Register one model-backed provider through the shared configuration and call policy.
 * @param ctx - context exposing the title and LLM services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated titles.
 * @param automatic - provider-owned automatic generation cadence.
 * @param selectMessages - exact source-message selection for one revision.
 */
export function registerSessionTitleLlmProvider(
  ctx: Context,
  config: SessionTitleLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionTitleLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    async generate(request) {
      return generateSessionTitleWithLlm(ctx, resolved, request, selectMessages(request.messages), titleProvider)
    },
  })
}

/** Resolve the explicit pair or the exact route captured from `request/header`. */
function resolveRoute(
  config: Pick<SessionTitleLlmConfig, 'provider' | 'model'>,
  request: SessionTitleProviderRequest,
): SessionTitleModelProvenance {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if (request.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return request.route
}

/** Stable language-aware system instruction shared by both provider plugins. */
function systemPrompt(config: ResolvedSessionTitleLlmConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-title-llm: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-title-llm: title model unexpectedly requested a tool')
    default:
      return new Error(`session-title-llm: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Framing, dispatch, assembly, and terminal-failure policy shared by every auxiliary call. */
interface AuxiliaryCallLimits
  extends Pick<SessionTitleLlmConfig, 'maxInputBytes' | 'maxOutputTokens' | 'timeoutMs' | 'provider' | 'model'> {}

/**
 * Run one auxiliary title-model call end to end: frame the selected messages,
 * enforce the input byte cap, resolve the route, log the pre-dispatch record,
 * stream under the deadline, and reject terminal failures or tool-call output.
 * @returns the text blocks in order, used route, and exact source seqs.
 */
async function streamAuxiliaryText(
  ctx: Context,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
  system: string,
  limits: AuxiliaryCallLimits,
): Promise<{ textBlocks: readonly string[]; route: SessionTitleModelProvenance; messageSeqs: SessionSeq[] }> {
  request.signal.throwIfAborted()
  if (selectedMessages.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const framedInput = frameMessages(selectedMessages)
  const inputBytes = Buffer.byteLength(framedInput, 'utf8')
  if (inputBytes > limits.maxInputBytes) {
    throw new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${limits.maxInputBytes}`)
  }
  const route = resolveRoute(limits, request)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framedInput }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  })]
  using callDeadline = deadline(request.signal, limits.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: limits.maxOutputTokens,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: callDeadline.signal,
  })
  request.session.append('session/title-llm-request', {
    titleProvider,
    messageSeqs: selectedMessages.map(message => message.seq),
    route,
    system,
    messages,
    maxTokens: limits.maxOutputTokens,
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-title-llm: auxiliary output must contain text only')
  }
  const textBlocks = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
  return { textBlocks, route, messageSeqs: selectedMessages.map(message => message.seq) }
}

/**
 * Generate one title through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, message snapshot, and cancellation.
 * @param selectedMessages - exact provider-selected subset to frame and attribute.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @returns normalized non-empty title, exact source seqs, and used model route.
 */
export async function generateSessionTitleWithLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  const { textBlocks, route, messageSeqs } = await streamAuxiliaryText(
    ctx,
    request,
    selectedMessages,
    titleProvider,
    systemPrompt(config),
    config,
  )
  const title = normalizeSessionTitle(textBlocks.join(' '), Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return {
    title,
    messageSeqs,
    model: route,
  }
}

/** Required deployment policy for one model-backed session-brief plugin (name plus summary). */
export interface SessionBriefLlmConfig {
  /** Target word count for non-CJK names. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean names. */
  readonly targetCjkCharacters: number
  /** Target word count for non-CJK summaries. */
  readonly targetSummaryWords: number
  /** Target character count for Chinese, Japanese, or Korean summaries. */
  readonly targetSummaryCjkCharacters: number
  /** Maximum UTF-8 bytes in the final JSON-framed user prompt. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap; reasoning-model budgets must cover the reasoning trace too. */
  readonly maxOutputTokens: number
  /** Maximum UTF-8 bytes in an accepted summary after truncation. */
  readonly maxSummaryBytes: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable model-provider policy for session briefs. */
export interface ResolvedSessionBriefLlmConfig extends SessionBriefLlmConfig {}

/** Shared Loader field schemas with no library defaults: the title fields plus the summary-only limits. */
export const SessionBriefLlmConfigFields = {
  ...SessionTitleLlmConfigFields,
  targetSummaryWords: z.number().step(1).min(1).required(),
  targetSummaryCjkCharacters: z.number().step(1).min(1).required(),
  maxSummaryBytes: z.number().step(1).min(1).required(),
}

/** Complete configuration key set: the title keys plus the summary-only limits. */
const BRIEF_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...CONFIG_KEYS,
  'targetSummaryWords',
  'targetSummaryCjkCharacters',
  'maxSummaryBytes',
])

/** Numeric limit fields unique to the brief policy. */
const BRIEF_INTEGER_FIELDS = ['targetSummaryWords', 'targetSummaryCjkCharacters', 'maxSummaryBytes'] as const

/**
 * Validate and detach required model-provider configuration for a brief.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSessionBriefLlmConfig(
  config: SessionBriefLlmConfig,
): ResolvedSessionBriefLlmConfig {
  return detachValidatedLlmConfig(config, BRIEF_CONFIG_KEYS, [...COMMON_INTEGER_FIELDS, ...BRIEF_INTEGER_FIELDS])
}

/** Stable language-aware system instruction shared by brief provider plugins. */
function briefSystemPrompt(config: ResolvedSessionBriefLlmConfig): string {
  return [
    'Create a name and a one-sentence summary for an AI coding-assistant session from the supplied human messages.',
    'Return only one JSON object on one line, with exactly two string fields and no other text:',
    '{"name": "...", "summary": "..."}',
    '"name" is the session title in plain natural language — no quotes, prefix, explanation, Markdown, XML, terminal control codes, or code.',
    '"summary" is one sentence describing what the session aims to do, in plain natural language.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters for "name".`,
    `Aim for about ${config.targetSummaryWords} words in non-CJK languages or ${config.targetSummaryCjkCharacters} CJK characters for "summary".`,
  ].join('\n')
}

/**
 * Extract the two required string fields from the model's text output.
 * Tolerates surrounding prose and a single Markdown code fence around the object.
 */
function parseBriefJson(text: string): { name: string; summary: string } {
  const unfenced = text.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('session-title-llm: brief output contains no JSON object')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    throw new Error('session-title-llm: brief output is not valid JSON')
  }
  // The sliced span always begins with "{", so any successful parse is an
  // object; field-level checks below reject every non-conforming shape.
  const record = parsed as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.summary !== 'string') {
    throw new Error('session-title-llm: brief JSON requires string "name" and "summary" fields')
  }
  return { name: record.name, summary: record.summary }
}

/**
 * Generate one name-plus-summary revision through the shared auxiliary LLM call.
 * The summary is appended as a `session/summary` event only after the name,
 * summary, and byte caps all validate, so a rejected call leaves no partial log.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, message snapshot, and cancellation.
 * @param selectedMessages - exact provider-selected subset to frame and attribute.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @returns normalized non-empty name as the title, exact source seqs, and used model route.
 */
export async function generateSessionBriefWithLlm(
  ctx: Context,
  config: ResolvedSessionBriefLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  const { textBlocks, route, messageSeqs } = await streamAuxiliaryText(
    ctx,
    request,
    selectedMessages,
    titleProvider,
    briefSystemPrompt(config),
    config,
  )
  const parsed = parseBriefJson(textBlocks.join(''))
  const name = normalizeSessionTitle(parsed.name, Number.MAX_SAFE_INTEGER)
  if (name.length === 0) throw new Error('session-title-llm: brief model produced an empty name')
  const summary = normalizeSessionTitle(truncateTitleUtf8(parsed.summary, config.maxSummaryBytes), Number.MAX_SAFE_INTEGER)
  if (summary.length === 0) throw new Error('session-title-llm: brief model produced an empty summary')
  request.session.append('session/summary', { summary, messageSeqs })
  return {
    title: name,
    messageSeqs,
    model: route,
  }
}

/**
 * Fold one committed event into the `summary` projection state. Pure: unrelated
 * events return the same reference so the registry skips downstream work.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state.
 */
export function applySessionSummaryEvent(state: string | null, event: SessionEvent): string | null {
  return event.type === 'session/summary' ? event.data.summary : state
}

/**
 * Register one model-backed brief provider through the shared configuration and call policy,
 * plus the `summary` projection unit that carries appended summaries to clients.
 * @param ctx - context exposing the title, LLM, and session-projection services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated names.
 * @param automatic - provider-owned automatic generation cadence.
 * @param selectMessages - exact source-message selection for one revision.
 */
export function registerSessionBriefLlmProvider(
  ctx: Context,
  config: SessionBriefLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionBriefLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  // Register before the projection unit so a competing provider fails loud
  // before any side effect lands.
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    async generate(request) {
      return generateSessionBriefWithLlm(ctx, resolved, request, selectMessages(request.messages), titleProvider)
    },
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const summarySchema = zod.union([zod.string().min(1), zod.null()])
    projectionCtx.sessionProjections.register<'summary', string | null>({
      key: 'summary',
      stateSchema: summarySchema,
      init: () => null,
      apply: applySessionSummaryEvent,
      wire: { viewSchema: summarySchema, view: state => state },
      stateVersion: 1,
    })
  })
}
