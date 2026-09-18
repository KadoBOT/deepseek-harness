// @vitest-environment jsdom
/** Authorization-card projections and grant-backed Models readiness. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { providerUsable } from '../src/client/store.ts'
import {
  AuthorizationCard,
  authorizationMethod, noticeHref, promptLabel, promptOptions,
} from '../src/client/AuthorizationCard.tsx'
import { enableAuthorizationProfile } from '../src/client/ModelsSection.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const grant: CredentialInfo = { configured: true, writable: true }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'openai-codex',
      displayName: 'Codex',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai-codex'],
      active: true,
      authorizationKey: 'llm-pi-ai/openai-codex' as never,
    },
    configured: true,
    removable: true,
    apiKeyEnv: undefined,
    credential: undefined,
    authorization: {
      key: 'llm-pi-ai/openai-codex' as never,
      label: 'Codex',
      methods: [{ id: 'oauth', label: 'OAuth' }],
      configured: true,
      credentialKind: 'grant',
      inFlight: false,
    },
    ...overrides,
  }
}

function state(rows: readonly ProviderRow[]): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    authorizationError: null,
    writable: true,
    rows,
    namespaces: new Map(),
  }
}

describe('AuthorizationCard projections', () => {
  it('offers only the OAuth method and ignores unrelated authorization methods', () => {
    expect(authorizationMethod({
      key: 'llm-pi-ai/openai-codex' as never,
      label: 'Codex',
      methods: [{ id: 'oauth', label: 'OAuth' }, { id: 'api-key', label: 'API key' }],
      configured: false,
      inFlight: false,
    })).toEqual({ id: 'oauth', label: 'OAuth' })
    expect(authorizationMethod({
      key: 'llm-pi-ai/openai-codex' as never,
      label: 'Codex',
      methods: [{ id: 'device', label: 'Device code' }],
      configured: false,
      inFlight: false,
    })).toBeUndefined()
  })

  it('accepts only browser-safe notice links', () => {
    expect(noticeHref('https://example.test/device')).toBe('https://example.test/device')
    expect(noticeHref('http://localhost:1455')).toBe('http://localhost:1455')
    expect(noticeHref('javascript:alert(1)')).toBeUndefined()
    expect(noticeHref('//example.test')).toBeUndefined()
  })

  it('projects text and select prompts without putting secrets in the page text', () => {
    const secret = { id: 'prompt-secret' as never, kind: 'secret' as const, message: 'Paste the code' }
    expect(promptLabel(secret)).toBe('Paste the code')
    expect(promptOptions(secret)).toEqual([])
    const select = {
      id: 'prompt-provider' as never,
      kind: 'select' as const,
      message: 'Choose an account',
      options: [{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }],
    }
    expect(promptLabel(select)).toBe('Choose an account')
    expect(promptOptions(select)).toEqual(select.options)
  })

  it('renders a safe sign-in notice and answers a secret prompt without echoing it', async () => {
    const onChanged = vi.fn()
    const onEnable = vi.fn(() => Promise.resolve(undefined))
    const operations = {
      beginAuthorization: vi.fn(() => Promise.resolve({ attempt: {
        id: 'attempt-1' as never,
        key: 'llm-pi-ai/openai-codex' as never,
        status: 'pending' as const,
        notice: { message: 'Open the sign-in page', url: 'https://example.test/login', code: 'ABCD' },
        prompt: { id: 'prompt-1' as never, kind: 'secret' as const, message: 'Paste the returned code' },
      } })),
      respondAuthorization: vi.fn(() => Promise.resolve({ attempt: {
        id: 'attempt-1' as never,
        key: 'llm-pi-ai/openai-codex' as never,
        status: 'authorized' as const,
      } })),
      readAuthorization: vi.fn(),
      cancelAuthorization: vi.fn(),
      disconnectAuthorization: vi.fn(),
    } as unknown as ModelsOperations
    render(<AuthorizationCard
      flow={{ ...row().authorization!, configured: false }}
      enabled={false}
      readOnly={false}
      operations={operations}
      t={key => en[key]}
      onChanged={onChanged}
      onEnable={onEnable}
    />)
    fireEvent.click(screen.getByRole('button', { name: en.connectAccount }))
    expect((await screen.findByRole('link', { name: en.openAuthorization })).getAttribute('href')).toBe('https://example.test/login')
    expect(screen.getByText('ABCD')).toBeTruthy()
    const input = screen.getByLabelText('Paste the returned code') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'secret-code' } })
    fireEvent.click(screen.getByRole('button', { name: en.submitAuthorization }))
    await waitFor(() => { expect(onEnable).toHaveBeenCalledOnce() })
    expect(document.body.textContent).not.toContain('secret-code')
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('cancels a pending attempt when the card unmounts', async () => {
    const cancelAuthorization = vi.fn(() => Promise.resolve({ attempt: {
      id: 'attempt-2' as never,
      key: 'llm-pi-ai/openai-codex' as never,
      status: 'cancelled' as const,
    } }))
    const operations = {
      beginAuthorization: vi.fn(() => Promise.resolve({ attempt: {
        id: 'attempt-2' as never,
        key: 'llm-pi-ai/openai-codex' as never,
        status: 'pending' as const,
      } })),
      readAuthorization: vi.fn(), cancelAuthorization,
      respondAuthorization: vi.fn(), disconnectAuthorization: vi.fn(),
    } as unknown as ModelsOperations
    const view = render(<AuthorizationCard
      flow={{ ...row().authorization!, configured: false }} enabled={false} readOnly={false} operations={operations}
      t={key => en[key]} onChanged={vi.fn()} onEnable={() => Promise.resolve(undefined)}
    />)
    fireEvent.click(screen.getByRole('button', { name: en.connectAccount }))
    await screen.findByRole('button', { name: en.cancelAccount })
    view.unmount()
    expect(cancelAuthorization).toHaveBeenCalledWith('attempt-2')
  })
})

describe('grant-backed provider readiness', () => {
  it('treats a configured grant as usable without requiring an API key', () => {
    expect(providerUsable(row())).toBe(true)
    expect(providerUsable(row({ authorization: { ...row().authorization!, configured: false } }))).toBe(false)
  })

  it('does not let an authorization failure hide an unrelated API-key provider', () => {
    const openrouter: ProviderRow = {
      ...row(),
      entry: {
        ...row().entry,
        provider: 'openrouter',
        displayName: 'OpenRouter',
        authorizationKey: undefined,
      },
      apiKeyEnv: 'OPENROUTER_API_KEY',
      credential: grant,
      authorization: undefined,
    }
    expect(state([openrouter, row({ authorization: undefined })]).rows).toContain(openrouter)
    expect(providerUsable(openrouter)).toBe(true)
  })

  it('switches one user API-key override to a grant with a scoped unset', async () => {
    const writeSettings = vi.fn(() => Promise.resolve({ kind: 'written' as const, view: {} as never }))
    const operations = { writeSettings } as unknown as ModelsOperations
    const namespace = {
      ns: 'llm-pi-ai', schema: {}, value: { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_API_KEY' } } },
      base: {}, user: { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_API_KEY' } } },
      applies: 'live' as const, secrets: [], revision: 7,
    }
    await expect(enableAuthorizationProfile(row(), namespace, settingsSchema, operations, 'inherited')).resolves.toBeUndefined()
    expect(writeSettings).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'openai-codex', 'apiKeyEnv'] }],
      7,
    )
  })

  it('refuses a grant switch when the deployment supplies the API-key field', async () => {
    const writeSettings = vi.fn()
    const operations = { writeSettings } as unknown as ModelsOperations
    const namespace = {
      ns: 'llm-pi-ai', schema: {}, value: { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_API_KEY' } } },
      base: { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_API_KEY' } } }, user: {},
      applies: 'live' as const, secrets: [], revision: 7,
    }
    await expect(enableAuthorizationProfile(row(), namespace, settingsSchema, operations, 'inherited')).resolves.toBe('inherited')
    expect(writeSettings).not.toHaveBeenCalled()
  })
})
