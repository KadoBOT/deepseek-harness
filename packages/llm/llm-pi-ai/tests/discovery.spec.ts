import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { userAgent } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { discoverModels } from '../src/discovery.ts'

const servers: Server[] = []
/** Credential variables a test set, cleared so the next one starts unset. */
const touchedEnv: string[] = []

afterEach(async () => {
  // A no-op when the test never stubbed `fetch`; only 'probe key format'
  // below installs one.
  vi.unstubAllGlobals()
  for (const name of touchedEnv.splice(0)) Reflect.deleteProperty(process.env, name)
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface ListingServer {
  url: string
  paths: string[]
  headers: IncomingMessage['headers'][]
}

/**
 * A stand-in provider that answers one scripted `GET /models`. `chunks` writes
 * without a declared length, which is how a real streamed reply arrives.
 */
async function listingServer(behavior: {
  status?: number
  body?: string
  chunks?: string[]
  holdOpenMs?: number
}): Promise<ListingServer> {
  const paths: string[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push(request.headers)
    if (behavior.chunks !== undefined) {
      // No declared length: the ceiling has to hold on what is read.
      response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
      for (const chunk of behavior.chunks) response.write(chunk)
      if (behavior.holdOpenMs === undefined) { response.end(); return }
      // Left open so a caller's cancellation lands while the body is still
      // being read rather than after it completed.
      setTimeout(() => { response.end() }, behavior.holdOpenMs)
      return
    }
    const body = behavior.body ?? '{}'
    response.writeHead(behavior.status ?? 200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers }
}

/** A bare dormant mount: discovery is offered whether or not a route exists. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {})
  return ctx
}

describe('catalog-route model discovery', () => {
  it('answers from the installed registry, merging endpoint-only ids after it', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'from-the-endpoint' }] }) })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', baseURL: server.url })

    // pi-ai's own registry is the authority for its own providers, and it
    // carries what a listing endpoint would not disclose; the endpoint can
    // only append ids the catalog does not describe.
    const catalogIds = getBuiltinModels('deepseek').map(model => model.id)
    expect(models.map(model => model.id).sort())
      .toEqual([...catalogIds, 'from-the-endpoint'].sort())
    expect(models.every(model => (model.contextWindow ?? 0) > 0 || model.id === 'from-the-endpoint')).toBe(true)
    expect(server.paths).toEqual(['/models'])
  })

  it('lets the catalog win when the endpoint repeats a known id', async () => {
    const [known] = getBuiltinModels('deepseek').map(model => model.id)
    const server = await listingServer({
      body: JSON.stringify({ data: [{ id: known, name: 'Endpoint Renames It', context_length: 7 }] }),
    })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', baseURL: server.url })

    expect(models.filter(model => model.id === known)).toHaveLength(1)
    expect(models.find(model => model.id === known)?.name).not.toBe('Endpoint Renames It')
  })

  it('falls back to the catalog when the endpoint probe fails', async () => {
    const broken = await listingServer({ status: 500, body: '{"error":"boom"}' })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', baseURL: broken.url })

    expect(models.map(model => model.id).sort())
      .toEqual(getBuiltinModels('deepseek').map(model => model.id).sort())
  })

  it('falls back to the catalog for a codex route with no usable grant', async () => {
    const ctx = await harness()

    // No grant is stored, so the Codex backend is never asked: the fake
    // endpoint below would fail DNS rather than answer.
    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'openai-codex',
      baseURL: 'https://gateway.example/v1',
      api: 'openai-codex-responses',
    })).resolves.not.toHaveLength(0)
  })

  it('needs no endpoint for a route the catalog describes', async () => {
    const ctx = await harness()
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })).resolves.not.toHaveLength(0)
  })

  it('says where a route the catalog does not describe must get its models', async () => {
    const ctx = await harness()
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway' }))
      .rejects.toThrow(/ships no catalog for provider "acme-gateway".*set a baseURL/s)
    // A form that cleared the field says the same thing as one that never had it.
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: '' }))
      .rejects.toThrow(/set a baseURL/)
    // The seam refuses a request naming neither, so the module's own guard for
    // that shape is only reachable by calling it directly.
    await expect(discoverModels({})).rejects.toThrow(/set a baseURL/)
  })
})

/** A stored profile answering fixed credentials, without mounting the plugin. */
function profileOf(credentials: { apiKey?: string; oauthToken?: string }, headers?: Record<string, string>) {
  return () => ({
    headers,
    resolveApiKey: async () => credentials.apiKey,
    resolveOAuthToken: async () => credentials.oauthToken,
  })
}

describe('live catalog sources', () => {
  it('appends Codex-backend models the catalog does not describe', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        models: [
          { slug: 'codex-next-thing', display_name: 'Codex Next Thing', supported_in_api: true },
          { slug: 'hidden-lab-model', supported_in_api: false },
          { display_name: 'no slug anywhere' },
          { slug: 'flagless-model' },
          null,
        ],
      }),
    })
    const catalogIds = getBuiltinModels('openai-codex').map(model => model.id)

    const models = await discoverModels(
      { provider: 'openai-codex', baseURL: server.url },
      profileOf({ oauthToken: 'grant-token' }, { 'x-tenant': 't1' }),
    )

    expect(models.map(model => model.id).sort())
      .toEqual([...catalogIds, 'codex-next-thing', 'flagless-model'].sort())
    expect(models.find(model => model.id === 'codex-next-thing')).toMatchObject({ name: 'Codex Next Thing' })
    expect(server.paths).toEqual(['/models?client_version=0.155.1'])
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer grant-token'])
    expect(server.headers.map(headers => headers['x-tenant'])).toEqual(['t1'])
  })

  it('reaches the Codex backend through the catalog base when the draft names none', async () => {
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.155.1')
      expect((init?.headers as Headers).get('authorization')).toBe('Bearer grant-token')
      return new Response(JSON.stringify({ models: [{ slug: 'codex-next-thing' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const catalogIds = getBuiltinModels('openai-codex').map(model => model.id)

    const models = await discoverModels({ provider: 'openai-codex' }, profileOf({ oauthToken: 'grant-token' }))

    expect(models.map(model => model.id).sort())
      .toEqual([...catalogIds, 'codex-next-thing'].sort())
  })

  it('asks nothing without a usable grant on a codex route', async () => {
    const server = await listingServer({ body: JSON.stringify({ models: [{ slug: 'x' }] }) })
    const catalogIds = getBuiltinModels('openai-codex').map(model => model.id)

    const models = await discoverModels(
      { provider: 'openai-codex', baseURL: server.url },
      profileOf({}),
    )

    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
    expect(server.paths).toEqual([])
  })

  it('falls back to the catalog when the Codex backend refuses', async () => {
    const broken = await listingServer({ status: 401, body: '{"error":"bad token"}' })
    const catalogIds = getBuiltinModels('openai-codex').map(model => model.id)

    const models = await discoverModels(
      { provider: 'openai-codex', baseURL: broken.url, apiKey: 'typed' },
      profileOf({ oauthToken: 'grant-token' }),
    )

    // A typed key is attempted first and cannot fail over to the grant, but
    // the refusal still costs only the live rows, never the catalog.
    expect(broken.headers.map(headers => headers.authorization)).toEqual(['Bearer typed'])
    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
  })

  it('names the missing grant for a grantless codex draft', async () => {
    await expect(discoverModels(
      { provider: 'acme-codex-clone', baseURL: 'https://gateway.example/v1', api: 'openai-codex-responses' },
      profileOf({}),
    )).rejects.toThrow(/no usable grant/)
  })

  it('reads a Codex-compatible draft endpoint with a typed token', async () => {
    const server = await listingServer({
      body: JSON.stringify({ models: [{ slug: 'acme-codex-model', supported_in_api: true }] }),
    })

    const models = await discoverModels(
      { baseURL: server.url, api: 'openai-codex-responses', apiKey: 'typed' },
      profileOf({}),
    )

    expect(models).toEqual([{ id: 'acme-codex-model', name: 'acme-codex-model' }])
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer typed'])
  })

  it('reads a Codex-compatible draft endpoint with a grant token', async () => {
    const server = await listingServer({
      body: JSON.stringify({ models: [{ slug: 'acme-codex-model', supported_in_api: true }] }),
    })

    const models = await discoverModels(
      { baseURL: server.url, api: 'openai-codex-responses' },
      profileOf({ oauthToken: 'grant-token' }),
    )

    expect(models).toEqual([{ id: 'acme-codex-model', name: 'acme-codex-model' }])
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer grant-token'])
  })

  it('rejects a Codex reply with no models array', async () => {
    const server = await listingServer({ body: '{"data":[]}' })

    await expect(discoverModels(
      { baseURL: server.url, api: 'openai-codex-responses', apiKey: 'typed' },
      profileOf({}),
    )).rejects.toThrow(/no "models" array/)
  })

  it('reads a Google generative listing through a draft endpoint', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        models: [
          {
            name: 'models/gemini-new-thing',
            displayName: 'Gemini New Thing',
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 64_000,
          },
          { name: 'unprefixed-model' },
          { name: 'models/' },
          { name: '' },
          null,
        ],
      }),
    })

    const models = await discoverModels(
      { baseURL: server.url, api: 'google-generative-ai', apiKey: 'g-key' },
      profileOf({}, { 'x-tenant': 't1' }),
    )

    expect(models).toEqual([
      { id: 'gemini-new-thing', name: 'Gemini New Thing', contextWindow: 1_000_000, maxTokens: 64_000 },
      { id: 'unprefixed-model', name: 'unprefixed-model' },
    ])
    expect(server.paths).toEqual(['/models?key=g-key'])
    expect(server.headers.map(headers => headers['x-tenant'])).toEqual(['t1'])
  })

  it('rejects a Google reply with no models array', async () => {
    const server = await listingServer({ body: '{"data":[]}' })

    await expect(discoverModels(
      { baseURL: server.url, api: 'google-generative-ai', apiKey: 'g-key' },
      profileOf({}),
    )).rejects.toThrow(/no "models" array/)
  })

  it('reads a draft Google endpoint for a catalog route', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        models: [{ name: 'models/gemini-new-thing', displayName: 'Gemini New Thing' }],
      }),
    })
    const catalogIds = getBuiltinModels('google').map(model => model.id)

    const models = await discoverModels(
      { provider: 'google', baseURL: server.url, apiKey: 'g-key' },
      profileOf({}),
    )

    expect(models.map(model => model.id).sort())
      .toEqual([...catalogIds, 'gemini-new-thing'].sort())
    expect(server.paths).toEqual(['/models?key=g-key'])
  })

  it('stands on the catalog for a route speaking no readable listing', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args)
      throw new Error('must not probe an unreadable protocol')
    })
    // Azure has models but no base URL and no readable listing shape.
    const catalogIds = getBuiltinModels('azure-openai-responses').map(model => model.id)
    expect(catalogIds.length).toBeGreaterThan(0)

    const models = await discoverModels({ provider: 'azure-openai-responses' }, profileOf({ apiKey: 'k' }))

    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
    expect(calls).toEqual([])
  })

  it('borrows nothing for an unconnected codex route, answering the catalog', async () => {
    // Mounting the route wires the OAuth-token resolver; with no grant stored
    // it answers undefined, so the backend is never asked.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'openai-codex': {} } })

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })).resolves.not.toHaveLength(0)
  })

  it('refuses a keyless Google draft probe at the endpoint, not the catalog', async () => {
    const server = await listingServer({ status: 400, body: '{"error":"key required"}' })

    await expect(discoverModels(
      { baseURL: server.url, api: 'google-generative-ai' },
      profileOf({}),
    )).rejects.toThrow(/answered 400/)
    expect(server.paths).toEqual(['/models'])
  })

  it('appends generativelanguage models the catalog predates', async () => {
    vi.stubGlobal('fetch', async (url: string | URL) => {
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=g-key')
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-new-thing', displayName: 'Gemini New Thing' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const catalogIds = getBuiltinModels('google').map(model => model.id)

    const models = await discoverModels({ provider: 'google' }, profileOf({ apiKey: 'g-key' }))

    expect(models.map(model => model.id).sort())
      .toEqual([...catalogIds, 'gemini-new-thing'].sort())
  })

  it('asks nothing for a google route with no key at all', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args)
      throw new Error('must not probe without a key')
    })
    const catalogIds = getBuiltinModels('google').map(model => model.id)

    const models = await discoverModels({ provider: 'google' }, profileOf({}))

    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
    expect(calls).toEqual([])
  })

  it('falls back to the catalog when the Google listing fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"boom"}', { status: 500 }))
    const catalogIds = getBuiltinModels('google').map(model => model.id)

    const models = await discoverModels({ provider: 'google' }, profileOf({ apiKey: 'g-key' }))

    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
  })

  it('asks the catalog endpoint for an untouched route with a stored key', async () => {
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/models')
      expect((init?.headers as Headers).get('authorization')).toBe('Bearer stored-key')
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-new-thing' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const catalogIds = getBuiltinModels('deepseek').map(model => model.id)

    const models = await discoverModels({ provider: 'deepseek' }, profileOf({ apiKey: 'stored-key' }))

    expect(models.map(model => model.id).sort())
      .toEqual([...catalogIds, 'deepseek-new-thing'].sort())
  })

  it('answers from the catalog when the stored credential is missing', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args)
      throw new Error('must not probe without a credential')
    })
    const failing = () => ({
      headers: undefined,
      resolveApiKey: async (): Promise<string | undefined> => {
        throw new Error('MISSING_CREDENTIAL')
      },
    })
    const catalogIds = getBuiltinModels('deepseek').map(model => model.id)

    const models = await discoverModels({ provider: 'deepseek' }, failing)

    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
    expect(calls).toEqual([])
  })

  it('leaves an explicitly foreign protocol to the draft endpoint it belongs to', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args)
      throw new Error('must not probe a replaced protocol at the catalog endpoint')
    })
    const catalogIds = getBuiltinModels('deepseek').map(model => model.id)

    const models = await discoverModels(
      { provider: 'deepseek', api: 'anthropic-messages' },
      profileOf({ apiKey: 'stored-key' }),
    )

    expect(models.map(model => model.id).sort()).toEqual([...catalogIds].sort())
    expect(calls).toEqual([])
  })
})

