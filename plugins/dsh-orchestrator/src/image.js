/**
 * Provider image-generation calls for the DSH `image_gen` tool.
 * Grok, Gemini, and OpenAI expose image generation in their own products; the
 * harness chat adapters do not forward those native tools, so this module
 * calls the matching image endpoints with the same stored credentials.
 * A Codex (`openai-codex`) worker generates through the ChatGPT backend's
 * Responses `image_generation` tool with the stored OAuth grant, billed to
 * the ChatGPT subscription — no API key involved.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { Buffer } from 'node:buffer'

const RECORD_SCOPE = 'llm-pi-ai'

/** Credential scope this plugin's own account routes store their grants under. */
const ACCOUNT_RECORD_SCOPE = 'dsh-orchestrator'

const XAI_IMAGE_MODELS = ['grok-2-image', 'grok-2-image-1212', 'grok-imagine-image']
const GOOGLE_IMAGE_MODELS = [
  'gemini-3.1-flash-lite-image',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.5-flash-image',
]

// Attempted in order; each miss falls through to the next, so ids the
// installed pi-ai catalog has not caught up with stay attemptable.
// On Codex routes these are the Responses `image_generation` tool models.
const OPENAI_IMAGE_MODELS = [
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5',
  'gpt-image-2',
]

/**
 * @param {unknown} record
 * @returns {string | undefined}
 */
