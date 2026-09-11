/** Host registry, DSH directory listing, and remote Workspace adoption. */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { promises as fs, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-settings'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Config, REMOTE_HOSTS_NS, validateHosts } from './config.ts'
import { DshGatewayClient, isRemoteAbsolute, normalizeBaseUrl } from './dsh-client.ts'
import { RemoteError } from './errors.ts'
import { MachineId } from './types.ts'
import type {
  Config as HostsConfig,
  CreateRemoteWorkspaceRequest,
  CreateRemoteWorkspaceValue,
  HostRecord,
  ListDirectoryRequest,
  MachineView,
  RemoteDirectoryListing,
  RemoveMachineRequest,
  UpsertMachineRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteHosts: RemoteHostService
  }
}

/** Factory for secondary gateway clients (test hook). */
export type DshClientFactory = (host: HostRecord) => DshGatewayClient

type WorkspaceCreateAt = {
  createAt(input: {
    readonly path: string
    readonly machineId: string
    readonly machineLabel: string
    readonly title?: string
  }): Promise<Workspace>
}

/**
 * Stat row served by the secondary.
 */
export interface LocalStatValue {
  readonly type: 'file' | 'directory' | 'symlink' | 'other' | null
  readonly version: string
  readonly size?: number
}

/** Machine registry and remote directory operations. */
export class RemoteHostService extends TypertRemoteService {
  static inject = ['workspaceRegistry']

  static Config = Config

  private hosts: HostRecord[] = []
  private readonly status = new Map<string, MachineView['status']>()
  private persist: ((hosts: readonly HostRecord[]) => Promise<void>) | undefined
  /** Test hook: replace the DSH gateway client factory. Production dials the secondary. */
  internals: { clientFactory: DshClientFactory } = {
    clientFactory: host => new DshGatewayClient(host.url, host.auth),
  }

