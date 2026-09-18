/**
 * Browser-driven sign-in for account routes, over the web GUI's own HTTP
 * server.
 *
 * The orchestrator settings page cannot call a Host method for this: the
 * application Remote assembly selects its namespaces at build time, and an
 * out-of-tree plugin adds none. So the plugin owns four raw routes instead —
 * list, connect, answer, disconnect — and the connect route answers as
 * Server-Sent Events, which is what lets a sign-in's notices, links, device
 * codes, and questions reach exactly the page that asked for them. No token
 * ever crosses: the credential is committed on the Host side by the flow that
 * obtained it.
 */

import { randomUUID } from 'node:crypto'

/** Path prefix every account route is registered under. */
export const ACCOUNTS_ROUTE_PREFIX = '/orchestrator/accounts'

/** Largest request body this surface accepts, in bytes. */
const MAX_BODY_BYTES = 16 * 1024

/** Hard cap on one sign-in attempt, so an abandoned browser cannot hold a flow open. */
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000

/** Interval between comment frames that keep an idle SSE response alive. */
const SSE_PING_MS = 15_000

/**
 * The request policy every route here defers to: the same gate the GUI's own
 * bridge applies, so a non-loopback bind does not expose a sign-in that the
 * rest of the application refuses.
 * @param {object | undefined} connection - the connection service, when mounted.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | undefined} the rejection reason, when the request must be refused.
 */
export function requestRejection(connection, req) {
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  return connection.requestRejection(req)
}

/**
 * Read a JSON request body under a byte cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>} the parsed body; an empty body reads as `{}`.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Translate one pi-ai auth event into the frame the browser renders.
 * @param {object} event - a pi-ai `AuthEvent`.
 * @returns {object} the frame payload.
 */
export function noticeFrame(event) {
  switch (event.type) {
    case 'auth_url':
      return { type: 'notice', kind: 'auth_url', message: event.instructions || 'Open this page to continue signing in.', url: event.url }
    case 'device_code':
      return {
        type: 'notice',
        kind: 'device_code',
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      }
    case 'info': {
      const link = Array.isArray(event.links) ? event.links[0] : undefined
      return { type: 'notice', kind: 'info', message: event.message, ...(link === undefined ? {} : { url: link.url }) }
    }
    case 'progress':
      return { type: 'notice', kind: 'progress', message: event.message }
    default:
      // pi-ai's event union is open: an unknown event still tells the human
      // something is happening rather than leaving the page silent.
      return { type: 'notice', kind: 'progress', message: 'Signing in…' }
  }
}

/**
 * Translate one pi-ai auth prompt into the frame the browser answers.
 * @param {object} prompt - a pi-ai `AuthPrompt`.
 * @param {string} promptId
 * @returns {object} the frame payload.
 */
export function promptFrame(prompt, promptId) {
  return {
    type: 'prompt',
    promptId,
    kind: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    ...(Array.isArray(prompt.options)
      ? { options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) }
      : {}),
  }
}

/**
 * Translate one stored-account state into the frame's own field names: the
 * frame already uses `account` for the route id, so the identity a sign-in
 * reported travels as `identity`.
 * @param {object} state - what the runtime's connect returned.
 * @returns {object} the frame fields, without the route id.
 */
export function doneFrame(state) {
  if (!state || typeof state !== 'object') return {}
  const { account, ...rest } = state
  return { ...rest, ...(account === undefined ? {} : { identity: account }) }
}

/**
 * Register the account routes on the web server.
 *
 * One attempt per account at a time: two overlapping sign-ins for the same
 * record would race on the same credential key, and the flow's own store lock
 * would serialize them into a confusing partial result rather than a refusal.
 * @param {object} input
 * @param {object} input.webServer - the `webServer` service.
 * @param {object | undefined} input.connection - the `connection` service, for the request policy.
 * @param {object} input.runtime - the accounts runtime.
 * @param {() => {id: string, product: string, label: string}[]} input.readAccounts
 * @param {object} [input.log]
 * @returns {{dispose: () => void}} the registration, whose disposal aborts every live attempt.
 */
export function registerAccountRoutes({ webServer, connection, runtime, readAccounts, log }) {
  /** Live attempts by attempt id, and the one live attempt per account. */
  const attempts = new Map()
  const byAccount = new Map()

  const accountOf = (id) => readAccounts().find((account) => account.id === id)

  async function statusHandler(req, res) {
    const rejection = requestRejection(connection, req)
    if (rejection !== undefined) return sendJson(res, 403, { error: rejection })
    const accounts = readAccounts()
    try {
      return sendJson(res, 200, { accounts: await runtime.status(accounts), problems: runtime.problems() })
    } catch (error) {
      return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  async function disconnectHandler(req, res) {
    const rejection = requestRejection(connection, req)
    if (rejection !== undefined) return sendJson(res, 403, { error: rejection })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
    }
    const id = typeof body.id === 'string' ? body.id : ''
    if (!accountOf(id)) return sendJson(res, 404, { error: `unknown account "${id}"` })
    const live = byAccount.get(id) === undefined ? undefined : attempts.get(byAccount.get(id))
    if (live !== undefined) live.controller.abort('account disconnected')
    try {
      await runtime.disconnect(id)
      return sendJson(res, 200, await runtime.status(readAccounts()))
    } catch (error) {
      return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  async function answerHandler(req, res) {
    const rejection = requestRejection(connection, req)
    if (rejection !== undefined) return sendJson(res, 403, { error: rejection })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
    }
    const attempt = attempts.get(typeof body.attempt === 'string' ? body.attempt : '')
    if (attempt === undefined) return sendJson(res, 404, { error: 'that sign-in attempt is no longer running' })
    if (body.cancel === true) {
      attempt.controller.abort('cancelled by the browser')
      return sendJson(res, 200, { cancelled: true })
    }
    const pending = attempt.pending
    if (pending === null || pending.id !== body.prompt) {
      return sendJson(res, 409, { error: 'that sign-in is not waiting for an answer' })
    }
    if (typeof body.value !== 'string') return sendJson(res, 400, { error: 'an answer must be a string' })
    attempt.pending = null
    pending.resolve(body.value)
    return sendJson(res, 200, { accepted: true })
  }

  async function connectHandler(req, res) {
    const rejection = requestRejection(connection, req)
    if (rejection !== undefined) return sendJson(res, 403, { error: rejection })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
    }
    const account = accountOf(typeof body.id === 'string' ? body.id : '')
    if (account === undefined) return sendJson(res, 404, { error: `unknown account "${String(body.id)}"` })
    if (byAccount.has(account.id)) return sendJson(res, 409, { error: `a sign-in for "${account.id}" is already running` })

    const attemptId = randomUUID()
    const controller = new AbortController()
    const attempt = { id: account.id, controller, pending: null }
    attempts.set(attemptId, attempt)
    byAccount.set(account.id, attemptId)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const frame = (payload) => {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, SSE_PING_MS)
    const expiry = setTimeout(() => controller.abort('sign-in timed out'), ATTEMPT_TIMEOUT_MS)
    const settle = () => {
      clearInterval(ping)
      clearTimeout(expiry)
      attempts.delete(attemptId)
      if (byAccount.get(account.id) === attemptId) byAccount.delete(account.id)
      if (attempt.pending !== null) {
        attempt.pending.reject(new Error('the sign-in was cancelled'))
        attempt.pending = null
      }
    }

    req.on('close', () => {
      if (attempts.has(attemptId)) controller.abort('the browser closed the sign-in')
    })

    frame({ type: 'open', attempt: attemptId, account: account.id, label: account.label, product: account.product })
    try {
      frame({ type: 'done', account: account.id, ...doneFrame(await runtime.connect(account, {
        signal: controller.signal,
        notify(event) {
          frame(noticeFrame(event))
        },
        prompt(prompt) {
          const promptId = randomUUID()
          return new Promise((resolve, reject) => {
            attempt.pending = { id: promptId, resolve, reject }
            frame(promptFrame(prompt, promptId))
            const onAbort = () => {
              if (attempt.pending !== null && attempt.pending.id === promptId) {
                attempt.pending = null
                reject(new Error('the sign-in was cancelled'))
              }
            }
            controller.signal.addEventListener('abort', onAbort, { once: true })
            if (prompt.signal !== undefined) prompt.signal.addEventListener('abort', onAbort, { once: true })
          })
        },
      })) })
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      if (controller.signal.aborted) frame({ type: 'cancelled', message: 'Sign-in cancelled.' })
      else frame({ type: 'error', message })
      log?.warn?.('dsh-orchestrator: account sign-in for "%s" failed: %s', account.id, message)
    } finally {
      settle()
      if (!res.writableEnded) res.end()
    }
  }

  const handlers = [
    { path: ACCOUNTS_ROUTE_PREFIX, handler: statusHandler },
    { path: `${ACCOUNTS_ROUTE_PREFIX}/connect`, handler: connectHandler },
    { path: `${ACCOUNTS_ROUTE_PREFIX}/answer`, handler: answerHandler },
    { path: `${ACCOUNTS_ROUTE_PREFIX}/disconnect`, handler: disconnectHandler },
  ]
  const unregister = handlers.map(({ path, handler }) => webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
      log?.warn?.('dsh-orchestrator: %s failed: %s', path, String(error && error.message ? error.message : error))
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else if (!res.writableEnded) res.end()
    }),
  }))

  return {
    dispose() {
      for (const dispose of unregister) {
        try {
          dispose()
        } catch {
          // The webserver already tore its tables down; nothing is left to remove.
        }
      }
      for (const attempt of attempts.values()) attempt.controller.abort('the plugin unloaded')
      attempts.clear()
      byAccount.clear()
    },
  }
}
