/**
 * The fixed provider catalog this plugin authorizes: which credential record
 * and LLM route each provider id maps to. ChatGPT and Grok ride pi-ai's own
 * flows and settings profiles; Gemini is this plugin's own flow and adapter.
 * @module @deepseek-ai/dsh-oauth-agents/providers
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'

/** Credential record this plugin owns. */
export const GEMINI_KEY: CredentialKey = credentialKey('oauth-agents', 'gemini')

/** LLM provider route registered by the Gemini adapter. */
export const GEMINI_PROVIDER = 'gemini-code-assist'

/** Gemini Code Assist API base and the client metadata every call carries. */
export const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com'
export const CODE_ASSIST_CLIENT_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const

/** One model the Gemini adapter advertises. */
export interface GeminiModelInfo {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
}

/** The Gemini model catalog gemini-cli currently serves for Code Assist
 * accounts, in adapter-preferred order (pro tiers, then flash tiers, stable
 * 2.5, then the experimental Gemma models). */
export const GEMINI_MODELS: readonly GeminiModelInfo[] = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', contextWindow: 131072, maxTokens: 8192 },
  { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B', contextWindow: 131072, maxTokens: 8192 },
]

/** Host-side catalog entry for one authorizable provider. */
export interface ProviderEntry {
  /** Credential record the authorization flow writes. */
  readonly key: CredentialKey
  /** User-facing display name. */
  readonly label: string
  /** LLM route the provider's models ride. */
  readonly route: string
  /** Recommended model for a default-model selection. */
  readonly defaultModel: string
  /** True when this plugin registers the authorization flow itself. */
  readonly own: boolean
  /** Settings namespace whose provider profile is added after connecting; absent for the own route. */
  readonly settingsNs?: string
  /** Provider profile id added into {@link ProviderEntry.settingsNs}. */
  readonly settingsProfile?: string
}

/** The fixed provider catalog, keyed by the tool-facing provider id. */
export const PROVIDERS: Readonly<Record<'chatgpt' | 'grok' | 'gemini', ProviderEntry>> = {
  gemini: {
    key: GEMINI_KEY,
    label: 'Gemini (Google account)',
    route: GEMINI_PROVIDER,
    defaultModel: 'gemini-3.5-flash',
    own: true,
  },
  chatgpt: {
    key: credentialKey('llm-pi-ai', 'openai-codex'),
    label: 'ChatGPT (Codex)',
    route: 'openai-codex',
    defaultModel: 'gpt-5.6-terra',
    own: false,
    settingsNs: 'llm-pi-ai',
    settingsProfile: 'openai-codex',
  },
  grok: {
    key: credentialKey('llm-pi-ai', 'xai'),
    label: 'Grok (xAI)',
    route: 'xai',
    defaultModel: 'grok-4.6',
    own: false,
    settingsNs: 'llm-pi-ai',
    settingsProfile: 'xai',
  },
}

/** The catalog's provider ids in card display order. */
export const PROVIDER_IDS = ['gemini', 'chatgpt', 'grok'] as const