export function secretFromRecord(record) {
  if (!record || typeof record !== 'object') return undefined
  if (record.kind === 'api-key' && typeof record.key === 'string' && record.key) return record.key
  const payload = record.payload
  if (!payload || typeof payload !== 'object') return undefined
  for (const field of ['access', 'access_token', 'token', 'apiKey', 'key']) {
    const value = payload[field]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/**
 * Whether a model id names an image endpoint model rather than a chat model.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isImageModelId(id) {
  return typeof id === 'string' && /image|imagine|imagen/i.test(id)
}

/**
 * Chat models that can generate images still need the image endpoint id.
 * @param {string} provider
 * @param {string} model
 * @returns {string[]}
 */
export function imageModelsFor(provider, model) {
  const id = typeof model === 'string' ? model : ''
  if (isImageModelId(id)) return [id]
  if (provider === 'xai') return XAI_IMAGE_MODELS
  if (provider === 'google') return GOOGLE_IMAGE_MODELS
  if (provider === 'openai' || provider === 'openai-codex') return OPENAI_IMAGE_MODELS
  return []
}

/**
 * Live chat models for an image turn, in catalog order. Reads the provider's
 * current catalog, so a stale pi-ai catalog cannot pin a retired chat id.
 * The backend judges tool support per chat model at call time; callers
 * advance through this list on `not supported with` failures.
 * @param {{get: (name: string) => object | undefined}} ctx
 * @param {string} provider
 * @returns {Promise<string[]>}
 */
export async function resolveChatModels(ctx, provider) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm unavailable; cannot pick a chat model for the image turn')
  let models = []
  try {
    models = (await llm.listModels(provider)) || []
  } catch {
    throw new Error(`model list unavailable for provider "${provider}"; pin a chat model as the imagegen route model instead`)
  }
  const chats = models
    .map((model) => (model && model.id ? model.id : String(model)))
    .filter((id) => id && !isImageModelId(id))
  if (chats.length === 0) throw new Error(`no chat model found for provider "${provider}"; pin a chat model as the imagegen route model instead`)
  return chats
}

/**
 * First live chat model for an image turn.
 * @param {{get: (name: string) => object | undefined}} ctx
 * @param {string} provider
 * @returns {Promise<string>}
 */
export async function resolveChatModel(ctx, provider) {
  return (await resolveChatModels(ctx, provider))[0]
}

/**
 * Which dimension a failed Codex attempt faults: the turn's chat model
 * (`Tool ... is not supported with ...`), the image tool model (unknown or
 * rejected id), or anything else (kept on the current pair's successor).
 * @param {string} message
 * @returns {'chat' | 'tool' | 'other'}
 */
export function codexErrorKind(message) {
  const text = String(message)
  if (/not supported with/i.test(text)) return 'chat'
  if (/invalid model|model .*not found|does not exist|unknown model|model_not_found/i.test(text)) return 'tool'
  return 'other'
}

/**
 * Read the Codex OAuth grant this plugin needs: the access token for the
 * ChatGPT backend plus the refresh token that rotates it.
 * @param {unknown} record
 * @returns {{access: string, refresh: string | undefined, expires: number | undefined, accountId: string | undefined}}
 */
export function codexGrantFromRecord(record) {
  const payload = record && typeof record === 'object' ? record.payload : undefined
  const access = secretFromRecord(record)
  if (!payload || typeof payload !== 'object' || !access) {
    throw new Error('no stored credential for openai-codex; connect it in Settings → Models')
  }
  const refresh = typeof payload.refresh === 'string' && payload.refresh ? payload.refresh : undefined
  const expires = typeof payload.expires === 'number' ? payload.expires : undefined
  const accountId = typeof payload.accountId === 'string' && payload.accountId
    ? payload.accountId
    : typeof payload.account_id === 'string' && payload.account_id ? payload.account_id : undefined
  return { access, refresh, expires, accountId }
}

/**
 * Whether a Codex grant needs rotation before use. A missing expiry cannot
 * be trusted, so it refreshes too.
 * @param {{expires: number | undefined}} grant
 * @param {number} [now]
 * @returns {boolean}
 */
export function codexGrantIsStale(grant, now = Date.now()) {
  return typeof grant.expires !== 'number' || grant.expires - now < 120000
}

/**
 * ChatGPT account id for the `chatgpt-account-id` backend header, decoded
 * from the OAuth access token's JWT claim. Same claim pi-ai reads.
 * @param {string} token
 * @returns {string | undefined}
 */
export function accountIdFromJwt(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * The stored record and its address for one route: the adapter family's own
 * record first, then the record this plugin writes when the route is one of
 * its accounts, so an image turn works the same on either.
 * @param {{get: (name: string) => object | undefined}} ctx
 * @param {string} provider
 * @param {(scope: string, provider: string) => Promise<unknown>} [keyFor] - record address builder; the credentials package by default.
 * @returns {Promise<{record: unknown, key: unknown} | undefined>}
 */
export async function readRouteRecord(ctx, provider, keyFor = defaultRecordKey) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  for (const scope of [RECORD_SCOPE, ACCOUNT_RECORD_SCOPE]) {
    const key = await keyFor(scope, provider)
    const record = await credentials.readRecord(key)
    if (record !== undefined) return { record, key }
  }
  return undefined
}

/**
 * Address one record in one scope through the credentials package.
 * @param {string} scope
 * @param {string} provider
 * @returns {Promise<unknown>}
 */
async function defaultRecordKey(scope, provider) {
  const { credentialKey } = await import('@deepseek-ai/dsh-credentials')
  return credentialKey(scope, provider)
}

async function readSecret(ctx, provider) {
  const found = await readRouteRecord(ctx, provider)
  const secret = secretFromRecord(found === undefined ? undefined : found.record)
  if (!secret) {
    const envNames = provider === 'xai'
      ? ['XAI_API_KEY']
      : provider === 'google'
        ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
        : provider === 'openai'
          ? ['OPENAI_API_KEY']
          : []
    for (const name of envNames) {
      if (process.env[name]) return process.env[name]
    }
    throw new Error(`no stored credential for ${provider}; connect it in Settings (Models for a provider route, Orchestrator for an account)`)
  }
  return secret
}

function decodeImagePayload(body, contentType) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body !== 'string') body = JSON.stringify(body)
  const trimmed = body.trim()
  try {
    const json = JSON.parse(trimmed)
    const b64 = json?.data?.[0]?.b64_json
      || json?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData?.data
      || json?.candidates?.[0]?.content?.parts?.find((part) => part.inline_data)?.inline_data?.data
    const url = json?.data?.[0]?.url
    if (typeof b64 === 'string' && b64) return { buffer: Buffer.from(b64, 'base64'), url: undefined }
    if (typeof url === 'string' && url) return { buffer: undefined, url }
  } catch {
    // Not JSON; maybe raw bytes already as latin1 from a non-JSON response.
  }
  if (contentType && contentType.includes('image/')) return { buffer: Buffer.from(trimmed, 'binary'), url: undefined }
  return { buffer: undefined, url: undefined, error: trimmed.slice(0, 400) }
}

