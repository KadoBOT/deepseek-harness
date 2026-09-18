/**
 * Pure orchestrator routing helpers. Host tools and the Settings UI both
 * sample `orchestrator-routes` per call; this module does not cache routes.
 */

/** Role ids stored under `orchestrator-routes`. */
export const ROLE_NAMES = ['explorer', 'worker', 'tester', 'researcher', 'reviewer', 'imagegen']

/** Worker briefs and spawn headers keyed by role. */
export const ROLES = {
  explorer: {
    brief: 'Repository mapping, tracing execution/data flow, locating symbols and tests. Read-only: do not edit files.',
    header: 'You are the EXPLORER worker. Map and report; do not edit files. Return: conclusions, responsible file paths, key symbols/lines, and boundaries for implementation.',
  },
  worker: {
    brief: 'Bounded implementation, targeted fixes, small scoped refactors on explicitly owned files.',
    header: 'You are the WORKER. Implement only the assigned scope on the stated file ownership. Return: what changed, files touched, and how to verify.',
  },
  tester: {
    brief: 'Reproduction, targeted test execution, validation, regression checks.',
    header: 'You are the TESTER. Reproduce, run the highest-value tests, and report pass/fail with commands. Return: results, failing output excerpts, and risks.',
  },
  researcher: {
    brief: 'Current API/framework behavior, dependency/version questions, primary-source verification.',
    header: 'You are the RESEARCHER. Verify against primary or authoritative sources. Return: concise findings, sources, and compatibility implications.',
  },
  reviewer: {
    brief: 'Independent post-change review: correctness, security, regressions, missing tests. Report findings; do not silently rewrite unrelated code.',
    header: 'You are the REVIEWER. Independently review the change or finding. Report findings rather than silently modifying unrelated code. Return: issues by severity, correctness/security/regression notes, and missing-test analysis.',
  },
  imagegen: {
    brief: 'Generate images with the routed Grok, Gemini, OpenAI, or Codex image_gen capability. On OpenAI/Codex rows an image model pins the endpoint while a chat model tries the image list in order. Save artifacts to the workspace and report paths.',
    header: 'You are the IMAGEGEN worker running on a Grok, Gemini, OpenAI, or Codex route that can generate images. Call the image_gen tool with the prompt and output path. Pass workspace image paths as references when the task names visual sources to follow, restyle, or edit (Codex routes only). On a Codex route the tool uses your ChatGPT sign-in (OAuth), billed to the subscription — no API key needed. Do not use pollinations, unsplash, or any other third-party image host. Do not spawn subagents to fetch images. Vision (reading images) is not image generation. Return the saved path and which provider/model produced it.',
  },
}

const DELEGATION_TOOLS = [
  'subagent',
  'list_subagent_models',
  'orchestrator_dispatch',
  'orchestrator_set_role',
  ...ROLE_NAMES.map((role) => `delegate_${role}`),
]

const WRITE_TOOLS = ['write', 'edit']
const WEB_TOOLS = ['web_fetch', 'web_search']

/**
 * Per-role DSH tool denylist. Spawn children inherit the orchestrator tool
 * surface; this is how each worker gets its own toolbelt. Grok/Gemini/OpenAI
 * native tools are not forwarded by the chat adapters, so imagegen's native
 * image capability is the registered `image_gen` tool (xAI / Gemini / OpenAI
 * image endpoints, plus the ChatGPT backend for Codex OAuth routes).
 */
export const ROLE_TOOLBELTS = {
  explorer: { deny: [...WRITE_TOOLS, 'image_gen', ...DELEGATION_TOOLS] },
  worker: { deny: ['image_gen', ...DELEGATION_TOOLS] },
  tester: { deny: ['image_gen', ...DELEGATION_TOOLS] },
  researcher: { deny: [...WRITE_TOOLS, 'image_gen', ...DELEGATION_TOOLS] },
  reviewer: { deny: [...WRITE_TOOLS, 'image_gen', ...DELEGATION_TOOLS] },
  imagegen: { deny: [...WEB_TOOLS, ...DELEGATION_TOOLS] },
}

/**
 * @param {string} role
 * @returns {{deny: string[]} | undefined}
 */
export function toolFilterForRole(role) {
  const belt = ROLE_TOOLBELTS[role]
  if (!belt || !Array.isArray(belt.deny) || belt.deny.length === 0) return undefined
  return { deny: belt.deny.slice() }
}

/**
 * Drop names `tools.restrict()` rejected as unknown, keep the rest.
 * @param {string[]} deny
 * @param {string} message
 * @returns {string[]}
 */
export function dropUnknownDeniedTools(deny, message) {
  const head = String(message).split('; known global tools')[0]
  const unknown = new Set()
  const quoted = head.matchAll(/"([^"]+)"/g)
  for (const match of quoted) unknown.add(match[1])
  return deny.filter((name) => !unknown.has(name))
}

