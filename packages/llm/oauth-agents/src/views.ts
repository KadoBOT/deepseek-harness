/**
 * Wire-safe vocabulary shared by the Host and Client faces: the fixed provider
 * catalog the Host authorizes and the Client renders. Free of service imports
 * so the browser bundle can consume it without loading the Host half.
 * @module @deepseek-ai/dsh-oauth-agents/views
 */

/** One external AI provider this plugin knows how to authorize. */
export interface OAuthProviderView {
  /** Stable provider id the tools and the Models-page card use. */
  readonly id: 'chatgpt' | 'grok' | 'gemini'
  /** User-facing display name. */
  readonly label: string
  /** One-line hint of what the sign-in asks the human to do. */
  readonly signinHint: string
}

/** The fixed provider catalog, in card display order. Both faces read this. */
export const OAUTH_PROVIDER_VIEWS: readonly OAuthProviderView[] = [
  {
    id: 'gemini',
    label: 'Gemini (Google account)',
    signinHint: 'Open the Google sign-in page, then paste the authorization code shown after you choose an account.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT (Codex)',
    signinHint: 'Open the sign-in page in your browser, sign in, and the connection completes on its own.',
  },
  {
    id: 'grok',
    label: 'Grok (xAI)',
    signinHint: 'Open the device-activation page in your browser and enter the code shown with it.',
  },
]
