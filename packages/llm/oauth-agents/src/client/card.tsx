/**
 * Models-page footer card: one row per OAuth provider with a connect button,
 * the opened sign-in page link with an inline authorization-code field, and
 * the verbatim `/oauth-status` text block. Pure React over the inject face;
 * copy rides the `oauth-agents` locale namespace.
 * @module @deepseek-ai/dsh-oauth-agents/client/card
 */

import { createElement, useCallback, useState, type CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { OAUTH_PROVIDER_VIEWS } from '../views.ts'

/** Verbs the registration injects from the apply closure. */
export interface OAuthAgentsInjected {
  /**
   * Start one provider's sign-in and open its page.
   * @param provider - one of the catalog provider ids.
   * @returns the sign-in page URL with the optional user code, or the error.
   */
  start(provider: string): Promise<{ url?: string; code?: string; error?: string }>
  /**
   * Complete the started sign-in, optionally submitting a pasted code.
   * @param provider - one of the catalog provider ids.
   * @param code - the code pasted in the card, or `''` when none.
   * @returns the outcome text.
   */
  finish(provider: string, code: string): Promise<string>
  /**
   * Run `/oauth-status` on the current session.
   * @returns the status text, or `undefined` when no session carries it.
   */
  status(): Promise<string | undefined>
}

/** Footer card props: injected verbs plus the namespace translator. */
export interface OAuthAgentsFooterProps extends OAuthAgentsInjected {
  /** The `oauth-agents` namespace translator. */
  t: TranslateNS<'oauth-agents'>
}

/** Where one provider's card row stands in the sign-in stepper. */
type ConnectState = 'idle' | 'starting' | 'waiting' | 'finishing'

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 8,
    padding: '12px 0', borderTop: '1px solid var(--dsh-border, #e2e2e2)',
  },
  title: { fontSize: 13, fontWeight: 600, margin: 0 },
  hint: { fontSize: 12, opacity: 0.7, margin: 0, lineHeight: 1.5 },
  column: { display: 'flex', flexDirection: 'column', gap: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { fontSize: 13, flex: 1 },
  connectButton: {
    fontSize: 12, padding: '3px 10px', cursor: 'pointer', borderRadius: 6,
    border: '1px solid var(--dsh-border, #d0d0d0)', background: 'transparent', color: 'inherit',
  },
  openLink: { fontSize: 12, color: 'var(--dsh-accent, #4c8dff)', textDecoration: 'none' },
  codeRow: { display: 'flex', alignItems: 'center', gap: 8 },
  codeInput: {
    flex: 1, fontSize: 12, padding: '3px 8px', borderRadius: 6,
    border: '1px solid var(--dsh-border, #d0d0d0)', background: 'transparent', color: 'inherit',
  },
  deviceCode: { fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0 },
  result: {
    fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5,
    opacity: 0.85, paddingLeft: 4,
  },
  status: {
    fontSize: 12, opacity: 0.75, margin: 0, whiteSpace: 'pre-wrap',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.6,
  },
  refresh: { alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'inherit', padding: 0 },
}

/**
 * Render the provider rows with the sign-in stepper, the status block, and the
 * refresh control.
 * @param props - injected verbs and the translator.
 * @returns the footer element tree.
 */
