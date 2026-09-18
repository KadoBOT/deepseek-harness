/**
 * Loopback OAuth callback receiver for the Gemini flow: binds an ephemeral
 * 127.0.0.1 port, accepts Google's `/oauth2callback` redirect, validates the
 * state parameter, and hands the authorization code to the flow. Installed-app
 * clients are allowed any loopback port (RFC 8252 §7.3), which is exactly how
 * gemini-cli's web sign-in works.
 * @module @deepseek-ai/dsh-oauth-agents/google-callback
 */

import * as nodeHttp from 'node:http'
import type { AddressInfo } from 'node:net'
import { requestError } from './http.ts'

/** Google's page after a completed sign-in, matching gemini-cli's redirect target. */
const SIGN_IN_SUCCESS_URL = 'https://developers.google.com/gemini-code-assist/auth_success_gemini'
/** Google's page after a refused sign-in. */
const SIGN_IN_FAILURE_URL = 'https://developers.google.com/gemini-code-assist/auth_failure_gemini'

/** One bound callback receiver for a single sign-in attempt. */
export interface GoogleCallbackServer {
  /** The ephemeral loopback port the auth URL's redirect_uri must carry. */
  readonly port: number
  /**
   * Resolve with the authorization code from the first `/oauth2callback` visit
   * whose `state` echoes `expectedState`; a request carrying `error` rejects.
   * The promise stays pending until one arrives or {@link GoogleCallbackServer.close}.
   * @param expectedState - the state the authorization URL carried.
   * @returns the authorization code.
   */
  waitForAuthorizationCode(expectedState: string): Promise<string>
  /** Stop the listener and settle a still-pending wait; safe to call more than once. */
  close(): void
}

/**
 * Start the callback receiver on an ephemeral loopback port.
 * @returns the receiver, resolved once the listener is bound.
 */
export function startGoogleCallbackServer(): Promise<GoogleCallbackServer> {
  let expectedState: string | undefined
  let emitCode: ((code: string) => void) | undefined
  let emitFailure: ((error: unknown) => void) | undefined
  const waitForAuthorizationCode = (state: string): Promise<string> => new Promise<string>((resolve, reject) => {
    expectedState = state
    emitCode = resolve
    emitFailure = reject
  })
  return new Promise<GoogleCallbackServer>((resolveServer, rejectServer) => {
    const server = nodeHttp.createServer()
    let settled = false
    let closed = false
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth2callback') {
        response.writeHead(404)
        response.end()
        return
      }
      const googleError = url.searchParams.get('error')
      if (googleError !== null) {
        const detail = url.searchParams.get('error_description')
        response.writeHead(301, { Location: SIGN_IN_FAILURE_URL })
        response.end()
        if (!settled && emitFailure !== undefined) {
          settled = true
          emitFailure(requestError(`Google refused the sign-in: ${googleError}`
            + (detail === null ? '' : ` ${detail}`), 'AUTH'))
        }
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (code === null || expectedState === undefined || state !== expectedState) {
        // Neither a code nor this attempt's state: answer 400 and keep waiting.
        response.writeHead(400)
        response.end()
        return
      }
      response.writeHead(301, { Location: SIGN_IN_SUCCESS_URL })
      response.end()
      if (!settled && emitCode !== undefined) {
        settled = true
        emitCode(code)
      }
    })
    server.on('error', rejectServer)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolveServer({
        port,
        waitForAuthorizationCode,
        close: () => {
          if (closed) return
          closed = true
          server.close()
          if (!settled && emitFailure !== undefined) {
            settled = true
            emitFailure(requestError('the callback receiver closed before Google redirected back', 'DECLINED'))
          }
        },
      })
    })
  })
}
