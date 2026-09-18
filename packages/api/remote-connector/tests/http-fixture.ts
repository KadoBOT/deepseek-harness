/** Shared scripted HTTP server for connector tests: assigned loopback port, caller-owned close. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One observed request against the scripted server. */
export interface RecordedRequest {
  readonly method: string
  readonly path: string
  /** Raw request body, when the request carried one. */
  body?: string
}

/** One scripted response the server writes back. */
export interface ScriptedResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}

/** Scripted server handle; the test owns `close()` and must await it. */
export interface ScriptedServer {
  readonly server: Server
  readonly port: number
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

/**
 * Bind a scripted HTTP server on an assigned loopback port.
 * @param handler - pure request-to-response mapping recording every request.
 * @returns server whose assigned port is read only after listening.
 */
export async function startScriptedServer(handler: (request: RecordedRequest) => ScriptedResponse): Promise<ScriptedServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const recorded = { method: request.method ?? 'GET', path: request.url ?? '/' }
    const chunks: Buffer[] = []
    request.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) })
    request.on('end', () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString()
      const recordedWithBody = body === undefined ? recorded : { ...recorded, body }
      requests.push(recordedWithBody)
      const result = handler(recordedWithBody)
      response.writeHead(result.status, result.headers)
      response.end(result.body)
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => { server.once('listening', resolve) })
  const address = server.address() as AddressInfo
  return {
    server,
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
  }
}