async function fetchBuffer(url, headers) {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`download failed ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function generateXai(secret, model, prompt) {
  const response = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      response_format: 'b64_json',
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`xai ${model} HTTP ${response.status}: ${text.slice(0, 300)}`)
  const decoded = decodeImagePayload(text, response.headers.get('content-type'))
  if (decoded.buffer) return decoded.buffer
  if (decoded.url) return fetchBuffer(decoded.url, { authorization: `Bearer ${secret}` })
  throw new Error(`xai ${model} returned no image (${decoded.error || 'empty'})`)
}

async function generateGoogle(secret, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'x-goog-api-key': secret,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`google ${model} HTTP ${response.status}: ${text.slice(0, 300)}`)
  const decoded = decodeImagePayload(text, response.headers.get('content-type'))
  if (decoded.buffer) return decoded.buffer
  if (decoded.url) return fetchBuffer(decoded.url)
  throw new Error(`google ${model} returned no image (${decoded.error || 'empty'})`)
}

async function generateOpenai(secret, model, prompt) {
  // No response_format: gpt-image models reject it and dall-e models default
  // to a short-lived url, which decodeImagePayload already handles.
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`openai ${model} HTTP ${response.status}: ${text.slice(0, 300)}`)
  const decoded = decodeImagePayload(text, response.headers.get('content-type'))
  if (decoded.buffer) return decoded.buffer
  if (decoded.url) return fetchBuffer(decoded.url)
  throw new Error(`openai ${model} returned no image (${decoded.error || 'empty'})`)
}

/**
 * Generate one image with the worker's provider and write it to `outputPath`.
 * A Codex worker keeps its chat model for the Responses turn and cycles the
 * OpenAI image list as the `image_generation` tool model, billed to the
 * ChatGPT subscription through the stored OAuth grant. An explicit
 * `imageModel` pins a single tool model instead of cycling. Workspace
 * `references` attach as `input_image` parts of the same turn so the
 * generation can follow, restyle, or edit them; only Codex routes take them.
 * @param {{ctx: object, provider: string, model: string, prompt: string, outputPath: string, imageModel?: string, references?: string[], size?: string, effort?: string, accountProduct?: string}} input
 * @returns {Promise<{path: string, provider: string, model: string, bytes: number}>}
 */
export async function generateAndSave(input) {
  // An account route names its product's image endpoints through the product,
  // because the route id itself is not one of the provider keys this table
  // knows.
  const models = input.imageModel ? [input.imageModel] : imageModelsFor(input.accountProduct || input.provider, input.model)
  if (models.length === 0) {
    throw new Error(`provider "${input.provider}" has no image-generation endpoint in this plugin`)
  }
  const codexRoute = input.provider === 'openai-codex' || input.accountProduct === 'openai-codex'
  if (codexRoute) {
    return generateCodex(input.ctx, {
      provider: input.provider,
      chatModel: input.model,
      toolModels: models,
      prompt: input.prompt,
      outputPath: input.outputPath,
      referencePaths: input.references || [],
      size: normalizeImageSize(input.size),
      effort: normalizeTurnEffort(input.effort),
    })
  }
  if (input.references && input.references.length > 0) {
    throw new Error(`reference images are only supported on Codex routes, not provider "${input.provider}"`)
  }
  const secret = await readSecret(input.ctx, input.provider)
  const errors = []
  for (const model of models) {
    try {
      const buffer = input.provider === 'xai'
        ? await generateXai(secret, model, input.prompt)
        : input.provider === 'google'
          ? await generateGoogle(secret, model, input.prompt)
          : await generateOpenai(secret, model, input.prompt)
      await mkdir(dirname(input.outputPath), { recursive: true })
      await writeFile(input.outputPath, buffer)
      return { path: input.outputPath, provider: input.provider, model, bytes: buffer.length }
    } catch (error) {
      errors.push(`${model}: ${String(error && error.message ? error.message : error)}`)
    }
  }
  throw new Error(errors.join(' | '))
}

/** ChatGPT OAuth token endpoint; the client id minted the stored grant, and refresh tokens are bound to it (same client pi-ai's Codex flow uses). */
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Codex Responses endpoint: the same ChatGPT backend pi-ai streams chat through. */
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/**
 * Rotate a Codex grant. The token URL is overridable for tests; production
 * always uses the ChatGPT OAuth endpoint above.
 * @param {string} refreshToken
 * @param {string} [tokenUrl]
 * @returns {Promise<{access: string, refresh: string, expires: number}>}
 */
export async function refreshCodexGrant(refreshToken, tokenUrl = CODEX_TOKEN_URL) {
  let response
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    })
  } catch (error) {
    throw new Error(`openai-codex token refresh error: ${String(error && error.message ? error.message : error)}`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`openai-codex token refresh failed (${response.status}): ${text.slice(0, 200)}`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('openai-codex token refresh returned non-JSON')
  }
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
    throw new Error(`openai-codex token refresh response missing fields: ${text.slice(0, 200)}`)
  }
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 }
}

/**
 * Rotate the stored Codex grant when it is stale. The staleness re-check
 * runs inside the serialized write, so two concurrent rotations keep the
 * second one's fresh read instead of spending a rotated-out refresh token.
 */
async function persistRefreshedCodexGrant(credentials, key) {
  const after = await credentials.modifyRecord(key, async (current) => {
    const grant = codexGrantFromRecord(current)
    if (!codexGrantIsStale(grant)) return undefined
    if (!grant.refresh) throw new Error('stored openai-codex grant has no refresh token; reconnect it in Settings → Orchestrator')
    const fresh = await refreshCodexGrant(grant.refresh)
    const payload = current.payload
    return { kind: 'grant', payload: { ...payload, type: 'oauth', access: fresh.access, refresh: fresh.refresh, expires: fresh.expires } }
  })
  return codexGrantFromRecord(after)
}

function describeCodexFailure(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const code = typeof value.code === 'string' ? value.code : undefined
    const message = typeof value.message === 'string' ? value.message : undefined
    if (message) return code ? `${code}: ${message}` : message
    try {
      return JSON.stringify(value).slice(0, 300)
    } catch {
      return 'unknown error'
    }
  }
  return 'unknown error'
}

/**
 * Base64 image result from a Responses `output` array.
 * @param {unknown} output
 * @param {unknown} whole
 * @returns {string}
 */
export function codexImageFromOutput(output, whole) {
  const list = Array.isArray(output) ? output : []
  const item = list.find((entry) => entry && typeof entry === 'object' && entry.type === 'image_generation_call')
  if (!item) {
    const failure = list.find((entry) => entry && typeof entry === 'object' && (entry.type === 'response.failed' || entry.status === 'failed'))
    throw new Error(`codex response held no image (${describeCodexFailure(failure) || describeCodexFailure(whole).slice(0, 200)})`)
  }
  if (typeof item.result === 'string' && item.result) return item.result
  throw new Error(`codex image_generation_call produced no image (status: ${item.status || 'unknown'})`)
}

/**
 * Base64 image result from a streamed or plain Responses body. The stream is
 * detected by content as well as header: some backends serve SSE frames under
 * a generic content type.
 * @param {string} text
 * @param {string | null} contentType
 * @returns {string}
 */
export function extractCodexImage(text, contentType) {
  const streamed = (contentType && contentType.includes('text/event-stream'))
    || /^\s*event:/m.test(text)
    || /\ndata:\s*\{/.test(text)
  if (!streamed) {
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`codex returned non-JSON: ${text.slice(0, 200)}`)
    }
    if (json && typeof json === 'object' && json.error) {
      throw new Error(`codex image request failed: ${describeCodexFailure(json.error)}`)
    }
    return codexImageFromOutput(json?.output, json)
  }
  let failure = null
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const payloads = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('data:')) payloads.push(line.slice(5).trimStart())
    }
    if (payloads.length === 0) continue
    const data = payloads.join('\n')
    if (data === '[DONE]') continue
    let event
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'response.output_item.done' && event.item?.type === 'image_generation_call') {
      const result = event.item.result
      if (typeof result === 'string' && result) return result
      throw new Error(`codex image_generation_call produced no image (status: ${event.item.status || 'unknown'})`)
    }
    if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
      return codexImageFromOutput(event.response.output, event.response)
    }
    if (event.type === 'response.failed') failure = describeCodexFailure(event.response?.error || event.error)
  }
  throw new Error(failure ? `codex image request failed: ${failure}` : 'codex stream held no image')
}

/**
 * Media type for a reference image path, or undefined when the extension
 * names no format the image endpoint reads.
 * @param {string} imagePath
 * @returns {string | undefined}
 */
export function mimeTypeForImagePath(imagePath) {
  const ext = extname(String(imagePath)).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return undefined
}

/**
 * Read workspace reference images into data payloads for `input_image` parts.
 * @param {string[]} imagePaths
 * @returns {Promise<Array<{mimeType: string, base64: string}>>}
 */
export async function readReferenceImages(imagePaths) {
  const out = []
  for (const imagePath of imagePaths) {
    const mimeType = mimeTypeForImagePath(imagePath)
    if (!mimeType) throw new Error(`reference "${imagePath}" must be a .png, .jpg, or .webp file`)
    let bytes = null
    try {
      bytes = await readFile(imagePath)
    } catch {
      throw new Error(`reference "${imagePath}" is not readable`)
    }
    out.push({ mimeType, base64: bytes.toString('base64') })
  }
  return out
}

/**
 * Message content for a Codex image turn: the prompt plus one `input_image`
 * part per reference, following the backend's message-list shape.
 * @param {string} prompt
 * @param {Array<{mimeType: string, base64: string}>} references
 * @returns {Array<object>}
 */
export function codexMessageContent(prompt, references) {
  const content = [{ type: 'input_text', text: prompt }]
  for (const reference of references) {
    content.push({ type: 'input_image', image_url: `data:${reference.mimeType};base64,${reference.base64}` })
  }
  return content
}

/** Image sizes the `image_generation` tool takes. */
const CODEX_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto']

/**
 * Validated image size, or undefined to take the backend default.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeImageSize(value) {
  if (value === undefined || value === null || value === '') return undefined
  const size = String(value).trim()
  if (!CODEX_IMAGE_SIZES.includes(size)) {
    throw new Error(`unsupported image size "${size}"; use ${CODEX_IMAGE_SIZES.join(', ')}`)
  }
  return size
}

/** Turn reasoning efforts the backend takes; anything else is omitted. */
const CODEX_TURN_EFFORTS = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high', xhigh: 'high' }

/**
 * Validated turn reasoning effort, or undefined to take the backend default.
 * Unknown values are omitted rather than rejected: effort dialects differ per
 * catalog, and a wrong guess must cheapen the turn, never fail it.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeTurnEffort(value) {
  if (value === undefined || value === null || value === '') return undefined
  return CODEX_TURN_EFFORTS[String(value).trim().toLowerCase()]
}

/**
 * Request body for a forced-`image_generation` Responses turn.
 * @param {{chatModel: string, toolModel: string, prompt: string, references?: Array<{mimeType: string, base64: string}>, size?: string, effort?: string}} input
 * @returns {object}
 */
export function codexRequestBody(input) {
  return {
    model: input.chatModel,
    store: false,
    // The Codex backend takes a message list, never a bare string.
    input: [{ role: 'user', content: codexMessageContent(input.prompt, input.references || []) }],
    tools: [{ type: 'image_generation', model: input.toolModel, ...(input.size ? { size: input.size } : {}) }],
    tool_choice: { type: 'image_generation' },
    ...(input.effort ? { reasoning: { effort: input.effort } } : {}),
    stream: true,
  }
}

/**
 * One forced-`image_generation` Responses turn on the Codex backend.
 */
async function requestCodexImage(input) {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.access}`,
      'chatgpt-account-id': input.accountId,
      'OpenAI-Beta': 'responses=experimental',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(codexRequestBody({
      chatModel: input.chatModel,
      toolModel: input.toolModel,
      prompt: input.prompt,
      references: input.references,
      size: input.size,
    })),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 300)
    try {
      const json = JSON.parse(text)
      if (json && typeof json === 'object' && json.error) detail = describeCodexFailure(json.error)
    } catch {
      // Plain-text failure body; the slice above already carries it.
    }
    throw new Error(`codex ${input.chatModel}+${input.toolModel} HTTP ${response.status}: ${detail}`)
  }
  return extractCodexImage(text, response.headers.get('content-type'))
}

