/**
 * Gemini Code Assist LLM adapter: the `:streamGenerateContent` SSE protocol
 * over the credential store's OAuth grant, mapped onto the harness message and
 * stream vocabulary. Tokens refresh through the Google OAuth client; the Code
 * Assist project is onboarded once and cached in the grant payload.
 * @module @deepseek-ai/dsh-oauth-agents/gemini-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
// Type-only: pulls the timer service's Context merge (ctx.timeout).
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {
  ContentBlock, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm/types'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GrantRecord } from '@deepseek-ai/dsh-credentials/types'
import { RequestError, requestError, decodeChunk, type Http } from './http.ts'
import { refreshAccessToken } from './google-oauth.ts'
import {
  CODE_ASSIST_BASE, CODE_ASSIST_CLIENT_METADATA, GEMINI_KEY, GEMINI_MODELS, GEMINI_PROVIDER,
  type GeminiModelInfo,
} from './providers.ts'

/** OAuth grant payload this adapter owns inside its credential record. */
export interface GeminiGrant {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds the access token expires at. */
  expiresAt: number
  email?: string
  projectId?: string
  provider: string
}

/** Narrow one stored record to this plugin's grant payload. */
function readGrant(record: unknown): GeminiGrant | undefined {
  if (record === null || record === undefined || typeof record !== 'object') return undefined
  if ((record as GrantRecord).kind !== 'grant') return undefined
  const payload = (record as GrantRecord).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as Partial<GeminiGrant>
  if (typeof candidate.refreshToken !== 'string') return undefined
  return candidate as GeminiGrant
}

/** Recursively strip JSON-Schema keys Google's function declarations reject. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (typeof schema !== 'object' || schema === null) return { type: 'string' }
  const drop = new Set([
    '$schema', 'additionalProperties', '$id', '$defs', 'definitions',
    'exclusiveMinimum', 'exclusiveMaximum',
  ])
  const source = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (drop.has(key)) continue
    const value = source[key]
    out[key] = (typeof value === 'object' && value !== null) ? sanitizeSchema(value) : value
  }
  if (out.type === 'object' && out.properties === undefined) out.properties = {}
  return out
}

/** Parse one JSON object argument, refusing arrays and primitives as `{}`. */
function safeParseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Malformed arguments degrade to an empty object.
  }
  return {}
}

/** Flatten text and nested tool-result blocks to plain text. */
function blocksToText(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += (out.length > 0 ? '\n' : '') + block.text
    else if (block.type === 'tool-result') out += (out.length > 0 ? '\n' : '') + blocksToText(block.content)
  }
  return out
}

/** One Gemini API `contents` entry. */
interface GeminiContent {
  readonly role: 'model' | 'user'
  readonly parts: ReadonlyArray<Record<string, unknown>>
}

/**
 * Translate harness messages into the Code Assist envelope: assistant tool
 * calls become `functionCall` parts, tool results become `functionResponse`
 * parts keyed by the originating call's name.
 */
function buildContents(messages: GenerateOptions['messages']): GeminiContent[] {
  const callNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') callNames.set(block.id, block.name)
    }
  }
  const contents: GeminiContent[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ text: block.text })
        else if (block.type === 'tool-call') {
          parts.push({ functionCall: { name: block.name, args: safeParseObject(block.arguments) } })
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    let toolResult: ContentBlock | undefined
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        toolResult = block
        break
      }
    }
    if (toolResult !== undefined && toolResult.type === 'tool-result') {
      const name = callNames.get(toolResult.toolCallId) ?? 'tool'
      const text = blocksToText(toolResult.content)
      const response = toolResult.isError === true ? { error: text } : { result: text }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] })
      continue
    }
    if (message.role !== 'user') continue
    const parts: Array<Record<string, unknown>> = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ text: block.text })
    }
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }
  return contents
}

/** Envelope body posted to `:streamGenerateContent`. */
interface GeminiEnvelope {
  readonly model: string
  readonly project?: string
  readonly request: {
    contents: GeminiContent[]
    systemInstruction?: { parts: { text: string }[] }
    tools?: { functionDeclarations: unknown[] }[]
    generationConfig?: Record<string, unknown>
  }
  readonly user_prompt_id: string
}

