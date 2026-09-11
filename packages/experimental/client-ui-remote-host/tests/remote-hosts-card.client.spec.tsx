// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MachineId } from '@deepseek-ai/dsh-experimental-remote-host/types'
import { RemoteHostsCard } from '../src/client/RemoteHostsCard.tsx'

const t = (key: string) => key

function card(overrides: Record<string, unknown> = {}) {
  return {
    t,
    listMachines: vi.fn(async () => []),
    listDirectory: vi.fn(),
    upsertMachine: vi.fn(async (input: unknown) => ({ id: MachineId('new'), ...(input as object), status: 'unknown' as const })),
    createWorkspace: vi.fn(),
    probe: vi.fn(async () => {}),
    removeMachine: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('RemoteHostsCard', () => {
  afterEach(() => { cleanup() })

  it('lists machines and adds a host', async () => {
    const props = card({
      listMachines: vi.fn(async () => [
        { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
      ]),
    })
    render(<RemoteHostsCard {...props} />)
    expect(await screen.findByText(/gpu-box/)).toBeTruthy()
    expect(screen.getByText('card.title')).toBeTruthy()
    expect(screen.getByText('add.machine')).toBeTruthy()
  })

  it('adds a host with url and optional credential', async () => {
    const upsertMachine = vi.fn(async (input: unknown) => ({ id: MachineId('m'), ...(input as object), status: 'unknown' as const }))
    const listMachines = vi.fn(async () => [])
    render(<RemoteHostsCard {...card({ upsertMachine, listMachines })} />)
    const [label, url, auth] = screen.getAllByRole('textbox')
    const add = screen.getByRole('button', { name: 'add.machine' })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(label as HTMLElement, { target: { value: 'gpu-box' } })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(url as HTMLElement, { target: { value: 'http://127.0.0.1:3081' } })
    fireEvent.change(auth as HTMLElement, { target: { value: 'tok' } })
    fireEvent.click(add)
    await waitFor(() => {
      expect(upsertMachine).toHaveBeenCalledWith({ label: 'gpu-box', url: 'http://127.0.0.1:3081', auth: 'tok' })
    })
    await waitFor(() => {
      expect((label as HTMLInputElement).value).toBe('')
    })
  })

  it('omits a blank credential', async () => {
    const upsertMachine = vi.fn(async (input: unknown) => ({ id: MachineId('m'), ...(input as object), status: 'unknown' as const }))
    render(<RemoteHostsCard {...card({ upsertMachine })} />)
    const [label, url] = screen.getAllByRole('textbox')
    fireEvent.change(label as HTMLElement, { target: { value: 'mac' } })
    fireEvent.change(url as HTMLElement, { target: { value: 'http://127.0.0.1:3082' } })
    fireEvent.click(screen.getByRole('button', { name: 'add.machine' }))
    await waitFor(() => {
      expect(upsertMachine).toHaveBeenCalledWith({ label: 'mac', url: 'http://127.0.0.1:3082' })
    })
  })

  it('probes and removes machines', async () => {
    const probe = vi.fn(async () => {})
    const removeMachine = vi.fn(async () => {})
    render(<RemoteHostsCard {...card({
      listMachines: vi.fn(async () => [
        { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
      ]),
      probe,
      removeMachine,
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'action.probe' }))
    await waitFor(() => { expect(probe).toHaveBeenCalledWith('gpu') })
    fireEvent.click(screen.getByRole('button', { name: 'action.remove' }))
    await waitFor(() => { expect(removeMachine).toHaveBeenCalledWith('gpu') })
  })

  it('surfaces failures as the generic error', async () => {
    render(<RemoteHostsCard {...card({ listMachines: vi.fn(async () => { throw new Error('down') }) })} />)
    expect(await screen.findByText('error')).toBeTruthy()
    cleanup()
    const upsertMachine = vi.fn(async () => { throw new Error('down') })
    render(<RemoteHostsCard {...card({ upsertMachine })} />)
    const [label, url] = screen.getAllByRole('textbox')
    fireEvent.change(label as HTMLElement, { target: { value: 'x' } })
    fireEvent.change(url as HTMLElement, { target: { value: 'http://127.0.0.1:1' } })
    fireEvent.click(screen.getByRole('button', { name: 'add.machine' }))
    expect(await screen.findByText('error')).toBeTruthy()
    cleanup()
    const probe = vi.fn(async () => { throw new Error('down') })
    const removeMachine = vi.fn(async () => { throw new Error('down') })
    render(<RemoteHostsCard {...card({
      listMachines: vi.fn(async () => [
        { id: MachineId('gpu'), label: 'gpu-box', url: 'http://127.0.0.1:3081', status: 'unknown' as const },
      ]),
      probe,
      removeMachine,
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'action.probe' }))
    expect(await screen.findByText('error')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'action.remove' }))
    await waitFor(() => { expect(removeMachine).toHaveBeenCalled() })
  })
})
