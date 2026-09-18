/**
 * Host Remote owner for browser-driven authorization flows.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AuthorizationError,
  type AuthorizationEntry,
  type AuthorizationPrompt,
  type AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationPromptView,
  AuthorizationAttemptId,
  AuthorizationPromptId,
} from './types.ts'

const AUTH_TIMEOUT_CODE = 'AUTHORIZATION_TIMEOUT'
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000

interface PendingPrompt {
  readonly id: AuthorizationPromptId
  readonly source: AuthorizationPrompt
  readonly resolve: (answer: string) => void
  readonly reject: (error: unknown) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

interface AttemptState {
  readonly id: AuthorizationAttemptId
  readonly key: CredentialKey
  readonly controller: AbortController
  readonly done: Promise<void>
  resolveDone: () => void
  status: AuthorizationAttemptView['status']
  notice?: AuthorizationAttemptView['notice']
  prompt?: PendingPrompt | undefined
  error?: string
}

/** Host configuration for the authorization Remote owner. */
export interface AuthorizationControllerConfig {
  /** Maximum time one browser authorization flow may run; positive and at most MAX_TIMER_DELAY_MS. */
  readonly authTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/**
 * Host service backing `ctx.remote.authorization`. It keeps browser-safe
 * projections of the authorization service's live interactions; credential
 * values and prompt answers never enter retained state.
 */
export class AuthorizationController extends TypertRemoteService {
  private readonly timeoutMs: number
  private readonly byKey = new Map<CredentialKey, AttemptState>()
  private readonly byId = new Map<AuthorizationAttemptId, AttemptState>()
  private readonly tasks = new Set<Promise<void>>()
  private disposed = false

