import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  accountIdFromJwt,
  codexErrorKind,
  codexGrantFromRecord,
  codexGrantIsStale,
  codexMessageContent,
  codexRequestBody,
  extractCodexImage,
  imageModelsFor,
  isImageModelId,
  mimeTypeForImagePath,
  normalizeImageSize,
  normalizeTurnEffort,
  readReferenceImages,
  refreshCodexGrant,
  resolveChatModel,
  resolveChatModels,
  secretFromRecord,
} from '../lib/image.js'
import {
  advertisesImageGeneration,
  agentOptionsFromRoute,
  attemptPlan,
  blankRoutes,
  canFallback,
  currentRoutesFrom,
  imagegenModels,
  isRouteRecord,
  MAX_DELEGATE_OUTPUT_CHARS,
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
  assert.deepEqual(routes.explorer, [{ provider: 'xai', model: 'grok-4.6', reasoningEffort: 'high', chatModel: '' }])
  assert.deepEqual(routes.worker, [])
  assert.deepEqual(routes.imagegen, [])
})

test('ordered arrays keep sequence and drop incomplete rows', () => {
  assert.deepEqual(normalizeRoleRoutes([
    { provider: 'google', model: 'gemini-3', reasoning_effort: 'medium' },
    { provider: 'xai' },
    { provider: 'openrouter', model: 'flash', reasoningEffort: '' },
  ]), [
    { provider: 'google', model: 'gemini-3', reasoningEffort: 'medium', chatModel: '' },
    { provider: 'openrouter', model: 'flash', reasoningEffort: '', chatModel: '' },
  ])
})