async function saveCodexImage(outputPath, b64, toolModel, turnModel) {
  const buffer = Buffer.from(b64, 'base64')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, buffer)
  return { path: outputPath, provider: 'openai-codex', model: toolModel, turn: turnModel, bytes: buffer.length }
}

/**
 * Generate one image on the Codex backend with the stored OAuth grant.
 * The route's chat model leads the turn candidates, or the live catalog
 * when the route itself names an image model (dispatch spawns the worker on
 * the pinned chat, so the tool sees it as the route model). Both dimensions fall through on backend rejection: a chat model
 * that cannot serve the `image_generation` tool advances the turn, an
 * unknown tool id advances the tool, anything else moves to the next pair.
 * A 401 rotates the grant once and retries that pair before moving on; a
 * reasoning rejection retries the pair once without effort.
 */
async function generateCodex(ctx, input) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('credentials unavailable')
  const found = await readRouteRecord(ctx, input.provider)
  if (found === undefined) throw new Error(`no stored credential for ${input.provider}; connect it in Settings → Orchestrator`)
  const key = found.key
  let grant = codexGrantFromRecord(found.record)
  if (codexGrantIsStale(grant)) grant = await persistRefreshedCodexGrant(credentials, key)
  const accountId = grant.accountId || accountIdFromJwt(grant.access)
  if (!accountId) throw new Error('stored openai-codex grant names no account; reconnect it in Settings')
  const picked = isImageModelId(input.chatModel) ? [input.chatModel] : input.toolModels
  const first = isImageModelId(input.chatModel) ? null : input.chatModel
  let chats = []
  try {
    const live = await resolveChatModels(ctx, input.provider)
    chats = [...(first ? [first] : []), ...live.filter((id) => id !== first)]
  } catch {
    // A dead catalog still leaves the route chat model to try.
    chats = [input.chatModel]
  }
  const references = await readReferenceImages(input.referencePaths)
  const errors = []
  for (const turnModel of chats) {
    for (const toolModel of picked) {
      const attempt = async (effort) => {
        const b64 = await requestCodexImage({ access: grant.access, accountId, chatModel: turnModel, toolModel, prompt: input.prompt, references, size: input.size, effort })
        return saveCodexImage(input.outputPath, b64, toolModel, turnModel)
      }
      try {
        return await attempt(input.effort)
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        if (input.effort && /reasoning|effort/i.test(message)) {
          try {
            return await attempt(undefined)
          } catch (retryError) {
            errors.push(`${turnModel}+${toolModel}: ${String(retryError && retryError.message ? retryError.message : retryError)}`)
            continue
          }
        }
        if (/HTTP 401\b/.test(message) && grant.refresh) {
          try {
            grant = await persistRefreshedCodexGrant(credentials, key)
            const retryAccountId = grant.accountId || accountId
            const b64 = await requestCodexImage({ access: grant.access, accountId: retryAccountId, chatModel: turnModel, toolModel, prompt: input.prompt, references, size: input.size, effort: input.effort })
            return await saveCodexImage(input.outputPath, b64, toolModel, turnModel)
          } catch (retryError) {
            errors.push(`${turnModel}+${toolModel}: ${String(retryError && retryError.message ? retryError.message : retryError)}`)
            continue
          }
        }
        errors.push(`${turnModel}+${toolModel}: ${message}`)
        if (codexErrorKind(message) === 'chat') break
      }
    }
  }
  throw new Error(errors.join(' | '))
}

/**
 * Provider/model of the calling agent (the imagegen worker's routed model).
 * @param {object | undefined} agent
 * @returns {{provider: string, model: string}}
 */
export function agentRoute(agent) {
  const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
    ? agent.session.requestHeader()?.config
    : undefined
  const options = agent && agent.options ? agent.options : {}
  const provider = (header && header.provider) || options.provider || ''
  const model = (header && header.model) || options.model || ''
  return { provider, model }
}
