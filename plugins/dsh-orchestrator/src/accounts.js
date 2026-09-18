/**
 * Multi-account routes for the orchestrator.
 *
 * One account is one LLM route of this plugin's own: the account's `product`
 * names the installed pi-ai catalog provider whose endpoint, wire protocol,
 * auth methods, and model list the route borrows, while the account's `id` is
 * the route key and the credential-record id. Two Grok, ChatGPT, or Gemini
 * accounts therefore exist side by side as two providers, each with its own
 * stored grant, and any role row can pick either one.
 *
 * Requests are served by llm-pi-ai's own exported `PiAiAdapter`, so context
 * conversion, streaming, retry, reasoning, and image handling stay in one
 * implementation. The adapter reads profiles from this module's registry and
 * resolves auth through a credential store this plugin owns
 * (`dsh-orchestrator/<account id>`), which is also the record a connect writes
 * and a disconnect deletes.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { accountIdFromJwt } from './image.js'

/** Settings namespace holding the account list. */
export const ACCOUNTS_NS = 'orchestrator-accounts'

/** Credential-record scope every account grant is stored under. */
export const ACCOUNT_RECORD_SCOPE = 'dsh-orchestrator'

/** Route-id grammar: the credential-key segment grammar, which route keys already must satisfy. */
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Default provider-idle interval for an account route, copied from
 * `DEFAULT_STREAM_IDLE_TIMEOUT_MS` in dsh-llm-pi-ai's resolver because a
 * resolved profile must carry a positive value.
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Default request-level base64 image bound; same source as the idle interval. */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Default total-pixel request-version budget; same source as the idle interval. */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048

/** Default raw request-version byte target; same source as the idle interval. */
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/**
 * One account entry, normalized, or null when it carries nothing usable.
 * A half-filled entry is dropped rather than guessed at: a route id this
 * plugin invents would address a credential record nobody connected.
 * @param {unknown} entry
 * @returns {{id: string, product: string, label: string} | null}
 */
export function normalizeAccount(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = text(entry.id)
  const product = text(entry.product)
  const label = text(entry.label) || id
  if (!id || !product) return null
  if (!ROUTE_ID_PATTERN.test(id)) return null
  return { id, product, label }
}

/**
 * The usable accounts in a stored section value, in stored order.
 * @param {unknown} value
 * @returns {{id: string, product: string, label: string}[]}
 */
export function accountsFrom(value) {
  const list = value && typeof value === 'object' && Array.isArray(value.accounts) ? value.accounts : []
  const out = []
  const seen = new Set()
  for (const entry of list) {
    const account = normalizeAccount(entry)
    if (!account || seen.has(account.id)) continue
    seen.add(account.id)
    out.push(account)
  }
  return out
}

/**
 * Reject an account list this plugin could not serve, naming every fault at
 * once so one settings save fixes all of them.
 * @param {unknown} value
 * @throws {Error} when the section is not `{accounts: [...]}` or any entry is unusable.
 */
export function assertAccounts(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.accounts)) {
    throw new Error('orchestrator-accounts must be an object with an `accounts` list')
  }
  const problems = []
  const seen = new Set()
  value.accounts.forEach((entry, index) => {
    const at = `accounts[${index}]`
    if (!entry || typeof entry !== 'object') {
      problems.push(`${at} must be an object`)
      return
    }
    const id = text(entry.id)
    const product = text(entry.product)
    if (!id) problems.push(`${at} needs an id`)
    else if (!ROUTE_ID_PATTERN.test(id)) problems.push(`${at} id "${id}" must be lowercase letters, digits, and hyphens, starting with a letter`)
    else if (seen.has(id)) problems.push(`${at} id "${id}" is declared twice`)
    if (id) seen.add(id)
    if (!product) problems.push(`${at} needs a product (the pi-ai provider this account signs in to)`)
  })
  if (problems.length > 0) throw new Error(`orchestrator-accounts: ${problems.join('; ')}`)
}

