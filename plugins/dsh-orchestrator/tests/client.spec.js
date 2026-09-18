/**
 * The settings page's account block, driven through a minimal hook harness.
 *
 * The module is a browser bundle: it registers itself on
 * `window.__ModuleLoader__`, uses only `React.createElement`, `useState`, and
 * `useEffect`, and reaches the Host through the settings Remote plus the
 * plugin's own HTTP routes. Those are exactly the seams a stub can supply,
 * which is what lets this suite exercise the real component — the connect
 * flow's streamed frames included — without a browser or a test renderer.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * A React stand-in: element objects, function components rendered inline, and
 * one hook store per component function so a nested component's hooks cannot
 * shift the outer one's positions.
 */
function createReact() {
  const stores = new Map()
  let current = null
  let dirty = false

  const storeFor = (component) => {
    if (!stores.has(component)) stores.set(component, { slots: [], effects: new Map() })
    return stores.get(component)
  }
  const withStore = (store, run) => {
    const previous = current
    current = store
    try {
      return run()
    } finally {
      current = previous
    }
  }
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: Object.assign({}, props, flat.length === 0 ? {} : { children: flat.length === 1 ? flat[0] : flat }) }
    },
    useState(initial) {
      const store = current
      const at = store.cursor
      store.cursor += 1
      if (!(at in store.slots)) store.slots[at] = typeof initial === 'function' ? initial() : initial
      return [store.slots[at], (value) => {
        store.slots[at] = typeof value === 'function' ? value(store.slots[at]) : value
        dirty = true
      }]
    },
    useEffect(fn) {
      const store = current
      const at = store.cursor
      store.cursor += 1
      if (!store.effects.has(at)) store.effects.set(at, fn())
    },
  }

  /** Render one element tree, invoking function components in place. */
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const store = storeFor(node.type)
      store.cursor = 0
      return expand(withStore(store, () => node.type(node.props || {})))
    }
    const props = Object.assign({}, node.props)
    if (props.children !== undefined) props.children = expand(props.children)
    return { type: node.type, props }
  }

  return {
    React,
    /** Render `Component` until no state update asks for another pass. */
    async render(Component, props = {}) {
      let tree
      for (let pass = 0; pass < 25; pass += 1) {
        dirty = false
        const store = storeFor(Component)
        store.cursor = 0
        tree = expand(withStore(store, () => Component(props)))
        await new Promise((resolve) => setImmediate(resolve))
        if (!dirty) return tree
      }
      throw new Error('the component kept re-rendering')
    },
  }
}

/** Every element in a tree, in render order. */
function elements(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) for (const child of children) elements(child, out)
  return out
}

/** The text under one element, flattened. */
function textOf(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const children = node.props && node.props.children
  if (children === undefined) return ''
  if (Array.isArray(children)) return children.map(textOf).join(' ')
  return textOf(children)
}

/** Everything a tree renders, as one searchable string. */
const flatten = (node) => elements(node).map(textOf).join(' | ')

/** The first control whose label text contains `needle`. */
function buttonByText(tree, needle) {
  const found = elements(tree).find((node) => node.type === 'button'
    && textOf(node).includes(needle) && node.props && typeof node.props.onClick === 'function')
  assert.ok(found, `a "${needle}" button is rendered`)
  return found
}

/** The first control carrying an aria-label containing `needle`. */
function fieldByLabel(tree, needle, type) {
  const found = elements(tree).find((node) => (type === undefined ? node.type === 'input' || node.type === 'select' : node.type === type)
    && String((node.props && node.props['aria-label']) || '').includes(needle))
  assert.ok(found, `a control labelled "${needle}" is rendered`)
  return found
}

const CATALOG = [
  { id: 'xai', name: 'xAI' },
  { id: 'xai-work', name: 'Grok (work)' },
  { id: 'openai-codex', name: 'OpenAI Codex' },
]

