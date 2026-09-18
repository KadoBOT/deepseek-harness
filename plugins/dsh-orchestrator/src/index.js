/**
 * dsh-orchestrator (host half).
 *
 * Owns the durable `orchestrator-routes` settings section — an ordered
 * provider/model/effort chain per worker role, persisted in settings.yaml —
 * plus the `orchestrator_*` and `delegate_*` tools that sample it on every
 * call. Changing Settings mid-conversation or before resume therefore changes
 * the next dispatch; an already-running worker keeps the route it started with.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import {
  ROLE_NAMES,
  ROLES,
  agentOptionsFromRoute,
  attemptPlan,
  blankRoutes,
  currentRoutesFrom,
  formatRoute,
  isRouteRecord,
  roleLine,
  runAttemptPlan,
  summarizeOutput,
  toolFilterForRole,
  dropUnknownDeniedTools,
} from './routes.js'
import { agentRoute, generateAndSave, isImageModelId, resolveChatModel } from './image.js'
import { ACCOUNTS_NS, accountsFrom, assertAccounts, createAccountsRuntime, loadPiAi } from './accounts.js'
import { registerAccountRoutes } from './accounts-http.js'

/** Plugin name. */
export const name = 'dsh-orchestrator'

/** Registries this row contributes to: settings sections and model tools. */
export const inject = ['settings', 'tools']

/** Settings namespace holding the live role-routing table. */
export const ORCHESTRATOR_ROUTES_NS = 'orchestrator-routes'

const roleRouteSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  chatModel: z.string().default(''),
})

const roleRoutesSchema = z.union([
  z.array(roleRouteSchema).default([]),
  roleRouteSchema,
]).default([])

/** Schema served to settings clients for the role-routing table. */
export const ORCHESTRATOR_ROUTES_SCHEMA = z.object({
  explorer: roleRoutesSchema,
  worker: roleRoutesSchema,
  tester: roleRoutesSchema,
  researcher: roleRoutesSchema,
  reviewer: roleRoutesSchema,
  imagegen: roleRoutesSchema,
})

const accountSchema = z.object({
  id: z.string().default(''),
  product: z.string().default(''),
  label: z.string().default(''),
})

/** Schema served to settings clients for the connected-account list. */
export const ORCHESTRATOR_ACCOUNTS_SCHEMA = z.object({
  accounts: z.array(accountSchema).default([]),
})

function persistableRoutes(routes) {
  const out = {}
  for (const role of ROLE_NAMES) {
    out[role] = (routes[role] || []).map((route) => ({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort || '',
      ...(route.chatModel ? { chatModel: route.chatModel } : {}),
    }))
  }
  return out
}

function normStr(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text.length > 0 ? text : undefined
}

function routeFromArgs(entry) {
  if (!entry || typeof entry !== 'object') return null
  const provider = normStr(entry.provider)
  const model = normStr(entry.model)
  const effort = normStr(entry.reasoning_effort !== undefined ? entry.reasoning_effort : entry.reasoningEffort)
  const chat = normStr(entry.chat_model !== undefined ? entry.chat_model : entry.chatModel)
  if (!provider || !model) return null
  return { provider, model, reasoningEffort: effort || '', chatModel: chat || '' }
}