  /** @param ctx - host context containing optional authorization and credential services. */
  constructor(ctx: Context, config: AuthorizationControllerConfig = {}) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
    const requested = config.authTimeoutMs
    if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0 || requested > MAX_TIMER_DELAY_MS)) {
      throw new TypeError(`authTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    this.timeoutMs = requested ?? DEFAULT_AUTH_TIMEOUT_MS
    ctx.effect(() => async () => {
      this.disposed = true
      for (const attempt of this.byKey.values()) attempt.controller.abort()
      await Promise.all([...this.byKey.values()].map(attempt => attempt.done))
      await Promise.all([...this.tasks])
      this.byKey.clear()
      this.byId.clear()
    }, 'authorization-controller.teardown')
  }

  /**
   * List registered flows and their redacted credential metadata.
   * @returns one browser-safe view per registered flow.
   */
  @Remote
  async list(): Promise<AuthorizationFlowView[]> {
    if (this.disposed) return []
    const authorization = this.authorization()
    if (authorization === undefined) return []
    const entries = authorization.list()
    return Promise.all(entries.map(entry => this.flowView(entry)))
  }

  /**
   * Start one flow and return its pending attempt handle promptly.
   * @param key - credential key owned by a registered authorization flow.
   * @param method - method id selected from that flow's metadata.
   * @returns the pending attempt view.
   */
  @Remote
  begin(key: CredentialKey, method: string): Promise<AuthorizationAttemptView> {
    this.ensureActive()
    const parsedKey = this.key(key)
    const authorization = this.requireAuthorization()
    const entry = authorization.describe(parsedKey)
    if (entry === undefined) throw this.notFound('key', parsedKey)
    if (!entry.methods.some(candidate => candidate.id === method)) {
      throw new RemoteError('authorization/rejected', `authorization method "${method}" is unavailable`, { key: parsedKey })
    }
    const current = this.byKey.get(parsedKey)
    if (current?.status === 'pending') {
      throw new RemoteError('authorization/busy', `an authorization attempt for "${parsedKey}" is already running`, { key: parsedKey })
    }
    if (current !== undefined) this.remove(current)

    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const attempt: AttemptState = {
      id: brandString<AuthorizationAttemptId>(randomUUID()),
      key: parsedKey,
      controller: new AbortController(),
      done,
      resolveDone,
      status: 'pending',
    }
    this.byKey.set(parsedKey, attempt)
    this.byId.set(attempt.id, attempt)
    const task = this.run(attempt, authorization, method)
    this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task) })
    return Promise.resolve(this.view(attempt))
  }

  /**
   * Read the current projection of the latest attempt.
   * @param id - opaque attempt id returned by {@link begin}.
   * @returns the latest view for that attempt.
   */
  @Remote
  read(id: AuthorizationAttemptId): AuthorizationAttemptView {
    return this.view(this.requireAttempt(id))
  }

  /**
   * Resolve the currently displayed prompt without retaining its answer.
   * @param id - opaque attempt id returned by {@link begin}.
   * @param promptId - opaque prompt id carried by the current prompt view.
   * @param answer - text supplied for the prompt; it is consumed immediately.
   * @returns the attempt view after accepting the answer.
   */
  @Remote
  respond(
    id: AuthorizationAttemptId,
    promptId: AuthorizationPromptId,
    answer: string,
  ): Promise<AuthorizationAttemptView> {
    this.ensureActive()
    const attempt = this.requireAttempt(id)
    const prompt = attempt.prompt
    if (attempt.status !== 'pending' || prompt === undefined || prompt.id !== promptId) {
      throw new RemoteError('authorization/prompt-not-found', 'authorization prompt is no longer pending', { id, promptId })
    }
    this.clearPrompt(attempt, prompt)
    prompt.resolve(answer)
    return Promise.resolve(this.view(attempt))
  }

  /**
   * Cancel an attempt and wait until its flow releases its prompt and slot.
   * @param id - opaque attempt id returned by {@link begin}.
   * @returns the terminal attempt view.
   */
  @Remote
  async cancel(id: AuthorizationAttemptId): Promise<AuthorizationAttemptView> {
    this.ensureActive()
    const attempt = this.requireAttempt(id)
    if (attempt.status === 'pending') {
      attempt.controller.abort()
      await attempt.done
    }
    return this.view(attempt)
  }

  /**
   * Cancel this flow's owned attempt, then remove exactly its credential record.
   * @param key - credential key whose record should be disconnected.
   * @returns after the attempt is cancelled and the exact record is removed.
   */
  @Remote
  async disconnect(key: CredentialKey): Promise<void> {
    this.ensureActive()
    const parsedKey = this.key(key)
    const attempt = this.byKey.get(parsedKey)
    if (attempt?.status === 'pending') {
      attempt.controller.abort()
      await attempt.done
    }
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) await credentials.deleteRecord(parsedKey)
  }

  private authorization(): AuthorizationService | undefined {
    return this.ctx.get('authorization')
  }

  private ensureActive(): void {
    if (this.disposed) throw new RemoteError('gateway/cancelled', 'authorization controller is disposed', {})
  }

  private requireAuthorization(): AuthorizationService {
    const authorization = this.authorization()
    if (authorization === undefined) {
      throw new RemoteError('gateway/internal', 'authorization service is absent: this deployment mounts no authorization flows', {})
    }
    return authorization
  }

  private credentials(): CredentialProvider | undefined {
    return this.ctx.get('credentials')
  }

  private async flowView(entry: AuthorizationEntry): Promise<AuthorizationFlowView> {
    const record = await this.credentials()?.describeRecord(entry.key)
    const attempt = this.byKey.get(entry.key)
    return {
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      configured: record?.configured ?? false,
      ...record?.kind === undefined ? {} : { credentialKind: record.kind },
      inFlight: entry.inFlight || attempt?.status === 'pending',
      ...attempt === undefined ? {} : { attempt: this.view(attempt) },
    }
  }

  private async run(attempt: AttemptState, authorization: AuthorizationService, method: string): Promise<void> {
    const d = deadline(attempt.controller.signal, this.timeoutMs, AUTH_TIMEOUT_CODE)
    try {
      const outcome = await authorization.begin({
        key: attempt.key,
        method,
        signal: d.signal,
        interaction: {
          notify: (notice) => { this.notify(attempt, notice) },
          prompt: prompt => this.prompt(attempt, prompt),
        },
      })
      if (timeoutOf(d.signal, AUTH_TIMEOUT_CODE) !== undefined) {
        this.fail(attempt, `authorization timed out after ${this.timeoutMs}ms`)
      } else {
        this.finish(attempt, outcome.status)
      }
    } catch (error: unknown) {
      this.fail(attempt, messageOf(error))
    } finally {
      this.clearPrompt(attempt, attempt.prompt)
      d[Symbol.dispose]()
      attempt.resolveDone()
    }
  }

  private notify(attempt: AttemptState, notice: { message: string; url?: string; code?: string }): void {
    if (!this.current(attempt) || attempt.status !== 'pending'
      || (notice.url !== undefined && !/^https?:$/i.test(new URL(notice.url).protocol))) return
    attempt.notice = {
      message: notice.message,
      ...notice.url === undefined ? {} : { url: notice.url },
      ...notice.code === undefined ? {} : { code: notice.code },
    }
  }

  private prompt(attempt: AttemptState, prompt: AuthorizationPrompt): Promise<string> {
    if (!this.current(attempt) || attempt.status !== 'pending') return Promise.reject(new Error('authorization attempt is no longer active'))
    this.clearPrompt(attempt, attempt.prompt)
    const id = brandString<AuthorizationPromptId>(randomUUID())
    const signal = prompt.signal === undefined
      ? attempt.controller.signal
      : AbortSignal.any([attempt.controller.signal, prompt.signal])
    let resolve!: (answer: string) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })
    const source: AuthorizationPrompt = prompt.kind === 'select'
      ? { kind: 'select', message: prompt.message, options: prompt.options.map(option => ({ ...option })) }
      : {
        kind: prompt.kind,
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    const pending: PendingPrompt = { id, source, resolve, reject, signal, onAbort: () => {
      this.clearPrompt(attempt, pending)
      reject(new Error('authorization prompt was cancelled'))
    } }
    attempt.prompt = pending
    if (signal.aborted) pending.onAbort()
    else signal.addEventListener('abort', pending.onAbort, { once: true })
    return promise
  }

  private clearPrompt(attempt: AttemptState, prompt: PendingPrompt | undefined): void {
    if (prompt === undefined || attempt.prompt !== prompt) return
    attempt.prompt = undefined
    prompt.signal.removeEventListener('abort', prompt.onAbort)
  }

  private finish(attempt: AttemptState, status: 'authorized' | 'cancelled'): void {
    if (!this.current(attempt)) return
    attempt.status = status
  }

  private fail(attempt: AttemptState, error: string): void {
    attempt.status = 'failed'
    attempt.error = error
  }

  private current(attempt: AttemptState): boolean {
    return !this.disposed && this.byKey.get(attempt.key) === attempt && this.byId.get(attempt.id) === attempt
  }

  private view(attempt: AttemptState): AuthorizationAttemptView {
    return {
      id: attempt.id,
      key: attempt.key,
      status: attempt.status,
      ...attempt.notice === undefined ? {} : { notice: { ...attempt.notice } },
      ...attempt.prompt === undefined ? {} : { prompt: this.promptView(attempt.prompt) },
      ...attempt.error === undefined ? {} : { error: attempt.error },
    }
  }

  private promptView(prompt: PendingPrompt): AuthorizationPromptView {
    const source = prompt.source
    if (source.kind === 'select') {
      return { id: prompt.id, kind: 'select', message: source.message, options: source.options.map(option => ({ ...option })) }
    }
    return {
      id: prompt.id,
      kind: source.kind,
      message: source.message,
      ...source.placeholder === undefined ? {} : { placeholder: source.placeholder },
    }
  }

  private requireAttempt(id: AuthorizationAttemptId): AttemptState {
    const attempt = this.byId.get(id)
    if (attempt === undefined || this.byKey.get(attempt.key) !== attempt) throw this.notFound('id', id)
    if (this.authorization()?.describe(attempt.key) === undefined) {
      this.remove(attempt)
      throw this.notFound('id', id)
    }
    return attempt
  }

  private remove(attempt: AttemptState): void {
    this.byKey.delete(attempt.key)
    this.byId.delete(attempt.id)
  }

  private key(value: CredentialKey): CredentialKey {
    try { return parseCredentialKey(String(value)) }
    catch (error: unknown) { throw new RemoteError('gateway/bad-request', messageOf(error), {}) }
  }

  private notFound(subject: 'id' | 'key', value: string): RemoteError {
    return subject === 'id'
      ? new RemoteError('authorization/not-found', `authorization attempt "${value}" was not found`, { id: value as AuthorizationAttemptId })
      : new RemoteError('authorization/not-found', `authorization flow "${value}" was not found`, { key: value as CredentialKey })
  }
}

function messageOf(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export default AuthorizationController
