import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, { AuthorizationError, type AuthorizationFlow, type AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SettingsController from '../src/index.ts'
import { AuthorizationController } from '../src/authorization.ts'
import type { AuthorizationPromptId } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OTHER = credentialKey('llm-pi-ai', 'anthropic')

async function boot(run: AuthorizationFlow['run'] = async () => undefined, config: { authTimeoutMs?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  ctx.authorization.registerFlow(committingFlow(ctx, run))
  await ctx.plugin(SettingsController, config)
  return { ctx, controller: ctx.authorizationController }
}

function committingFlow(ctx: Context, run: AuthorizationFlow['run'] = async () => undefined): AuthorizationFlow {
  return {
    key: KEY,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    async run(session) {
      await run(session)
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: 'host-only' } }))
    },
  }
}

describe('authorization Remote namespace', () => {
  it('validates authTimeoutMs configuration in constructor', () => {
    expect(() => new AuthorizationController(new Context(), { authTimeoutMs: -1 })).toThrow(TypeError)
    expect(() => new AuthorizationController(new Context(), { authTimeoutMs: 0 })).toThrow(TypeError)
    expect(() => new AuthorizationController(new Context(), { authTimeoutMs: NaN })).toThrow(TypeError)
    expect(() => new AuthorizationController(new Context(), { authTimeoutMs: 3_000_000_000 })).toThrow(TypeError)
    expect(() => new AuthorizationController(new Context(), { authTimeoutMs: 1000 })).not.toThrow()
  })

  it('publishes the generated methods and lists metadata without an auth service', async () => {
    const ctx = new Context()
    await ctx.plugin(SettingsController)
    expect(remoteMethods(ctx.authorizationController)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'begin', invocation: { kind: 'direct' } },
      { method: 'read', invocation: { kind: 'direct' } },
      { method: 'respond', invocation: { kind: 'direct' } },
      { method: 'cancel', invocation: { kind: 'direct' } },
      { method: 'disconnect', invocation: { kind: 'direct' } },
    ])
    await expect(ctx.authorizationController.list()).resolves.toEqual([])
  })

  it('projects notices and prompts, resolves responses, and never retains the answer', async () => {
    const answer = Promise.withResolvers<string>()
    const { controller } = await boot(async (session) => {
      session.notify({ message: 'Plain notice without url or code' })
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start', code: 'ABCD' })
      answer.resolve(await session.prompt({ kind: 'secret', message: 'Paste the code', placeholder: 'code' }))
    })
    const pending = await controller.begin(KEY, 'oauth')
    expect(pending.status).toBe('pending')
    await vi.waitFor(() => { expect(controller.read(pending.id).prompt?.kind).toBe('secret') })
    const prompt = controller.read(pending.id).prompt!
    expect(controller.read(pending.id).notice).toEqual({
      message: 'Continue in your browser', url: 'https://auth.example/start', code: 'ABCD',
    })
    await expect(controller.respond(pending.id, prompt.id, 'secret-answer')).resolves.toMatchObject({ status: 'pending' })
    await vi.waitFor(() => { expect(controller.read(pending.id).status).toBe('authorized') })
    expect(JSON.stringify(controller.read(pending.id))).not.toContain('secret-answer')
  })

  it('rejects stale attempts and stale prompts after replacing a terminal attempt', async () => {
    const { ctx, controller } = await boot()
    const first = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(first.id).status).toBe('authorized') })
    const second = await controller.begin(KEY, 'oauth')
    expect(second.id).not.toBe(first.id)
    expect(remoteErrorOf(await Promise.resolve().then(() => controller.read(first.id)).catch((error: unknown) => error))).toMatchObject({ code: 'authorization/not-found' })
    await controller.cancel(second.id)
    await expect(controller.disconnect(OTHER)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('cancels and awaits a flow, then disconnects exactly its record', async () => {
    const { ctx, controller } = await boot()
    const pending = await controller.begin(KEY, 'oauth')
    await controller.cancel(pending.id)
    expect(controller.read(pending.id).status).toBe('cancelled')
    await ctx.credentials.modifyRecord(OTHER, () => Promise.resolve({ kind: 'grant', payload: { token: 'keep' } }))
    await controller.disconnect(KEY)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(await ctx.credentials.readRecord(OTHER)).toEqual({ kind: 'grant', payload: { token: 'keep' } })
  })

  it('marks timeout as failed and disposes a pending prompt', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key: OTHER,
      label: 'Other',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.prompt({ kind: 'text', message: 'wait forever' })
      },
    })
    await ctx.plugin(SettingsController, { authTimeoutMs: 10 })
    const controller = ctx.authorizationController
    const pending = await controller.begin(OTHER, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending.id).status).toBe('failed') }, { timeout: 1000 })
    expect(controller.read(pending.id).error).toContain('timed out')
  })

  it('lists flows with various record and attempt states', async () => {
    const { ctx, controller } = await boot()
    const listBefore = await controller.list()
    expect(listBefore).toHaveLength(1)
    expect(listBefore[0]?.configured).toBe(false)
    expect(listBefore[0]?.inFlight).toBe(false)

    // Start attempt to verify inFlight and attempt view projection in list
    const attempt = await controller.begin(KEY, 'oauth')
    const listDuring = await controller.list()
    expect(listDuring[0]?.attempt?.id).toBe(attempt.id)

    await vi.waitFor(() => { expect(controller.read(attempt.id).status).toBe('authorized') })
    const listAfter = await controller.list()
    expect(listAfter[0]?.configured).toBe(true)
    expect(listAfter[0]?.credentialKind).toBe('grant')
    expect(listAfter[0]?.inFlight).toBe(false)

    // Mock describeRecord returning undefined to cover ?? false branch in flowView
    vi.spyOn(ctx.credentials, 'describeRecord').mockResolvedValue(undefined as unknown as CredentialRecordInfo)
    const listUnconfigured = await controller.list()
    expect(listUnconfigured[0]?.configured).toBe(false)
    expect(listUnconfigured[0]?.credentialKind).toBeUndefined()

    // Test disconnect when credentials service is absent on ctx
    const originalGet = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((name: string): unknown => {
      if (name === 'credentials') return undefined
      return originalGet(name) as unknown
    })
    await expect(controller.disconnect(KEY)).resolves.toBeUndefined()

    // List after disposal returns []
    await ctx.fiber.dispose()
    expect(await controller.list()).toEqual([])
  })

  it('validates begin arguments and error conditions', async () => {
    const { ctx, controller } = await boot(async (session) => {
      await session.prompt({ kind: 'text', message: 'wait' })
    })

    // Bad key
    expect(() => controller.begin('invalid-key' as CredentialKey, 'oauth'))
      .toThrow()

    // Missing flow
    expect(() => controller.begin(OTHER, 'oauth'))
      .toThrow(/was not found/)

    // Invalid method
    expect(() => controller.begin(KEY, 'invalid-method'))
      .toThrow(/is unavailable/)

    // First attempt starts
    const pending = await controller.begin(KEY, 'oauth')

    // Attempting to begin another while running fails with busy
    expect(() => controller.begin(KEY, 'oauth'))
      .toThrow(/is already running/)

    // Cancel and clean up
    await controller.cancel(pending.id)
    await ctx.fiber.dispose()

    // Calling begin after disposal fails
    expect(() => controller.begin(KEY, 'oauth'))
      .toThrow(/disposed/)
  })

  it('requires authorization service when calling begin', async () => {
    const ctx = new Context()
    await ctx.plugin(SettingsController)
    expect(() => ctx.authorizationController.begin(KEY, 'oauth'))
      .toThrow(/authorization service is absent/)
  })

  it('validates respond error handling and prompt types', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Select Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        session.notify({ message: 'Ignore invalid url', url: 'javascript:alert(1)' })
        const choice = await session.prompt({
          kind: 'select',
          message: 'Pick one',
          options: [{ id: 'opt1', label: 'Option 1' }],
        })
        if (choice === 'fail-auth-error') throw new AuthorizationError('Auth domain failure', 'AUTH_FAILED')
        if (choice === 'fail-string') throw 'raw string failure'
        if (choice === 'fail-error') throw new Error('generic failure')
      },
    })
    await ctx.plugin(SettingsController)
    const controller = ctx.authorizationController

    const pending = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending.id).prompt?.kind).toBe('select') })

    // Invalid prompt id
    expect(() => controller.respond(pending.id, 'wrong-prompt' as AuthorizationPromptId, 'opt1'))
      .toThrow(/no longer pending/)

    // Respond with fail-auth-error to verify AuthorizationError mapping
    await controller.respond(pending.id, controller.read(pending.id).prompt!.id, 'fail-auth-error')
    await vi.waitFor(() => { expect(controller.read(pending.id).status).toBe('failed') })
    expect(controller.read(pending.id).error).toBe('Auth domain failure')

    // Test non-Error failure mapping
    const pending2 = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending2.id).prompt?.kind).toBe('select') })
    await controller.respond(pending2.id, controller.read(pending2.id).prompt!.id, 'fail-string')
    await vi.waitFor(() => { expect(controller.read(pending2.id).status).toBe('failed') })
    expect(controller.read(pending2.id).error).toBe('raw string failure')

    // Test generic Error failure mapping
    const pending3 = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending3.id).prompt?.kind).toBe('select') })
    await controller.respond(pending3.id, controller.read(pending3.id).prompt!.id, 'fail-error')
    await vi.waitFor(() => { expect(controller.read(pending3.id).status).toBe('failed') })
    expect(controller.read(pending3.id).error).toBe('generic failure')
  })

  it('handles prompt with custom signal and cancel on terminal attempt', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    const abortPrompt = new AbortController()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Abort Prompt Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.prompt({
          kind: 'text',
          message: 'Enter token',
          signal: abortPrompt.signal,
        })
      },
    })
    await ctx.plugin(SettingsController)
    const controller = ctx.authorizationController

    const pending = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending.id).prompt).toBeDefined() })

    // Abort the prompt signal
    abortPrompt.abort()
    await vi.waitFor(() => { expect(controller.read(pending.id).status).toBe('failed') })

    // Cancel on an already terminal attempt returns its view without re-cancelling
    const cancelView = await controller.cancel(pending.id)
    expect(cancelView.status).toBe('failed')

    // Disconnect when an attempt is pending aborts the attempt and deletes credentials
    const pendingToDisconnect = await controller.begin(KEY, 'oauth')
    await controller.disconnect(KEY)
    expect(controller.read(pendingToDisconnect.id).status).toBe('cancelled')
  })

  it('handles flow unregistration during attempt lifecycle', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    const unregister = ctx.authorization.registerFlow({
      key: KEY,
      label: 'Ephemeral',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.prompt({ kind: 'text', message: 'wait' })
      },
    })
    await ctx.plugin(SettingsController)
    const controller = ctx.authorizationController
    const pending = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending.id).prompt).toBeDefined() })

    // Deregister the flow
    unregister()

    // Reading attempt after flow is gone removes attempt and throws not-found
    expect(() => controller.read(pending.id)).toThrow(/not found/)
  })

  it('rejects prompt when attempt is no longer active', async () => {
    let savedSession: AuthorizationSession | undefined
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Late Prompt Flow',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        savedSession = session
        await session.prompt({ kind: 'text', message: 'Initial' })
      },
    })
    await ctx.plugin(SettingsController)
    const controller = ctx.authorizationController
    const pending = await controller.begin(KEY, 'oauth')
    await vi.waitFor(() => { expect(controller.read(pending.id).prompt).toBeDefined() })

    // Cancel the attempt so status is no longer pending
    await controller.cancel(pending.id)

    // Late prompt rejects immediately
    expect(savedSession).toBeDefined()
    if (savedSession !== undefined) {
      await expect(savedSession.prompt({ kind: 'text', message: 'Late' }))
        .rejects.toThrow('authorization attempt is no longer active')
    }
  })
})
