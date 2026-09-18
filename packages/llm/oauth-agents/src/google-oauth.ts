/**
 * Google OAuth 2.0 client for the Gemini Code Assist flow: the same OAuth
 * client and loopback redirect style gemini-cli's web sign-in uses, with PKCE
 * and an ephemeral port served by {@link ./google-callback.ts}. Token exchange,
 * refresh, and the display email all run through {@link Http}.
 * @module @deepseek-ai/dsh-oauth-agents/google-oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { requestError, type Http } from './http.ts'

/** Google OAuth endpoints. No credential is bundled: shipping a shared client
 * secret would publish it to every checkout, so the Code Assist flow stays
 * broken until these arrive from runtime configuration. */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GOOGLE_CLIENT_ID = ''
const GOOGLE_CLIENT_SECRET = ''
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/cloud-platform'
  + ' https://www.googleapis.com/auth/userinfo.email'
  + ' https://www.googleapis.com/auth/userinfo.profile'

/** Google token payload; `refresh_token` is absent on refresh grants that kept the original. */
export interface GoogleTokens {
  readonly access_token: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
  readonly error_description?: string
  readonly raw?: string
}

/** Narrow one token-endpoint response, refusing every refusal shape Google answers with. */
function expectTokens(response: { status: number; body: unknown }, what: string): GoogleTokens {
  const body = response.body
  const tokens = (body !== null && typeof body === 'object') ? body as GoogleTokens : undefined
  if (tokens === undefined || typeof tokens.access_token !== 'string' || tokens.access_token === '') {
    const detail = tokens === undefined
      ? `HTTP ${response.status} response carried no JSON token object`
      : (tokens.error_description ?? tokens.error
        ?? (typeof (body as { raw?: unknown }).raw === 'string' ? (body as { raw: string }).raw : `HTTP ${response.status}`))
    throw requestError(`${what}: ${detail}`, 'AUTH', response.status === 0 ? undefined : response.status)
  }
  return tokens
}

/** PKCE verifier/challenge pair plus the state parameter, generated per sign-in attempt. */
export interface GoogleAuthChallenge {
  /** The RFC 7636 code_verifier handed to the token exchange. */
  readonly verifier: string
  /** The S256 code_challenge sent in the authorization URL. */
  readonly challenge: string
  /** The state parameter carried through the authorization request. */
  readonly state: string
}

/**
 * Generate the PKCE material one sign-in attempt binds to.
 * @returns the verifier/challenge/state triple.
 */
export function authChallenge(): GoogleAuthChallenge {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  return { verifier, challenge, state }
}

/**
 * Build the authorization URL a human must open in their browser, mirroring
 * gemini-cli's web sign-in: a loopback redirect with PKCE S256 and state. The
 * same redirect_uri must be presented again at the token exchange, where a
 * mismatch is what Google answers with `redirect_uri_mismatch`.
 * @param challenge - the attempt's PKCE material.
 * @param redirectUri - the loopback callback URL the receiver listens on.
 * @returns the consent URL.
 */
export function authUrl(challenge: GoogleAuthChallenge, redirectUri: string): string {
  return `${GOOGLE_AUTH_URL}?` + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    code_challenge: challenge.challenge,
    code_challenge_method: 'S256',
    state: challenge.state,
  }).toString()
}

/**
 * Extract the authorization code from what the user submitted: either the bare
 * code or the whole callback URL the browser landed on when the receiver was
 * unreachable.
 * @param input - the pasted code or callback URL.
 * @returns the authorization code.
 */
export function codeFromCallbackInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.includes('code=')) return trimmed
  try {
    const code = new URL(trimmed).searchParams.get('code')
    if (code !== null && code !== '') return code
  } catch {
    // Not a URL; hand the raw text to the exchange.
  }
  return trimmed
}

/**
 * Exchange one manual authorization code for tokens.
 * @param http - the curl HTTP client.
 * @param code - the code Google showed after account selection.
 * @param challenge - the PKCE material the authorization URL was built with.
 * @returns the token response.
 * @throws {RequestError} with code `AUTH` when Google refuses the exchange.
 */
export async function exchangeCode(
  http: Http,
  code: string,
  challenge: GoogleAuthChallenge,
  redirectUri: string,
): Promise<GoogleTokens> {
  // Google binds the code to the redirect_uri of the authorization request:
  // the exchange must present the identical loopback URL or it answers
  // `redirect_uri_mismatch` with HTTP 400.
  const response = await http.postForm(GOOGLE_TOKEN_URL, {
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: challenge.verifier,
  })
  return expectTokens(response, 'Gemini token exchange failed')
}

/**
 * Refresh an access token from a refresh token.
 * @param http - the curl HTTP client.
 * @param refreshToken - the stored Google refresh token.
 * @returns the refreshed token response.
 * @throws {RequestError} with code `AUTH` when Google refuses the refresh.
 */
export async function refreshAccessToken(http: Http, refreshToken: string): Promise<GoogleTokens> {
  const response = await http.postForm(GOOGLE_TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  })
  return expectTokens(response, 'Gemini token refresh failed')
}

/**
 * Read the signed-in account's email for display purposes only.
 * @param http - the curl HTTP client.
 * @param accessToken - the fresh access token.
 * @returns the email, or `undefined` when userinfo is unavailable.
 */
export async function userEmail(http: Http, accessToken: string): Promise<string | undefined> {
  try {
    const response = await http.getJson(GOOGLE_USERINFO_URL, { Authorization: `Bearer ${accessToken}` })
    if (response.status === 200 && response.body !== null && typeof response.body === 'object') {
      const email = (response.body as { email?: unknown }).email
      if (typeof email === 'string') return email
    }
  } catch {
    // The account label is display-only.
  }
  return undefined
}