/**
 * A route id derived from a label and product: lowercase, hyphenated, and
 * unique against `taken`. The label supplies the human half, the product the
 * vendor half, so "Grok — work" on `xai` becomes `xai-grok-work`.
 * @param {string} product
 * @param {string} label
 * @param {readonly string[]} taken
 * @returns {string}
 */
export function accountRouteId(product, label, taken = []) {
  const slug = (part) => text(part).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const productPart = slug(product).replace(/^[^a-z]+/, '') || 'account'
  const labelPart = slug(label)
  const stem = labelPart && labelPart !== productPart ? `${productPart}-${labelPart}` : productPart
  const base = ROUTE_ID_PATTERN.test(stem) ? stem : `account-${stem}`.replace(/[^a-z0-9-]+/g, '-')
  const takenSet = new Set(taken)
  if (!takenSet.has(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`
    if (!takenSet.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * The credential record address for one account route.
 * @param {string} id
 * @returns {Promise<import('@deepseek-ai/dsh-credentials').CredentialKey>}
 */
export async function accountRecordKey(id) {
  const { credentialKey } = await loadCredentialsApi()
  return credentialKey(ACCOUNT_RECORD_SCOPE, id)
}

/** The credentials package, loaded on first use. */
let credentialsApi = null

/**
 * Resolve the credentials package the way the plugin reaches every harness
 * package: by bare specifier, resolved against the plugin's own installation.
 * @returns {Promise<object>} the package's runtime exports.
 */
export async function loadCredentialsApi() {
  if (credentialsApi === null) credentialsApi = await import('@deepseek-ai/dsh-credentials')
  return credentialsApi
}

/**
 * The JSON image of a pi-ai credential: `undefined` members are dropped
 * because the credential store's validator refuses unrepresentable values,
 * and pi-ai's own credentials carry them (an optional `accountId`, say).
 * @param {unknown} value
 * @returns {unknown}
 */
export function jsonImage(value) {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : jsonImage(entry)))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

/**
 * The stored record for a credential pi-ai produced.
 * @param {unknown} credential
 * @returns {{kind: 'api-key', key?: string, env?: Record<string, string>} | {kind: 'grant', payload: unknown}}
 */
export function recordFromCredential(credential) {
  if (!credential || typeof credential !== 'object') throw new Error('login produced no credential')
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...(typeof credential.key === 'string' && credential.key ? { key: credential.key } : {}),
      ...(credential.env && typeof credential.env === 'object' ? { env: { ...credential.env } } : {}),
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/**
 * The pi-ai credential a stored record holds.
 * @param {unknown} record
 * @returns {unknown} the credential, or undefined when nothing is stored.
 */
export function credentialFromRecord(record) {
  if (record === undefined || record === null || typeof record !== 'object') return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    }
  }
  return record.payload
}

/**
 * Connected state and a human label for one stored record.
 * @param {unknown} record
 * @returns {{connected: boolean, method?: 'oauth' | 'api key', account?: string}}
 */
export function recordState(record) {
  if (!record || typeof record !== 'object') return { connected: false }
  if (record.kind === 'api-key') {
    return { connected: typeof record.key === 'string' && record.key.length > 0, method: 'api key' }
  }
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {}
  const access = typeof payload.access === 'string' ? payload.access : ''
  const account = text(payload.email)
    || text(payload.accountId)
    || text(payload.account_id)
    || (access ? text(accountIdFromJwt(access)) : '')
  return {
    connected: Boolean(access || payload.refresh),
    method: 'oauth',
    ...(account ? { account } : {}),
  }
}

/**
 * The pi-ai provider one account route registers: the catalog provider's
 * endpoint, auth, and model list under the account's own id and name.
 *
 * Dynamic catalog refresh is dropped exactly as llm-pi-ai's own route
 * builder drops it — a background refresh would republish a catalog the
 * account route does not own.
 * @param {object} base - the installed catalog provider for the account's product.
 * @param {{id: string, label: string}} account
 * @returns {object} a pi-ai `Provider`.
 */
export function accountProvider(base, account) {
  return {
    id: account.id,
    name: account.label,
    ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
    auth: base.auth,
    getModels: () => base.getModels(),
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/**
 * Which login method an account route can offer: the product's own sign-in
 * when the installed catalog ships one, otherwise its api-key method.
 * @param {object} base - the catalog provider.
 * @returns {{type: 'oauth' | 'api_key', label: string} | null}
 */
export function accountLoginMethod(base) {
  const oauth = base && base.auth ? base.auth.oauth : undefined
  if (oauth) return { type: 'oauth', label: oauth.loginLabel || oauth.name || 'Sign in' }
  const apiKey = base && base.auth ? base.auth.apiKey : undefined
  if (apiKey && typeof apiKey.login === 'function') return { type: 'api_key', label: apiKey.name || 'API key' }
  return null
}

/**
 * The resolved profiles one account set produces, plus what could not be
 * served. A product the installed catalog does not ship is reported rather
 * than registered: a route with no protocol could only fail every request.
 * @param {{accounts: {id: string, product: string, label: string}[], builtins: object[]}} input
 * @returns {{profiles: Map<string, object>, problems: string[]}}
 */
export function buildAccountProfiles({ accounts, builtins }) {
  const profiles = new Map()
  const problems = []
  for (const account of accounts) {
    const base = builtins.find((provider) => provider.id === account.product)
    if (base === undefined) {
      problems.push(`account "${account.id}": unknown product "${account.product}"`)
      continue
    }
    profiles.set(account.id, {
      provider: account.id,
      displayName: account.label,
      piProvider: accountProvider(base, account),
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
      requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
      configuredMaxTokens: new Map(),
    })
  }
  return { profiles, problems }
}

/**
 * Resolve the installed pi-ai library the account routes are served by.
 *
 * It is located through dsh-llm-pi-ai's own installation rather than by a bare
 * import, because only the harness packages are hoisted beside this plugin:
 * the library lives in the adapter's private `node_modules`, and reading it
 * from there is what keeps one pi-ai instance in the process. The provider
 * catalog is a package subpath, so it is loaded beside the entry the same way
 * the adapter family itself reaches it.
 * @returns {Promise<object>} the pi-ai entry module, with `builtinProviders` from its catalog subpath.
 */
export async function loadPiAi() {
  let adapterDir
  try {
    adapterDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai')))
  } catch (error) {
    throw new Error(`llm-pi-ai is not installed beside this plugin: ${String(error && error.message ? error.message : error)}`)
  }
  const candidates = [
    join(adapterDir, '..', 'node_modules', '@earendil-works', 'pi-ai'),
    join(adapterDir, '..', '..', '..', 'node_modules', '@earendil-works', 'pi-ai'),
    join(homedir(), '.dsh', 'plugins', 'node_modules', '@earendil-works', 'pi-ai'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@earendil-works', 'pi-ai'),
  ]
  for (const candidate of candidates) {
    const entry = join(candidate, 'dist', 'index.js')
    const catalog = join(candidate, 'dist', 'providers', 'all.js')
    if (!existsSync(entry) || !existsSync(catalog)) continue
    const main = await import(pathToFileURL(resolvePath(entry)).href)
    const providers = await import(pathToFileURL(resolvePath(catalog)).href)
    return Object.assign({}, main, { builtinProviders: providers.builtinProviders })
  }
  throw new Error('the pi-ai library was not found; account routes need the installation dsh-llm-pi-ai came from')
}

/**
 * The credential store pi-ai reads and writes for account routes, backed by
 * the harness credential records under {@link ACCOUNT_RECORD_SCOPE}.
 *
 * `modify` is the only write path, so a token refresh is one serialized
 * read-decide-replace under the store's own lock — the same reason the
 * adapter family keys its records this way.
 * @param {{get: (name: string) => object | undefined}} ctx
 * @param {(id: string) => Promise<unknown> | unknown} [keyFor] - record address builder; defaults to {@link accountRecordKey}.
 * @returns {object} a pi-ai `CredentialStore`.
 */
export function createAccountCredentialStore(ctx, keyFor = accountRecordKey) {
  const store = () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('the credentials service is not mounted; an account sign-in has nowhere to store its grant')
    return credentials
  }
  return {
    keyFor,
    async read(providerId) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      if (!ROUTE_ID_PATTERN.test(providerId)) return undefined
      return credentialFromRecord(await credentials.readRecord(await keyFor(providerId)))
    },
    async list() {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return []
      const records = await credentials.listRecords()
      const out = []
      for (const entry of records) {
        const key = entry && entry.key !== undefined ? String(entry.key) : ''
        if (!key.startsWith(`${ACCOUNT_RECORD_SCOPE}/`)) continue
        out.push({
          providerId: key.slice(ACCOUNT_RECORD_SCOPE.length + 1),
          type: entry.kind === 'api-key' ? 'api_key' : 'oauth',
        })
      }
      return out
    },
    async modify(providerId, fn) {
      if (!ROUTE_ID_PATTERN.test(providerId)) {
        throw new Error(`account route "${providerId}" cannot address a credential record`)
      }
      const key = await keyFor(providerId)
      const next = await store().modifyRecord(key, async (current) => {
        const credential = await fn(credentialFromRecord(current))
        return credential === undefined ? undefined : recordFromCredential(credential)
      })
      return credentialFromRecord(next)
    },
    async delete(providerId) {
      if (!ROUTE_ID_PATTERN.test(providerId)) return
      await store().deleteRecord(await keyFor(providerId))
    },
  }
}

/**
 * Ambient lookups a provider performs while resolving its own auth: the
 * harness credential references first (so `XAI_API_KEY` in the store counts),
 * then the process environment, plus the file probe providers such as Bedrock
 * use for on-disk credentials.
 * @param {{get: (name: string) => object | undefined}} ctx
 * @returns {object} a pi-ai `AuthContext`.
 */
export function createAccountAuthContext(ctx) {
  return {
    async env(name) {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const { isCredentialRefName, credentialRef } = await loadCredentialsApi()
        if (isCredentialRefName(name)) {
          const hit = await credentials.resolve(credentialRef(name))
          if (hit !== undefined) return hit.value
        }
      }
      return process.env[name]
    },
    async fileExists(path) {
      try {
        const expanded = typeof path === 'string' && path.startsWith('~')
          ? join(homedir(), path.slice(1))
          : path
        return existsSync(expanded)
      } catch {
        return false
      }
    },
  }
}

/**
 * The account subsystem: one llm-pi-ai adapter serving every account route,
 * rebuilt from the settings section on each change.
 *
 * Routes are swapped through the registration's atomic `replace`, so a rename
 * never leaves a request routed to a profile that is no longer there. The
 * first registration happens when the first account exists, because the
 * registry refuses a route-less adapter; afterwards an emptied list keeps the
 * registration live holding none.
 * @param {{ctx: object, log?: object, piAi: object, adapterClass?: object}} input
 * @returns {Promise<object>} the runtime, with `sync`, `status`, `connect`, `disconnect`.
 */
export async function createAccountsRuntime({ ctx, log, piAi, adapterClass }) {
  const AdapterClass = adapterClass ?? (await import('@deepseek-ai/dsh-llm-pi-ai')).PiAiAdapter
  let profiles = new Map()
  let handle
  let problems = []
  /** Routes this registration currently holds, so a re-sync never reads them as a foreign conflict. */
  let owned = new Set()
  const credentials = createAccountCredentialStore(ctx)
  const adapter = new AdapterClass({
    profiles: () => profiles,
    // No request-level key override: an account's key or grant is what the
    // credential store holds, and pi-ai resolves it per route from there.
    resolveApiKey: async () => undefined,
    auth: { credentials, authContext: createAccountAuthContext(ctx) },
    resolveAttachments: () => ctx.get('attachments'),
  })

  function modelsFor(account) {
    const base = piAi.builtinProviders().find((provider) => provider.id === account.product)
    if (base === undefined) throw new Error(`unknown product "${account.product}" for account "${account.id}"`)
    const models = piAi.createModels({ credentials, authContext: createAccountAuthContext(ctx) })
    models.setProvider(accountProvider(base, account))
    return { models, base }
  }

  return {
    /** The llm-pi-ai adapter serving every account route. */
    adapter,
    /**
     * Apply one account list to the route registry.
     * @param {{id: string, product: string, label: string}[]} accounts
     * @returns {string[]} problems that kept an account out of the registry.
     */
    sync(accounts) {
      const built = buildAccountProfiles({ accounts, builtins: piAi.builtinProviders() })
      const next = [...built.profiles.keys()]
      const conflicts = []
      for (const entry of (ctx.get('llm')?.listProviders() ?? [])) {
        const id = entry && entry.id ? entry.id : String(entry)
        if (next.includes(id) && !owned.has(id)) conflicts.push(`account route "${id}" is already served by another adapter`)
      }
      if (conflicts.length > 0) {
        problems = conflicts
        return problems
      }
      if (handle === undefined) {
        profiles = built.profiles
        problems = built.problems
        if (next.length === 0) return problems
        handle = ctx.llm.registerAdapter(next, adapter)
        owned = new Set(next)
        return problems
      }
      handle.replace(next)
      profiles = built.profiles
      problems = built.problems
      owned = new Set(next)
      return problems
    },
    /** Problems from the last {@link sync}. */
    problems: () => problems.slice(),
    /**
     * Connected state for one account list, plus what could not be read.
     * @param {{id: string, product: string, label: string}[]} accounts
     * @returns {Promise<object[]>}
     */
    async status(accounts) {
      const credentialService = ctx.get('credentials')
      const builtins = piAi.builtinProviders()
      const out = []
      for (const account of accounts) {
        const base = builtins.find((provider) => provider.id === account.product)
        const method = base === undefined ? null : accountLoginMethod(base)
        const record = credentialService === undefined
          ? undefined
          : await credentialService.readRecord(await credentials.keyFor(account.id))
        const state = recordState(record)
        out.push({
          id: account.id,
          product: account.product,
          label: account.label,
          productName: base ? base.name : account.product,
          methods: method === null ? [] : [method.type],
          loginLabel: method === null ? null : method.label,
          ...state,
        })
      }
      return out
    },
    /**
     * Run one account's own sign-in and store what it produced.
     * @param {object} account
     * @param {object} interaction - pi-ai `AuthInteraction` (notify + prompt + signal).
     * @returns {Promise<object>} the stored state for the account.
     */
    async connect(account, interaction) {
      const { models, base } = modelsFor(account)
      const method = accountLoginMethod(base)
      if (method === null) throw new Error(`product "${account.product}" offers no interactive sign-in; configure it with an API key instead`)
      const credential = await models.login(account.id, method.type, interaction)
      return { ...recordState(recordFromCredential(credential)), method: method.type === 'oauth' ? 'oauth' : 'api key' }
    },
    /**
     * Forget one account's stored credential.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async disconnect(id) {
      const credentialService = ctx.get('credentials')
      if (credentialService === undefined) throw new Error('the credentials service is not mounted')
      await credentialService.deleteRecord(await credentials.keyFor(id))
      log?.info?.('dsh-orchestrator: disconnected account route "%s"', id)
    },
  }
}