export function OAuthAgentsFooter(props: OAuthAgentsFooterProps) {
  const [states, setStates] = useState<Record<string, ConnectState>>({})
  const [pages, setPages] = useState<Record<string, { url: string; code?: string }>>({})
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [outcomes, setOutcomes] = useState<Record<string, string>>({})
  const [statusText, setStatusText] = useState<string | undefined>(undefined)
  const [statusMissing, setStatusMissing] = useState(false)

  const refresh = useCallback(async () => {
    const text = await props.status()
    if (text === undefined) setStatusMissing(true)
    else {
      setStatusMissing(false)
      setStatusText(text)
    }
  }, [props])

  const connect = useCallback(async (provider: string) => {
    setStates(previous => ({ ...previous, [provider]: 'starting' }))
    setOutcomes(previous => ({ ...previous, [provider]: '' }))
    try {
      const started = await props.start(provider)
      if (started.error !== undefined || started.url === undefined) {
        setOutcomes(previous => ({ ...previous, [provider]: started.error ?? 'connect failed' }))
        setStates(previous => ({ ...previous, [provider]: 'idle' }))
        return
      }
      const url = started.url
      const deviceCode = started.code
      setPages(previous => ({
        ...previous,
        [provider]: deviceCode === undefined ? { url } : { url, code: deviceCode },
      }))
      setStates(previous => ({ ...previous, [provider]: 'waiting' }))
      // Open the sign-in page in a new tab; the rendered link is the fallback
      // when the browser blocks the delayed popup.
      window.open(url, '_blank', 'noopener')
    } catch (error) {
      setOutcomes(previous => ({
        ...previous,
        [provider]: error instanceof Error ? error.message : String(error),
      }))
      setStates(previous => ({ ...previous, [provider]: 'idle' }))
    }
  }, [props])

  const finish = useCallback(async (provider: string) => {
    setStates(previous => ({ ...previous, [provider]: 'finishing' }))
    try {
      const text = await props.finish(provider, codes[provider] ?? '')
      setOutcomes(previous => ({ ...previous, [provider]: text }))
      setPages(previous => Object.fromEntries(
        Object.entries(previous).filter(([key]) => key !== provider),
      ))
      setCodes(previous => ({ ...previous, [provider]: '' }))
      setStates(previous => ({ ...previous, [provider]: 'idle' }))
      await refresh()
    } catch (error) {
      setOutcomes(previous => ({
        ...previous,
        [provider]: error instanceof Error ? error.message : String(error),
      }))
      setStates(previous => ({ ...previous, [provider]: 'idle' }))
    }
  }, [props, codes, refresh])

  return createElement('div', { style: styles.root },
    createElement('p', { style: styles.title }, props.t('card.title')),
    createElement('p', { style: styles.hint }, props.t('card.hint')),
    OAUTH_PROVIDER_VIEWS.map(view => createElement('div', { key: view.id, style: styles.column },
      createElement('div', { style: styles.row },
        createElement('span', { style: styles.label }, view.label),
        createElement('button', {
          style: styles.connectButton,
          disabled: states[view.id] === 'starting' || states[view.id] === 'finishing',
          onClick: () => {
            void connect(view.id)
          },
        }, states[view.id] === 'starting'
          ? props.t('connect.starting')
          : (states[view.id] === 'waiting' ? props.t('connect.running') : props.t('connect.button'))),
        createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, view.signinHint),
      ),
      (() => {
        const page = pages[view.id]
        if (page === undefined) return null
        return createElement('div', { style: styles.column },
          createElement('a', {
            style: styles.openLink,
            href: page.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, props.t('connect.open')),
          page.code !== undefined
            ? createElement('p', { style: styles.deviceCode },
              `${props.t('connect.enterCode')} ${page.code}`)
            : null,
          createElement('div', { style: styles.codeRow },
            createElement('input', {
              style: styles.codeInput,
              value: codes[view.id] ?? '',
              placeholder: props.t('connect.codePlaceholder'),
              onChange: (event) => {
                const { value } = event.target as HTMLInputElement
                setCodes(previous => ({ ...previous, [view.id]: value }))
              },
            }),
            createElement('button', {
              style: styles.connectButton,
              disabled: states[view.id] === 'finishing',
              onClick: () => {
                void finish(view.id)
              },
            }, states[view.id] === 'finishing' ? props.t('connect.finishing') : props.t('connect.finish')),
          ),
        )
      })(),
      outcomes[view.id] !== undefined && outcomes[view.id] !== ''
        ? createElement('p', { style: styles.result }, outcomes[view.id])
        : null,
    )),
    createElement('button', {
      style: styles.refresh,
      onClick: () => {
        void refresh()
      },
    }, props.t('connect.refresh')),
    createElement('p', { style: styles.status },
      statusMissing ? props.t('status.unavailable') : (statusText ?? '')),
  )
}