test('chat model survives normalization and formats onto the status line', () => {
  assert.deepEqual(normalizeRoleRoutes([
    { provider: 'openai-codex', model: 'gpt-image-2.5-flare', chat_model: 'gpt-5.6-luna', reasoningEffort: 'low' },
  ]), [
    { provider: 'openai-codex', model: 'gpt-image-2.5-flare', reasoningEffort: 'low', chatModel: 'gpt-5.6-luna' },
  ])
  const routes = blankRoutes()
  routes.imagegen = [{ provider: 'openai-codex', model: 'gpt-image-2.5-flare', reasoningEffort: 'low', chatModel: 'gpt-5.6-luna' }]
  assert.match(roleLine('imagegen', routes), /chat=gpt-5\.6-luna/)
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

test('summarizeOutput caps unbounded worker text with head and tail', () => {
  const tiny = summarizeOutput([{ type: 'text', text: 'ok' }])
  assert.equal(tiny, 'ok')
  const exact = 'x'.repeat(MAX_DELEGATE_OUTPUT_CHARS)
  assert.equal(summarizeOutput([{ type: 'text', text: exact }]), exact)
  const big = `A${'y'.repeat(MAX_DELEGATE_OUTPUT_CHARS)}B`
  const capped = summarizeOutput([{ type: 'text', text: big }])
  assert.ok(capped.length < big.length)
  assert.ok(capped.startsWith('A' + 'y'.repeat(100)))
  assert.ok(capped.endsWith('B'))
  assert.match(capped, /truncated \d+ chars/)
  // Multibyte code points survive the cut without splitting a surrogate pair.
  const emoji = `a${'😀'.repeat(MAX_DELEGATE_OUTPUT_CHARS + 10)}b`
  const cappedEmoji = summarizeOutput([{ type: 'text', text: emoji }])
  assert.ok(cappedEmoji.includes('truncated'))
  assert.ok(cappedEmoji.endsWith('b'))
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

test('image model ids are recognized across providers', () => {
  assert.equal(isImageModelId('gpt-image-2.5-flare'), true)
  assert.equal(isImageModelId('grok-imagine-image'), true)
  assert.equal(isImageModelId('gpt-5.5'), false)
  assert.equal(isImageModelId('gpt-5.6-luna'), false)
  assert.equal(isImageModelId(''), false)
  assert.equal(isImageModelId(undefined), false)
})

test('codex failures fault the chat model, the tool model, or neither', () => {
  assert.equal(codexErrorKind(`codex gpt-image-2.5-sunburst HTTP 400: Tool 'image_generation' is not supported with gpt-5.3-codex-spark.`), 'chat')
  assert.equal(codexErrorKind('codex x HTTP 400: invalid model gpt-image-9'), 'tool')
  assert.equal(codexErrorKind('codex x HTTP 400: {"detail":"Store must be set to false"}'), 'other')
  assert.equal(codexErrorKind('codex stream held no image'), 'other')
})

test('chat models resolve in live catalog order', async () => {
  const ctx = {
    get: () => ({ async listModels() { return [{ id: 'gpt-5.3-codex-spark' }, { id: 'gpt-image-2' }, { id: 'gpt-5.5' }] } }),
  }
  assert.deepEqual(await resolveChatModels(ctx, 'openai-codex'), ['gpt-5.3-codex-spark', 'gpt-5.5'])
})

test('chat model resolves to the first live non-image model', async () => {
  const ctx = {
    get(name) {
      assert.equal(name, 'llm')
      return { async listModels(provider) {
        assert.equal(provider, 'openai-codex')
        return [{ id: 'gpt-image-2.5-flare' }, { id: 'gpt-5.6-luna' }, { id: 'gpt-5.5' }]
      } }
    },
  }
  assert.equal(await resolveChatModel(ctx, 'openai-codex'), 'gpt-5.6-luna')
  await assert.rejects(
    resolveChatModel({ get: () => ({ async listModels() { return [{ id: 'gpt-image-2' }] } }) }, 'openai-codex'),
    /no chat model found/,
  )
  await assert.rejects(
    resolveChatModel({ get: () => ({ async listModels() { throw new Error('down') } }) }, 'openai-codex'),
    /model list unavailable/,
  )
  await assert.rejects(resolveChatModel({ get: () => undefined }, 'openai-codex'), /llm unavailable/)
})

test('chat Codex/OpenAI routes map to OpenAI image endpoint ids', () => {
  assert.deepEqual(imageModelsFor('openai-codex', 'gpt-5.4'), [
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5',
    'gpt-image-2',
  ])
  assert.deepEqual(imageModelsFor('openai', 'gpt-5.4'), imageModelsFor('openai-codex', 'gpt-5.4'))
  assert.deepEqual(imageModelsFor('openai', 'gpt-image-2'), ['gpt-image-2'])
})

test('reference images map extensions and build input parts', async () => {
  assert.equal(mimeTypeForImagePath('ref.PNG'), 'image/png')
  assert.equal(mimeTypeForImagePath('photo.jpeg'), 'image/jpeg')
  assert.equal(mimeTypeForImagePath('pic.webp'), 'image/webp')
  assert.equal(mimeTypeForImagePath('notes.txt'), undefined)
  assert.equal(mimeTypeForImagePath('noext'), undefined)
  const dir = mkdtempSync(join(tmpdir(), 'orch-ref-'))
  try {
    const png = join(dir, 'a.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const refs = await readReferenceImages([png])
    assert.equal(refs.length, 1)
    assert.equal(refs[0].mimeType, 'image/png')
    assert.equal(refs[0].base64, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
    const content = codexMessageContent('make it blue', refs)
    assert.deepEqual(content, [
      { type: 'input_text', text: 'make it blue' },
      { type: 'input_image', image_url: `data:image/png;base64,${refs[0].base64}` },
    ])
    assert.deepEqual(codexMessageContent('plain', []), [{ type: 'input_text', text: 'plain' }])
    await assert.rejects(readReferenceImages([join(dir, 'missing.png')]), /not readable/)
    await assert.rejects(readReferenceImages([join(dir, 'a.txt')]), /must be a \.png, \.jpg, or \.webp file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turn effort maps known dials and omits the rest', () => {
  assert.equal(normalizeTurnEffort(undefined), undefined)
  assert.equal(normalizeTurnEffort(''), undefined)
  assert.equal(normalizeTurnEffort('low'), 'low')
  assert.equal(normalizeTurnEffort('xhigh'), 'high')
  assert.equal(normalizeTurnEffort('max'), 'high')
  assert.equal(normalizeTurnEffort('turbo'), undefined)
})

test('request body carries reasoning only when set', () => {
  const base = { chatModel: 'gpt-5.6-luna', toolModel: 'gpt-image-2.5-flare', prompt: 'hi', references: [] }
  assert.deepEqual(codexRequestBody({ ...base, effort: 'low' }).reasoning, { effort: 'low' })
  assert.ok(!('reasoning' in codexRequestBody(base)))
})

test('image size validates against the tool values', () => {
  assert.equal(normalizeImageSize(undefined), undefined)
  assert.equal(normalizeImageSize(''), undefined)
  assert.equal(normalizeImageSize('1536x1024'), '1536x1024')
  assert.throws(() => normalizeImageSize('800x600'), /unsupported image size/)
})

test('request body carries size only when set', () => {
  const base = { chatModel: 'gpt-5.5', toolModel: 'gpt-image-2.5-flare', prompt: 'hi', references: [] }
  const sized = codexRequestBody({ ...base, size: '1024x1536' })
  assert.equal(sized.tools[0].size, '1024x1536')
  assert.equal(sized.store, false)
  assert.equal(sized.stream, true)
  const plain = codexRequestBody(base)
  assert.ok(!('size' in plain.tools[0]))
})

function jwtWithAccount(accountId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

test('codex account id decodes from the access token JWT claim', () => {
  assert.equal(accountIdFromJwt(jwtWithAccount('acc-1')), 'acc-1')
  assert.equal(accountIdFromJwt('not-a-jwt'), undefined)
  assert.equal(accountIdFromJwt('a.b.c'), undefined)
})

test('codex grant reads the stored OAuth record and names a missing one', () => {
  const grant = codexGrantFromRecord({
    kind: 'grant',
    payload: { type: 'oauth', access: 'at', refresh: 'rt', expires: 42, accountId: 'acc-1' },
  })
  assert.deepEqual(grant, { access: 'at', refresh: 'rt', expires: 42, accountId: 'acc-1' })
  assert.throws(() => codexGrantFromRecord(undefined), /no stored credential for openai-codex/)
  assert.throws(() => codexGrantFromRecord({ kind: 'grant', payload: {} }), /no stored credential for openai-codex/)
})

test('codex grant without expiry or past expiry reads stale', () => {
  const now = 1_700_000_000_000
  assert.equal(codexGrantIsStale({ expires: now + 3_600_000 }, now), false)
  assert.equal(codexGrantIsStale({ expires: now + 30_000 }, now), true)
  assert.equal(codexGrantIsStale({ expires: now - 1 }, now), true)
  assert.equal(codexGrantIsStale({ expires: undefined }, now), true)
})

const IMAGE_B64 = Buffer.from('fake-png-bytes').toString('base64')

test('codex image result reads from a plain Responses body', () => {
  const body = JSON.stringify({ output: [{ type: 'image_generation_call', status: 'completed', result: IMAGE_B64 }] })
  assert.equal(extractCodexImage(body, 'application/json'), IMAGE_B64)
  assert.throws(() => extractCodexImage(JSON.stringify({ output: [] }), 'application/json'), /held no image/)
  assert.throws(
    () => extractCodexImage(JSON.stringify({ error: { code: 'invalid_model', message: 'no such model' } }), 'application/json'),
    /invalid_model: no such model/,
  )
})

test('codex image result reads from a streamed SSE body', () => {
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  const body = frame({ type: 'response.created', response: {} })
    + frame({ type: 'response.output_item.done', item: { type: 'image_generation_call', status: 'completed', result: IMAGE_B64 } })
    + 'data: [DONE]\n\n'
  assert.equal(extractCodexImage(body, 'text/event-stream'), IMAGE_B64)
  // The stream is detected by content too: some backends serve SSE frames
  // under a generic content type.
  assert.equal(extractCodexImage(body, null), IMAGE_B64)
  assert.equal(extractCodexImage(body, 'application/json'), IMAGE_B64)
  const failed = frame({ type: 'response.failed', response: { error: { code: 'billing', message: 'quota spent' } } })
  assert.throws(() => extractCodexImage(failed, 'text/event-stream'), /billing: quota spent/)
})

test('codex grant refresh posts the ChatGPT OAuth form and maps the reply', async () => {
  let seen = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen = { url: req.url, contentType: req.headers['content-type'], body }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const before = Date.now()
    const fresh = await refreshCodexGrant('old-rt', `http://127.0.0.1:${server.address().port}/oauth/token`)
    assert.equal(fresh.access, 'new-at')
    assert.equal(fresh.refresh, 'new-rt')
    assert.ok(fresh.expires >= before + 3_599_000)
    const params = new URLSearchParams(seen.body)
    assert.equal(params.get('grant_type'), 'refresh_token')
    assert.equal(params.get('refresh_token'), 'old-rt')
    assert.ok(params.get('client_id'))
    assert.match(seen.contentType, /application\/x-www-form-urlencoded/)
    await assert.rejects(refreshCodexGrant('old-rt', 'http://127.0.0.1:1/closed'), /token refresh error/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
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
