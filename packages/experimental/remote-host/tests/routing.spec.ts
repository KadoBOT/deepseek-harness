import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { FileSystem, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { bindLocalExecution, RemoteHostService } from '../src/service.ts'
import { DshGatewayClient } from '../src/dsh-client.ts'
import { RoutingFileSystem } from '../src/routing-fs.ts'
import { RoutingShellExecutor } from '../src/routing-shell.ts'
import { RoutingSubprocessRuntime } from '../src/routing-subprocess.ts'

class FakeFileSystem extends FileSystem {
  readonly resolved: string[] = []

  override async resolve(path: string): Promise<FsTarget> {
    this.resolved.push(path)
    return { targetKey: FsTargetKey(`/local${path}`), displayPath: path }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file://${this.processPath(target)}`
  }

  override contains(): boolean {
    return false
  }

  override async stat(): Promise<undefined> {
    return undefined
  }

  override async lstat(): Promise<undefined> {
    return undefined
  }

  override async readText(): Promise<string> {
    return ''
  }

  override async streamText(): Promise<AsyncIterable<string>> {
    return { async *[Symbol.asyncIterator]() { yield '' } }
  }

  override async readBytes(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  override async listDir(): Promise<never[]> {
    return []
  }

  override async writeText(): Promise<never> {
    throw new Error('unused')
  }

  override async editText(): Promise<never> {
    throw new Error('unused')
  }
}

function fakeSubprocess(): SubprocessRuntime & { spawned: SubprocessSpawnSpec[] } {
  const spawned: SubprocessSpawnSpec[] = []
  return {
    spawned,
    resolveExecutable: async (command: string) => command,
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      spawned.push(spec)
      return {
        pid: 1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: undefined,
        terminate() {},
        waitForExit: async () => {},
        done: Promise.resolve({ exitCode: 0, signal: null }),
      } as unknown as SubprocessHandle
    },
    spawnTerminal: async () => {
      throw new Error('unused')
    },
  } as unknown as SubprocessRuntime & { spawned: SubprocessSpawnSpec[] }
}

describe('routing', () => {
  it('uses the local backend when the initiator has no machineId', async () => {
    const ctx = new Context()
    const local = new FakeFileSystem(ctx.isolate('fs'))
    const subprocess = fakeSubprocess()
    const shell = new LocalBashExecutor(ctx.isolate('shell', Symbol('local')), {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
      maxSpillBytes: 64,
      graceMs: 100,
    })
    bindLocalExecution(ctx.root, { fs: local, subprocess, shell: shell as ShellExecutor })
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', { currentInitiator: () => undefined })
    await ctx.plugin(RemoteHostService, { hosts: [] })
    await ctx.plugin(RoutingFileSystem)
    await ctx.plugin(RoutingSubprocessRuntime)
    await ctx.plugin(RoutingShellExecutor, {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
      maxSpillBytes: 64,
      graceMs: 100,
    })
    await ctx.fs.resolve('/tmp/local')
    expect(local.resolved).toEqual(['/tmp/local'])
    ctx.subprocess.spawn({
      argv: ['echo', 'hi'],
      cwd: '/tmp',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16 }, stderr: { maxBytes: 16 } },
      graceMs: 1000,
    })
    expect(subprocess.spawned).toHaveLength(1)
    expect(subprocess.spawned[0]?.argv).toEqual(['echo', 'hi'])
    const spec = ctx.shell.resolve({ command: 'echo hi', workdir: '/tmp' })
    expect(spec.workdir).toBe('/tmp')
  })

  it('uses the secondary DSH gateway when the initiator session carries machineId', async () => {
    const ctx = new Context()
    const local = new FakeFileSystem(ctx.isolate('fs'))
    const subprocess = fakeSubprocess()
    const shell = new LocalBashExecutor(ctx.isolate('shell', Symbol('local')), {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
      maxSpillBytes: 64,
      graceMs: 100,
    })
    bindLocalExecution(ctx.root, { fs: local, subprocess, shell: shell as ShellExecutor })
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { header: { machineId: 'gpu', cwd: '/home/app' } } }),
    })
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    const endpoints: string[] = []
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(endpoint: string): Promise<T> => {
        endpoints.push(endpoint)
        if (endpoint === 'remoteHosts/localRealpath') return '/home/app' as T
        if (endpoint === 'remoteHosts/localStat') {
          return { type: 'directory', version: '1', size: 0 } as T
        }
        if (endpoint === 'remoteHosts/localExec') {
          return {
            stdoutB64: Buffer.from('hi\n').toString('base64'),
            stderrB64: Buffer.from('').toString('base64'),
            exitCode: 0,
          } as T
        }
        throw new Error(`unexpected endpoint ${endpoint}`)
      },
    }) as DshGatewayClient
    await ctx.plugin(RoutingFileSystem)
    await ctx.plugin(RoutingSubprocessRuntime)
    await ctx.plugin(RoutingShellExecutor, {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
      maxSpillBytes: 64,
      graceMs: 100,
    })
    const target = await ctx.fs.resolve('/home/app')
    expect(local.resolved).toEqual([])
    expect(String(target.targetKey)).toBe('/home/app')
    expect(endpoints).toContain('remoteHosts/localRealpath')
    const handle = ctx.subprocess.spawn({
      argv: ['uname', '-a'],
      cwd: '/home/app',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16 }, stderr: { maxBytes: 16 } },
      graceMs: 1000,
    })
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    expect(endpoints).toContain('remoteHosts/localExec')
    const spec = ctx.shell.resolve({ command: 'uname -a' })
    expect(spec.workdir).toBe('/home/app')
    const explicit = ctx.shell.resolve({ command: 'uname -a', workdir: '/home/app/sub' })
    expect(explicit.workdir).toBe('/home/app/sub')
  })
})