/** A settings descriptor list carrying both plugin namespaces. */
function descriptors(routesValue, accountsValue) {
  return [
    { ns: 'orchestrator-routes', value: routesValue, revision: 3 },
    { ns: 'orchestrator-accounts', value: accountsValue, revision: 7 },
  ]
}

/**
 * One SSE response whose frames arrive one read at a time, holding the last
 * one until `release()` — a sign-in that is waiting for its human, which is the
 * state the page has to render.
 * @param {object[]} frames
 * @returns {{response: object, release: () => void}}
 */
function sseResponse(frames) {
  const encoder = new TextEncoder()
  let at = 0
  let release
  const held = new Promise((resolve) => { release = resolve })
  return {
    release,
    response: {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          async read() {
            if (at >= frames.length) return { done: true, value: undefined }
            if (at === frames.length - 1) await held
            return { done: false, value: encoder.encode(`data: ${JSON.stringify(frames[at++])}\n\n`) }
          },
        }),
      },
    },
  }
}

/**
 * Load the browser bundle and mount the settings component against stubs.
 * @param {object} harness - the hook harness.
 * @param {{accounts: object, routes?: object, status?: object[], fetch?: Function}} input
 * @returns {Promise<{Component: Function, mutations: object[]}>}
 */
async function mountSettings(harness, { accounts, routes = {}, status = [], fetch: fetchImpl }) {
  const React = harness.React
  const mutations = []
  let registration = null
  let exported = null
  const ctx = {
    effect(fn) { return fn() },
    slots: {
      inject(_name, callback) { callback(); return () => {} },
      register(options, component) { if (options.id === 'orchestrator') registration = component; return () => {} },
    },
    remote: {
      settings: {
        async describe() { return descriptors(routes, accounts) },
        async mutate(ns, ops, revision) { mutations.push({ ns, ops, revision }); return {} },
      },
      session: { async modelCatalog() { return { groups: CATALOG, failures: [] } } },
      $on() { return () => {} },
    },
  }
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = {
    __ModuleLoader__: {
      load(module) {
        exported = module.factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require("${name}")`)
        })
      },
    },
  }
  // The component loads its status through a page-relative URL, which only a
  // browser resolves; the stub therefore stays installed for the whole test.
  globalThis.fetch = fetchImpl === undefined
    ? async () => ({ ok: true, status: 200, async json() { return { accounts: status, problems: [] } } })
    : fetchImpl
  try {
    await import(`../lib/client.js?case=${Math.random()}`)
  } finally {
    globalThis.window = previousWindow
    void previousFetch
  }
  assert.ok(exported, 'the bundle registered itself with the module loader')
  exported.apply(ctx)
  assert.ok(registration, 'the settings component registered')
  return { Component: registration, mutations }
}

test('the settings page renders one row per account with its connected state', async () => {
  const harness = createReact()
  const mounted = await mountSettings(harness, {
    accounts: { accounts: [{ id: 'xai-work', product: 'xai', label: 'Grok (work)' }] },
    status: [{ id: 'xai-work', product: 'xai', label: 'Grok (work)', connected: true, method: 'oauth', account: 'me@example.com' }],
  })
  const tree = await harness.render(mounted.Component)
  const text = flatten(tree)
  assert.match(text, /Accounts/)
  assert.match(text, /Grok \(work\)/)
  assert.match(text, /connected · me@example.com/)
  assert.match(text, /Reconnect/)
  // The account route is offered beside the vendor routes the catalog lists.
  assert.match(text, /xAI/)
  assert.match(text, /OpenAI Codex/)
})

test('an added account is saved with a derived route id', async () => {
  const harness = createReact()
  const mounted = await mountSettings(harness, { accounts: { accounts: [] } })
  let tree = await harness.render(mounted.Component)
  buttonByText(tree, 'Add account').props.onClick()
  tree = await harness.render(mounted.Component)
  fieldByLabel(tree, 'label').props.onChange({ target: { value: 'ChatGPT work' } })
  tree = await harness.render(mounted.Component)
  fieldByLabel(tree, 'product', 'select').props.onChange({ target: { value: 'openai-codex' } })
  tree = await harness.render(mounted.Component)
  await buttonByText(tree, 'Save accounts').props.onClick()
  assert.deepEqual(mounted.mutations, [{
    ns: 'orchestrator-accounts',
    ops: [{ op: 'set', path: ['accounts'], value: [{ id: 'openai-codex-chatgpt-work', product: 'openai-codex', label: 'ChatGPT work' }] }],
    revision: 7,
  }])
})

test('an unusable route id is refused before any settings write', async () => {
  const harness = createReact()
  const mounted = await mountSettings(harness, { accounts: { accounts: [{ id: 'xai-work', product: 'xai', label: 'Grok work' }] } })
  let tree = await harness.render(mounted.Component)
  fieldByLabel(tree, 'route id').props.onChange({ target: { value: 'xai work' } })
  tree = await harness.render(mounted.Component)
  await buttonByText(tree, 'Save accounts').props.onClick()
  tree = await harness.render(mounted.Component)
  assert.match(flatten(tree), /must be lowercase/)
  assert.deepEqual(mounted.mutations, [])
})

test('connecting streams the sign-in into the page, and the answer posts back', async () => {
  const harness = createReact()
  const calls = []
  const frames = [
    { type: 'open', attempt: 'attempt-1', account: 'xai-work' },
    { type: 'notice', kind: 'auth_url', message: 'Sign in with SuperGrok', url: 'https://accounts.x.ai/authorize' },
    { type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code' },
    { type: 'done', account: 'xai-work', connected: true, identity: 'me@example.com', method: 'oauth' },
  ]
  const stream = sseResponse(frames)
  const mounted = await mountSettings(harness, {
    accounts: { accounts: [{ id: 'xai-work', product: 'xai', label: 'Grok (work)' }] },
    status: [{ id: 'xai-work', product: 'xai', label: 'Grok (work)', connected: false }],
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null })
      if (String(url).endsWith('/connect')) return stream.response
      return { ok: true, status: 200, async json() { return { accounts: [], problems: [] } } }
    },
  })

  let tree = await harness.render(mounted.Component)
  const connecting = buttonByText(tree, 'Connect').props.onClick()

  tree = await harness.render(mounted.Component)
  const text = flatten(tree)
  assert.match(text, /Connecting Grok \(work\)/)
  assert.match(text, /Sign in with SuperGrok/)
  assert.match(text, /https:\/\/accounts\.x\.ai\/authorize/)
  fieldByLabel(tree, 'Paste the code').props.onChange({ target: { value: 'AB-12' } })
  tree = await harness.render(mounted.Component)
  buttonByText(tree, 'Send').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  stream.release()
  await connecting
  tree = await harness.render(mounted.Component)
  assert.match(flatten(tree), /Connected as me@example.com/)

  const flowCalls = calls.filter((call) => call.url !== '/orchestrator/accounts')
  assert.deepEqual(flowCalls, [
    { url: '/orchestrator/accounts/connect', body: { id: 'xai-work' } },
    { url: '/orchestrator/accounts/answer', body: { attempt: 'attempt-1', prompt: 'p1', value: 'AB-12' } },
  ])
})

test('disconnecting posts to the plugin route and adopts the returned state', async () => {
  const harness = createReact()
  const calls = []
  const mounted = await mountSettings(harness, {
    accounts: { accounts: [{ id: 'xai-work', product: 'xai', label: 'Grok (work)' }] },
    status: [{ id: 'xai-work', product: 'xai', label: 'Grok (work)', connected: true, method: 'oauth' }],
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) })
      return { ok: true, status: 200, async json() { return { accounts: [{ id: 'xai-work', connected: false }], problems: [] } } }
    },
  })
  let tree = await harness.render(mounted.Component)
  await buttonByText(tree, 'Disconnect').props.onClick()
  tree = await harness.render(mounted.Component)
  assert.deepEqual(calls, [{ url: '/orchestrator/accounts/disconnect', body: { id: 'xai-work' } }])
  assert.match(flatten(tree), /not connected/)
})
