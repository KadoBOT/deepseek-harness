/**
 * Authenticated read-only HTTP access to a second DSH host, plus the local
 * profile store naming its login URLs.
 */

export type { RemoteConnection, RemoteConnectionOptions } from './connection.ts'
export { connectRemote } from './connection.ts'
export type { RemoteProfile } from './profiles.ts'
export { createProfileStore } from './profiles.ts'
