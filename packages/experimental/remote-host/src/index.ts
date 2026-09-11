/**
 * Experimental remote-host plugin: machine registry, DSH directory adoption,
 * and host-plane fs/subprocess/shell routers.
 * @module @deepseek-ai/dsh-experimental-remote-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { randomUUID } from 'node:crypto'
import { validateHosts } from './config.ts'
import type { Config as HostsConfig } from './types.ts'
import {
  discoveryLabel,
  ownCandidateUrls,
  resolveDiscovery,
  startDiscovery,
} from './discovery.ts'
import { RoutingFileSystem } from './routing-fs.ts'
import { RoutingShellExecutor } from './routing-shell.ts'
import { RoutingSubprocessRuntime } from './routing-subprocess.ts'
import { bindLocalExecution, RemoteHostService } from './service.ts'

/** Cordis plugin name. */
export const name = 'remote-host'

/** Services required to mount local backends, routing, and the machine registry. */
export const inject = ['workspaceRegistry', 'agents', 'sandboxPolicy', 'sandbox']

export { Config, REMOTE_HOSTS_NS, validateHosts } from './config.ts'
export { MachineId } from './types.ts'
export type {
  Config as HostsConfig,
  CreateRemoteWorkspaceRequest,
  CreateRemoteWorkspaceValue,
  DiscoveryConfig,
  HostRecord,
  ListDirectoryRequest,
  MachineView,
  RemoteDirectoryListing,
  RemoveMachineRequest,
  UpsertMachineRequest,
} from './types.ts'
export {
  DshGatewayClient,
  isRemoteAbsolute,
  normalizeBaseUrl,
} from './dsh-client.ts'
export {
  DEFAULT_DISCOVERY_INTERVAL_MS,
  DEFAULT_DISCOVERY_PORT,
  DISCOVERY_GROUP,
  DISCOVERY_MAGIC,
  PROBE_TIMEOUT_MS,
  TAILSCALE_REFRESH_MS,
  buildBeacon,
  defaultTailscaleRunner,
  discoveryLabel,
  extractTailscaleIps,
  ownCandidateUrls,
  parseBeacon,
  probePeer,
  resolveDiscovery,
  startDiscovery,
  tailscalePeerIps,
} from './discovery.ts'
export type { DiscoveryBeacon, DiscoveryRegistry, ResolvedDiscovery, StartDiscoveryOptions, TailscaleRunner } from './discovery.ts'
export { RemoteHostService, bindLocalExecution } from './service.ts'
export { DshFileSystem } from './dsh-fs.ts'
export { DshSubprocessRuntime } from './dsh-subprocess.ts'
export { RoutingFileSystem } from './routing-fs.ts'
export { RoutingSubprocessRuntime } from './routing-subprocess.ts'
export { RoutingShellExecutor } from './routing-shell.ts'

/**
 * Mount the machine registry. When this row replaces the stock
 * fs/subprocess/shell plugins, also mount isolated local backends and the
 * execution-world routers. A composition that already mounts `ctx.fs`,
 * `ctx.subprocess`, or `ctx.shell` mis-specifies the overlay: fail loud
 * instead of serving a settings card with no routing.
 * @param ctx - Host context.
 * @param config - initial host list from composition.
 */
export async function apply(ctx: Context, config: HostsConfig = {}): Promise<void> {
  validateHosts(config.hosts ?? [])
  ctx.plugin(RemoteHostService, config as never)
  const existingFs = ctx.get('fs')
  const existingSubprocess = ctx.get('subprocess')
  const existingShell = ctx.get('shell')
  if (existingFs !== undefined || existingSubprocess !== undefined || existingShell !== undefined) {
    throw new Error(
      'remote-host: stock fs/subprocess/shell rows must be disabled in the overlay '
      + 'so routers can own ctx.fs, ctx.subprocess, and ctx.shell',
    )
  }
  const localRealm = ctx.isolate('fs').isolate('subprocess').isolate('shell')
  await localRealm.plugin(SandboxedFileSystem)
  await localRealm.plugin(LocalSubprocessRuntime)
  await localRealm.plugin(SandboxBashExecutor)
  const localFs = localRealm.get('fs')
  const localSubprocess = localRealm.get('subprocess')
  const localShell = localRealm.get('shell')
  /* v8 ignore next -- local backends always register when their plugins mount; the throw guards future plugin changes */
  if (localFs === undefined || localSubprocess === undefined || localShell === undefined) {
    throw new Error('remote-host: isolated local filesystem, subprocess, and shell did not register')
  }
  bindLocalExecution(ctx.root, {
    fs: localFs,
    subprocess: localSubprocess,
    shell: localShell,
  })
  ctx.plugin(RoutingFileSystem)
  ctx.plugin(RoutingSubprocessRuntime)
  ctx.plugin(RoutingShellExecutor, {})
  ctx.on('agent/session-start', ({ agent }) => {
    if (agent.session.header.machineId === undefined) return
    if (ctx.sandboxPolicy.overrideOf(agent.session) === 'danger-full-access') return
    setSandboxMode(agent.session, 'danger-full-access')
  })
  ctx.inject(['webServer', 'remoteHosts'], (scoped) => {
    ctx.effect(async () => {
      const resolved = resolveDiscovery(config.discovery)
      if (!resolved.enabled) return async () => {}
      const server = scoped.get('webServer')
      const service = scoped.get('remoteHosts')
      /* v8 ignore next -- inject fires only when both services resolve; the guard covers scope races */
      if (server === undefined || service === undefined) return async () => {}
      try {
        const stop = await startDiscovery({
          service,
          self: {
            instanceId: randomUUID(),
            label: discoveryLabel(),
            urls: ownCandidateUrls(server.port, server.host),
          },
          port: resolved.port,
          intervalMs: resolved.intervalMs,
        })
        return () => stop()
      } catch {
        // Discovery is opportunistic: a blocked UDP port must not take down the harness.
        return async () => {}
      }
    }, 'remote-host.discovery')
  })
}
