import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ANTIGRAVITY_MODELS, resolveAgyModelFlag } from '../src/index.js'

test('catalog lists effort variants, never bare base ids', () => {
  for (const base of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro']) {
    assert.ok(!(base in ANTIGRAVITY_MODELS), `${base} must not be advertised`)
  }
  assert.equal(ANTIGRAVITY_MODELS['gemini-3.8-flash-high'].name, 'Gemini 3.8 Flash (High)')
  assert.equal(ANTIGRAVITY_MODELS['gemini-3.1-pro-low'].name, 'Gemini 3.1 Pro (Low)')
  assert.equal(Object.keys(ANTIGRAVITY_MODELS).length, 14)
})

test('pinned variant without effort stays exactly as picked', () => {
  assert.equal(resolveAgyModelFlag('gemini-3.8-flash-high', undefined), 'gemini-3.8-flash-high')
  assert.equal(resolveAgyModelFlag('gemini-3.1-pro-low', undefined), 'gemini-3.1-pro-low')
  assert.equal(resolveAgyModelFlag('claude-sonnet-4-6', undefined), 'claude-sonnet-4-6')
})

test('legacy base ids keep working through family mapping', () => {
  assert.equal(resolveAgyModelFlag('gemini-3.8-flash', undefined), 'gemini-3.8-flash-medium')
  assert.equal(resolveAgyModelFlag('gemini-3.1-pro', 'low'), 'gemini-3.1-pro-low')
})

test('explicit effort remaps within the family', () => {
  assert.equal(resolveAgyModelFlag('gemini-3.8-flash-high', 'low'), 'gemini-3.8-flash-low')
  assert.equal(resolveAgyModelFlag('gemini-3.1-pro-low', 'high'), 'gemini-3.1-pro-high')
  assert.equal(resolveAgyModelFlag('unknown-model', 'high'), 'unknown-model')
})
