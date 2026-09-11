// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MachineId } from '@deepseek-ai/dsh-experimental-remote-host/types'
import { AddRemoteProject } from '../src/client/AddRemoteProject.tsx'

const t = (key: string) => key
const globalProps = {
  useSessions: () => ({}) as never,
  useSessionPendingInteraction: () => ({}) as never,
  useWorkspaces: () => ({}) as never,
}

describe('AddRemoteProject', () => {
  afterEach(() => { cleanup() })
  it('opens a folder browser on the selected machine without a path text field', async () => {
    const listMachines = vi.fn(async () => [
      { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
    ])
    const listDirectory = vi.fn(async (input: { path?: string }) => {
      if (input.path === '/home/app') return { path: '/home/app', entries: [] }
      return { path: '/home', entries: [{ name: 'app', path: '/home/app' }] }
    })
    render(
      <AddRemoteProject
        {...globalProps}
        wide
        t={t}
        listMachines={listMachines}
        listDirectory={listDirectory}
        upsertMachine={vi.fn()}
        createWorkspace={vi.fn()}
      />,
    )
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('dialog.title')).toBeTruthy()
    expect(await screen.findByText('/home')).toBeTruthy()
    expect(screen.queryByText('field.path')).toBeNull()
    expect(screen.queryByText('field.target')).toBeNull()
    screen.getByRole('button', { name: 'app' }).click()
    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalledWith({ machineId: 'gpu', path: '/home/app' })
    })
    expect(await screen.findByText('/home/app')).toBeTruthy()
  })

  it('creates a workspace from the listed folder', async () => {
    const createWorkspace = vi.fn(async () => {})
    render(
      <AddRemoteProject
        {...globalProps}
        wide
        t={t}
        listMachines={vi.fn(async () => [
          { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
        ])}
        listDirectory={vi.fn(async () => ({ path: '/home/app', entries: [] }))}
        upsertMachine={vi.fn()}
        createWorkspace={createWorkspace}
      />,
    )
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('/home/app')).toBeTruthy()
    screen.getByRole('button', { name: 'action.select' }).click()
    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        machineId: 'gpu',
        path: '/home/app',
        title: 'app',
      })
    })
  })
})

describe('AddRemoteProject browser', () => {
  afterEach(() => { cleanup() })

  const machines = [
    { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
    { id: MachineId('mac'), label: 'mac', url: 'http://127.0.0.1:3082', status: 'unknown' as const },
  ]

  function browser(overrides: Record<string, unknown> = {}) {
    const listDirectory = vi.fn(async (input: { machineId: string; path?: string }) => {
      if (input.machineId === 'mac') return { path: '/Users/mac', entries: [] }
      if (input.path === '/home/app') return { path: '/home/app', entries: [] }
      return { path: '/home', entries: [{ name: 'app', path: '/home/app' }] }
    })
    return {
      listMachines: vi.fn(async () => machines),
      listDirectory,
      upsertMachine: vi.fn(),
      createWorkspace: vi.fn(async () => {}),
      ...overrides,
    }
  }

  it('switches machines and navigates to the parent directory', async () => {
    const props = browser()
    render(<AddRemoteProject {...globalProps} wide t={t} {...props} />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mac' } })
    expect(await screen.findByText('/Users/mac')).toBeTruthy()
    expect(props.listDirectory).toHaveBeenCalledWith({ machineId: 'mac' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gpu' } })
    expect(await screen.findByText('/home')).toBeTruthy()
    screen.getByRole('button', { name: 'app' }).click()
    expect(await screen.findByText('/home/app')).toBeTruthy()
    screen.getByRole('button', { name: 'browse.parent' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
  })

  it('keeps a custom project name and reports workspace failures', async () => {
    const createWorkspace = vi.fn(async () => { throw new Error('denied') })
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...browser({ createWorkspace })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
    const [name] = screen.getAllByRole('textbox')
    fireEvent.change(name as HTMLElement, { target: { value: 'custom' } })
    screen.getByRole('button', { name: 'action.select' }).click()
    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({ machineId: 'gpu', path: '/home', title: 'custom' })
    })
    expect(await screen.findByText('denied')).toBeTruthy()
  })

  it('reports directory and machine load failures', async () => {
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...browser({ listDirectory: vi.fn(async () => { throw new Error('ls failed') }) })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('ls failed')).toBeTruthy()
    cleanup()
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...browser({ listMachines: vi.fn(async () => { throw new Error('list failed') }) })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('list failed')).toBeTruthy()
  })

  it('closes without adopting', async () => {
    const createWorkspace = vi.fn()
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...browser({ createWorkspace })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
    screen.getByRole('button', { name: 'action.cancel' }).click()
    expect(createWorkspace).not.toHaveBeenCalled()
  })
})

describe('AddRemoteProject windows paths', () => {
  afterEach(() => { cleanup() })

  const windows: Record<string, { path: string; entries: Array<{ name: string; path: string }> }> = {
    'C:\\Users\\ricar\\ComfyUI': { path: 'C:\\Users\\ricar\\ComfyUI', entries: [] },
    'C:\\Users\\ricar': {
      path: 'C:\\Users\\ricar',
      entries: [{ name: 'ComfyUI', path: 'C:\\Users\\ricar\\ComfyUI' }],
    },
    'C:\\Users': { path: 'C:\\Users', entries: [{ name: 'ricar', path: 'C:\\Users\\ricar' }] },
    'C:\\': { path: 'C:\\', entries: [{ name: 'Users', path: 'C:\\Users' }] },
  }

  function windowsProps(overrides: Record<string, unknown> = {}) {
    return {
      listMachines: vi.fn(async () => [
        { id: MachineId('win'), label: 'win', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
      ]),
      listDirectory: vi.fn(async (input: { machineId: string; path?: string }) => (
        windows[input.path ?? 'C:\\Users\\ricar\\ComfyUI'] ?? { path: input.path ?? '', entries: [] }
      )),
      upsertMachine: vi.fn(),
      createWorkspace: vi.fn(async () => {}),
      ...overrides,
    }
  }

  it('walks windows parents up to the drive root', async () => {
    render(<AddRemoteProject {...globalProps} wide t={t} {...windowsProps()} />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('C:\\Users\\ricar\\ComfyUI')).toBeTruthy()
    screen.getByRole('button', { name: 'browse.parent' }).click()
    expect(await screen.findByText('C:\\Users\\ricar')).toBeTruthy()
    screen.getByRole('button', { name: 'browse.parent' }).click()
    expect(await screen.findByText('C:\\Users')).toBeTruthy()
    screen.getByRole('button', { name: 'browse.parent' }).click()
    expect(await screen.findByText('C:\\')).toBeTruthy()
    // The drive root has no parent entry.
    expect(screen.queryByRole('button', { name: 'browse.parent' })).toBeNull()
  })

  it('closes through the dialog close control', async () => {
    render(<AddRemoteProject {...globalProps} wide t={t} {...windowsProps()} />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('dialog.title')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'dialog.close' }))
    await waitFor(() => {
      expect(screen.queryByText('dialog.title')).toBeNull()
    })
  })

  it('shows empty machines and falls back on blank errors', async () => {
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...windowsProps({ listMachines: vi.fn(async () => []) })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('empty')).toBeTruthy()
    cleanup()
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...windowsProps({ listMachines: vi.fn(async () => { throw new Error('   ') }) })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('error')).toBeTruthy()
    cleanup()
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      {...windowsProps({ listMachines: vi.fn(async () => { throw 'oops-string' }) })}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('error')).toBeTruthy()
  })
})

