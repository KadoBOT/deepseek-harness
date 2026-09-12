import assert from 'node:assert/strict'
import { test } from 'node:test'

import { imageModelsFor, secretFromRecord } from '../lib/image.js'
import {
  advertisesImageGeneration,
  agentOptionsFromRoute,
  attemptPlan,
  blankRoutes,
  canFallback,
  currentRoutesFrom,
  imagegenModels,
  isRouteRecord,
  normalizeRoleRoutes,
  roleLine,
  runAttemptPlan,
  summarizeOutput,
  toolFilterForRole,
  dropUnknownDeniedTools,
} from '../lib/routes.js'

test('legacy single-object settings become a one-element chain', () => {
  const live = {
    explorer: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high' },
    worker: { provider: '', model: '', reasoningEffort: '' },
  }
  assert.equal(isRouteRecord(live), true)
  const routes = currentRoutesFrom(live)
  assert.deepEqual(routes.explorer, [{ provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high' }])
  assert.deepEqual(routes.worker, [])
  assert.deepEqual(routes.imagegen, [])
})

test('ordered arrays keep sequence and drop incomplete rows', () => {
  assert.deepEqual(normalizeRoleRoutes([
    { provider: 'google', model: 'gemini-3', reasoning_effort: 'medium' },
    { provider: 'xai' },
    { provider: 'openrouter', model: 'flash', reasoningEffort: '' },
  ]), [
    { provider: 'google', model: 'gemini-3', reasoningEffort: 'medium' },
    { provider: 'openrouter', model: 'flash', reasoningEffort: '' },
  ])
})

test('attempt plan always ends with inherit', () => {
  const plan = attemptPlan([{ provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high' }])
  assert.equal(plan.length, 2)
  assert.equal(plan[0].kind, 'pinned')
  assert.equal(plan[1].kind, 'inherit')
  assert.equal(attemptPlan([]).length, 1)
  assert.equal(attemptPlan([])[0].kind, 'inherit')
})

test('inherit omits agentOptions so the parent route is sampled at spawn time', () => {
  assert.equal(agentOptionsFromRoute(undefined), undefined)
  assert.deepEqual(
    agentOptionsFromRoute({ provider: 'xai', model: 'grok-4.6', reasoningEffort: '' }),
    { provider: 'xai', model: 'grok-4.6' },
  )
})

test('cancellation never falls back; other failures do', () => {
  assert.equal(canFallback({ aborted: true }), false)
  assert.equal(canFallback({ stopReason: 'aborted' }), false)
  assert.equal(canFallback({ stopReason: 'cancelled' }), false)
  assert.equal(canFallback({ stopReason: 'killed' }), false)
  assert.equal(canFallback({ stopReason: 'completed' }), false)
  assert.equal(canFallback({ stopReason: 'error' }), true)
  assert.equal(canFallback({ stopReason: null }), true)
})

test('status line names every pinned route then inherit', () => {
  const routes = blankRoutes()
  routes.worker = [
    { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high' },
    { provider: 'google', model: 'gemini-3.8-flash', reasoningEffort: '' },
  ]
  assert.match(roleLine('worker', routes), /xai \/ grok-4.6 \/ effort=high then google \/ gemini-3.8-flash \/ effort=model default then inherits orchestrator route/)
})

test('summarizeOutput keeps text and names image blocks', () => {
  assert.equal(summarizeOutput([{ type: 'text', text: 'ok' }, { type: 'image', attachment: {} }]), 'ok\n[1 image block]')
})

test('imagegen filter uses advertised generation, never vision input', () => {
  const vision = { id: 'vision', inputModalities: ['text', 'image'] }
  const generator = { id: 'gen', outputModalities: ['image'] }
  assert.equal(advertisesImageGeneration(vision), false)
  assert.equal(advertisesImageGeneration(generator), true)
  assert.deepEqual(imagegenModels([vision, generator]), { models: [generator], filtered: true })
  assert.deepEqual(imagegenModels([vision]), { models: [vision], filtered: false })
})

test('runAttemptPlan falls through pinned failure then inherit', async () => {
  const plan = attemptPlan([{ provider: 'xai', model: 'grok-4.6', reasoningEffort: '' }])
  const seen = []
  const settled = await runAttemptPlan(plan, {
    async runAttempt(attempt) {
      seen.push(attempt.kind)
      if (attempt.kind === 'pinned') {
        return { ok: false, routeLabel: 'xai / grok-4.6', error: 'ended (error)', stopReason: 'error' }
      }
      return { ok: true, routeLabel: 'inherited orchestrator route', output: 'ok' }
    },
  })
  assert.deepEqual(seen, ['pinned', 'inherit'])
  assert.equal(settled.routeLabel, 'inherited orchestrator route')
  assert.equal(settled.failures.length, 1)
})

test('each role has its own toolbelt; imagegen keeps image_gen and drops web', () => {
  const explorer = toolFilterForRole('explorer')
  const imagegen = toolFilterForRole('imagegen')
  const worker = toolFilterForRole('worker')
  assert.ok(explorer.deny.includes('write'))
  assert.ok(explorer.deny.includes('image_gen'))
  assert.ok(!imagegen.deny.includes('image_gen'))
  assert.ok(imagegen.deny.includes('web_fetch'))
  assert.ok(worker.deny.includes('image_gen'))
  assert.ok(worker.deny.includes('delegate_imagegen'))
})

test('dropUnknownDeniedTools keeps remaining denials', () => {
  const next = dropUnknownDeniedTools(
    ['write', 'nope', 'image_gen'],
    'tools.restrict() names unknown global tool "nope"; known global tools: "write", "image_gen"',
  )
  assert.deepEqual(next, ['write', 'image_gen'])
})

test('chat Grok/Gemini routes map to image endpoint ids', () => {
  assert.equal(imageModelsFor('xai', 'grok-4.6')[0], 'grok-2-image')
  assert.equal(imageModelsFor('google', 'gemini-3.8-flash')[0], 'gemini-3.1-flash-lite-image')
  assert.deepEqual(imageModelsFor('google', 'gemini-3.1-flash-lite-image'), ['gemini-3.1-flash-lite-image'])
})

test('secretFromRecord reads api-key and oauth access without other fields', () => {
  assert.equal(secretFromRecord({ kind: 'api-key', key: 'sk' }), 'sk')
  assert.equal(secretFromRecord({ kind: 'grant', payload: { type: 'oauth', access: 'at' } }), 'at')
  assert.equal(secretFromRecord({ kind: 'grant', payload: {} }), undefined)
})

test('runAttemptPlan does not retry cancellation', async () => {
  const plan = attemptPlan([{ provider: 'xai', model: 'grok-4.6', reasoningEffort: '' }])
  await assert.rejects(
    () => runAttemptPlan(plan, {
      async runAttempt() {
        return { ok: false, routeLabel: 'xai / grok-4.6', error: 'ended (aborted)', stopReason: 'aborted', aborted: true }
      },
    }),
    /ended without fallback/,
  )
})