  /**
   * @param ctx - Host context.
   * @param config - initial hosts from composition or settings.
   */
  constructor(ctx: Context, config: HostsConfig = {}) {
    super(ctx, 'remoteHosts')
    this.hosts = validateHosts(config.hosts ?? [])
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, REMOTE_HOSTS_NS, Config, config as never, {
        validate: (value) => {
          validateHosts((value.hosts ?? []).map(host => ({
            id: host.id ?? '',
            label: host.label ?? '',
            url: host.url ?? '',
            ...host.auth === undefined ? {} : { auth: host.auth },
          })))
        },
        setSource: (source) => {
          const hosts = source().hosts ?? []
          this.hosts = validateHosts(hosts.map(host => ({
            id: host.id ?? '',
            label: host.label ?? '',
            url: host.url ?? '',
            ...host.auth === undefined ? {} : { auth: host.auth },
          })))
        },
        onChange: () => {
          const resolved = settingsCtx.settings.get(REMOTE_HOSTS_NS) as HostsConfig | undefined
          this.hosts = validateHosts(resolved?.hosts ?? [])
        },
      })
      this.persist = async (hosts) => {
        await settingsCtx.settings.replace(REMOTE_HOSTS_NS, { hosts })
      }
    })
  }

  /**
   * Local sandboxed filesystem used when the initiator has no machineId.
   * @returns the isolated local backend.
   */
  get localFileSystem(): FileSystem {
    return localExecution(this.ctx).fs
  }

  /**
   * Local subprocess runtime used when the initiator has no machineId.
   * @returns the isolated local backend.
   */
  get localSubprocess(): SubprocessRuntime {
    return localExecution(this.ctx).subprocess
  }

  /**
   * Local shell executor used when the initiator has no machineId.
   * @returns the isolated local backend.
   */
  get localShell(): ShellExecutor {
    return localExecution(this.ctx).shell
  }

  /**
   * Configured machines in settings order.
   * @returns machine views with last probe status.
   */
  @Remote('listMachines')
  listMachines(): MachineView[] {
    return this.hosts.map(host => ({
      ...host,
      status: this.status.get(host.id) ?? 'unknown',
    }))
  }

  /**
   * Create or replace one machine record.
   * @param request - label, DSH URL, and optional existing id.
   * @returns the stored view.
   */
  @Remote('upsertMachine')
  async upsertMachine(request: UpsertMachineRequest): Promise<MachineView> {
    const id = MachineId(request.id?.trim() || randomUUID())
    const next: HostRecord = {
      id,
      label: request.label,
      url: request.url.trim().replace(/\/+$/, ''),
      ...request.auth === undefined || request.auth.trim() === '' ? {} : { auth: request.auth.trim() },
    }
    const without = this.hosts.filter(host => host.id !== id)
    const hosts = validateHosts([...without, next])
    await this.writeHosts(hosts)
    return { ...next, status: this.status.get(id) ?? 'unknown' }
  }

  /**
   * Register one discovered peer. URL deduplicates: a beacon from an already
   * known URL resolves to the stored view without minting a duplicate.
   * @param request - Peer label and vetted base URL.
   * @returns the stored view.
   */
  async upsertDiscovered(request: { label: string; url: string }): Promise<MachineView> {
    const url = normalizeBaseUrl(request.url)
    const label = request.label.trim()
    if (label.length === 0 || url.length === 0) {
      throw new RemoteError('remote-host/invalid-config', 'discovered peer must carry a label and url', {
        reason: 'empty-discovery-field',
      })
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
    } catch {
      throw new RemoteError('remote-host/invalid-config', `discovered peer url must be an http(s) DSH base URL, got "${url}"`, {
        reason: 'invalid-discovery-url',
      })
    }
    const existing = this.hosts.find(host => host.url === url)
    if (existing !== undefined) return { ...existing, status: this.status.get(existing.id) ?? 'unknown' }
    return this.upsertMachine({ label, url })
  }

  /**
   * Remove one machine record. Unknown ids are an idempotent no-op.
   * @param request - machine identity.
   */
  @Remote('removeMachine')
  async removeMachine(request: RemoveMachineRequest): Promise<void> {
    const id = request.id.trim()
    const hosts = this.hosts.filter(host => host.id !== id)
    if (hosts.length === this.hosts.length) return
    this.status.delete(id)
    await this.writeHosts(hosts)
  }

  /**
   * Probe DSH gateway reachability via `remoteHosts/listMachines`.
   * @param id - machine identity.
   * @param signal - abort the HTTP request.
   * @returns the updated view.
   */
  @Remote('probe')
  async probe(id: string, signal?: AbortSignal): Promise<MachineView> {
    const host = this.requireHost(id)
    try {
      await this.client(host).call('remoteHosts/listMachines', {}, signal)
    } catch (error: unknown) {
      this.status.set(host.id, 'unreachable')
      throw new RemoteError(
        'remote-host/unreachable',
        error instanceof Error ? error.message : `cannot reach "${host.url}"`,
        { id: host.id },
      )
    }
    this.status.set(host.id, 'reachable')
    return { ...host, status: 'reachable' }
  }

  /**
   * List directories on the secondary DSH.
   * @param request - machine and optional path.
   * @param signal - abort the listing.
   * @returns name-sorted directory children.
   */
  @Remote('listDirectory')
  async listDirectory(request: ListDirectoryRequest, signal?: AbortSignal): Promise<RemoteDirectoryListing> {
    const host = this.requireHost(request.machineId)
    const requested = request.path?.trim() ?? ''
    const path = requested.length === 0
      ? await this.client(host).call<string>('remoteHosts/localHome', {}, signal)
      : requested
    const entries = await this.client(host).call<Array<{ name: string; path: string }>>(
      'remoteHosts/localListDir',
      { path, dirsOnly: true },
      signal,
    )
    return { path, entries: entries.map(entry => ({ name: entry.name, path: entry.path })) }
  }

  /**
   * Verify a remote directory and register it as a Workspace. Does not mkdir on the harness.
   * @param request - machine and absolute remote path.
   * @returns the durable Workspace identity and stored label.
   */
  @Remote('createWorkspace')
  async createWorkspace(request: CreateRemoteWorkspaceRequest): Promise<CreateRemoteWorkspaceValue> {
    const host = this.requireHost(request.machineId)
    const path = request.path.trim()
    if (!isRemoteAbsolute(path)) {
      throw new RemoteError(
        'remote-host/invalid-path',
        `remote path must be absolute, got "${path}"`,
        { path },
      )
    }
    const canonical = await this.client(host).call<string>('remoteHosts/localRealpath', { path })
    const info = await this.client(host).call<LocalStatValue | null>('remoteHosts/localStat', { path: canonical })
    if (info === null || info.type !== 'directory') {
      throw new RemoteError(
        'remote-host/invalid-path',
        `not a directory: ${canonical}`,
        { path: canonical },
      )
    }
    const registry = this.ctx.workspaceRegistry as typeof this.ctx.workspaceRegistry & WorkspaceCreateAt
    const title = request.title?.trim()
    const workspace = await registry.createAt({
      path: canonical,
      machineId: host.id,
      machineLabel: host.label,
      ...title === undefined || title.length === 0 ? {} : { title },
    })
    return {
      workspaceId: workspace.id,
      path: workspace.path,
      machineId: host.id,
      machineLabel: host.label,
      title: workspace.title,
    }
  }

  /**
   * Gateway client for one host.
   * @param host - configured machine.
   * @returns client dialing the secondary.
   */
  client(host: HostRecord): DshGatewayClient {
    return this.internals.clientFactory(host)
  }

  /**
   * Look up a configured machine.
   * @param id - machine identity.
   * @returns the host record.
   */
  requireHost(id: string): HostRecord {
    const host = this.hosts.find(candidate => candidate.id === id)
    if (host === undefined) {
      throw new RemoteError('remote-host/not-found', `no machine "${id}"`, { id })
    }
    return host
  }

  private async writeHosts(hosts: HostRecord[]): Promise<void> {
    this.hosts = hosts
    if (this.persist !== undefined) await this.persist(hosts)
  }

  /**
   * Secondary home directory (served by the secondary DSH).
   * @returns absolute home path.
   */
  @Remote('localHome')
  async localHome(): Promise<string> {
    return homedir()
  }

  /**
   * List a directory on the secondary (served locally, called remotely).
   * @param args - path and dirsOnly flag.
   * @returns name-sorted children.
   */
  @Remote('localListDir')
  async localListDir(args: { path: string; dirsOnly?: boolean }): Promise<Array<{ name: string; path: string; type: string }>> {
    const entries = await fs.readdir(args.path, { withFileTypes: true })
    const rows = entries
      .filter(entry => args.dirsOnly !== true || entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        path: join(args.path, entry.name),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return rows
  }

  /**
   * Canonicalize a path on the secondary.
   * @param args - path to resolve.
   * @returns absolute real path (falls back to resolved path).
   */
  @Remote('localRealpath')
  async localRealpath(args: { path: string }): Promise<string> {
    try {
      return await fs.realpath(args.path)
    } catch {
      return resolvePath(args.path)
    }
  }

  /**
   * Stat a path on the secondary.
   * @param args - path to stat.
   * @returns stat row or null when missing.
   */
  @Remote('localStat')
  async localStat(args: { path: string }): Promise<LocalStatValue | null> {
    try {
      const st = await fs.stat(args.path)
      // fs.stat follows links, so only files and directories surface here.
      const type = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'
      return { type, version: `${st.mtimeMs}:${st.size}`, size: st.size }
    } catch {
      return null
    }
  }

  /**
   * Read a file on the secondary as base64.
   * @param args - path to read.
   * @returns base64 content.
   */
  @Remote('localRead')
  async localRead(args: { path: string }): Promise<string> {
    const bytes = await fs.readFile(args.path)
    return bytes.toString('base64')
  }

  /**
   * Write a file on the secondary atomically.
   * @param args - path, base64 content, and mode.
   * @returns fresh version row for the written file.
   */
  @Remote('localWrite')
  async localWrite(args: { path: string; contentB64: string; mode?: number }): Promise<LocalStatValue> {
    const content = Buffer.from(args.contentB64, 'base64')
    await fs.mkdir(dirname(args.path), { recursive: true })
    const tmp = `${args.path}.dsh-tmp-${randomUUID()}`
    await fs.writeFile(tmp, content, { mode: args.mode ?? 0o600 })
    await fs.rename(tmp, args.path)
    const st = await fs.stat(args.path)
    return { type: 'file', version: `${st.mtimeMs}:${st.size}`, size: st.size }
  }

  /**
   * Resolve an executable on the secondary via PATH.
   * @param args - command and optional PATH.
   * @returns absolute executable path.
   */
  @Remote('localWhich')
  async localWhich(args: { command: string; path?: string }): Promise<string> {
    const PATH = args.path ?? process.env.PATH ?? ''
    for (const dir of PATH.split(':')) {
      if (dir.trim() === '') continue
      const candidate = join(dir, args.command)
      try {
        const st = await fs.stat(candidate)
        if (st.isFile()) return candidate
      } catch { /* try next */ }
    }
    throw new RemoteError('remote-host/invalid-path', `cannot resolve "${args.command}"`, { path: args.command })
  }

  /**
   * Run a command on the secondary and buffer output.
   * @param args - cwd, argv, and env.
   * @returns buffered outcome.
   */
  @Remote('localExec')
  async localExec(args: {
    cwd: string
    argv: string[]
    env?: Record<string, string>
  }): Promise<{ stdoutB64: string; stderrB64: string; exitCode: number | null }> {
    const program = args.argv[0]
    if (program === undefined || program.length === 0) throw new Error('remote-host: executable name must be non-empty')
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args.argv.slice(1), {
        cwd: args.cwd,
        env: { ...process.env, ...args.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
      child.on('error', (error: Error) => { reject(error) })
      child.on('close', (code: number | null) => {
        resolve({
          stdoutB64: Buffer.concat(stdout).toString('base64'),
          stderrB64: Buffer.concat(stderr).toString('base64'),
          exitCode: code,
        })
      })
    })
  }

  /**
   * Version probe for secondary stat (used for staleness checks).
   * @param args - path to version.
   * @returns version string or null.
   */
  @Remote('localVersion')
  async localVersion(args: { path: string }): Promise<string | null> {
    try {
      const st = statSync(args.path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }
}

const LOCALS = new WeakMap<Context, { fs: FileSystem; subprocess: SubprocessRuntime; shell: ShellExecutor }>()

/**
 * Remember isolated local backends for the routing services.
 * @param root - Root context.
 * @param local - Isolated `ctx.fs`, `ctx.subprocess`, and `ctx.shell`.
 */
export function bindLocalExecution(
  root: Context,
  local: { fs: FileSystem; subprocess: SubprocessRuntime; shell: ShellExecutor },
): void {
  LOCALS.set(root, local)
}

/**
 * Isolated local backends bound by {@link bindLocalExecution}.
 * @param ctx - Any context in the tree.
 * @returns the local fs, subprocess, and shell trio.
 */
export function localExecution(ctx: Context): { fs: FileSystem; subprocess: SubprocessRuntime; shell: ShellExecutor } {
  const found = LOCALS.get(ctx.root)
  if (found === undefined) {
    throw new Error('remote-host: local filesystem, subprocess, and shell are not mounted')
  }
  return found
}