/** Build the full Code Assist request envelope for one generate call. */
function buildEnvelope(options: GenerateOptions, project: string | undefined): GeminiEnvelope {
  const contents = buildContents(options.messages)
  if (contents.length === 0) {
    throw requestError('Gemini request has no sendable content', 'INVALID_REQUEST')
  }
  const request: GeminiEnvelope['request'] = { contents }
  if (typeof options.system === 'string' && options.system.length > 0) {
    request.systemInstruction = { parts: [{ text: options.system }] }
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations = options.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeSchema(tool.parameters),
    }))
    request.tools = [{ functionDeclarations: declarations }]
  }
  const generationConfig: Record<string, unknown> = {}
  if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature
  if (typeof options.maxTokens === 'number') generationConfig.maxOutputTokens = options.maxTokens
  if (options.stop !== undefined && options.stop.length > 0) generationConfig.stopSequences = options.stop
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  return {
    model: options.model,
    request,
    user_prompt_id: `dsh-${randomSuffix(12)}`,
    ...(project === undefined ? {} : { project }),
  }
}

/** Generate a lowercase base-36 random identifier of at least `length` characters. */
function randomSuffix(length: number): string {
  let out = ''
  while (out.length < length) out += Math.floor(Math.random() * 4294967296).toString(36)
  return out.slice(0, length)
}

/** One streaming SSE event from `:streamGenerateContent`. */
interface SseEvent {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly GeminiPart[] }
    readonly finishReason?: string
  }[]
  readonly usageMetadata?: {
    readonly promptTokenCount?: number
    readonly candidatesTokenCount?: number
    readonly thoughtsTokenCount?: number
    readonly totalTokenCount?: number
  }
  readonly error?: { readonly message?: string; readonly status?: number }
}

/** One text, thought, or function-call part of a Gemini response. */
interface GeminiPart {
  readonly text?: string
  readonly thought?: boolean
  readonly functionCall?: { readonly name?: string; readonly args?: unknown }
}

/** Parser accumulator shared by the `data` listener and settlement. */
interface SseParserState {
  headerBuf: string
  status: number | null
  buffer: string
  dataLines: string[]
  rest: string
  stderrText: string
  queue: (SseEvent | null)[]
  wake: (() => void) | null
  ended: boolean
  error: Error | null
}

/** Mutable per-stream block and usage state of one SSE consumption. */
interface BlockState {
  index: number
  type: 'text' | 'reasoning' | 'tool-call' | null
  text: string
  toolId: ToolCallId
  toolName: string
  toolArgs: string
  usage: TokenUsage | undefined
  finishKind: 'stop' | 'tool-calls' | 'max-tokens'
}

/** Extract one project id from a string or `{ id }` shape. */
function projectIdOf(project: unknown): string | undefined {
  if (typeof project === 'string' && project.length > 0) return project
  if (project !== null && typeof project === 'object' && typeof (project as { id?: unknown }).id === 'string') {
    return (project as { id: string }).id
  }
  return undefined
}

/**
 * Gemini adapter: one `LlmAdapter` over the Code Assist SSE protocol, scoped
 * to the `gemini-code-assist` route. Model resolution is static; every stream
 * call refreshes its access token when close to expiry and reuses the stored
 * Code Assist project id.
 */
export class GeminiAdapter extends LlmAdapter {
  /**
   * @param ctx - host context carrying the credentials and timer services.
   * @param http - the curl HTTP client.
   */
  constructor(private readonly ctx: Context, private readonly http: Http) {
    super()
  }