describe('remote delegation', () => {
  async function remoteWorld(cwd: string | undefined): Promise<{
    ctx: Context
    calls: Array<{ endpoint: string; args: Record<string, unknown> }>
  }> {
    const ctx = new Context()
    const local = new FakeFileSystem(ctx.isolate('fs'))
    const subprocess = fakeSubprocess()
    const shell = new LocalBashExecutor(ctx.isolate('shell', Symbol('local')), {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 1024,
      maxSpillBytes: 1024,
      graceMs: 100,
    })
    bindLocalExecution(ctx.root, { fs: local, subprocess, shell: shell as ShellExecutor })
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { header: { machineId: 'gpu', ...cwd === undefined ? {} : { cwd } } } }),
    })
    await ctx.plugin(RemoteHostService, {
      hosts: [{ id: 'gpu', label: 'gpu-box', url: 'http://127.0.0.1:3081' }],
    })
    const store = new Map<string, { type: string; content: Buffer; version: string }>([
      ['/home/app', { type: 'directory', content: Buffer.of(), version: 'vd' }],
      ['/home/app/f.txt', { type: 'file', content: Buffer.from('hi', 'utf8'), version: 'v1' }],
    ])
    const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
    ctx.remoteHosts.internals.clientFactory = () => ({
      call: async <T>(endpoint: string, args: Record<string, unknown>): Promise<T> => {
        calls.push({ endpoint, args })
        const path = args['path'] as string
        switch (endpoint) {
          case 'remoteHosts/localRealpath':
            return path as T
          case 'remoteHosts/localStat': {
            const entry = store.get(path)
            if (entry === undefined) return null as T
            return { type: entry.type, version: entry.version, size: entry.content.length } as T
          }
          case 'remoteHosts/localListDir':
            return [{ name: 'f.txt', path: '/home/app/f.txt', type: 'file', version: 'v1', size: 2 }] as T
          case 'remoteHosts/localRead':
            return store.get(path)?.content.toString('base64') as T
          case 'remoteHosts/localWrite': {
            const content = Buffer.from(args['contentB64'] as string, 'base64')
            store.set(path, { type: 'file', content, version: 'v2' })
            return { type: 'file', version: 'v2', size: content.length } as T
          }
          case 'remoteHosts/localWhich':
            return `/usr/bin/${String((args as { command: string }).command)}` as T
          case 'remoteHosts/localExec':
            return {
              stdoutB64: Buffer.from('hi\n').toString('base64'),
              stderrB64: Buffer.from('').toString('base64'),
              exitCode: 0,
            } as T
          default:
            throw new Error(`unexpected endpoint ${endpoint}`)
        }
      },
    }) as DshGatewayClient
    await ctx.plugin(RoutingFileSystem)
    await ctx.plugin(RoutingSubprocessRuntime)
    await ctx.plugin(RoutingShellExecutor, {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 1024,
      maxSpillBytes: 1024,
      graceMs: 100,
    })
    return { ctx, calls }
  }

  it('routes every filesystem method to the secondary', async () => {
    const { ctx } = await remoteWorld('/home/app')
    expect(ctx.fs.sandboxMode).toBeUndefined()
    const dir = await ctx.fs.resolve('/home/app')
    expect(String(dir.targetKey)).toBe('/home/app')
    expect(ctx.fs.processPath(dir)).toBe('/home/app')
    expect(ctx.fs.processPathFromHostPath('/host/x')).toBeUndefined()
    expect(ctx.fs.fileUrl(dir)).toBe('file:///home/app')
    expect(ctx.fs.contains(dir, dir)).toBe(true)
    expect(await ctx.fs.stat(dir)).toMatchObject({ type: 'directory' })
    expect(await ctx.fs.lstat('/home/app', { cwd: '/' })).toMatchObject({ type: 'directory' })
    const file = await ctx.fs.resolve('/home/app/f.txt')
    expect(await ctx.fs.readText(file)).toBe('hi')
    expect((await ctx.fs.readBytes(file, undefined, 64)).length).toBe(2)
    for await (const _chunk of await ctx.fs.streamText(file)) break
    expect(await ctx.fs.listDir(dir)).toHaveLength(1)
    const written = await ctx.fs.writeText(file, 'hello')
    expect(written.after).toBe('hello')
    const edited = await ctx.fs.editText(file, { oldString: 'hello', newString: 'bye' })
    expect(edited.after).toBe('bye')
  })

  it('routes subprocess and shell execution to the secondary', async () => {
    const { ctx } = await remoteWorld('/home/app')
    expect(await ctx.subprocess.resolveExecutable('echo')).toBe('/usr/bin/echo')
    const handle = ctx.subprocess.spawn({
      argv: ['echo', 'hi'],
      cwd: '/home/app',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
      graceMs: 1000,
    })
    expect((await handle.done).exitCode).toBe(0)
    await expect(ctx.subprocess.spawnTerminal({
      argv: ['bash'],
      cwd: '/home/app',
      env: {},
      rows: 24,
      cols: 80,
      graceMs: 100,
    })).rejects.toThrow(/spawnTerminal/)
    expect(ctx.shell.sandboxMode).toBeUndefined()
    expect(ctx.shell.resolve({ command: 'echo hi' }).workdir).toBe('/home/app')
    expect(ctx.shell.resolve({ command: 'echo hi', workdir: '/tmp' }).workdir).toBe('/tmp')
    const result = await ctx.shell.run(ctx.shell.resolve({ command: 'echo hi' }))
    expect(result.stdout.text).toBe('hi\n')
    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'echo hi' }))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.readOutput().delta).toBe('hi\n')
  })

  it('requires a workdir for remote shells without session cwd', async () => {
    const { ctx } = await remoteWorld(undefined)
    expect(() => ctx.shell.resolve({ command: 'echo hi' })).toThrow(/explicit workdir or session cwd/)
    expect(ctx.shell.resolve({ command: 'echo hi', workdir: '/tmp' }).workdir).toBe('/tmp')
  })
})

