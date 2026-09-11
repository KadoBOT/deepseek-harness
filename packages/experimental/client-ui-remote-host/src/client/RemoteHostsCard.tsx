import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MachineView } from '@deepseek-ai/dsh-experimental-remote-host'
import type { AddRemoteProjectInjected } from './AddRemoteProject.tsx'
import { NS } from './locales.ts'
import css from './AddRemoteProject.module.css'

export type RemoteHostsCardProps = PropsLocale<typeof NS> & AddRemoteProjectInjected & {
  probe: (id: string) => Promise<void>
  removeMachine: (id: string) => Promise<void>
}

/** Settings card for configured DSH/Tailscale machines. */
export function RemoteHostsCard(props: RemoteHostsCardProps) {
  const { t, listMachines, upsertMachine, probe, removeMachine } = props
  const [machines, setMachines] = useState<MachineView[]>([])
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState('')
  const [error, setError] = useState<string | undefined>()

  const reload = (): void => {
    void listMachines().then(setMachines, () => { setError(t('error')) })
  }

  useEffect(() => { reload() }, [])

  return (
    <section>
      <h3>{t('card.title')}</h3>
      <p>{t('card.desc')}</p>
      {machines.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
        <ul>
          {machines.map(machine => (
            <li key={machine.id}>
              {machine.label} ({machine.url})
              <Button size="sm" onClick={() => { void probe(machine.id).then(reload, () => { setError(t('error')) }) }}>
                {t('action.probe')}
              </Button>
              <Button size="sm" onClick={() => { void removeMachine(machine.id).then(reload, () => { setError(t('error')) }) }}>
                {t('action.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <label className={css.field}>
        {t('field.label')}
        <Input value={label} onChange={(event) => { setLabel(event.target.value) }} />
      </label>
      <label className={css.field}>
        {t('field.target')}
        <Input value={url} onChange={(event) => { setUrl(event.target.value) }} />
        <span>{t('field.target.hint')}</span>
      </label>
      <label className={css.field}>
        {t('field.auth')}
        <Input value={auth} onChange={(event) => { setAuth(event.target.value) }} />
        <span>{t('field.auth.hint')}</span>
      </label>
      <Button
        variant="primary"
        disabled={label.trim() === '' || url.trim() === ''}
        onClick={() => {
          void upsertMachine({ label: label.trim(), url: url.trim(), ...auth.trim() === '' ? {} : { auth: auth.trim() } }).then(
            () => { setLabel(''); setUrl(''); setAuth(''); reload() },
            () => { setError(t('error')) },
          )
        }}
      >
        {t('add.machine')}
      </Button>
      {error === undefined ? null : <p className={css.error}>{error}</p>}
    </section>
  )
}
