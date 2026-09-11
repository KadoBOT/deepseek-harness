import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteHostService } from '../src/service.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

async function service(): Promise<RemoteHostService> {
  const ctx = new Context()
  ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
  await ctx.plugin(RemoteHostService, { hosts: [] })
  return ctx.remoteHosts
}

describe('RemoteHostService local gateway', () => {
  it('serves home, directories, and file content', async () => {
    const svc = await service()
    expect((await svc.localHome()).length).toBeGreaterThan(0)
    const dir = await scratch({ 'b.txt': 'b', 'a.txt': 'a' })
    await mkdir(join(dir, 'sub'))
    const rows = await svc.localListDir({ path: dir })
    expect(rows.map(row => row.name)).toEqual(['a.txt', 'b.txt', 'sub'])
    expect(rows.find(row => row.name === 'sub')).toMatchObject({ type: 'directory' })
    const dirsOnly = await svc.localListDir({ path: dir, dirsOnly: true })
    expect(dirsOnly.map(row => row.name)).toEqual(['sub'])
  })

  it('canonicalizes, stats, and versions paths', async () => {
    const svc = await service()
    const dir = await scratch({ 'f.txt': 'hello' })
    const canonicalDir = await realpath(dir)
    expect(await svc.localRealpath({ path: join(dir, 'sub', '..', 'f.txt') })).toBe(join(canonicalDir, 'f.txt'))
    expect(await svc.localRealpath({ path: join(dir, 'missing.txt') })).toBe(join(dir, 'missing.txt'))
    expect(await svc.localStat({ path: join(dir, 'f.txt') })).toMatchObject({ type: 'file', size: 5 })
    expect(await svc.localStat({ path: dir })).toMatchObject({ type: 'directory' })
    expect(await svc.localStat({ path: join(dir, 'missing.txt') })).toBeNull()
    const version = await svc.localVersion({ path: join(dir, 'f.txt') })
    expect(typeof version).toBe('string')
    expect(await svc.localVersion({ path: join(dir, 'missing.txt') })).toBeNull()
  })

  it('reads and atomically writes files', async () => {
    const svc = await service()
    const dir = await scratch({ 'f.txt': 'old' })
    expect(Buffer.from(await svc.localRead({ path: join(dir, 'f.txt') }), 'base64').toString('utf8')).toBe('old')
    const stat = await svc.localWrite({
      path: join(dir, 'new', 'n.txt'),
      contentB64: Buffer.from('new', 'utf8').toString('base64'),
    })
    expect(stat).toMatchObject({ type: 'file', size: 3 })
    await expect(svc.localRead({ path: join(dir, 'missing.txt') })).rejects.toThrow()
  })

  it('resolves executables and buffers command output', async () => {
    const svc = await service()
    const resolved = await svc.localWhich({ command: 'sh', path: '/usr/bin:/bin' })
    expect(resolved.endsWith('/sh')).toBe(true)
    await expect(svc.localWhich({ command: 'definitely-not-a-binary', path: '/usr/bin:/bin' })).rejects.toMatchObject({
      code: 'remote-host/invalid-path',
    })
    await expect(svc.localExec({ cwd: '/tmp', argv: [] })).rejects.toThrow(/non-empty/)
    const ok = await svc.localExec({ cwd: '/tmp', argv: [process.execPath, '-e', 'process.stdout.write("o");process.stderr.write("e")'] })
    expect(Buffer.from(ok.stdoutB64, 'base64').toString('utf8')).toBe('o')
    expect(Buffer.from(ok.stderrB64, 'base64').toString('utf8')).toBe('e')
    expect(ok.exitCode).toBe(0)
    const missing = svc.localExec({ cwd: '/tmp', argv: ['/definitely/not/here'] })
    await expect(missing).rejects.toThrow()
  })

  it('lists directories and validates workspaces through the gateway client', async () => {
    const ctx = new Context()
    const createAt = vi.fn(async (input: { path: string }) => ({
      id: 'ws',
      path: input.path,
      title: 'ws',
      machineId: 'gpu',
      machineLabel: 'gpu-box',
    }))
    ctx.provide('workspaceRegistry', { createAt } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    const dir = await scratch({ 'f.txt': 'x' })
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(endpoint: string): Promise<T> => {
        if (endpoint === 'remoteHosts/localHome') return '/home/gpu' as T
        if (endpoint === 'remoteHosts/localListDir') {
          return [{ name: 'app', path: '/home/gpu/app' }] as T
        }
        if (endpoint === 'remoteHosts/localRealpath') return dir as T
        if (endpoint === 'remoteHosts/localStat') {
          return { type: 'directory', version: 'v1', size: 0 } as T
        }
        throw new Error(`unexpected ${endpoint}`)
      },
    }) as never
    expect(await ctx.remoteHosts.listDirectory({ machineId: 'gpu' })).toEqual({
      path: '/home/gpu',
      entries: [{ name: 'app', path: '/home/gpu/app' }],
    })
    expect(await ctx.remoteHosts.listDirectory({ machineId: 'gpu', path: '  /home/gpu  ' })).toMatchObject({
      path: '/home/gpu',
    })
    const created = await ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: dir, title: '  app  ' })
    expect(created).toMatchObject({ path: dir, machineId: 'gpu', machineLabel: 'gpu-box', title: 'ws' })
    await expect(ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: 'relative' })).rejects.toMatchObject({
      code: 'remote-host/invalid-path',
    })
  })

  it('rejects non-directory workspace paths', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    const dir = await scratch({ 'f.txt': 'x' })
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(endpoint: string, args: { path: string }): Promise<T> => {
        if (endpoint === 'remoteHosts/localRealpath') return args.path as T
        return { type: 'file', version: 'v1', size: 1 } as T
      },
    }) as never
    await expect(ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: dir })).rejects.toMatchObject({
      code: 'remote-host/invalid-path',
    })
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(): Promise<T> => null as T,
    }) as never
    await expect(ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: dir })).rejects.toMatchObject({
      code: 'remote-host/invalid-path',
    })
  })

  it('exposes local backends, clients, and lookups', async () => {
    const svc = await service()
    expect(() => svc.requireHost('nope')).toThrow(/no machine/)
    expect(svc.client({ id: 'x' as never, label: 'x', url: 'http://127.0.0.1:3081' }).constructor.name).toBe('DshGatewayClient')
    // localExecution without bindLocalExecution fails loud.
    expect(() => svc.localFileSystem).toThrow(/not mounted/)
    expect(() => svc.localSubprocess).toThrow(/not mounted/)
    expect(() => svc.localShell).toThrow(/not mounted/)
  })

  it('normalizes upserted auth credentials', async () => {
    const svc = await service()
    const blank = await svc.upsertMachine({ label: 'a', url: 'http://127.0.0.1:3081', auth: '   ' })
    expect(blank).not.toHaveProperty('auth')
    const kept = await svc.upsertMachine({ label: 'b', url: 'http://127.0.0.1:3082', auth: '  tok  ' })
    expect(kept.auth).toBe('tok')
  })
})