describe('draft-provider model discovery', () => {
  it('reads an OpenAI-compatible listing and keeps the capacities it discloses', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          { id: 'acme-large', display_name: 'Acme Large', context_length: 65_536, max_output_tokens: 4096 },
          { id: 'acme-camel', displayName: 'Acme Camel', contextWindow: 131_072, maxOutputTokens: 8192 },
          { id: 'acme-mixed', name: 'Acme Mixed', context_window: 32_768, maxTokens: 2048 },
          { id: 'acme-legacy', max_tokens: 1024 },
          { id: 'acme-small' },
        ],
      }),
    })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL: `${server.url}/v1`, apiKey: 'probe-key' })

    expect(models).toEqual([
      { id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 },
      { id: 'acme-camel', name: 'Acme Camel', contextWindow: 131_072, maxTokens: 8192 },
      { id: 'acme-mixed', name: 'Acme Mixed', contextWindow: 32_768, maxTokens: 2048 },
      { id: 'acme-legacy', name: 'acme-legacy', maxTokens: 1024 },
      { id: 'acme-small', name: 'acme-small' },
    ])
    expect(server.paths).toEqual(['/v1/models'])
    expect(server.headers[0]?.authorization).toBe('Bearer probe-key')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('reads an enriched models map using route ids and nested capacities', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        models: {
          'lobechat-deepseek-chat': {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            limit: { context: 1_048_576, output: 384_000 },
          },
          'bare-route': {},
          '': { id: 'nested-id', display_name: 'Nested fallback' },
          'malformed-route': null,
          'primitive-route': 'not a model record',
        },
      }),
    })
    const ctx = await harness()

    expect(await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url })).toEqual([
      {
        id: 'lobechat-deepseek-chat',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1_048_576,
        maxTokens: 384_000,
      },
      { id: 'bare-route', name: 'bare-route' },
      { id: 'nested-id', name: 'Nested fallback' },
    ])
  })

  it('uses Anthropic model-listing paths, headers, and capacity fields', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          {
            id: 'claude-sonnet',
            display_name: 'Claude Sonnet',
            max_input_tokens: 200_000,
            max_tokens: 64_000,
          },
        ],
      }),
    })
    const ctx = await harness()

    const rootModels = await ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: server.url,
      api: 'anthropic-messages',
      apiKey: 'anthropic-key',
    })
    const versionedModels = await ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: `${server.url}/v1`,
      api: 'anthropic-messages',
      apiKey: 'anthropic-key',
    })
    await ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: server.url,
      api: 'anthropic-messages',
    })

    expect(rootModels).toEqual([
      { id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 200_000, maxTokens: 64_000 },
    ])
    expect(versionedModels).toEqual(rootModels)
    expect(server.paths).toEqual([
      '/v1/models?limit=1000',
      '/v1/models?limit=1000',
      '/v1/models?limit=1000',
    ])
    expect(server.headers.map(headers => headers['x-api-key']))
      .toEqual(['anthropic-key', 'anthropic-key', undefined])
    expect(server.headers.map(headers => headers['anthropic-version']))
      .toEqual(['2023-06-01', '2023-06-01', '2023-06-01'])
    expect(server.headers.map(headers => headers.authorization)).toEqual([undefined, undefined, undefined])
    expect(server.headers.map(headers => headers['user-agent'])).toEqual([userAgent(), userAgent(), userAgent()])
  })

  it('prefers the standard data array when both supported formats are present', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [{ id: 'standard' }],
        models: { enriched: { name: 'Enriched' } },
      }),
    })
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .resolves.toEqual([{ id: 'standard', name: 'standard' }])
  })

  it('keeps a deployment path instead of resolving it away', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = await harness()

    await ctx.llm.discoverModels('llm-pi-ai', { baseURL: `${server.url}/openai/v1/` })

    expect(server.paths).toEqual(['/openai/v1/models'])
  })

  it('offers no credential when the draft names none', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = await harness()

    await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url })

    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  it('authenticates configured routes the draft cannot supply a key for', async () => {
    // What the Models page actually sends after a key is saved: the form holds
    // the redacted descriptor, so the draft names the route and the endpoint
    // and no credential at all. Interrogating unauthenticated would answer 401
    // and read as a wrong key.
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    process.env['ACME_GATEWAY_KEY'] = 'stored-key'
    touchedEnv.push('ACME_GATEWAY_KEY')
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          headers: { 'X-Company-Code': 'private-tenant' },
          models: [{ id: 'acme-large' }],
        },
        'plain-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          models: [{ id: 'plain-large' }],
        },
      },
    })

    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: server.url })
    // A key typed into the form is the one being tested — possibly the
    // replacement for the stored one — so it wins without resolving the
    // missing stored credential, while the route's headers still apply.
    Reflect.deleteProperty(process.env, 'ACME_GATEWAY_KEY')
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: server.url, apiKey: 'typed' })
    // A route no profile declares yet is the create case: nothing is stored.
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'not-declared-yet', baseURL: server.url })
    // A configured route without deployment headers still contributes its
    // stored credential without inventing a header map.
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'plain-gateway', baseURL: server.url, apiKey: 'plain-typed' })

    expect(server.headers.map(headers => headers.authorization))
      .toEqual(['Bearer stored-key', 'Bearer typed', undefined, 'Bearer plain-typed'])
    expect(server.headers.map(headers => headers['x-company-code']))
      .toEqual(['private-tenant', 'private-tenant', undefined, undefined])
  })

  it('leaves a catalog route\'s credential unresolved, having never reached the network', async () => {
    // The catalog answers before any endpoint is asked, so a route whose
    // profile names a credential that is not set must still answer rather than
    // failing over a key the interrogation never needed.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    Reflect.deleteProperty(process.env, 'ABSENT_FOR_DISCOVERY')
    await ctx.plugin(LlmPiAi, { providers: { deepseek: { apiKeyEnv: 'ABSENT_FOR_DISCOVERY' } } })

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })).resolves.not.toHaveLength(0)
  })

  it('drops unusable rows rather than failing the whole listing', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          { id: 'good' },
          { id: '' },
          { name: 'no id at all' },
          null,
          { id: 'good' },
          { id: 'zero-capacity', context_length: 0, max_tokens: -1 },
        ],
      }),
    })
    const ctx = await harness()

    expect(await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .toEqual([{ id: 'good', name: 'good' }, { id: 'zero-capacity', name: 'zero-capacity' }])
  })

  it('points at the credential for a rejected one, and only then', async () => {
    const ctx = await harness()

    for (const status of [401, 403]) {
      const refused = await listingServer({ status, body: '{"error":"nope"}' })
      await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: refused.url, apiKey: 'wrong' }))
        .rejects.toThrow(new RegExp(`answered ${status}; check the API key`))
    }

    // A server fault is not a credential problem, so it must not send the user
    // off to re-check a key that is fine.
    const broken = await listingServer({ status: 500, body: '{"error":"boom"}' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: broken.url, apiKey: 'fine' }))
      .rejects.toThrow(/answered 500$/)
  })

  it('reports a reply that is not a model listing', async () => {
    const server = await listingServer({ body: '{"models":[]}' })
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .rejects.toThrow(/neither a "data" array nor a "models" object/)

    const broken = await listingServer({ body: 'not json at all' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: broken.url }))
      .rejects.toThrow(/did not answer with JSON/)
  })

  it('refuses an oversized reply, whether its length is declared or streamed', async () => {
    const ctx = await harness()
    // Just over the four-megabyte ceiling, as one padded model row.
    const oversized = `{"data":[{"id":"m","pad":"${'x'.repeat(4 * 1024 * 1024)}"}]}`

    const declared = await listingServer({ body: oversized })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: declared.url }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)

    // A streamed reply declares no length, so the ceiling has to hold on the
    // body the harness actually read.
    const streamed = await listingServer({ chunks: ['{"data":[{"id":"m","pad":"', 'x'.repeat(4 * 1024 * 1024), '"}]}'] })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: streamed.url }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)
  })

  it('reports an unreachable endpoint instead of an empty catalog', async () => {
    const ctx = await harness()
    // Port 9 is the discard service: nothing accepts a connection there.
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'http://127.0.0.1:9/v1' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it.each(['azure-openai-responses'])(
    'says it cannot interrogate %s rather than guessing a shape',
    async (api) => {
      // Azure authenticates with an `api-key` header and an `api-version`
      // query despite its OpenAI lineage; guessing at it would report an auth
      // failure as a provider with no models.
      const ctx = await harness()
      await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'https://gateway.example/v1', api }))
        .rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    },
  )

  it('reports cancellation during the body read as an abort, not a raw reason', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const bodyRead = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('expected a discovery signal')
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          bodyRead.resolve(undefined)
          return new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              stream.error(signal.reason)
              resolve()
            }, { once: true })
          })
        },
      }))
    })
    const probe = ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: 'https://slow.example/v1',
    }, controller.signal)
    await bodyRead.promise
    controller.abort('test cancellation')

    await expect(probe).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honors caller cancellation', async () => {
    const ctx = await harness()
    const aborted = AbortSignal.abort('test cancellation')
    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: 'http://127.0.0.1:9/v1',
    }, aborted)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('is offered for the namespace, and refuses one it does not serve', async () => {
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).resolves.not.toHaveLength(0)
    await expect(ctx.llm.discoverModels('llm-deepseek', { baseURL: 'https://api.deepseek.com' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
  })

  it('withdraws the offer when the plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmPiAi, {})
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).resolves.not.toHaveLength(0)

    await fiber.dispose()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  })
})