describe('AddRemoteProject titles', () => {
  afterEach(() => { cleanup() })

  it('keeps a custom title across navigation and tolerates empty paths', async () => {
    const listDirectory = vi.fn(async (input: { machineId: string; path?: string }) => {
      if (input.path === '/home/app') return { path: '/home/app', entries: [] }
      if (input.path === '') return { path: '', entries: [] }
      return { path: '/home', entries: [{ name: 'app', path: '/home/app' }, { name: 'empty', path: '' }] }
    })
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      listMachines={vi.fn(async () => [
        { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
      ])}
      listDirectory={listDirectory}
      upsertMachine={vi.fn()}
      createWorkspace={vi.fn(async () => {})}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
    const [name] = screen.getAllByRole('textbox')
    fireEvent.change(name as HTMLElement, { target: { value: 'custom' } })
    screen.getByRole('button', { name: 'app' }).click()
    expect(await screen.findByText('/home/app')).toBeTruthy()
    expect((name as HTMLInputElement).value).toBe('custom')
    screen.getByRole('button', { name: 'browse.parent' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
    screen.getByRole('button', { name: 'empty' }).click()
    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalledWith({ machineId: 'gpu', path: '' })
    })
    // The empty path flows through the title derivation before the listing lands.
    await waitFor(() => {
      expect(screen.queryByText('/home')).toBeNull()
    })
  })
})

describe('AddRemoteProject empty titles', () => {
  afterEach(() => { cleanup() })

  it('derives an empty title from an empty path', async () => {
    const listDirectory = vi.fn(async (input: { machineId: string; path?: string }) => {
      if (input.path === '') return { path: '', entries: [] }
      return { path: '/home', entries: [{ name: 'empty', path: '' }] }
    })
    render(<AddRemoteProject
      {...globalProps}
      wide
      t={t}
      listMachines={vi.fn(async () => [
        { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
      ])}
      listDirectory={listDirectory}
      upsertMachine={vi.fn()}
      createWorkspace={vi.fn(async () => {})}
    />)
    screen.getByRole('button', { name: 'add.project' }).click()
    expect(await screen.findByText('/home')).toBeTruthy()
    screen.getByRole('button', { name: 'empty' }).click()
    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalledWith({ machineId: 'gpu', path: '' })
    })
    await waitFor(() => {
      const [name] = screen.getAllByRole('textbox')
      expect((name as HTMLInputElement).value).toBe('')
    })
  })
})
