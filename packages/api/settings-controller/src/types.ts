/**
 * Browser-safe type surface of the settings, credential, and authorization
 * configuration surfaces this package serves. The redacted settings views
 * themselves live with their seam in `@deepseek-ai/dsh-settings/types`.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'

/** Opaque id for one Host-owned authorization attempt. */
export type AuthorizationAttemptId = Branded<'AuthorizationAttemptId'>

/** Opaque id for one pending authorization prompt. */
export type AuthorizationPromptId = Branded<'AuthorizationPromptId'>

/** Browser-safe prompt option. */
export interface AuthorizationPromptOptionView {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** Browser-safe prompt projection, including its opaque response id. */
export type AuthorizationPromptView =
  | { readonly id: AuthorizationPromptId; readonly kind: 'text' | 'secret'; readonly message: string; readonly placeholder?: string }
  | { readonly id: AuthorizationPromptId; readonly kind: 'select'; readonly message: string; readonly options: readonly AuthorizationPromptOptionView[] }

/** Browser-safe projection of one authorization attempt. */
export interface AuthorizationAttemptView {
  readonly id: AuthorizationAttemptId
  readonly key: CredentialKey
  readonly status: 'pending' | 'authorized' | 'cancelled' | 'failed'
  readonly notice?: { readonly message: string; readonly url?: string; readonly code?: string }
  readonly prompt?: AuthorizationPromptView
  readonly error?: string
}

/** Browser-safe projection of one registered authorization flow. */
export interface AuthorizationFlowView {
  readonly key: CredentialKey
  readonly label: string
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  readonly configured: boolean
  readonly credentialKind?: 'api-key' | 'grant'
  readonly inFlight: boolean
  readonly attempt?: AuthorizationAttemptView
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A requested flow or attempt is no longer registered. */
    'authorization/not-found': { readonly id?: AuthorizationAttemptId; readonly key?: CredentialKey }
    /** A flow already has a browser attempt in progress. */
    'authorization/busy': { readonly key: CredentialKey }
    /** A valid authorization request was refused by the flow registry. */
    'authorization/rejected': { readonly key: CredentialKey }
    /** A prompt response arrived after the flow moved on or ended. */
    'authorization/prompt-not-found': { readonly id: AuthorizationAttemptId; readonly promptId: AuthorizationPromptId }
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }
