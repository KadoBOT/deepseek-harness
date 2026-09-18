import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import {
  ACCOUNT_RECORD_SCOPE,
  accountLoginMethod,
  accountProvider,
  accountRouteId,
  accountsFrom,
  buildAccountProfiles,
  credentialFromRecord,
  createAccountCredentialStore,
  createAccountsRuntime,
  jsonImage,
  normalizeAccount,
  recordFromCredential,
  recordState,
} from '../lib/accounts.js'
import { noticeFrame, promptFrame, readJsonBody, registerAccountRoutes, sendJson } from '../lib/accounts-http.js'
import { readRouteRecord } from '../lib/image.js'

const baseProvider = (overrides = {}) => ({
  id: 'xai',
  name: 'xAI',
  baseUrl: 'https://api.x.ai/v1',
  auth: { oauth: { name: 'xAI', login: async () => ({}) }, apiKey: { name: 'xAI API key' } },
  getModels: () => [{ id: 'grok-4.6', name: 'Grok 4.6' }],
  refreshModels: async () => {},
  stream: () => 'base-stream',
  streamSimple: () => 'base-simple',
  ...overrides,
})

test('an account entry needs a usable route id and a product', () => {
  assert.deepEqual(normalizeAccount({ id: 'xai-work', product: 'xai' }), { id: 'xai-work', product: 'xai', label: 'xai-work' })
  assert.deepEqual(normalizeAccount({ id: 'xai-work', product: 'xai', label: 'Grok (work)' }).label, 'Grok (work)')
  assert.equal(normalizeAccount({ id: 'Xai-Work', product: 'xai' }), null)
  assert.equal(normalizeAccount({ id: 'xai-work' }), null)
  assert.equal(normalizeAccount('xai'), null)
})

test('accountsFrom keeps order and drops duplicates and half-filled rows', () => {
  const accounts = accountsFrom({
    accounts: [
      { id: 'xai-work', product: 'xai', label: 'Grok work' },
      { id: 'xai-work', product: 'xai', label: 'duplicate' },
      { id: 'codex', product: 'openai-codex' },
      { id: '9bad', product: 'xai' },
      { product: 'xai' },
    ],
  })
  assert.deepEqual(accounts, [
    { id: 'xai-work', product: 'xai', label: 'Grok work' },
    { id: 'codex', product: 'openai-codex', label: 'codex' },
  ])
  assert.deepEqual(accountsFrom(undefined), [])
})

test('route ids are derived from product and label, then de-duplicated', () => {
  assert.equal(accountRouteId('xai', 'Grok work'), 'xai-grok-work')
  assert.equal(accountRouteId('openai-codex', 'ChatGPT'), 'openai-codex-chatgpt')
  assert.equal(accountRouteId('xai', 'xai'), 'xai')
  assert.equal(accountRouteId('', ''), 'account')
  assert.equal(accountRouteId('xai', 'work', ['xai-work']), 'xai-work-2')
  assert.equal(accountRouteId('xai', 'work', ['xai-work', 'xai-work-2']), 'xai-work-3')
})

test('the JSON image drops undefined members the record store cannot hold', () => {
  assert.deepEqual(jsonImage({ a: 1, b: undefined, c: { d: undefined, e: null }, f: [undefined, 1] }), {
    a: 1,
    c: { e: null },
    f: [null, 1],
  })
})

test('a credential round-trips through its stored record', () => {
  const grant = { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: undefined }
  const record = recordFromCredential(grant)
  assert.deepEqual(record, { kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } })
  assert.deepEqual(credentialFromRecord(record), { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
  const key = recordFromCredential({ type: 'api_key', key: 'sk-x', env: { REGION: 'eu' } })
  assert.deepEqual(key, { kind: 'api-key', key: 'sk-x', env: { REGION: 'eu' } })
  assert.deepEqual(credentialFromRecord(key), { type: 'api_key', key: 'sk-x', env: { REGION: 'eu' } })
  assert.equal(credentialFromRecord(undefined), undefined)
  assert.throws(() => recordFromCredential(undefined), /no credential/)
})

test('stored state reports connected accounts by their own identity', () => {
  assert.deepEqual(recordState(undefined), { connected: false })
  assert.deepEqual(recordState({ kind: 'api-key', key: 'sk-x' }), { connected: true, method: 'api key' })
  const withEmail = recordState({ kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', email: 'me@example.com' } })
  assert.deepEqual(withEmail, { connected: true, method: 'oauth', account: 'me@example.com' })
  const jwt = ['x', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url'), 'y'].join('.')
  assert.deepEqual(recordState({ kind: 'grant', payload: { type: 'oauth', access: jwt, refresh: 'r' } }), {
    connected: true,
    method: 'oauth',
    account: 'acct-1',
  })
})

test('an account route borrows the catalog provider without its dynamic refresh', () => {
  const base = baseProvider()
  const provider = accountProvider(base, { id: 'xai-work', label: 'Grok (work)' })
  assert.equal(provider.id, 'xai-work')
  assert.equal(provider.name, 'Grok (work)')
  assert.equal(provider.baseUrl, 'https://api.x.ai/v1')
  assert.equal(provider.auth, base.auth)
  assert.equal(provider.refreshModels, undefined)
  assert.deepEqual(provider.getModels(), base.getModels())
  assert.equal(provider.streamSimple(), 'base-simple')
  assert.equal(accountProvider({ id: 'xai', auth: {} }, { id: 'g', label: 'G' }).baseUrl, undefined)
})

test('the offered login method prefers the product sign-in and falls back to its key', () => {
  assert.deepEqual(accountLoginMethod(baseProvider()), { type: 'oauth', label: 'xAI' })
  assert.deepEqual(accountLoginMethod(baseProvider({ auth: { apiKey: { name: 'Google AI Studio key', login: async () => ({}) } } })), {
    type: 'api_key',
    label: 'Google AI Studio key',
  })
  assert.equal(accountLoginMethod(baseProvider({ auth: { apiKey: { name: 'ambient only' } } })), null)
  assert.equal(accountLoginMethod(undefined), null)
})

test('an image turn finds a route credential in either owning scope', async () => {
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async readRecord(key) {
          if (key === 'dsh-orchestrator/xai-work') return { kind: 'grant', payload: { type: 'oauth', access: 'account-token' } }
          if (key === 'llm-pi-ai/xai') return { kind: 'grant', payload: { type: 'oauth', access: 'provider-token' } }
          return undefined
        },
      }
    },
  }
  const keyFor = async (scope, provider) => `${scope}/${provider}`
  const account = await readRouteRecord(ctx, 'xai-work', keyFor)
  assert.equal(account.record.payload.access, 'account-token')
  assert.equal(account.key, 'dsh-orchestrator/xai-work')
  const provider = await readRouteRecord(ctx, 'xai', keyFor)
  assert.equal(provider.record.payload.access, 'provider-token')
  assert.equal(provider.key, 'llm-pi-ai/xai')
  assert.equal(await readRouteRecord(ctx, 'nothing-here', keyFor), undefined)
  assert.equal(await readRouteRecord({ get: () => undefined }, 'xai'), undefined)
})

test('profiles carry the account identity and report products the catalog lacks', () => {
  const built = buildAccountProfiles({
    accounts: [
      { id: 'xai-work', product: 'xai', label: 'Grok (work)' },
      { id: 'ghost', product: 'not-a-product', label: 'Ghost' },
    ],
    builtins: [baseProvider()],
  })
  assert.deepEqual([...built.profiles.keys()], ['xai-work'])
  assert.equal(built.profiles.get('xai-work').displayName, 'Grok (work)')
  assert.equal(built.profiles.get('xai-work').piProvider.id, 'xai-work')
  assert.equal(built.profiles.get('xai-work').configuredMaxTokens.size, 0)
  assert.equal(typeof built.profiles.get('xai-work').streamIdleTimeoutMs, 'number')
  assert.deepEqual(built.problems, ['account "ghost": unknown product "not-a-product"'])
})

/** The credential service surface this plugin consumes, in memory. */
function fakeCredentials(initial = []) {
  const records = new Map(initial)
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, kind: record.kind }))
    },
    async modifyRecord(key, fn) {
      const next = await fn(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

test('the credential store addresses records under this plugin scope only', async () => {
  const credentials = fakeCredentials([
    [`${ACCOUNT_RECORD_SCOPE}/xai-work`, { kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }],
    ['llm-pi-ai/xai', { kind: 'grant', payload: { type: 'oauth', access: 'other', refresh: 'r', expires: 1 } }],
  ])
  const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined) }
  const store = createAccountCredentialStore(ctx, (id) => `${ACCOUNT_RECORD_SCOPE}/${id}`)

  assert.deepEqual(await store.read('xai-work'), { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
  assert.equal(await store.read('Xai'), undefined)
  assert.deepEqual(await store.list(), [{ providerId: 'xai-work', type: 'oauth' }])

  const rotated = await store.modify('xai-work', async (current) => ({ ...current, access: 'b' }))
  assert.equal(rotated.access, 'b')
  assert.equal(credentials.records.get(`${ACCOUNT_RECORD_SCOPE}/xai-work`).payload.access, 'b')

  await store.modify('xai-work', async () => undefined)
  assert.equal(credentials.records.get(`${ACCOUNT_RECORD_SCOPE}/xai-work`).payload.access, 'b')

  await store.delete('xai-work')
  assert.equal(credentials.records.has(`${ACCOUNT_RECORD_SCOPE}/xai-work`), false)
  await assert.rejects(() => store.modify('Bad Id', async () => ({ type: 'api_key', key: 'k' })), /cannot address/)
})

test('a store with no credentials service stores nothing and refuses writes', async () => {
  const store = createAccountCredentialStore({ get: () => undefined }, (id) => id)
  assert.equal(await store.read('xai'), undefined)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(() => store.modify('xai', async () => ({ type: 'api_key', key: 'k' })), /credentials service is not mounted/)
})

test('auth events and prompts become browser frames', () => {  assert.deepEqual(noticeFrame({ type: 'auth_url', url: 'https://x', instructions: 'Open it' }), {
    type: 'notice',
    kind: 'auth_url',
    message: 'Open it',
    url: 'https://x',
  })
  assert.deepEqual(noticeFrame({ type: 'auth_url', url: 'https://x' }).message, 'Open this page to continue signing in.')
  assert.deepEqual(noticeFrame({ type: 'device_code', userCode: 'AB-12', verificationUri: 'https://v' }), {
    type: 'notice',
    kind: 'device_code',
    message: 'Enter this code on the verification page to finish signing in.',
    url: 'https://v',
    code: 'AB-12',
  })
  assert.deepEqual(noticeFrame({ type: 'info', message: 'hi', links: [{ url: 'https://l' }] }), {
    type: 'notice',
    kind: 'info',
    message: 'hi',
    url: 'https://l',
  })
  assert.deepEqual(noticeFrame({ type: 'progress', message: 'working' }), { type: 'notice', kind: 'progress', message: 'working' })
  assert.deepEqual(noticeFrame({ type: 'something_new', message: 'x' }).kind, 'progress')

  assert.deepEqual(promptFrame({ type: 'secret', message: 'Paste the key', placeholder: 'sk-…' }, 'p1'), {
    type: 'prompt',
    promptId: 'p1',
    kind: 'secret',
    message: 'Paste the key',
    placeholder: 'sk-…',
  })
  assert.deepEqual(promptFrame({ type: 'select', message: 'How?', options: [{ id: 'browser', label: 'Browser', description: 'opens a page' }] }, 'p2'), {
    type: 'prompt',
    promptId: 'p2',
    kind: 'select',
    message: 'How?',
    options: [{ id: 'browser', label: 'Browser', description: 'opens a page' }],
  })
})

test('request bodies are read under a cap and non-objects are refused', async () => {
  const request = (text) => Readable.from([Buffer.from(text)])
  assert.deepEqual(await readJsonBody(request('{"id":"xai-work"}')), { id: 'xai-work' })
  assert.deepEqual(await readJsonBody(request('')), {})
  await assert.rejects(() => readJsonBody(request('[1]')), /JSON object/)
  await assert.rejects(() => readJsonBody(request('nope')), SyntaxError)
  await assert.rejects(() => readJsonBody(request('x'.repeat(17 * 1024))), /too large/)
})

test('responses carry JSON and no cache', () => {
  const res = { headers: null, body: '', writableEnded: false, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body; this.writableEnded = true } }
  sendJson(res, 404, { error: 'unknown account' })
  assert.equal(res.status, 404)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body, JSON.stringify({ error: 'unknown account' }))
})

/** A webserver stub recording the routes a registration claims. */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
}

/** A response stub capturing SSE frames. */
function fakeResponse() {
  return {
    frames: [],
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
    write(chunk) { this.frames.push(String(chunk)); return true },
    end(body) { this.body = body; this.writableEnded = true },
  }
}

/** A request stub carrying a JSON body. */
function fakeRequest(body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    async *[Symbol.asyncIterator]() { yield Buffer.from(text) },
    on() {},
  }
}

const parseFrames = (res) => res.frames
  .filter((frame) => frame.startsWith('data: '))
  .map((frame) => JSON.parse(frame.slice(6)))

test('the connect route streams notices and questions, then the stored account', async () => {
  const webServer = fakeWebServer()
  const account = { id: 'xai-work', product: 'xai', label: 'Grok (work)' }
  const runtime = {
    problems: () => [],
    async status() { return [{ id: account.id, connected: false }] },
    async disconnect() {},
    async connect(_account, interaction) {
      interaction.notify({ type: 'auth_url', url: 'https://sign-in', instructions: 'Sign in' })
      const choice = await interaction.prompt({ type: 'select', message: 'How?', options: [{ id: 'browser', label: 'Browser' }] })
      interaction.notify({ type: 'progress', message: `chose ${choice}` })
      return { connected: true, method: 'oauth', account: 'me@example.com' }
    },
  }
  const registration = registerAccountRoutes({
    webServer,
    connection: undefined,
    runtime,
    readAccounts: () => [account],
  })

  const statusRes = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts')(fakeRequest(), statusRes)
  assert.deepEqual(JSON.parse(statusRes.body), { accounts: [{ id: 'xai-work', connected: false }], problems: [] })

  const res = fakeResponse()
  const connecting = webServer.routes.get('/orchestrator/accounts/connect')(fakeRequest({ id: 'xai-work' }), res)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const opened = parseFrames(res)
  assert.equal(opened[0].type, 'open')
  assert.equal(opened[0].account, 'xai-work')
  assert.deepEqual(opened[1], { type: 'notice', kind: 'auth_url', message: 'Sign in', url: 'https://sign-in' })
  const prompt = opened[2]
  assert.equal(prompt.type, 'prompt')
  assert.deepEqual(prompt.options, [{ id: 'browser', label: 'Browser' }])

  const answerRes = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts/answer')(fakeRequest({ attempt: opened[0].attempt, prompt: prompt.promptId, value: 'browser' }), answerRes)
  assert.deepEqual(JSON.parse(answerRes.body), { accepted: true })
  await connecting

  const frames = parseFrames(res)
  assert.deepEqual(frames[3], { type: 'notice', kind: 'progress', message: 'chose browser' })
  assert.deepEqual(frames[4], { type: 'done', account: 'xai-work', identity: 'me@example.com', connected: true, method: 'oauth' })
  assert.equal(res.writableEnded, true)

  // A second sign-in for the same record while one is running is refused.
  const res2 = fakeResponse()
  const first = webServer.routes.get('/orchestrator/accounts/connect')(fakeRequest({ id: 'xai-work' }), res2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const overlapping = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts/connect')(fakeRequest({ id: 'xai-work' }), overlapping)
  assert.equal(overlapping.status, 409)
  // Cancel through the answer route: the flow's pending question rejects.
  const attemptId = parseFrames(res2)[0].attempt
  await webServer.routes.get('/orchestrator/accounts/answer')(fakeRequest({ attempt: attemptId, cancel: true }), fakeResponse())
  await first
  assert.equal(parseFrames(res2).find((frame) => frame.type === 'cancelled').message, 'Sign-in cancelled.')
  assert.equal(res2.writableEnded, true)
  registration.dispose()
  assert.equal(webServer.routes.size, 0)
})

test('an unknown account and an unbound question are refused by name', async () => {
  const webServer = fakeWebServer()
  const registration = registerAccountRoutes({
    webServer,
    connection: undefined,
    runtime: { problems: () => [], status: async () => [], disconnect: async () => {}, connect: async () => ({ connected: true }) },
    readAccounts: () => [{ id: 'xai-work', product: 'xai', label: 'Grok (work)' }],
  })

  const unknown = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts/connect')(fakeRequest({ id: 'nope' }), unknown)
  assert.equal(unknown.status, 404)
  assert.match(JSON.parse(unknown.body).error, /unknown account/)

  const stale = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts/answer')(fakeRequest({ attempt: 'gone', prompt: 'p', value: 'v' }), stale)
  assert.equal(stale.status, 404)

  const badBody = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts/disconnect')(fakeRequest(), badBody)
  assert.equal(badBody.status, 404)

  const disconnected = fakeResponse()
  await webServer.routes.get('/orchestrator/accounts/disconnect')(fakeRequest({ id: 'xai-work' }), disconnected)
  assert.equal(disconnected.status, 200)
  registration.dispose()
})

/** An llm service stub: it records what one registration holds. */
function fakeLlm(foreignRoutes = []) {
  const registered = []
  const replaces = []
  return {
    registered,
    replaces,
    listProviders() {
      const mine = registered.flatMap((entry) => entry.owned)
      return foreignRoutes.concat(mine).map((id) => ({ id, name: id }))
    },
    registerAdapter(routes, adapter) {
      assert.equal(typeof adapter.stream, 'function')
      const entry = { owned: routes.slice() }
      registered.push(entry)
      const handle = () => { entry.owned = [] }
      handle.replace = (next) => {
        replaces.push(next.slice())
        entry.owned = next.slice()
      }
      return handle
    },
  }
}

test('syncing accounts registers each one as its own route and never flags itself', async () => {
  const llm = fakeLlm()
  const runtime = await createAccountsRuntime({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined), llm },
    piAi: { builtinProviders: () => [baseProvider()], createModels: () => ({ setProvider() {} }) },
    adapterClass: class FakeAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async stream() {}
    },
  })

  assert.deepEqual(runtime.sync([{ id: 'xai-work', product: 'xai', label: 'Grok (work)' }]), [])
  assert.deepEqual(llm.registered[0].owned, ['xai-work'])
  assert.equal(runtime.problems().length, 0)

  // The same list again is a replace, not a conflict with the route this
  // registration already owns.
  assert.deepEqual(runtime.sync([{ id: 'xai-work', product: 'xai', label: 'Grok (work)' }]), [])
  assert.deepEqual(llm.replaces, [['xai-work']])

  // A rename swaps the whole route set atomically.
  assert.deepEqual(runtime.sync([{ id: 'xai-personal', product: 'xai', label: 'Grok personal' }]), [])
  assert.deepEqual(llm.replaces[1], ['xai-personal'])

  // Emptied list: the registration stays live holding no routes.
  assert.deepEqual(runtime.sync([]), [])
  assert.deepEqual(llm.replaces[2], [])

  // A route another adapter already serves is reported, and the routes this
  // registration holds stay untouched.
  const conflicted = fakeLlm(['xai'])
  const other = await createAccountsRuntime({
    ctx: { get: (name) => (name === 'llm' ? conflicted : undefined), llm: conflicted },
    piAi: { builtinProviders: () => [baseProvider()], createModels: () => ({ setProvider() {} }) },
    adapterClass: class FakeAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async stream() {}
    },
  })
  assert.deepEqual(other.sync([{ id: 'xai', product: 'xai', label: 'xAI' }]), ['account route "xai" is already served by another adapter'])
  assert.equal(conflicted.registered.length, 0)
})

