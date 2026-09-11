/**
 * Filesystem backend over a secondary `dsh web` gateway. The secondary serves
 * `remoteHosts/local*` remotes from its own disk; the remote OS user is the
 * confinement boundary. `processPathFromHostPath` is undefined because the
 * harness disk is a different world.
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { LocalStatValue, RemoteHostService } from './service.ts'

const BINARY_SAMPLE_BYTES = 8192

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function mapGatewayError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined
  if (code === 'remote-host/invalid-path' || /not found/i.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (code === 'remote-host/unreachable') {
    return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** DSH filesystem for one configured machine. Registers as `ctx.fs` on an isolated realm. */
export class DshFileSystem extends FileSystem {
  private readonly locks = new Map<string, Promise<unknown>>()

  /**
   * @param ctx - Isolated context whose `fs` key this instance owns.
   * @param hosts - Machine registry and gateway client factory.
   * @param machineId - Configured machine identity.
   */
  constructor(
    ctx: Context,
    private readonly hosts: RemoteHostService,
    private readonly machineId: string,
  ) {
    super(ctx)
  }

  private host(): { url: string; auth?: string; id: string } {
    return this.hosts.requireHost(this.machineId)
  }

  private client(): { call<T>(endpoint: string, args: unknown, signal?: AbortSignal): Promise<T> } {
    return this.hosts.client(this.host() as never) as never
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? '/', path)
    try {
      const targetKey = await this.client().call<string>('remoteHosts/localRealpath', { path: displayPath }, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapGatewayError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    return undefined
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`remote-host: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const info = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (info === undefined || info.type === null) return undefined
    return {
      version: FsVersion(info.version),
      type: info.type === 'file' || info.type === 'directory' ? info.type : 'other',
      ...info.type === 'file' && info.size !== undefined ? { size: info.size } : {},
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? '/', path)
    const info = await this.probe(displayPath, displayPath, signal)
    if (info === undefined || info.type === null) return undefined
    return {
      version: FsVersion(info.version),
      type: info.type === 'file' || info.type === 'directory' || info.type === 'symlink' ? info.type : 'other',
      ...info.type === 'file' && info.size !== undefined ? { size: info.size } : {},
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readBytes(target, signal, Number.MAX_SAFE_INTEGER)
    return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    await this.requireRegular(target, signal)
    const encoded = await this.readEncoded(target, signal)
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte limit`,
        'FS_TOO_LARGE',
      )
    }
    return bytes
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield text
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const listed = await this.client().call<Array<{
        name: string
        path: string
        type: string
        version?: string
        size?: number
      }>>('remoteHosts/localListDir', { path: String(target.targetKey), dirsOnly: false }, signal)
      const rows: FsDirEntry[] = listed.map((entry) => {
        const type: FsDirEntry['type'] = entry.type === 'file' || entry.type === 'directory' ? entry.type : 'other'
        return {
          name: entry.name,
          type,
          target: {
            targetKey: FsTargetKey(entry.path),
            displayPath: posix.join(target.displayPath, entry.name),
          },
          version: FsVersion(entry.version ?? `${entry.path}`),
          ...entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {},
        }
      })
      return rows.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapGatewayError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && existing.type !== null && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined || existing.type === null ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(target, content, signal)
      return {
        operation: existing === undefined || existing.type === null ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined || existing.type === null) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.type !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, signal)
      return { version, before, after }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<LocalStatValue | undefined> {
    try {
      const info = await this.client().call<LocalStatValue | null>('remoteHosts/localStat', { path }, signal)
      return info ?? undefined
    } catch (error: unknown) {
      throw mapGatewayError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private checkWriteIntent(existing: LocalStatValue | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined && existing.type !== null) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || existing.type === null || existing.version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readEncoded(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      return await this.client().call<string>('remoteHosts/localRead', { path: String(target.targetKey) }, signal)
    } catch (error: unknown) {
      throw mapGatewayError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = Buffer.from(await this.readEncoded(target, signal), 'base64')
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw error
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = Buffer.from(await this.readEncoded(target, signal), 'base64')
    return decodeText(bytes, target.displayPath, bytes.length)
  }

  private async writeAtomic(target: FsTarget, content: string, signal?: AbortSignal): Promise<FsVersion> {
    assertNotAborted(signal, 'write')
    try {
      const committed = await this.client().call<LocalStatValue>('remoteHosts/localWrite', {
        path: String(target.targetKey),
        contentB64: Buffer.from(content, 'utf8').toString('base64'),
      }, signal)
      return FsVersion(committed.version)
    } catch (error: unknown) {
      throw mapGatewayError(error, 'write', target.displayPath, signal)
    }
  }
}
