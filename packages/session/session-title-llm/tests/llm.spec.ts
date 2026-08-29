import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, ToolCallId, isAgentLoopRequest, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  applySessionSummaryEvent,
  generateSessionBriefWithLlm,
  generateSessionTitleWithLlm,
  registerSessionBriefLlmProvider,
  resolveSessionBriefLlmConfig,
  resolveSessionTitleLlmConfig,
  SESSION_TITLE_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionBriefLlmConfig, SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected title request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

class DelayedSuccessAdapter extends LlmAdapter {
  constructor(private readonly delayMs: number) {
    super()
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await new Promise<void>(resolve => setTimeout(resolve, this.delayMs))
    yield * SCRIPT
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  五个字标题  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

const BRIEF_CONFIG = {
  ...CONFIG,
  targetSummaryWords: 20,
  targetSummaryCjkCharacters: 40,
  maxSummaryBytes: 256,
} as const

const TITLE_PROVIDER = SessionTitleProviderId('test-title-provider')
let nextSession = 0

function request(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const session = ctx.sessions.create(SessionId(`title-call-${++nextSession}`))
  session.append('turn/start', {
    turn: 1,
  })
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const second = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '第二个问题' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return {
    session,
    messages: [
      { seq: first.seq, text: 'first prompt' },
      { seq: second.seq, text: '第二个问题' },
    ],
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

function requestWithoutRoute(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const routed = request(ctx, signal)
  return { session: routed.session, messages: routed.messages, signal }
}

async function withScript(script: readonly StreamChunk[]): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('generateSessionTitleWithLlm', () => {
  it('uses the exact logged route, language targets, full framed input, and output token cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const providerRequest = request(ctx)
    let requestWasLoggedAtDispatch = false
    const adapter = new RecordingAdapter(SCRIPT, () => {
      requestWasLoggedAtDispatch = providerRequest.session.snapshotEvents()
        .some(event => event.type === 'session/title-llm-request')
    })
    ctx.llm.registerAdapter(['current-route'], adapter)

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )

    expect(result).toEqual({
      title: '五个字标题',
      messageSeqs: providerRequest.messages.map(message => message.seq),
      model: { provider: 'current-route', model: 'current-model' },
    })
    expect(requestWasLoggedAtDispatch).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    const options = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(options).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      maxTokens: 32,
      sessionId: providerRequest.session.id,
      purpose: 'session-title',
    })
    expect(options.system).toContain('5 words')
    expect(options.system).toContain('10 CJK characters')
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('first prompt')
    expect(prompt?.type === 'text' && prompt.text).toContain('第二个问题')
    expect(providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')?.data)
      .toEqual({
        titleProvider: TITLE_PROVIDER,
        messageSeqs: providerRequest.messages.map(message => message.seq),
        route: { provider: 'current-route', model: 'current-model' },
        system: options.system,
        messages: options.messages,
        maxTokens: 32,
      })
  })

  it('uses paired explicit overrides and bounds the final framed input before model dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const oversized = request(ctx)
    const [selected] = oversized.messages
    if (selected === undefined) throw new Error('expected one selected message')
    const rawInputBytes = Buffer.byteLength(selected.text, 'utf8')
    const config = resolveSessionTitleLlmConfig({
      ...CONFIG,
      provider: 'explicit-route',
      model: 'explicit-model',
      maxInputBytes: rawInputBytes,
    })

    await expect(generateSessionTitleWithLlm(ctx, config, oversized, [selected], TITLE_PROVIDER))
      .rejects.toThrow(/input.*bytes.*maxInputBytes/i)
    expect(adapter.requests).toEqual([])
    expect(oversized.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)

    const withinLimit = resolveSessionTitleLlmConfig({ ...config, maxInputBytes: 1_000 })
    const within = request(ctx)
    await generateSessionTitleWithLlm(ctx, withinLimit, within, [within.messages[0]!], TITLE_PROVIDER)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
  })

  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionTitleLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, extra: true } as SessionTitleLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 0 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 1.5 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, model: 'only-model' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: '', model: 'model' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: '' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 1, model: 'model' } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: 1 } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(() => resolveSessionTitleLlmConfig(CONFIG)).not.toThrow()
  })

  it('rejects an absent route, empty selection, and pre-aborted caller before model dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    const unrouted = requestWithoutRoute(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, unrouted, unrouted.messages, TITLE_PROVIDER))
      .rejects.toThrow(/no logged request route/)
    const empty = request(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, empty, [], TITLE_PROVIDER))
      .rejects.toThrow(/at least one source message/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = request(ctx, controller.signal)
    await expect(generateSessionTitleWithLlm(ctx, config, aborted, aborted.messages, TITLE_PROVIDER))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ message, code })
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(true)
  })

  it.each([
    [{ kind: 'max-tokens' }, /reached maxOutputTokens/],
    [{ kind: 'tool-calls' }, /unexpectedly requested a tool/],
    [{ kind: 'future-finish' } as never, /unsupported finish reason "future-finish"/],
  ] satisfies Array<[FinishReason, RegExp]>)('rejects the terminal finish reason %s', async (reason, error) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(error)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const toolScript: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const tool = await withScript(toolScript)
    const toolRequest = request(tool.ctx)
    await expect(generateSessionTitleWithLlm(
      tool.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      toolRequest,
      toolRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(/output must contain text only/)

    const reasoning = await withScript([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningRequest = request(reasoning.ctx)
    await expect(generateSessionTitleWithLlm(
      reasoning.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      reasoningRequest,
      reasoningRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(/produced no text/)
  })

  it('aborts a cooperative model stream at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        providerRequest.messages,
        TITLE_PROVIDER,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a successful stream that completes after the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new DelayedSuccessAdapter(20))
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        providerRequest.messages,
        TITLE_PROVIDER,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(20)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})

function briefScript(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('generateSessionBriefWithLlm', () => {
  it('returns the JSON name as the title and logs the summary event with provenance', async () => {
    const { ctx, adapter } = await withScript(briefScript(
      '{"name": "Append-only titles", "summary": "Explain why session names come from append-only logs."}',
    ))
    const config = resolveSessionBriefLlmConfig(BRIEF_CONFIG)
    const providerRequest = request(ctx)

    const result = await generateSessionBriefWithLlm(ctx, config, providerRequest, providerRequest.messages, TITLE_PROVIDER)

    expect(result).toEqual({
      title: 'Append-only titles',
      messageSeqs: providerRequest.messages.map(message => message.seq),
      model: { provider: 'current-route', model: 'current-model' },
    })
    const logged = providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/summary')
    expect(logged?.data).toEqual({
      summary: 'Explain why session names come from append-only logs.',
      messageSeqs: providerRequest.messages.map(message => message.seq),
    })
    const options = adapter.requests[0]!
    expect(options.maxTokens).toBe(config.maxOutputTokens)
    expect(options.system).toContain('"name"')
    expect(options.system).toContain('20 words')
    expect(options.system).toContain('40 CJK characters for "summary"')
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(true)
  })

  it('ignores reasoning blocks and parses a fenced JSON answer', async () => {
    const fenced: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think about the messages first' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '```json\n{"name": "围栏名称", "summary": "围栏摘要句子。"}\n```' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { ctx } = await withScript(fenced)
    const config = resolveSessionBriefLlmConfig(BRIEF_CONFIG)
    const providerRequest = request(ctx)

    const result = await generateSessionBriefWithLlm(ctx, config, providerRequest, [providerRequest.messages[0]!], TITLE_PROVIDER)

    expect(result.title).toBe('围栏名称')
    expect(providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/summary')?.data)
      .toMatchObject({ summary: '围栏摘要句子。' })
  })

  it('truncates an over-long multibyte summary to maxSummaryBytes without splitting a character', async () => {
    const longSummary = '摘'.repeat(400)
    const { ctx } = await withScript(briefScript(JSON.stringify({ name: '截断标题', summary: longSummary })))
    const config = resolveSessionBriefLlmConfig(BRIEF_CONFIG)
    const providerRequest = request(ctx)

    await generateSessionBriefWithLlm(ctx, config, providerRequest, [providerRequest.messages[0]!], TITLE_PROVIDER)

    const logged = providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/summary')
    const summary = logged?.type === 'session/summary' ? logged.data.summary : ''
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(config.maxSummaryBytes)
    expect(Buffer.byteLength(`${summary}摘`, 'utf8')).toBeGreaterThan(config.maxSummaryBytes)
    expect(summary.endsWith('摘')).toBe(true)
  })

  it.each([
    ['plain prose without braces', /no JSON object/],
    ['{"name": "n",,}', /not valid JSON/],
    ['{"name": 1, "summary": "s"} extra', /requires string "name" and "summary"/],
    ['{"name": "n"}', /requires string "name" and "summary"/],
    ['{"name": "n", "summary": 2}', /requires string "name" and "summary"/],
    ['{"name": "", "summary": "s"}', /empty name/],
    ['{"name": "n", "summary": ""}', /empty summary/],
    ['{"name": "n", "summary": "  "}', /empty summary/],
  ])('rejects malformed model output %j', async (text, error) => {
    const { ctx } = await withScript(briefScript(text))
    const config = resolveSessionBriefLlmConfig(BRIEF_CONFIG)
    const providerRequest = request(ctx)
    await expect(generateSessionBriefWithLlm(ctx, config, providerRequest, providerRequest.messages, TITLE_PROVIDER))
      .rejects.toThrow(error)
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/summary')).toBe(false)
  })

  it('appends no summary or request event when the stream fails or the caller aborted before dispatch', async () => {
    const failed = await withScript([{ type: 'finish', reason: { kind: 'max-tokens' } }])
    const failedRequest = request(failed.ctx)
    await expect(generateSessionBriefWithLlm(
      failed.ctx,
      resolveSessionBriefLlmConfig(BRIEF_CONFIG),
      failedRequest,
      failedRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow(/reached maxOutputTokens/)
    expect(failedRequest.session.snapshotEvents().some(event => event.type === 'session/summary')).toBe(false)

    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = await withScript(briefScript('{"name": "n", "summary": "s"}'))
    const abortedRequest = request(aborted.ctx, controller.signal)
    await expect(generateSessionBriefWithLlm(
      aborted.ctx,
      resolveSessionBriefLlmConfig(BRIEF_CONFIG),
      abortedRequest,
      abortedRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toThrow('caller stopped')
    expect(abortedRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)
    expect(abortedRequest.session.snapshotEvents().some(event => event.type === 'session/summary')).toBe(false)
  })

  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionBriefLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, extra: true } as SessionBriefLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, targetSummaryWords: 1.5 }))
      .toThrow(/targetSummaryWords.*positive integer/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, targetSummaryCjkCharacters: 0 }))
      .toThrow(/targetSummaryCjkCharacters.*positive integer/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, maxOutputTokens: 0 }))
      .toThrow(/maxOutputTokens.*positive integer/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, maxSummaryBytes: 0 }))
      .toThrow(/maxSummaryBytes.*positive integer/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionBriefLlmConfig({ ...BRIEF_CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(resolveSessionBriefLlmConfig(BRIEF_CONFIG)).toMatchObject(BRIEF_CONFIG)
  })
})