test('a product the catalog does not ship is reported instead of registered', async () => {
  const llm = fakeLlm()
  const runtime = await createAccountsRuntime({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined), llm },
    piAi: { builtinProviders: () => [baseProvider()], createModels: () => ({ setProvider() {} }) },
    adapterClass: class FakeAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async stream() {}
    },
  })
  assert.deepEqual(runtime.sync([{ id: 'ghost', product: 'nope', label: 'Ghost' }]), ['account "ghost": unknown product "nope"'])
  assert.equal(llm.registered.length, 0)
})

test('every account route defers to the application request policy', async () => {
  const webServer = fakeWebServer()
  const registration = registerAccountRoutes({
    webServer,
    connection: { requestRejection: () => 'forbidden origin' },
    runtime: { problems: () => [], status: async () => [], disconnect: async () => {}, connect: async () => ({ connected: true }) },
    readAccounts: () => [],
  })
  for (const path of ['/orchestrator/accounts', '/orchestrator/accounts/connect', '/orchestrator/accounts/answer', '/orchestrator/accounts/disconnect']) {
    const res = fakeResponse()
    await webServer.routes.get(path)(fakeRequest({ id: 'xai-work' }), res)
    assert.equal(res.status, 403)
    assert.match(res.headers['content-type'], /application\/json/)
  }
  registration.dispose()
})