  override providerInfo(_provider: string): { id: string; name: string } {
    return { id: GEMINI_PROVIDER, name: 'Gemini (Code Assist)' }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return GEMINI_MODELS.map(entry => ({
      provider: _provider,
      id: entry.id,
      name: entry.name,
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const id = model.length > 0 ? model : 'gemini-3.5-flash'
    const known: GeminiModelInfo | undefined = GEMINI_MODELS.find(entry => entry.id === id)
    return {
      provider,
      id,
      name: known !== undefined ? known.name : id,
      context: { contextWindow: known?.contextWindow ?? 1048576 },
      defaultMaxTokens: known?.maxTokens ?? 65536,
      inputModalities: ['text'],
    }
  }

  /** Read the stored grant, refreshing the access token when close to expiry. */
  private async loadSession(): Promise<GeminiGrant> {
    const record: unknown = await this.ctx.credentials.readRecord(GEMINI_KEY)
    const grant = readGrant(record)
    if (grant === undefined) {
      throw requestError('Gemini is not connected yet. Connect it first (provider: gemini).', 'NO_CREDENTIAL')
    }
    if (typeof grant.accessToken === 'string' && typeof grant.expiresAt === 'number'
      && grant.expiresAt > Date.now() + 120000) {
      return grant
    }
    const refreshed = await refreshAccessToken(this.http, grant.refreshToken)
    const next: GeminiGrant = {
      ...grant,
      accessToken: refreshed.access_token,
      expiresAt: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
      refreshToken: (typeof refreshed.refresh_token === 'string' && refreshed.refresh_token.length > 0)
        ? refreshed.refresh_token
        : grant.refreshToken,
    }
    await this.ctx.credentials.modifyRecord(GEMINI_KEY, () => Promise.resolve({ kind: 'grant', payload: next }))
    return next
  }

  /**
   * Resolve (and cache in the grant) the account's Code Assist project,
   * onboarding the free tier when the account has none yet.
   */
  private async ensureProject(session: GeminiGrant): Promise<string> {
    if (typeof session.projectId === 'string' && session.projectId.length > 0) return session.projectId
    const load = await this.http.postJson(
      `${CODE_ASSIST_BASE}/v1internal:loadCodeAssist`,
      { Authorization: `Bearer ${session.accessToken}` },
      { metadata: CODE_ASSIST_CLIENT_METADATA },
    )
    if (load.status !== 200) {
      throw requestError(
        `Gemini onboarding failed (loadCodeAssist HTTP ${load.status}): ${JSON.stringify(load.body).slice(0, 400)}`,
        'AUTH',
        load.status,
      )
    }
    const loadBody = load.body as {
      cloudaicompanionProject?: unknown
      allowedTiers?: unknown
      currentTier?: unknown
    }
    let project = projectIdOf(loadBody.cloudaicompanionProject)
    if (project === undefined && loadBody.currentTier === undefined) {
      const tiers = Array.isArray(loadBody.allowedTiers)
        ? loadBody.allowedTiers as { id?: string; isDefault?: boolean }[]
        : []
      if (tiers.some(tier => tier.isDefault === true && tier.id === 'free')) {
        project = await this.onboardFreeTier(session)
      }
    }
    if (project === undefined) {
      throw requestError(
        'Gemini could not resolve a Code Assist project for this account.'
          + ' Set GOOGLE_CLOUD_PROJECT or use an eligible Google account.',
        'PROJECT_REQUIRED',
      )
    }
    await this.ctx.credentials.modifyRecord(GEMINI_KEY, (current) => {
      const existing = readGrant(current)
      if (existing === undefined) return Promise.resolve(undefined)
      const payload: GeminiGrant = { ...existing, projectId: project }
      return Promise.resolve({ kind: 'grant', payload } satisfies GrantRecord)
    })
    session.projectId = project
    return project
  }

  /** Poll one free-tier onboarding operation to completion and read its project. */
  private async onboardFreeTier(session: GeminiGrant): Promise<string | undefined> {
    let operation = await this.http.postJson(
      `${CODE_ASSIST_BASE}/v1internal:onboardUser`,
      { Authorization: `Bearer ${session.accessToken}` },
      { tierId: 'free', metadata: CODE_ASSIST_CLIENT_METADATA },
    )
    let guard = 0
    while (operation.status === 200 && operation.body !== null && typeof operation.body === 'object') {
      const op = operation.body as { name?: unknown; done?: unknown }
      if (op.done === true || typeof op.name !== 'string' || guard >= 10) break
      guard += 1
      await this.ctx.timeout(3000)
      operation = await this.http.getJson(
        `${CODE_ASSIST_BASE}/${op.name}`,
        { Authorization: `Bearer ${session.accessToken}` },
      )
    }
    if (operation.status !== 200 || operation.body === null || typeof operation.body !== 'object') return undefined
    const response = (operation.body as { response?: { cloudaicompanionProject?: unknown } }).response
    return projectIdOf(response?.cloudaicompanionProject)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const session = await this.loadSession()
    const project = await this.ensureProject(session)
    const envelope = buildEnvelope(options, project)
    const handleRef = { current: undefined as SubprocessHandle | undefined }
    const abort = (): void => {
      try {
        handleRef.current?.terminate()
      } catch {
        // curl already exited.
      }
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) throw requestError('request aborted', 'ABORTED')
      options.signal.addEventListener('abort', abort, { once: true })
    }
    let handle: SubprocessHandle
    try {
      handle = await this.http.openSse(
        `${CODE_ASSIST_BASE}/v1internal:streamGenerateContent?alt=sse`,
        { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
        JSON.stringify(envelope),
      )
      handleRef.current = handle
      yield* this.consumeEvents(handle, options)
    } finally {
      if (options.signal !== undefined) {
        try {
          options.signal.removeEventListener('abort', abort)
        } catch {
          // Older runtime without removeEventListener — nothing else can reach it.
        }
      }
      abort()
    }
  }

  /** Attach stream listeners, drive the parser, and yield the neutral chunks. */
  private async *consumeEvents(handle: SubprocessHandle, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const parser: SseParserState = {
      headerBuf: '', status: null, buffer: '', dataLines: [], rest: '', stderrText: '',
      queue: [], wake: null, ended: false, error: null,
    }
    const push = (value: SseEvent | null): void => {
      parser.queue.push(value)
      if (parser.wake !== null) {
        const wake = parser.wake
        parser.wake = null
        wake()
      }
    }
    const flushEvent = (): void => {
      if (parser.dataLines.length === 0) return
      const raw = parser.dataLines.join('\n')
      parser.dataLines = []
      if (raw === '[DONE]') return
      try {
        const parsed: unknown = JSON.parse(raw)
        push(parsed !== null && typeof parsed === 'object' ? parsed as SseEvent : null)
      } catch {
        // A malformed data line carries no event.
      }
    }
    const feed = (text: string): void => {
      if (parser.status === null) {
        parser.headerBuf += text
        const marker = parser.headerBuf.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n'
        const splitAt = parser.headerBuf.indexOf(marker)
        if (splitAt < 0) return
        const head = parser.headerBuf.slice(0, splitAt)
        const status = Number.parseInt((head.split('\n')[0] ?? '').split(' ')[1] ?? '', 10)
        parser.status = Number.isFinite(status) ? status : 0
        const remainder = parser.headerBuf.slice(splitAt + marker.length)
        parser.headerBuf = ''
        feedBody(parser, remainder, flushEvent, parser.status < 400)
        return
      }
      feedBody(parser, text, flushEvent, parser.status < 400)
    }
    const settleClosed = (): void => {
      if (parser.ended) return
      if (parser.status === null) {
        parser.error = parser.error ?? requestError(
          `Gemini API: the connection closed before a response arrived. ${parser.stderrText.slice(0, 200)}`,
          'PROTOCOL',
        )
      } else if (parser.status >= 400) {
        parser.error = parser.error ?? bodyError(parser.rest, parser.status)
      }
      if (parser.dataLines.length > 0) flushEvent()
      parser.ended = true
      push(null)
    }

    const stdout = handle.stdout
    if (stdout === undefined) throw requestError('Gemini API: curl produced no stdout stream', 'PROTOCOL')
    stdout.on('data', (chunk: unknown) => {
      try {
        feed(decodeChunk(chunk))
      } catch (error) {
        parser.error = parser.error ?? (error instanceof Error ? error : new Error(String(error)))
      }
    })
    stdout.on('end', settleClosed)
    stdout.on('error', (error: Error) => {
      parser.error = parser.error ?? error
      parser.ended = true
      push(null)
    })
    handle.stderr?.on('data', (chunk: unknown) => {
      parser.stderrText += decodeChunk(chunk)
    })
    void handle.done.then(settleClosed, (error: unknown) => {
      parser.error = parser.error ?? (error instanceof Error ? error : new Error(String(error)))
      parser.ended = true
      push(null)
    })

    const state: BlockState = {
      index: -1, type: null, text: '', toolId: ToolCallId(''), toolName: '', toolArgs: '',
      usage: undefined, finishKind: 'stop',
    }
    let sawToolCall = false
    while (true) {
      while (parser.queue.length === 0 && !parser.ended && parser.error === null) {
        await new Promise<void>((resolve) => {
          parser.wake = resolve
        })
      }
      if (parser.error !== null) throw parser.error
      if (parser.queue.length === 0) break
      const event = parser.queue.shift()
      if (event === null || event === undefined) break
      if (event.error !== undefined) {
        const status = event.error.status
        throw requestError(
          `Gemini API error: ${event.error.message ?? JSON.stringify(event.error).slice(0, 400)}`,
          status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'PROTOCOL',
          status,
        )
      }
      const candidate = event.candidates?.[0]
      const parts = candidate?.content?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part.functionCall !== undefined) {
            yield* openBlock(state, 'tool-call')
            state.toolName = part.functionCall.name ?? state.toolName
            state.toolArgs = JSON.stringify(part.functionCall.args ?? {})
            sawToolCall = true
            yield {
              type: 'tool-call-delta', index: state.index, id: state.toolId,
              ...(state.toolName === '' ? {} : { name: state.toolName }),
              argumentsDelta: state.toolArgs,
            }
          } else if (typeof part.text === 'string' && part.text.length > 0) {
            const kind = part.thought === true ? 'reasoning' : 'text'
            yield* openBlock(state, kind)
            state.text += part.text
            yield kind === 'text'
              ? { type: 'text-delta', index: state.index, text: part.text }
              : { type: 'reasoning-delta', index: state.index, text: part.text }
          }
        }
      }
      if (event.usageMetadata !== undefined) {
        const total = Number(event.usageMetadata.totalTokenCount)
        const reasoning = Number(event.usageMetadata.thoughtsTokenCount)
        state.usage = {
          inputTokens: Number(event.usageMetadata.promptTokenCount) || 0,
          outputTokens: Number(event.usageMetadata.candidatesTokenCount) || 0,
          ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
          ...(Number.isFinite(total) && total > 0 ? { totalTokens: total } : {}),
        }
      }
      const reason = candidate?.finishReason
      if (reason === 'MAX_TOKENS') state.finishKind = 'max-tokens'
    }
    yield* closeBlock(state)
    if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
    yield { type: 'finish', reason: { kind: sawToolCall && state.finishKind === 'stop' ? 'tool-calls' : state.finishKind } }
    void options
  }
}

