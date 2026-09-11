/**
 * Subprocess backend over a secondary `dsh web` gateway. Buffered exec only;
 * the remote OS user is the confinement boundary. Interactive PTY is deferred.
 */

import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteHostService } from './service.ts'

function readerFor(box: { text: string }): SubprocessOutputReader {
  return {
    readFrom(fromByte: number) {
      const bytes = Buffer.byteLength(box.text)
      const slice = Buffer.from(box.text, 'utf8').subarray(fromByte).toString('utf8')
      return { text: slice, nextOffset: bytes, lossy: false }
    },
  }
}

/** DSH subprocess for one configured machine. Registers as `ctx.subprocess` on an isolated realm. */
export class DshSubprocessRuntime extends SubprocessRuntime {
  /**
   * @param ctx - Isolated context whose `subprocess` key this instance owns.
   * @param hosts - Machine registry and gateway client factory.
   * @param machineId - Configured machine identity.
   */
  constructor(
    ctx: Context,
    private readonly hosts: RemoteHostService,
    private readonly machineId: string,
  ) {
    super(ctx)
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('remote-host: executable name must be non-empty')
    const host = this.hosts.requireHost(this.machineId)
    return await this.hosts.client(host).call<string>(
      'remoteHosts/localWhich',
      { command, ...env?.PATH === undefined ? {} : { path: env.PATH } },
      signal,
    )
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    if (spec.stdio.stdin === 'pipe') {
      throw new Error('remote DSH sessions do not support piped stdin in v1; use { data } or ignore')
    }
    const host = this.hosts.requireHost(this.machineId)
    const stdinData = typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined
    let terminated = false
    const stdoutBox = { text: '' }
    const stderrBox = { text: '' }
    const collected: SubprocessHandle['collected'] = {
      ...typeof spec.stdio.stdout === 'object' ? { stdout: readerFor(stdoutBox) } : {},
      ...typeof spec.stdio.stderr === 'object' ? { stderr: readerFor(stderrBox) } : {},
    }
    const done: Promise<SubprocessOutcome> = (async () => {
      const result = await this.hosts.client(host).call<{ stdoutB64: string; stderrB64: string; exitCode: number | null }>(
        'remoteHosts/localExec',
        {
          cwd: spec.cwd,
          argv: [...spec.argv],
          ...spec.env === undefined ? {} : { env: spec.env },
          ...stdinData === undefined ? {} : { stdinData },
        },
        spec.signal,
      )
      stdoutBox.text = Buffer.from(result.stdoutB64, 'base64').toString('utf8')
      stderrBox.text = Buffer.from(result.stderrB64, 'base64').toString('utf8')
      return { exitCode: result.exitCode, signal: terminated ? 'SIGTERM' : null }
    })()
    const handle: SubprocessHandle = {
      pid: 0,
      stdin: undefined,
      stdout: spec.stdio.stdout === 'pipe' ? Readable.from([]) : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? Readable.from([]) : undefined,
      collected,
      done,
      terminate: () => { terminated = true },
      waitForExit: async (signal?: AbortSignal) => {
        if (signal?.aborted === true) return false
        await done
        return true
      },
    }
    return handle
  }

  /**
   * Interactive remote PTY is not implemented in v1.
   * @param spec - unused terminal request.
   * @returns never; always rejects.
   */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    void spec
    throw new Error('remote DSH sessions do not support spawnTerminal in v1')
  }
}
