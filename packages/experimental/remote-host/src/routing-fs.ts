/**
 * Host-plane `ctx.fs` that dispatches by the initiator session's `machineId`.
 * Local sessions keep the sandboxed host filesystem.
 */

import type {} from '@deepseek-ai/dsh-agent'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { DshFileSystem } from './dsh-fs.ts'

/** Routing filesystem registered as the process-global `ctx.fs`. */
export class RoutingFileSystem extends FileSystem {
  static inject = ['agents', 'remoteHosts']

  private readonly remote = new Map<string, DshFileSystem>()

  override get sandboxMode(): SandboxMode | undefined {
    return this.ctx.remoteHosts.localFileSystem.sandboxMode
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.backend().resolve(path, opts)
  }

  override processPath(target: FsTarget): string {
    return this.backend().processPath(target)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return this.backend().processPathFromHostPath(hostPath)
  }

  override fileUrl(target: FsTarget): string {
    return this.backend().fileUrl(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return this.backend().contains(parent, child)
  }

  override stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.backend().stat(target, signal)
  }

  override lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.backend().lstat(path, opts, signal)
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.backend().readText(target, signal)
  }

  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.backend().readBytes(target, signal, maxBytes)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.backend().streamText(target, signal)
  }

  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.backend().listDir(target, signal)
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.backend().writeText(target, content, expected, signal, sandboxPolicy)
  }

  override editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.backend().editText(target, edit, expected, signal, sandboxPolicy)
  }

  private backend(): FileSystem {
    const machineId = this.ctx.agents.currentInitiator()?.session.header.machineId
    if (machineId === undefined) return this.ctx.remoteHosts.localFileSystem
    let remote = this.remote.get(machineId)
    if (remote === undefined) {
      remote = new DshFileSystem(this.ctx.isolate('fs', Symbol(machineId)), this.ctx.remoteHosts, machineId)
      this.remote.set(machineId, remote)
    }
    return remote
  }
}