/** Plugin body: settings section plus the orchestrator delegation tools. */
export function apply(ctx) {
  let source = () => blankRoutes()

  ctx.settings.installSection(ctx, ORCHESTRATOR_ROUTES_NS, ORCHESTRATOR_ROUTES_SCHEMA, blankRoutes(), {
    setSource: (next) => { source = next },
    validate: (value) => {
      if (!isRouteRecord(value)) {
        throw new Error('orchestrator-routes must map roles to an ordered list of {provider, model, reasoningEffort} (a legacy single object is accepted)')
      }
    },
    onChange: () => {},
  })

  // The account list is the second half of the same story: each entry becomes
  // its own provider route, so two accounts of one vendor are two selectable
  // providers in the role table above.
  let accountSource = () => ({ accounts: [] })
  let accountsChanged = () => {}
  ctx.settings.installSection(ctx, ACCOUNTS_NS, ORCHESTRATOR_ACCOUNTS_SCHEMA, { accounts: [] }, {
    setSource: (next) => { accountSource = next },
    validate: (value) => { assertAccounts(value) },
    onChange: () => { accountsChanged() },
  })

  /** The accounts runtime, once the llm service and the pi-ai library are both present. */
  let accounts = null
  const currentAccounts = () => accountsFrom(accountSource())

  ctx.inject(['llm'], (llmCtx) => {
    let disposed = false
    let routes = null
    llmCtx.effect(() => () => {
      disposed = true
      if (routes !== null) {
        routes.dispose()
        routes = null
      }
    }, 'dsh-orchestrator: account routes')

    loadPiAi().then(async (piAi) => {
      if (disposed) return
      const runtime = await createAccountsRuntime({ ctx: llmCtx, log: ctx.logger, piAi })
      if (disposed) return
      accounts = runtime
      accountsChanged = () => {
        try {
          for (const problem of runtime.sync(currentAccounts())) ctx.logger?.warn?.('dsh-orchestrator: %s', problem)
        } catch (error) {
          // A settings change must not fail the settings provider: a route the
          // registry refuses leaves the previous route set serving.
          ctx.logger?.warn?.('dsh-orchestrator: account routes were not updated: %s', String(error && error.message ? error.message : error))
        }
      }
      accountsChanged()
      llmCtx.inject(['webServer'], (webCtx) => {
        if (disposed) return
        if (routes !== null) {
          routes.dispose()
          routes = null
        }
        routes = registerAccountRoutes({
          webServer: webCtx.webServer,
          connection: webCtx.get('connection'),
          runtime,
          readAccounts: currentAccounts,
          log: ctx.logger,
        })
      })
    }).catch((error) => {
      ctx.logger?.warn?.('dsh-orchestrator: account routes are unavailable: %s', String(error && error.message ? error.message : error))
    })
  })

  function currentRoutes() {
    return currentRoutesFrom(source())
  }

  async function assertRoute(route) {
    const llm = ctx.get('llm')
    if (llm === undefined) return
    let providers = []
    try {
      providers = llm.listProviders() || []
    } catch {
      throw new Error('llm.listProviders failed')
    }
    const ids = providers.map((entry) => (entry && entry.id ? entry.id : String(entry)))
    if (ids.indexOf(route.provider) < 0) throw new Error(`unknown provider "${route.provider}"`)
    if (!route.reasoningEffort) return
    // Effort drives the worker and, for image turns, the chat model: check
    // the pinned chat when one names a real model, else the route model.
    const effortModel = route.chatModel && !isImageModelId(route.chatModel) ? route.chatModel : route.model
    let info = null
    try {
      info = await llm.resolveModelInfo(route.provider, effortModel)
    } catch {
      // Catalog resolve is best-effort; unknown models skip effort checking.
      info = null
    }
    if (info && info.reasoning) {
      const eids = info.reasoning.efforts.map((entry) => String(entry.id))
      if (eids.indexOf(route.reasoningEffort) < 0) {
        throw new Error(`unsupported effort "${route.reasoningEffort}" for ${route.provider} / ${effortModel}; supported: ${eids.join(', ') || '(none)'}`)
      }
    } else if (info) {
      throw new Error(`model "${effortModel}" exposes no selectable reasoning efforts; leave effort on model default`)
    }
  }

  async function applyRouteChange(role, opts) {
    if (!ROLES[role]) throw new Error('unknown role')
    const routes = currentRoutes()
    if (opts.reset === true) {
      routes[role] = []
      await ctx.settings.replace(ORCHESTRATOR_ROUTES_NS, persistableRoutes(routes))
      return `${role} reset to inherit the orchestrator route.`
    }
    let next = null
    if (Array.isArray(opts.routes)) {
      next = []
      for (const entry of opts.routes) {
        const route = routeFromArgs(entry)
        if (!route) throw new Error('each routes[] entry needs provider and model together')
        next.push(route)
      }
    } else if (opts.provider !== undefined || opts.model !== undefined) {
      const route = routeFromArgs(opts)
      if (!route) throw new Error('supply provider and model together')
      next = [route]
    } else {
      throw new Error('supply routes[], or provider and model together, or reset:true')
    }
    for (const route of next) await assertRoute(route)
    routes[role] = next
    await ctx.settings.replace(ORCHESTRATOR_ROUTES_NS, persistableRoutes(routes))
    if (next.length === 0) return `${role} now inherits the orchestrator route.`
    return `${role} now routes to ${next.map(formatRoute).join(' then ')} then inherits orchestrator route.`
  }

  async function collectModels(llm) {
    const lines = []
    let providers = []
    try {
      providers = llm.listProviders() || []
    } catch {
      return { lines: ['llm.listProviders() failed'] }
    }
    for (const entry of providers) {
      const id = entry && entry.id ? entry.id : String(entry)
      try {
        const models = (await llm.listModels(id)) || []
        const names = models.map((model) => (model && model.id ? model.id : String(model))).join(', ')
        lines.push(`- ${id}: ${names || '(no advertised models)'}`)
      } catch {
        lines.push(`- ${id}: model list unavailable`)
      }
    }
    return { lines }
  }

  async function disposeRun(run, failures) {
    if (!run || typeof run.dispose !== 'function') return
    try {
      await run.dispose()
    } catch (error) {
      failures.push(`dispose failed: ${String(error && error.message ? error.message : error)}`)
    }
  }

  async function startWithToolbelt(subagents, startRequest, belt) {
    if (!belt || !Array.isArray(belt.deny) || belt.deny.length === 0) {
      return subagents.start('spawn', startRequest)
    }
    let deny = belt.deny.slice()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await subagents.start('spawn', { ...startRequest, toolFilter: { deny } })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        if (!/unknown global tool/i.test(message)) throw error
        const next = dropUnknownDeniedTools(deny, message)
        if (next.length === deny.length) throw error
        if (next.length === 0) return subagents.start('spawn', startRequest)
        deny = next
      }
    }
    return subagents.start('spawn', startRequest)
  }

  async function dispatchRole(role, task, prompt, exec) {
    const def = ROLES[role]
    if (!def) throw new Error('unknown role')
    const parent = exec.agent
    if (!parent) throw new Error('requires a calling agent')
    const subagents = ctx.get('subagents')
    if (subagents === undefined) throw new Error('subagents unavailable')
    const plan = attemptPlan(currentRoutes()[role] || [])
    try {
      const settled = await runAttemptPlan(plan, {
        signal: exec.signal,
        async runAttempt(attempt) {
          const routeLabel = attempt.kind === 'inherit' ? 'inherited orchestrator route' : formatRoute(attempt.route)
          const label = attempt.kind === 'inherit'
            ? `${task} (inherit orchestrator)`
            : `${task} (${formatRoute(attempt.route)})`
          let agentOptions = attempt.kind === 'pinned' ? agentOptionsFromRoute(attempt.route) : undefined
          let promptText = `${def.header}\n\nTask: ${String(task)}\n\n${String(prompt)}`
          // The turn runs on the pinned chat model when one names a real
          // model; an image model cannot chat, so the worker spawns on a
          // live-picked chat model and pins the image model through the tool.
          if (attempt.kind === 'pinned' && role === 'imagegen'
            && (attempt.route.provider === 'openai' || attempt.route.provider === 'openai-codex')) {
            const pinnedChat = attempt.route.chatModel && !isImageModelId(attempt.route.chatModel)
              ? attempt.route.chatModel
              : null
            if (pinnedChat) {
              agentOptions = { ...agentOptions, model: pinnedChat }
            }
            if (isImageModelId(attempt.route.model)) {
              let chatModel = pinnedChat
              if (!chatModel) {
                try {
                  chatModel = await resolveChatModel(ctx, attempt.route.provider)
                } catch (error) {
                  return {
                    ok: false,
                    routeLabel,
                    error: `start failed: ${String(error && error.message ? error.message : error)}`,
                    aborted: aborted(),
                  }
                }
              }
              agentOptions = { ...agentOptions, model: chatModel }
              promptText += `\n\nCall image_gen with model "${attempt.route.model}" (the pinned image model) alongside your prompt and output path.`
            }
          }
          const disposeFailures = []
          const aborted = () => Boolean(exec.signal && exec.signal.aborted)
          let run
          const startRequest = {
            label: String(label),
            parent,
            prompt: [{ type: 'text', text: promptText }],
            signal: exec.signal,
            ...(agentOptions ? { agentOptions } : {}),
          }
          const belt = toolFilterForRole(role)
          try {
            run = await startWithToolbelt(subagents, startRequest, belt)
          } catch (error) {
            return {
              ok: false,
              routeLabel,
              error: `start failed: ${String(error && error.message ? error.message : error)}`,
              aborted: aborted(),
            }
          }
          let outcome
          try {
            const result = await run.result
            if (result && result.stopReason === 'completed') {
              outcome = { ok: true, routeLabel, output: summarizeOutput(result.output) }
            } else {
              const stopReason = result ? result.stopReason : 'no result'
              outcome = {
                ok: false,
                routeLabel,
                error: `ended (${stopReason})`,
                aborted: aborted(),
                stopReason,
              }
            }
          } catch (error) {
            outcome = {
              ok: false,
              routeLabel,
              error: `run failed: ${String(error && error.message ? error.message : error)}`,
              aborted: aborted(),
            }
          } finally {
            await disposeRun(run, disposeFailures)
          }
          if (disposeFailures.length > 0) {
            const extra = disposeFailures.join('; ')
            if (outcome.ok) outcome.output = `${outcome.output}\n(${extra})`
            else outcome.error = `${outcome.error}; ${extra}`
          }
          return outcome
        },
      })
      const used = `[${role} via ${settled.routeLabel}]`
      if (settled.failures.length === 0) return `${used} done:\n${settled.output}`
      return `${used} done after fallback:\n${settled.output}\n\nEarlier attempts: ${settled.failures.join(' | ')}`
    } catch (error) {
      throw new Error(`[${role}] ${String(error && error.message ? error.message : error)}`)
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'image_gen',
    description: 'Generate an image with the current Grok (xAI), Gemini (Google), OpenAI, or Codex route and save it to a filesystem path. On a Codex route the call uses the ChatGPT sign-in (OAuth), billed to the subscription. Use this instead of third-party image hosts.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description to generate.' },
      path: { type: 'string', required: true, description: 'Filesystem path to write the image (PNG).' },
      model: { type: 'string', description: 'Image endpoint model override (e.g. gpt-image-2.5-flare). Omit to try the provider list in order.' },
      references: { type: 'array', items: { type: 'string' }, description: 'Workspace image paths to attach as visual references (Codex routes only): the generation can follow, restyle, or edit them.' },
      size: { type: 'string', description: 'Image size on Codex routes: 1024x1024, 1536x1024, 1024x1536, or auto. Omit for the backend default.' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute(args, exec) {
      const route = agentRoute(exec.agent)
      if (!route.provider) throw new Error('image_gen requires a calling agent with a provider/model route')
      const imageModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined
      const references = Array.isArray(args.references)
        ? args.references.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
        : []
      const account = currentAccounts().find((entry) => entry.id === route.provider)
      const workerOptions = exec.agent && exec.agent.options ? exec.agent.options : {}
      const effort = workerOptions.reasoningEffort !== undefined ? workerOptions.reasoningEffort : workerOptions.reasoning_effort
      const result = await generateAndSave({
        ctx,
        provider: route.provider,
        model: route.model,
        prompt: String(args.prompt),
        outputPath: String(args.path),
        ...(account ? { accountProduct: account.product } : {}),
        ...(imageModel ? { imageModel } : {}),
        ...(references.length > 0 ? { references } : {}),
        ...(typeof args.size === 'string' && args.size.trim() ? { size: args.size.trim() } : {}),
        ...(effort !== undefined && effort !== null && String(effort).trim() ? { effort: String(effort).trim() } : {}),
      })
      return `saved ${result.path} (${result.bytes} bytes) via ${result.provider} / ${result.model}${result.turn ? ` (turn ${result.turn})` : ''}`
    },
  })), 'dsh-orchestrator: image_gen tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orchestrator_status',
    description: 'Show orchestrator role routing plus available LLM providers and models.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute() {
      const routes = currentRoutes()
      const llm = ctx.get('llm')
      const subagents = ctx.get('subagents')
      const out = [
        '# Orchestrator status',
        '',
        'Orchestrator (this session): the chat-box session model. Roles with an empty chain follow exactly this route. Pinned routes are tried in order; if every pinned route fails, the inherited orchestrator route is tried once. Each role spawn applies its own DSH toolbelt (explorer/researcher/reviewer cannot write; imagegen cannot fetch the web and gets image_gen). Grok/Gemini/OpenAI native product tools are not forwarded by the chat adapters; image_gen calls those providers\' image endpoints, and Codex routes generate through the ChatGPT backend with the stored OAuth grant. Routes are read from settings on every dispatch, so a Settings change applies to the next worker (including after stop/resume). An in-flight worker keeps the model it started with.',
        '',
        ROLE_NAMES.map((role) => roleLine(role, routes)).join('\n'),
        '',
      ]
      const configured = currentAccounts()
      if (configured.length > 0) {
        out.push('## Connected accounts', '')
        if (accounts === null) {
          out.push(configured.map((account) => `- ${account.id} (${account.product}): ${account.label}`).join('\n'), '')
        } else {
          try {
            const states = await accounts.status(configured)
            out.push(states.map((state) => {
              const where = state.connected ? `connected (${state.method}${state.account ? `, ${state.account}` : ''})` : 'not connected'
              return `- ${state.id} (${state.productName}): ${state.label} — ${where}`
            }).join('\n'), '')
          } catch (error) {
            out.push(`- account status unavailable: ${String(error && error.message ? error.message : error)}`, '')
          }
        }
        for (const problem of accounts === null ? [] : accounts.problems()) out.push(`Account problem: ${problem}`)
        if (accounts !== null && accounts.problems().length > 0) out.push('')
      }
      try {
        const names = subagents ? subagents.list() : []
        out.push(`Backends: ${(names && names.length > 0 ? names.join(', ') : '(none)')}\n`)
      } catch {
        out.push('Backends unavailable\n')
      }
      if (!llm) {
        out.push('(llm unavailable)')
      } else {
        out.push((await collectModels(llm)).lines.join('\n') || '(no providers)')
      }
      return out.join('\n')
    },
  })), 'dsh-orchestrator: orchestrator_status tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orchestrator_set_role',
    description: 'Assign the ordered model fallback list for one role. Supply routes[] (each provider + model, optional reasoning_effort) or a single provider+model. reset:true (or routes:[]) inherits the orchestrator route after the list. Stored durably in settings and sampled on the next dispatch.',
    parameters: {
      role: { type: 'string', required: true, description: 'explorer, worker, tester, researcher, reviewer, imagegen.' },
      routes: {
        type: 'array',
        description: 'Ordered fallbacks. The inherited orchestrator route is always tried after the last pinned route.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
            reasoning_effort: { type: 'string' },
            chat_model: { type: 'string', description: 'Imagegen only: chat model for the image turn. Omit to resolve live.' },
          },
        },
      },
      provider: { type: 'string', description: 'Convenience for a one-route list; supply together with model.' },
      model: { type: 'string' },
      reasoning_effort: { type: 'string', description: 'One of the selected model’s offered effort levels; omit for the model default.' },
      chat_model: { type: 'string', description: 'Imagegen only: chat model for the image turn. Omit to resolve live.' },
      reset: { type: 'boolean' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute(args) {
      return applyRouteChange(args.role, args)
    },
  })), 'dsh-orchestrator: orchestrator_set_role tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'orchestrator_dispatch',
    description: 'Dispatch one bounded task to a worker role. Independent dispatches MUST go in one parallel block. Tries that role’s pinned models in order, then the inherited orchestrator model. Reads settings at call time.',
    parameters: {
      role: { type: 'string', required: true, description: 'explorer, worker, tester, researcher, reviewer, imagegen.' },
      task: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    isConcurrencySafe() { return true },
    async execute(args, exec) {
      return dispatchRole(args.role, args.task, args.prompt, exec)
    },
  })), 'dsh-orchestrator: orchestrator_dispatch tool')

  for (const role of ROLE_NAMES) {
    const captured = role
    ctx.effect(() => ctx.tools.register(defineTool({
      name: `delegate_${captured}`,
      description: `Dispatch one bounded task to the ${captured} worker. Tries pinned ${captured} models in order, then the inherited orchestrator model. Independent dispatches MUST go in one parallel block. Reads settings at call time.`,
      parameters: {
        description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task, for display.' },
        prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: String(value) }] },
      },
      isConcurrencySafe() { return true },
      async execute(args, exec) {
        return dispatchRole(captured, args.description, args.prompt, exec)
      },
    })), `dsh-orchestrator: delegate_${captured} tool`)
  }
}
