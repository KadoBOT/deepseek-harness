/**
 * Host-plane `ctx.subprocess` that dispatches by the initiator session's `machineId`.
 */

import type {} from '@deepseek-ai/dsh-agent'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { DshSubprocessRuntime } from './dsh-subprocess.ts'

/** Routing subprocess registered as the process-global `ctx.subprocess`. */
export class RoutingSubprocessRuntime extends SubprocessRuntime {
  static inject = ['agents', 'remoteHosts']

  private readonly remote = new Map<string, DshSubprocessRuntime>()

  /** @inheritdoc */
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.backend().resolveExecutable(command, env, signal)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.backend().spawn(spec)
  }

  /** @inheritdoc */
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return this.backend().spawnTerminal(spec)
  }

  private backend(): SubprocessRuntime {
    const machineId = this.ctx.agents.currentInitiator()?.session.header.machineId
    if (machineId === undefined) return this.ctx.remoteHosts.localSubprocess
    let remote = this.remote.get(machineId)
    if (remote === undefined) {
      remote = new DshSubprocessRuntime(
        this.ctx.isolate('subprocess', Symbol(machineId)),
        this.ctx.remoteHosts,
        machineId,
      )
      this.remote.set(machineId, remote)
    }
    return remote
  }
}