const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort', 'chatModel']

const ABORT_STOP_REASONS = new Set(['aborted', 'cancelled', 'canceled', 'killed'])

/** Empty routing table: every role inherits the orchestrator route. */
export function blankRoutes() {
  const routes = {}
  for (const role of ROLE_NAMES) routes[role] = []
  return routes
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return ''
  return value
}

/**
 * Normalize one stored route object. Incomplete provider/model pairs become null.
 * @param {unknown} value
 * @returns {{provider: string, model: string, reasoningEffort: string, chatModel: string} | null}
 */
export function normalizeRoute(value) {
  if (!isPlainObject(value)) return null
  const provider = asNonEmptyString(value.provider).trim()
  const model = asNonEmptyString(value.model).trim()
  const reasoningEffort = asNonEmptyString(
    value.reasoningEffort !== undefined ? value.reasoningEffort : value.reasoning_effort,
  ).trim()
  const chatModel = asNonEmptyString(
    value.chatModel !== undefined ? value.chatModel : value.chat_model,
  ).trim()
  if (!provider || !model) return null
  return { provider, model, reasoningEffort, chatModel }
}

/**
 * Normalize one role's stored value: a legacy single object, an ordered array,
 * or inherit (empty).
 * @param {unknown} value
 * @returns {{provider: string, model: string, reasoningEffort: string}[]}
 */
export function normalizeRoleRoutes(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    const routes = []
    for (const entry of value) {
      const route = normalizeRoute(entry)
      if (route) routes.push(route)
    }
    return routes
  }
  const route = normalizeRoute(value)
  return route ? [route] : []
}

function isRouteObject(value) {
  if (!isPlainObject(value)) return false
  for (const field of ROUTE_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false
  }
  if (value.reasoning_effort !== undefined && typeof value.reasoning_effort !== 'string') return false
  return true
}

/**
 * Accept a mixed live/legacy settings object.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRouteRecord(value) {
  if (!isPlainObject(value)) return false
  for (const role of ROLE_NAMES) {
    const entry = value[role]
    if (entry === undefined) continue
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (!isRouteObject(item)) return false
      }
      continue
    }
    if (!isRouteObject(entry)) return false
  }
  return true
}

/**
 * Detached copy of every role as an ordered route array.
 * @param {unknown} live
 * @returns {Record<string, {provider: string, model: string, reasoningEffort: string}[]>}
 */
export function currentRoutesFrom(live) {
  const fresh = blankRoutes()
  if (!isRouteRecord(live)) return fresh
  for (const role of ROLE_NAMES) fresh[role] = normalizeRoleRoutes(live[role])
  return fresh
}

/**
 * Format one pinned route for status lines.
 * @param {{provider: string, model: string, reasoningEffort: string, chatModel?: string}} route
 * @returns {string}
 */
export function formatRoute(route) {
  return `${route.provider} / ${route.model}${route.reasoningEffort ? ` / effort=${route.reasoningEffort}` : ' / effort=model default'}${route.chatModel ? ` / chat=${route.chatModel}` : ''}`
}

/**
 * Status line for one role, including the terminal inherit fallback.
 * @param {string} role
 * @param {Record<string, {provider: string, model: string, reasoningEffort: string}[]>} routes
 * @returns {string}
 */
export function roleLine(role, routes) {
  const chain = routes[role] || []
  const parts = chain.map((route) => formatRoute(route))
  parts.push('inherits orchestrator route')
  return `- ${role}: ${parts.join(' then ')} — ${ROLES[role].brief}`
}

/**
 * Child agentOptions for a pinned route. Inherit omits agentOptions so the
 * spawn backend copies the parent's latest request header.
 * @param {{provider: string, model: string, reasoningEffort: string} | null | undefined} route
 * @returns {Record<string, string> | undefined}
 */
export function agentOptionsFromRoute(route) {
  if (!route) return undefined
  const options = { provider: route.provider, model: route.model }
  if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort
  return options
}

/**
 * Configured routes in order, then one inherit sentinel.
 * @param {{provider: string, model: string, reasoningEffort: string}[]} configured
 * @returns {Array<{kind: 'pinned', route: {provider: string, model: string, reasoningEffort: string}} | {kind: 'inherit'}>}
 */
export function attemptPlan(configured) {
  const plan = []
  for (const route of configured) plan.push({ kind: 'pinned', route })
  plan.push({ kind: 'inherit' })
  return plan
}

/**
 * Whether a failed attempt may continue to the next route.
 * Cancellation never retries. Completed workers are not retried.
 * A worker that already ran (and may have written files) still falls through
 * when it ends for a non-cancel reason, because the routing table promises
 * the next model.
 * @param {{aborted?: boolean, stopReason?: string | null}} failure
 * @returns {boolean}
 */