describe('RemoteHostService secondary execution edges', () => {
  it('rejects non-http discovery urls and honors modes and path fallbacks', async () => {
    const svc = await service()
    await expect(svc.upsertDiscovered({ label: 'x', url: 'ftp://files/x' })).rejects.toMatchObject({
      code: 'remote-host/invalid-config',
    })
    const dir = await scratch({ 'f.txt': 'hello' })
    const stat = await svc.localWrite({
      path: join(dir, 'm.txt'),
      contentB64: Buffer.from('m', 'utf8').toString('base64'),
      mode: 0o644,
    })
    expect(stat.type).toBe('file')
    await mkdir(join(dir, 'mycmd'))
    await expect(svc.localWhich({ command: 'mycmd', path: `:/nonexistent:${dir}` })).rejects.toMatchObject({
      code: 'remote-host/invalid-path',
    })
    expect(await svc.localWhich({ command: 'sh' })).toContain('/sh')
  })
})

describe('RemoteHostService listing edges', () => {
  it('marks links as other and defaults untitled workspaces', async () => {
    const svc = await service()
    const dir = await scratch({ 'f.txt': 'hello' })
    const { symlink } = await import('node:fs/promises')
    await symlink(join(dir, 'f.txt'), join(dir, 'link.txt'))
    const rows = await svc.localListDir({ path: dir })
    expect(rows.find(row => row.name === 'link.txt')).toMatchObject({ type: 'other' })

    const ctx = new Context()
    const createAt = vi.fn(async (input: { path: string; title?: string }) => ({
      id: 'ws',
      path: input.path,
      title: input.title ?? 'fallback',
      machineId: 'gpu',
      machineLabel: 'gpu-box',
    }))
    ctx.provide('workspaceRegistry', { createAt } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(endpoint: string): Promise<T> => {
        if (endpoint === 'remoteHosts/localRealpath') return dir as T
        return { type: 'directory', version: 'v1', size: 0 } as T
      },
    }) as never
    await ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: dir })
    expect(createAt).toHaveBeenCalledWith(
      expect.objectContaining({ path: dir, machineId: 'gpu', machineLabel: 'gpu-box' }),
    )
    expect(createAt.mock.calls[0]?.[0]).not.toHaveProperty('title')
  })
})

describe('RemoteHostService title edges', () => {
  it('omits blank workspace titles', async () => {
    const ctx = new Context()
    const createAt = vi.fn(async (input: { path: string }) => ({
      id: 'ws',
      path: input.path,
      title: 'ws',
      machineId: 'gpu',
      machineLabel: 'gpu-box',
    }))
    ctx.provide('workspaceRegistry', { createAt } as never)
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(endpoint: string): Promise<T> => {
        if (endpoint === 'remoteHosts/localRealpath') return '/home/app' as T
        return { type: 'directory', version: 'v1', size: 0 } as T
      },
    }) as never
    await ctx.remoteHosts.createWorkspace({ machineId: 'gpu', path: '/home/app', title: '   ' })
    expect(createAt.mock.calls[0]?.[0]).not.toHaveProperty('title')
  })
})

describe('RemoteHostService path fallback', () => {
  it('throws when no search path exists at all', async () => {
    const svc = await service()
    const saved = process.env.PATH
    delete process.env.PATH
    try {
      await expect(svc.localWhich({ command: 'sh' })).rejects.toMatchObject({ code: 'remote-host/invalid-path' })
    } finally {
      process.env.PATH = saved
    }
  })
})
