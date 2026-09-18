/** Browser controls for one host-owned account authorization flow. */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AuthorizationAttemptView, AuthorizationFlowView, AuthorizationPromptView, CredentialKey,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link AuthorizationCard}. */
export interface AuthorizationCardProps {
  /** Host-described authorization flow. */
  flow: AuthorizationFlowView
  /** Whether the matching settings profile is enabled. */
  enabled: boolean
  /** Disable writes in a read-only deployment. */
  readOnly: boolean
  /** Host operations used by the card. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Called after a grant changes or is disconnected. */
  onChanged: () => void
  /** Enable a dormant provider profile after a grant exists. */
  onEnable: () => Promise<string | undefined>
}

/** Select the generic OAuth method advertised by a flow. */
export function authorizationMethod(flow: AuthorizationFlowView): { id: string; label: string } | undefined {
  return flow.methods.find(method => method.id === 'oauth')
}

/** Keep only links that the browser may safely navigate to. */
export function noticeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Accessible prompt text. */
export function promptLabel(prompt: AuthorizationPromptView): string {
  return prompt.message
}

/** Select choices, or an empty list for text and secret prompts. */
export function promptOptions(prompt: AuthorizationPromptView): readonly { id: string; label: string; description?: string }[] {
  return prompt.kind === 'select' ? prompt.options : []
}

/** Render one browser-driven account connection card. */
export function AuthorizationCard(props: AuthorizationCardProps): ReactNode {
  const { flow, operations, t } = props
  const method = authorizationMethod(flow)
  const [attempt, setAttempt] = useState<AuthorizationAttemptView | undefined>(flow.attempt)
  const [promptValue, setPromptValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const attemptRef = useRef<AuthorizationAttemptView | undefined>(attempt)
  attemptRef.current = attempt

  useEffect(() => {
    setAttempt(flow.attempt)
    setPromptValue('')
    setFailure(undefined)
  }, [flow.attempt?.id, flow.attempt?.status])

  useEffect(() => {
    const id = attempt?.id
    if (id === undefined || attempt?.status !== 'pending') return
    const controller = new AbortController()
    let polling = false
    const poll = async (): Promise<void> => {
      if (controller.signal.aborted || polling) return
      polling = true
      try {
        const result = await operations.readAuthorization(id)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- signal can abort while read is awaited
        if (controller.signal.aborted) return
        if ('refused' in result) setFailure(result.refused)
        else {
          setAttempt(result.attempt)
          if (result.attempt.status === 'authorized') {
            const error = await props.onEnable()
            if (error !== undefined) setFailure(error)
            else props.onChanged()
          }
        }
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => { void poll() }, 1000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [attempt?.id, attempt?.status, operations])

  // A browser leaving the page must release its host-side pending interaction.
  // The ref prevents a terminal poll result from being cancelled by an effect
  // cleanup caused by its own state update.
  useEffect(() => () => {
    const current = attemptRef.current
    if (current?.status === 'pending') void operations.cancelAuthorization(current.id)
  }, [operations])

  if (method === undefined) return null

  const run = async (action: () => Promise<{ attempt: AuthorizationAttemptView } | { refused: string }>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    const result = await action()
    if ('refused' in result) setFailure(result.refused)
    else {
      setAttempt(result.attempt)
      setPromptValue('')
      if (result.attempt.status === 'authorized') {
        const error = await props.onEnable()
        if (error !== undefined) setFailure(error)
        else props.onChanged()
      }
    }
    setBusy(false)
  }

  const disconnect = (): void => {
    setBusy(true)
    setFailure(undefined)
    void operations.disconnectAuthorization(flow.key).then((error) => {
      if (error !== undefined) setFailure(error)
      else props.onChanged()
    }).finally(() => { setBusy(false) })
  }

  const currentPrompt = attempt?.status === 'pending' ? attempt.prompt : undefined
  const submitPrompt = (): void => {
    if (attempt?.id === undefined || currentPrompt === undefined) return
    void run(() => operations.respondAuthorization(attempt.id, currentPrompt.id, promptValue))
  }
  const cancel = (): void => {
    if (attempt?.id === undefined) return
    void run(() => operations.cancelAuthorization(attempt.id))
  }
  const enable = (): void => {
    setBusy(true)
    setFailure(undefined)
    void props.onEnable().then((error) => {
      if (error !== undefined) setFailure(error)
      else props.onChanged()
    }).finally(() => { setBusy(false) })
  }

  const notice = attempt?.notice
  const href = noticeHref(notice?.url)
  const connected = flow.configured && props.enabled
  return (
    <div className={styles['authorizationCard']}>
      <div className={styles['authorizationHead']}>
        <div>
          <strong className={styles['authorizationTitle']}>{flow.label}</strong>
          <p className={styles['authorizationHint']}>
            {connected ? t('accountConnected') : flow.configured ? t('accountEnableHint') : t('accountConnectHint')}
          </p>
        </div>
        <div className={styles['authorizationActions']}>
          {flow.configured && !props.enabled
            ? <button type="button" className={styles['secondaryButton']} disabled={busy || props.readOnly} onClick={enable}>{t('enableAccount')}</button>
            : null}
          {!flow.configured
            ? attempt?.status === 'pending'
              ? <button type="button" className={styles['secondaryButton']} disabled={busy || props.readOnly} onClick={cancel}>{t('cancelAccount')}</button>
              : <button type="button" className={styles['primaryButton']} disabled={busy || props.readOnly} onClick={() => { void run(() => operations.beginAuthorization(flow.key, method.id)) }}>{t('connectAccount')}</button>
            : <button type="button" className={styles['secondaryButton']} disabled={busy || props.readOnly || attempt?.status === 'pending'} onClick={disconnect}>{t('disconnectAccount')}</button>}
        </div>
      </div>
      {notice === undefined ? null : (
        <div className={styles['authorizationNotice']} role="status" aria-live="polite">
          <span>{notice.message}</span>
          {href === undefined ? null : <a href={href} target="_blank" rel="noreferrer">{t('openAuthorization')}</a>}
          {notice.code === undefined ? null : <code>{notice.code}</code>}
        </div>
      )}
      {currentPrompt === undefined ? null : (
        <div className={styles['authorizationPrompt']}>
          <label className={styles['fieldLabel']} htmlFor={`authorization-${String(currentPrompt.id)}`}>{promptLabel(currentPrompt)}</label>
          {currentPrompt.kind === 'select'
            ? (
              <select
                id={`authorization-${String(currentPrompt.id)}`}
                className={`${styles['input']} ${styles['selectInput']}`}
                value={promptValue}
                onChange={(event) => { setPromptValue(event.target.value) }}
              >
                <option value="">{t('selectAuthorizationOption')}</option>
                {promptOptions(currentPrompt).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            )
            : (
              <input
                id={`authorization-${String(currentPrompt.id)}`}
                className={styles['input']}
                type={currentPrompt.kind === 'secret' ? 'password' : 'text'}
                placeholder={currentPrompt.placeholder}
                value={promptValue}
                onChange={(event) => { setPromptValue(event.target.value) }}
              />
            )}
          <div className={styles['editorActions']}>
            <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={cancel}>{t('cancelAccount')}</button>
            <button type="button" className={styles['primaryButton']} disabled={busy || promptValue.length === 0} onClick={submitPrompt}>{t('submitAuthorization')}</button>
          </div>
        </div>
      )}
      {failure === undefined || failure.length === 0 ? null : <p className={styles['error']}>{failure}</p>}
    </div>
  )
}

/** Keep the imported brand visible to TypeScript declaration emit. */
export type { CredentialKey }