describe('probe key format', () => {
  it('reports an illegal probe key as a credential fault, not an unreachable endpoint', async () => {
    await expect(discoverModels({
      baseURL: 'https://acme.test',
      api: 'openai-completions',
      apiKey: 'sk-\u{1F600}',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('reports a blank probe key as a credential fault too', async () => {
    // The Models page omits `apiKey` entirely for a cleared field rather than
    // sending '', so this pins the contract for every other caller: a supplied
    // key is judged, and only an absent one probes unauthenticated. '' means
    // "I have a key" and is answered as the empty key it is.
    await expect(discoverModels({
      baseURL: 'https://acme.test',
      api: 'openai-completions',
      apiKey: '',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('leaves a probe with no key unauthenticated', async () => {
    // The file's other cases capture headers through a real local HTTP server
    // (`listingServer`); this one has no route or stored key to resolve, so
    // the smallest real double is a `fetch` stub, scoped to this test and
    // unstubbed by the shared `afterEach` above.
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await discoverModels({ baseURL: 'https://acme.test', api: 'openai-completions' })

    const headers = new Headers(requests[0]?.headers)
    expect(headers.has('authorization')).toBe(false)
  })
})

/**
 * Replies recorded from live endpoints on 2026-09-02, plus the reply
 * Anthropic's List Models reference documents. Each file keeps the reply's
 * top-level fields and entry objects verbatim; only a recorded entry list is
 * cut down to the named entries so the archive stays small.
 */
const RECORDED_LISTINGS = [
  {
    name: 'OpenRouter GET /api/v1/models',
    file: 'openrouter-2026-09-02.json',
    api: 'openai-completions',
    models: [
      { id: 'anthropic/claude-fable-5.1', name: 'Anthropic: Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 128_000 },
      // The router's own aggregate route reports no completion cap.
      { id: 'openrouter/auto-beta', name: 'Auto Router (Beta)', contextWindow: 2_000_000 },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash 0423', contextWindow: 1_048_576, maxTokens: 384_000 },
    ],
  },
  {
    name: 'the models.dev anthropic provider object',
    file: 'models-dev-anthropic-2026-09-02.json',
    api: 'openai-completions',
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)', contextWindow: 200_000, maxTokens: 64_000 },
    ],
  },
  {
    name: 'DeepSeek GET /models',
    file: 'deepseek-2026-09-02.json',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'deepseek-v4-flash-vision-exp' },
    ],
  },
  {
    name: "Anthropic's documented GET /v1/models example",
    file: 'anthropic-reference-example.json',
    api: 'anthropic-messages',
    // The reference example fills both capacities with 0, which is not a
    // usable capacity, so the row carries the name alone.
    models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }],
  },
]

describe('recorded provider listings', () => {
  it.each(RECORDED_LISTINGS)('reads $name as recorded', async ({ file, api, models }) => {
    const body = await readFile(new URL(`./fixtures/model-listings/${file}`, import.meta.url), 'utf8')
    const server = await listingServer({ body })
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url, api })).resolves.toEqual(models)
  })
})
