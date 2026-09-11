/**
 * Host-plane `ctx.shell` that dispatches by the initiator session's `machineId`.
 * Local sessions keep the mounted local executor (including its sandbox
 * confinement); remote sessions run `bash -c` on the remote machine through
 * the routed `ctx.subprocess` with no local seatbelt/bwrap confinement.
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'

/** Plugin config: remote defaults mirror the local bash executor knobs. */
export type Config = LocalConfig

/**
 * Routing shell registered as the process-global `ctx.shell`.
 * @param ctx - Host context providing agents, remoteHosts, and routed subprocess.
 * @param config - Remote defaults for timeouts and output caps.
 */
export class RoutingShellExecutor extends ShellExecutor {
  static inject = ['agents', 'remoteHosts', 'subprocess']

  static Config = LocalBashExecutor.Config

  private readonly remoteInner: LocalBashExecutor

  /** @param ctx - Host context. @param config - Remote executor defaults. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const resolved = LocalBashExecutor.Config(config)
    const innerCtx = ctx
      .isolate('shell', Symbol('remote'))
      .isolate('settings', Symbol('remote-settings'))
    this.remoteInner = new LocalBashExecutor(innerCtx, resolved)
  }

  /** Local confinement fact; remote sessions bypass confinement so this reports the local default. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.ctx.remoteHosts.localShell.sandboxMode
  }

  /**
   * Resolve a request, defaulting remote workdir from the session cwd verbatim.
   * @param request - Caller request with optional workdir.
   * @returns Fully-specified spec with an explicit remote or local workdir.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const machineId = this.ctx.agents.currentInitiator()?.session.header.machineId
    if (machineId === undefined) return this.ctx.remoteHosts.localShell.resolve(request)
    if (request.workdir !== undefined) return this.remoteInner.resolve(request)
    const headerCwd = this.ctx.agents.currentInitiator()?.session.header.cwd
    if (headerCwd === undefined || headerCwd.trim().length === 0) {
      throw new Error('remote-host: remote shell requires an explicit workdir or session cwd')
    }
    return this.remoteInner.resolve({ ...request, workdir: headerCwd })
  }

  /**
   * Run a command on the owning world.
   * @param spec - Resolved spec from {@link resolve}.
   * @returns Settled foreground result.
   */
  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const machineId = this.ctx.agents.currentInitiator()?.session.header.machineId
    if (machineId === undefined) return this.ctx.remoteHosts.localShell.run(spec)
    return this.remoteInner.run(spec)
  }

  /**
   * Start a background process on the owning world.
   * @param spec - Resolved spec from {@link resolve}.
   * @returns Live background handle.
   */
  override start(spec: ShellExecSpec): ShellProcess {
    const machineId = this.ctx.agents.currentInitiator()?.session.header.machineId
    if (machineId === undefined) return this.ctx.remoteHosts.localShell.start(spec)
    return this.remoteInner.start(spec)
  }
}
