/**
 * Public identities, machine records, and Remote request values for remote DSH hosts.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of one configured DSH/Tailscale machine. */
export type MachineId = Branded<'MachineId'>

/**
 * Brand a machine identity.
 * @param id - Stable uuid string.
 * @returns the same string branded as a machine identity.
 */
export function MachineId(id: string): MachineId {
  return id as MachineId
}

/** Reachability of one configured machine as last probed. */
export type MachineStatus = 'unknown' | 'reachable' | 'unreachable'

/** One configured DSH destination reachable over HTTP (same machine or Tailscale LAN). */
export interface HostRecord {
  /** Stable uuid. */
  readonly id: MachineId
  /** Display name, for example `gpu-box`. */
  readonly label: string
  /** Secondary `dsh web` base URL, for example `http://127.0.0.1:3081` or `http://gpu.tailnet.ts.net:3080`. */
  readonly url: string
  /** Optional credential sent as `Authorization: Bearer` when the secondary requires it. */
  readonly auth?: string
}

/** Browser-facing machine row. */
export interface MachineView extends HostRecord {
  /** Last probe outcome; `unknown` until a probe runs. */
  readonly status: MachineStatus
}

/** Settings document for the `remote-hosts` namespace. */
export interface Config {
  /** Configured machines. Duplicate ids fail at load. */
  readonly hosts?: readonly {
    readonly id: string
    readonly label: string
    readonly url: string
    readonly auth?: string
  }[]
  /** Zero-config peer discovery on the LAN and Tailscale. Absent enables it with defaults. */
  readonly discovery?: DiscoveryConfig
}

/** Zero-config peer discovery options. */
export interface DiscoveryConfig {
  /** Beacon and listen for peers. Default true. */
  readonly enabled?: boolean
  /** UDP discovery port shared by all peers. Default 43771. */
  readonly port?: number
  /** Beacon interval in milliseconds. Default 5000. */
  readonly intervalMs?: number
}

/** Create or replace one machine record. */
export interface UpsertMachineRequest {
  /** Existing id to replace; omitted mints a new uuid. */
  readonly id?: string
  /** Display name. */
  readonly label: string
  /** Secondary `dsh web` base URL. */
  readonly url: string
  /** Optional credential for the secondary. */
  readonly auth?: string
}

/** Delete one machine record. */
export interface RemoveMachineRequest {
  /** Machine identity. */
  readonly id: string
}

/** List remote directories. */
export interface ListDirectoryRequest {
  /** Machine identity. */
  readonly machineId: string
  /** POSIX path; omitted lists the remote home directory. */
  readonly path?: string
}

/** One remote directory child. */
export interface RemoteDirectoryEntry {
  /** Basename. */
  readonly name: string
  /** Absolute POSIX path. */
  readonly path: string
}

/** Remote directory listing. */
export interface RemoteDirectoryListing {
  /** Canonical listed directory. */
  readonly path: string
  /** Name-sorted directory children. */
  readonly entries: readonly RemoteDirectoryEntry[]
}

/** Register a remote directory as a Workspace. */
export interface CreateRemoteWorkspaceRequest {
  /** Machine identity. */
  readonly machineId: string
  /** Absolute directory path on that machine. */
  readonly path: string
  /** Display title; defaults to the path's last segment. */
  readonly title?: string
}

/** Workspace created or reused on a remote machine. */
export interface CreateRemoteWorkspaceValue {
  /** Durable Workspace identity. */
  readonly workspaceId: WorkspaceId
  /** Canonical remote path. */
  readonly path: string
  /** Machine identity copied onto the Workspace. */
  readonly machineId: MachineId
  /** Display label copied onto the Workspace. */
  readonly machineLabel: string
  /** Workspace title. */
  readonly title: string
}