describe('local shell passthrough', () => {
  it('runs and starts commands on the local backend without a machineId', async () => {
    const ctx = new Context()
    const local = new FakeFileSystem(ctx.isolate('fs'))
    const subprocess = fakeSubprocess()
    const shell = new LocalBashExecutor(ctx.isolate('shell', Symbol('local')), {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
      maxSpillBytes: 64,
      graceMs: 100,
    })
    bindLocalExecution(ctx.root, { fs: local, subprocess, shell: shell as ShellExecutor })
    ctx.provide('workspaceRegistry', { createAt: vi.fn() } as never)
    ctx.provide('agents', { currentInitiator: () => undefined })
    await ctx.plugin(RemoteHostService, { hosts: [] })
    await ctx.plugin(RoutingFileSystem)
    await ctx.plugin(RoutingSubprocessRuntime)
    await ctx.plugin(RoutingShellExecutor, {
      timeoutMs: 1000,
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
      maxSpillBytes: 64,
      graceMs: 100,
    })
    // The fake subprocess drops collect streams, so the local run rejects and start throws through the executor.
    await expect(ctx.shell.run(ctx.shell.resolve({ command: 'echo hi', workdir: '/tmp' }))).rejects.toThrow()
    expect(() => ctx.shell.start(ctx.shell.resolve({ command: 'echo hi', workdir: '/tmp' }))).toThrow(
      /stdout/,
    )
  })
})