describe('applySessionSummaryEvent', () => {
  it('takes the summary from a session/summary event and keeps every other state reference-stable', () => {
    const event = { type: 'session/summary', data: { summary: 'Fresh summary.', messageSeqs: [1] } } as SessionEvent
    expect(applySessionSummaryEvent(null, event)).toBe('Fresh summary.')
    expect(applySessionSummaryEvent('Prior summary.', event)).toBe('Fresh summary.')
    const unrelated = { type: 'turn/end', data: {} } as SessionEvent
    const prior = 'Unchanged summary.'
    expect(applySessionSummaryEvent(prior, unrelated)).toBe(prior)
  })
})

describe('registerSessionBriefLlmProvider', () => {
  it('registers the sole title provider plus the summary projection unit that folds appended events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
    const adapter = new RecordingAdapter(briefScript(
      '{"name": "Projection name", "summary": "Projection summary sentence."}',
    ))
    ctx.llm.registerAdapter(['title-route'], adapter)
    registerSessionBriefLlmProvider(ctx, {
      ...BRIEF_CONFIG,
      provider: 'title-route',
      model: 'title-model',
    }, 'test-brief-provider', 'first-prompt', messages => [messages[0]!])

    const session = ctx.sessions.create(SessionId('brief-projection'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'project the summary' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await ctx.sessionTitle.refresh(session)

    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Projection name',
      source: {
        kind: 'provider',
        provider: 'test-brief-provider',
        model: { provider: 'title-route', model: 'title-model' },
      },
    })
    expect(ctx.sessionProjections.stateOf(session, 'summary')).toBe('Projection summary sentence.')
    expect(ctx.sessionProjections.stateOf(session, 'title')).toBe('Projection name')
    expect(ctx.sessionProjections.snapshot(session).values).toMatchObject({
      title: 'Projection name',
      summary: 'Projection summary sentence.',
    })
    expect(first.seq).toBeGreaterThan(0)
  })

  it('fails loud when another provider already owns the seat, before any projection registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('occupant'),
      automatic: 'first-prompt',
      async generate() { throw new Error('never called') },
    })
    expect(() => {
      registerSessionBriefLlmProvider(ctx, BRIEF_CONFIG, 'second-provider', 'first-prompt', messages => [messages[0]!])
    }).toThrow(/already registered/)
  })
})
