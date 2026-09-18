/**
 * JSON-over-HTTP through the subprocess service: the host realm has no fetch,
 * so every Google/Code Assist request runs `curl` via `ctx.subprocess.spawn`
 * and parses the response head and JSON body itself.
 * @module @deepseek-ai/dsh-oauth-agents/http
 */

import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'

/** An error carrying the neutral LLM failure vocabulary beside its message. */
export class RequestError extends Error {
  /** Provider-neutral machine-routing failure. */
  readonly failure: LlmFailure

  /**
   * @param message - human-readable provider or transport failure.
   * @param code - stable machine-routing code.
   * @param status - HTTP status, when the provider returned one.
   */
  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'RequestError'
    this.failure = { message, code, ...(status === undefined ? {} : { status }) }
  }
}

/**
 * Build one {@link RequestError} carrying the neutral failure vocabulary.
 * @param message - human-readable failure.
 * @param code - stable machine-routing code.
 * @param status - HTTP status, when one is known.
 * @returns the error to throw.
 */
export function requestError(message: string, code: string, status?: number): RequestError {
  return new RequestError(message, code, status)
}

/**
 * Percent-encode one flat form body.
 * @param fields - single-value form fields.
 * @returns the urlencoded body text.
 */
export function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&')
}

/**
 * Generate a lowercase base-36 random identifier of at least `length` characters.
 * @param length - exact id length.
 * @returns the identifier.
 */
export function randomId(length: number): string {
  let out = ''
  while (out.length < length) out += Math.floor(Math.random() * 4294967296).toString(36)
  return out.slice(0, length)
}

/** JSON body plus HTTP status parsed from one curl `-i` response. */
export interface JsonResponse {
  readonly status: number
  readonly body: unknown
}

/**
 * Decode one subprocess stdout chunk, tolerating cross-realm Uint8Array
 * subclasses whose `toString` may throw.
 * @param chunk - raw stdout chunk.
 * @returns the UTF-8 text, or `''` when the chunk cannot be decoded.
 */
export function decodeChunk(chunk: unknown): string {
  try {
    if (chunk === null || chunk === undefined) return ''
    return (chunk as Buffer).toString('utf8')
  } catch {
    // A cross-realm chunk subclass may refuse toString.
    return ''
  }
}

/**
 * Split one raw `-i` response into status line and body.
 * @param raw - the complete response text.
 * @returns numeric HTTP status (0 when absent) and the body text.
 */
export function splitResponse(raw: string): { status: number; body: string } {
  const marker = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n'
  const splitAt = raw.indexOf(marker)
  if (splitAt < 0) return { status: 0, body: raw }
  const head = raw.slice(0, splitAt)
  const firstLine = head.split('\n')[0] ?? ''
  const status = Number.parseInt(firstLine.split(' ')[1] ?? '', 10)
  return { status: Number.isFinite(status) ? status : 0, body: raw.slice(splitAt + marker.length) }
}

/**
 * Parse one `-i` response body as JSON, keeping raw text when the body is not JSON.
 * @param raw - the complete response text.
 * @returns status plus the parsed value, or `{ raw }` holding unparsable text.
 */
export function parseJsonBody(raw: string): { status: number; body: unknown } {
  const parsed = splitResponse(raw)
  try {
    return { status: parsed.status, body: JSON.parse(parsed.body) as unknown }
  } catch {
    return { status: parsed.status, body: { raw: parsed.body.slice(0, 2000) } }
  }
}

/** Collected result of one `curl` invocation. */
interface CurlResult {
  readonly text: string
  readonly stderr: string
  readonly outcome: SubprocessOutcome
}

/**
 * Curl-based HTTP client backed by one subprocess service.
 *
 * The Google token, userinfo, and Code Assist endpoints all answer with small
 * JSON bodies, so every call runs one bounded collect-mode `curl -i` and
 * parses the head and body itself.
 */
export class Http {
  /**
   * @param subprocess - the host's subprocess service.
   */
  constructor(private readonly subprocess: SubprocessRuntime) {}

