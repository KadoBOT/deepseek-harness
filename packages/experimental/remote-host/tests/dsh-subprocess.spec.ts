import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DshSubprocessRuntime } from '../src/dsh-subprocess.ts'

function runtimeFor(handler: (endpoint: string, args: Record<string, unknown>) => unknown): {
  runtime: DshSubprocessRuntime
  calls: Array<{ endpoint: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  const service = {
    requireHost: () => ({ id: 'm', label: 'm', url: 'http://127.0.0.1:3081' }),
    client: () => ({
      call: async <T>(endpoint: string, args: Record<string, unknown>): Promise<T> => {
        calls.push({ endpoint, args })
        return handler(endpoint, args) as T
      },
    }),
  }
  const ctx = new Context().isolate('subprocess', Symbol('test'))
  return { runtime: new DshSubprocessRuntime(ctx, service as never, 'm'), calls }
}

function collectSpec(stdin: 'ignore' | { data: string } = 'ignore'): {
  argv: ['echo', 'hi']
  cwd: string
  stdio: { stdin: typeof stdin; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
  graceMs: number
} {
  return {
    argv: ['echo', 'hi'],
    cwd: '/home/app',
    stdio: { stdin, stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
    graceMs: 1000,
  }
}

function execResult(stdout = 'hi\n', stderr = '', exitCode: number | null = 0): {
  stdoutB64: string
  stderrB64: string
  exitCode: number | null
} {
  return {
    stdoutB64: Buffer.from(stdout, 'utf8').toString('base64'),
    stderrB64: Buffer.from(stderr, 'utf8').toString('base64'),
    exitCode,
  }
}

describe('DshSubprocessRuntime', () => {
  it('resolves executables and rejects empty names', async () => {
    const { runtime, calls } = runtimeFor(() => '/usr/bin/echo')
    await expect(runtime.resolveExecutable('')).rejects.toThrow(/non-empty/)
    expect(await runtime.resolveExecutable('echo', { PATH: '/usr/bin' })).toBe('/usr/bin/echo')
    expect(calls[0]).toMatchObject({ endpoint: 'remoteHosts/localWhich', args: { command: 'echo', path: '/usr/bin' } })
    const { runtime: plain } = runtimeFor(() => '/usr/bin/echo')
    await plain.resolveExecutable('echo')
  })

  it('spawns collect-mode commands and exposes buffered readers', async () => {
    const { runtime, calls } = runtimeFor(() => execResult('hi\n', 'warn\n', 0))
    const handle = runtime.spawn(collectSpec())
    expect(handle.pid).toBe(0)
    expect(handle.stdin).toBeUndefined()
    expect(handle.stdout).toBeUndefined()
    expect(handle.stderr).toBeUndefined()
    const outcome = await handle.done
    expect(outcome).toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('hi\n')
    expect(handle.collected.stderr?.readFrom(0).text).toBe('warn\n')
    expect(handle.collected.stdout?.readFrom(1)).toMatchObject({ text: 'i\n', nextOffset: 3, lossy: false })
    expect(calls[0]).toMatchObject({ endpoint: 'remoteHosts/localExec', args: { cwd: '/home/app', argv: ['echo', 'hi'] } })
    expect(await handle.waitForExit()).toBe(true)
    const controller = new AbortController()
    controller.abort()
    expect(await handle.waitForExit(controller.signal)).toBe(false)
  })

  it('marks terminated handles and forwards stdin data and env', async () => {
    let resolveExec: ((value: ReturnType<typeof execResult>) => void) | undefined
    const gate = new Promise<ReturnType<typeof execResult>>((resolve) => { resolveExec = resolve })
    const { runtime, calls } = runtimeFor(() => gate)
    const handle = runtime.spawn({
      ...collectSpec({ data: 'in' }),
      env: { FOO: 'bar' },
    })
    handle.terminate()
    resolveExec?.(execResult('', '', 143))
    const outcome = await handle.done
    expect(outcome).toEqual({ exitCode: 143, signal: 'SIGTERM' })
    expect(calls[0]?.args).toMatchObject({ env: { FOO: 'bar' }, stdinData: 'in' })
  })

  it('rejects piped stdin, empty argv, and terminals', async () => {
    const { runtime } = runtimeFor(() => execResult())
    expect(() => runtime.spawn({
      argv: ['echo'],
      cwd: '/',
      stdio: { stdin: 'pipe', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
      graceMs: 10,
    })).toThrow(/piped stdin/)
    expect(() => runtime.spawn({
      argv: [],
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
      graceMs: 10,
    })).toThrow(/non-empty program/)
    await expect(runtime.spawnTerminal({
      argv: ['bash'],
      cwd: '/',
      env: {},
      rows: 24,
      cols: 80,
      graceMs: 10,
    })).rejects.toThrow(/spawnTerminal/)
  })

  it('exposes piped streams as empty readers', async () => {
    const { runtime } = runtimeFor(() => execResult('x', '', 0))
    const handle = runtime.spawn({
      argv: ['echo'],
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 10,
    })
    expect(handle.stdout).not.toBeUndefined()
    expect(handle.stderr).not.toBeUndefined()
    expect(handle.collected.stdout).toBeUndefined()
    await handle.done
  })
})