export function canFallback(failure) {
  if (failure && failure.aborted) return false
  const reason = failure && failure.stopReason != null ? String(failure.stopReason) : ''
  if (ABORT_STOP_REASONS.has(reason)) return false
  if (reason === 'completed') return false
  return true
}

/**
 * Try pinned routes then inherit. `runAttempt` must dispose its own worker.
 * @param {ReturnType<typeof attemptPlan>} plan
 * @param {{signal?: AbortSignal, runAttempt: (attempt: (typeof plan)[number]) => Promise<{ok: true, output: string, routeLabel: string} | {ok: false, routeLabel: string, error: string, aborted?: boolean, stopReason?: string | null}>}} opts
 * @returns {Promise<{output: string, routeLabel: string, failures: string[]}>}
 */
export async function runAttemptPlan(plan, opts) {
  const failures = []
  for (const attempt of plan) {
    if (opts.signal && opts.signal.aborted) {
      throw new Error(`dispatch aborted${failures.length ? ` after ${failures.join(' | ')}` : ''}`)
    }
    const result = await opts.runAttempt(attempt)
    if (result.ok) {
      return { output: result.output, routeLabel: result.routeLabel, failures }
    }
    failures.push(`${result.routeLabel}: ${result.error}`)
    if (!canFallback({ aborted: Boolean(result.aborted || (opts.signal && opts.signal.aborted)), stopReason: result.stopReason })) {
      throw new Error(`ended without fallback after ${failures.join(' | ')}`)
    }
  }
  throw new Error(`all routes failed: ${failures.join(' | ') || 'no attempts'}`)
}

/**
 * Bound for worker text returned to the parent: one unbounded worker dump
 * previously overflowed the orchestrator context (819K-token failure).
 * Code-point counts so multibyte output cannot split a surrogate pair.
 */
export const MAX_DELEGATE_OUTPUT_CHARS = 12000
const DELEGATE_HEAD_CHARS = 8000
const DELEGATE_TAIL_CHARS = 2000

function codePoints(text) {
  return Array.from(text)
}

function truncateDelegateText(text) {
  const points = codePoints(text)
  if (points.length <= MAX_DELEGATE_OUTPUT_CHARS) return text
  const head = points.slice(0, DELEGATE_HEAD_CHARS).join('')
  const tail = points.slice(points.length - DELEGATE_TAIL_CHARS).join('')
  const omitted = points.length - DELEGATE_HEAD_CHARS - DELEGATE_TAIL_CHARS
  return `${head}\n… [truncated ${omitted} chars; showing ${DELEGATE_HEAD_CHARS} head + ${DELEGATE_TAIL_CHARS} tail of ${points.length}]\n${tail}`
}

/**
 * Render worker output, keeping text and naming non-text blocks.
 * Text is capped so a single worker cannot overflow the parent request.
 * @param {unknown} output
 * @returns {string}
 */
export function summarizeOutput(output) {
  const texts = []
  let images = 0
  const other = []
  if (Array.isArray(output)) {
    for (const block of output) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image') images += 1
      else if (typeof block.type === 'string') other.push(block.type)
    }
  }
  const parts = []
  const text = truncateDelegateText(texts.join('').trim())
  if (text) parts.push(text)
  if (images > 0) parts.push(`[${images} image block${images === 1 ? '' : 's'}]`)
  if (other.length > 0) parts.push(`[other blocks: ${other.join(', ')}]`)
  return parts.join('\n') || '(empty worker output)'
}

/**
 * True only when the catalog entry itself advertises image *generation*.
 * Image input / vision is not generation.
 * @param {unknown} model
 * @returns {boolean}
 */
export function advertisesImageGeneration(model) {
  if (!isPlainObject(model)) return false
  if (model.imageGeneration === true) return true
  if (Array.isArray(model.outputModalities) && model.outputModalities.includes('image')) return true
  const capabilities = model.capabilities
  if (Array.isArray(capabilities)) {
    for (const entry of capabilities) {
      const text = String(entry).toLowerCase()
      if (text === 'image-generation' || text === 'imagegen' || text === 'image_generation') return true
    }
  } else if (isPlainObject(capabilities) && capabilities.imageGeneration === true) {
    return true
  }
  return false
}

/**
 * Filter imagegen selectors when any advertised generator exists; otherwise
 * keep the full list so an unadvertised catalog stays usable.
 * @param {unknown[]} models
 * @returns {{models: unknown[], filtered: boolean}}
 */
export function imagegenModels(models) {
  const list = Array.isArray(models) ? models : []
  const advertised = list.filter((model) => advertisesImageGeneration(model))
  if (advertised.length > 0) return { models: advertised, filtered: true }
  return { models: list, filtered: false }
}