  private async runCollect(argv: readonly string[], body?: string): Promise<CurlResult> {
    const handle = await this.spawnHandle(argv, { maxBytes: 1048576 }, body)
    const outcome = await handle.done
    const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    return { text: stdout, stderr, outcome }
  }

  private async spawnHandle(
    argv: readonly string[],
    stdout: { maxBytes: number } | 'pipe',
    body: string | undefined,
  ): Promise<SubprocessHandle> {
    return this.subprocess.spawn({
      argv,
      cwd: '/tmp',
      stdio: {
        stdin: body === undefined ? 'ignore' : { data: body },
        stdout,
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
    })
  }

  private async runParsed(argv: readonly string[], body: string | undefined, url: string): Promise<JsonResponse> {
    const raw = await this.runCollect(argv, body)
    if (raw.outcome.exitCode !== 0 && raw.text === '') {
      throw requestError(
        `curl failed with exit ${String(raw.outcome.exitCode)} for ${url}: ${raw.stderr.slice(0, 300)}`,
        'PROTOCOL',
      )
    }
    return parseJsonBody(raw.text)
  }

  /**
   * POST one JSON body and parse the response.
   * @param url - endpoint.
   * @param headers - request headers.
   * @param body - JSON-serializable request body.
   * @param timeoutSec - whole-request curl deadline.
   * @returns status and parsed body.
   */
  async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutSec = 45,
  ): Promise<JsonResponse> {
    const argv = ['curl', '-sS', '-i', '--connect-timeout', '10', '--max-time', String(timeoutSec), '-X', 'POST']
    for (const name of Object.keys(headers)) argv.push('-H', `${name}: ${headers[name]}`)
    argv.push('-H', 'Content-Type: application/json', '--data-binary', '@-', url)
    return this.runParsed(argv, JSON.stringify(body), url)
  }

  /**
   * POST one urlencoded form body and parse the response.
   * @param url - token endpoint.
   * @param fields - single-value form fields.
   * @param timeoutSec - whole-request curl deadline.
   * @returns status and parsed body.
   */
  async postForm(url: string, fields: Record<string, string>, timeoutSec = 45): Promise<JsonResponse> {
    const argv = [
      'curl', '-sS', '-i', '--connect-timeout', '10', '--max-time', String(timeoutSec), '-X', 'POST',
      '-H', 'Content-Type: application/x-www-form-urlencoded',
      '-H', 'Accept: application/json', '--data-binary', '@-', url,
    ]
    return this.runParsed(argv, formEncode(fields), url)
  }

  /**
   * GET one URL and parse the response.
   * @param url - resource URL.
   * @param headers - request headers.
   * @param timeoutSec - whole-request curl deadline.
   * @returns status and parsed body.
   */
  async getJson(url: string, headers: Record<string, string>, timeoutSec = 45): Promise<JsonResponse> {
    const argv = ['curl', '-sS', '-i', '--connect-timeout', '10', '--max-time', String(timeoutSec)]
    for (const name of Object.keys(headers)) argv.push('-H', `${name}: ${headers[name]}`)
    argv.push(url)
    return this.runParsed(argv, undefined, url)
  }

  /**
   * Open one long-lived SSE POST. The caller consumes the handle's raw stdout
   * incrementally and owns termination.
   * @param url - streaming endpoint.
   * @param headers - request headers including the bearer token.
   * @param body - JSON request body.
   * @returns the live process handle; `stdout` is a piped Node stream.
   */
  async openSse(url: string, headers: Record<string, string>, body: string): Promise<SubprocessHandle> {
    const argv = ['curl', '-sS', '-i', '-N', '--connect-timeout', '10', '--max-time', '1800', '-X', 'POST']
    for (const name of Object.keys(headers)) argv.push('-H', `${name}: ${headers[name]}`)
    argv.push('-H', 'Content-Type: application/json', '--data-binary', '@-', url)
    return this.spawnHandle(argv, 'pipe', body)
  }
}
