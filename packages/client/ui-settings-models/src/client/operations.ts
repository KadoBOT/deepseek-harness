/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationAttemptId, AuthorizationAttemptView, AuthorizationFlowView, AuthorizationPromptId,
  CredentialInfo, CredentialKey, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** Result of a browser authorization mutation. */
export type AuthorizationActionOutcome =
  | { readonly attempt: AuthorizationAttemptView }
  | { readonly refused: string }

/** Result of listing browser authorization flows. */
export type AuthorizationListOutcome =
  | { readonly flows: readonly AuthorizationFlowView[] }
  | { readonly refused: string }

type RemoteCallResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

/** The generated Remote namespace's authorization face. Kept local so this
 * package remains source-compatible while the assembly regenerates its face. */
interface AuthorizationRemote {
  list(): Promise<RemoteCallResult<readonly AuthorizationFlowView[]>>
  begin(key: CredentialKey, method: string): Promise<RemoteCallResult<AuthorizationAttemptView>>
  read(id: AuthorizationAttemptId): Promise<RemoteCallResult<AuthorizationAttemptView>>
  respond(id: AuthorizationAttemptId, promptId: AuthorizationPromptId, answer: string): Promise<RemoteCallResult<AuthorizationAttemptView>>
  cancel(id: AuthorizationAttemptId): Promise<RemoteCallResult<AuthorizationAttemptView>>
  disconnect(key: CredentialKey): Promise<RemoteCallResult<void>>
}

function authorizationRemote(ctx: ClientContext): AuthorizationRemote {
  return (ctx.remote as unknown as { authorization: AuthorizationRemote }).authorization
}

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when the reference is unknown or the read was refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
  /** List metadata for account-connection flows; secrets never cross this face. */
  listAuthorization(): Promise<AuthorizationListOutcome>
  /** Start one provider's OAuth flow. */
  beginAuthorization(key: CredentialKey, method: string): Promise<AuthorizationActionOutcome>
  /** Poll one pending authorization attempt. */
  readAuthorization(id: AuthorizationAttemptId): Promise<AuthorizationActionOutcome>
  /** Answer one visible authorization prompt. */
  respondAuthorization(id: AuthorizationAttemptId, promptId: AuthorizationPromptId, answer: string): Promise<AuthorizationActionOutcome>
  /** Cancel one pending authorization attempt. */
  cancelAuthorization(id: AuthorizationAttemptId): Promise<AuthorizationActionOutcome>
  /** Disconnect and remove one provider grant. */
  disconnectAuthorization(key: CredentialKey): Promise<string | undefined>
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
    listAuthorization: async () => {
      const response = await authorizationRemote(ctx).list()
      return response.ok ? { flows: response.value } : { refused: response.error.message }
    },
    beginAuthorization: async (key, method) => {
      const response = await authorizationRemote(ctx).begin(key, method)
      return response.ok ? { attempt: response.value } : { refused: response.error.message }
    },
    readAuthorization: async (id) => {
      const response = await authorizationRemote(ctx).read(id)
      return response.ok ? { attempt: response.value } : { refused: response.error.message }
    },
    respondAuthorization: async (id, promptId, answer) => {
      const response = await authorizationRemote(ctx).respond(id, promptId, answer)
      return response.ok ? { attempt: response.value } : { refused: response.error.message }
    },
    cancelAuthorization: async (id) => {
      const response = await authorizationRemote(ctx).cancel(id)
      return response.ok ? { attempt: response.value } : { refused: response.error.message }
    },
    disconnectAuthorization: async (key) => {
      const response = await authorizationRemote(ctx).disconnect(key)
      return response.ok ? undefined : response.error.message
    },
  }
}
