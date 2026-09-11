import { useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MachineView, RemoteDirectoryListing } from '@deepseek-ai/dsh-experimental-remote-host'
import { NS } from './locales.ts'
import css from './AddRemoteProject.module.css'

/** Injected host actions. */
export interface AddRemoteProjectInjected {
  listMachines: () => Promise<MachineView[]>
  upsertMachine: (input: { label: string; url: string; auth?: string }) => Promise<MachineView>
  listDirectory: (input: { machineId: string; path?: string }) => Promise<RemoteDirectoryListing>
  createWorkspace: (input: { machineId: string; path: string; title?: string }) => Promise<void>
}

export type AddRemoteProjectProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & AddRemoteProjectInjected

function parentDirectory(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, '')
  const drive = /^([A-Za-z]:)(?:[\\/](.*))?$/.exec(trimmed)
  if (drive !== null) {
    const rest = drive[2] ?? ''
    if (rest.length === 0) return undefined
    const slash = Math.max(rest.lastIndexOf('\\'), rest.lastIndexOf('/'))
    return slash === -1 ? `${drive[1]}\\` : `${drive[1]}\\${rest.slice(0, slash)}`
  }
  if (!trimmed.startsWith('/') || trimmed === '/') return undefined
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

function failMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

/** Sidebar footer control that adopts a remote directory as a Workspace. */
export function AddRemoteProject(props: AddRemoteProjectProps) {
  const { t, listMachines, listDirectory, createWorkspace } = props
  const [open, setOpen] = useState(false)
  const [machines, setMachines] = useState<MachineView[]>([])
  const [machineId, setMachineId] = useState('')
  const [listing, setListing] = useState<RemoteDirectoryListing | undefined>()
  const [title, setTitle] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const browse = (id: string, nextPath?: string): void => {
    setBusy(true)
    setError(undefined)
    void listDirectory({ machineId: id, ...nextPath === undefined ? {} : { path: nextPath } }).then((result) => {
      setListing(result)
      if (!titleTouched) setTitle(pathBasename(result.path))
      setBusy(false)
    }, (error: unknown) => { setBusy(false); setError(failMessage(error, t('error'))) })
  }

  const load = (): void => {
    setError(undefined)
    void listMachines().then((rows) => {
      setMachines(rows)
      const first = rows[0]
      if (machineId === '' && first !== undefined) {
        setMachineId(first.id)
        browse(first.id)
      }
    }, (error: unknown) => { setError(failMessage(error, t('error'))) })
  }

  const parent = listing === undefined ? undefined : parentDirectory(listing.path)

  return (
    <>
      <button
        type="button"
        className={css.trigger}
        onClick={() => { setOpen(true); load() }}
      >
        {t('add.project')}
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('dialog.title')}
        closeLabel={t('dialog.close')}
        footer={(
          <>
            <Button onClick={() => { setOpen(false) }}>{t('action.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || machineId === '' || listing === undefined || title.trim() === ''}
              onClick={() => {
                /* v8 ignore next -- the button stays disabled while listing is undefined */
                if (listing === undefined) return
                setBusy(true)
                setError(undefined)
                void createWorkspace({
                  machineId,
                  path: listing.path,
                  title: title.trim(),
                }).then(
                  () => { setBusy(false); setOpen(false); setTitleTouched(false) },
                  (error: unknown) => { setBusy(false); setError(failMessage(error, t('error'))) },
                )
              }}
            >
              {t('action.select')}
            </Button>
          </>
        )}
      >
        {machines.length === 0
          ? <p className={css.empty}>{t('empty')}</p>
          : (
            <label className={css.field}>
              {t('field.machine')}
              <select
                value={machineId}
                onChange={(event) => {
                  const id = event.target.value
                  setMachineId(id)
                  browse(id)
                }}
              >
                {machines.map(machine => (
                  <option key={machine.id} value={machine.id}>{machine.label}</option>
                ))}
              </select>
            </label>
          )}
        {listing === undefined
          ? (busy ? <p className={css.empty}>{t('browse.loading')}</p> : null)
          : (
            <>
              <label className={css.field}>
                {t('field.projectName')}
                <Input
                  value={title}
                  onChange={(event) => {
                    setTitleTouched(true)
                    setTitle(event.target.value)
                  }}
                />
              </label>
              <p className={css.current}>
                <span className={css.currentLabel}>{t('browse.current')}</span>
                <span className={css.path}>{listing.path}</span>
              </p>
              <ul className={css.browser}>
                {parent !== undefined && (
                  <li>
                    <button type="button" className={css.folder} onClick={() => { browse(machineId, parent) }}>
                      {t('browse.parent')}
                    </button>
                  </li>
                )}
                {listing.entries.length === 0
                  ? <li className={css.empty}>{t('browse.empty')}</li>
                  : listing.entries.map(entry => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className={css.folder}
                        onClick={() => { browse(machineId, entry.path) }}
                      >
                        {entry.name}
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        {error === undefined ? null : <p className={css.error}>{error}</p>}
      </Modal>
    </>
  )
}
