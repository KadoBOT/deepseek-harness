/** RemoteError codes owned by the remote-host package. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No configured machine carries that id. */
    'remote-host/not-found': { readonly id: string }
    /** DSH gateway probe or command could not reach the destination. */
    'remote-host/unreachable': { readonly id: string }
    /** The remote path is missing, not a directory, or not absolute. */
    'remote-host/invalid-path': { readonly path: string }
    /** Hosts document failed uniqueness or field validation. */
    'remote-host/invalid-config': { readonly reason: string }
  }
}

export { RemoteError }