/** Feed one text arrival into the body parser; error-status bodies accumulate verbatim. */
function feedBody(
  parser: SseParserState,
  text: string,
  flushEvent: () => void,
  accept: boolean,
): void {
  if (!accept) {
    parser.rest += text
    return
  }
  parser.buffer += text
  let newlineAt = parser.buffer.indexOf('\n')
  while (newlineAt >= 0) {
    let line = parser.buffer.slice(0, newlineAt)
    parser.buffer = parser.buffer.slice(newlineAt + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.startsWith('data:')) parser.dataLines.push(line.slice(5).trim())
    else if (line === '') flushEvent()
    newlineAt = parser.buffer.indexOf('\n')
  }
}

/** Build one `RequestError` from an error-status response body. */
function bodyError(bodyText: string, status: number): RequestError {
  const raw = bodyText.trim()
  let message = raw.slice(0, 400)
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    if (parsed.error?.message !== undefined) message = parsed.error.message
  } catch {
    // Keep the raw text as the failure message.
  }
  return requestError(
    `Gemini API HTTP ${String(status)}: ${message}`,
    status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'PROTOCOL',
    status,
  )
}

/** Close any open block, emitting its `block-end`. */
function* closeBlock(state: BlockState): Generator<StreamChunk> {
  if (state.type === 'text') {
    yield { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
  } else if (state.type === 'reasoning') {
    yield { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } }
  } else if (state.type === 'tool-call') {
    yield {
      type: 'block-end', index: state.index,
      block: { type: 'tool-call', id: state.toolId, name: state.toolName, arguments: state.toolArgs },
    }
  }
  state.type = null
  state.text = ''
  state.toolId = ToolCallId('')
  state.toolName = ''
  state.toolArgs = ''
}

/** Open one block of `kind`, closing the previous one first. */
function* openBlock(state: BlockState, kind: 'text' | 'reasoning' | 'tool-call'): Generator<StreamChunk> {
  if (state.type === kind) return
  yield* closeBlock(state)
  state.index += 1
  state.type = kind
  state.toolId = ToolCallId(`call_${randomSuffix(16)}`)
  state.toolName = ''
  state.toolArgs = ''
  yield { type: 'block-start', index: state.index, blockType: kind }
}
