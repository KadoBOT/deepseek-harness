import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '../src/errors.ts'
import { DshFileSystem } from '../src/dsh-fs.ts'

type Entry = { type: 'file' | 'directory' | 'symlink' | 'other'; content: Buffer; version: string }

function files(initial: Record<string, Entry> = {}): Map<string, Entry> {
  return new Map(Object.entries(initial))
}

function text(content: string, version = 'v1'): Entry {
  return { type: 'file', content: Buffer.from(content, 'utf8'), version }
}

function stubService(store: Map<string, Entry>, faults: Record<string, unknown> = {}) {
  const written: Array<{ path: string; content: Buffer }> = []
  const client = {
    call: async <T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
      if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      if (faults[endpoint] !== undefined) {
        const fault = faults[endpoint]
        if (typeof fault === 'function') return (fault as (args: Record<string, unknown>) => T)(args)
        if (fault instanceof Error) throw fault
        return fault as T
      }
      const path = args['path'] as string
      switch (endpoint) {
        case 'remoteHosts/localRealpath':
          return path as T
        case 'remoteHosts/localStat': {
          const entry = store.get(path)
          if (entry === undefined) return null as T
          return { type: entry.type, version: entry.version, size: entry.content.length } as T
        }
        case 'remoteHosts/localListDir': {
          const prefix = path.endsWith('/') ? path : `${path}/`
          const rows = [...store.keys()]
            .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
            .map((key) => {
              const entry = store.get(key)
              const name = key.slice(prefix.length)
              return {
                name,
                path: key,
                type: entry?.type ?? 'other',
                version: entry?.version ?? 'v0',
                size: entry?.content.length,
              }
            })
            .filter(row => args['dirsOnly'] !== true || row.type === 'directory')
          return rows as T
        }
        case 'remoteHosts/localRead': {
          const entry = store.get(path)
          if (entry === undefined || entry.type !== 'file') {
            throw new RemoteError('remote-host/invalid-path', `missing: ${path}`, { path })
          }
          return entry.content.toString('base64') as T
        }
        case 'remoteHosts/localWrite': {
          const content = Buffer.from(args['contentB64'] as string, 'base64')
          written.push({ path, content })
          const version = `v${String(written.length + 1)}`
          store.set(path, { type: 'file', content, version })
          return { type: 'file', version, size: content.length } as T
        }
        default:
          throw new Error(`unexpected endpoint ${endpoint}`)
      }
    },
  }
  const service = {
    requireHost: () => ({ id: 'm', label: 'm', url: 'http://127.0.0.1:3081' }),
    client: () => client,
  }
  return { service, client, written }
}

interface FsHarness {
  fs: DshFileSystem
  written: Array<{ path: string; content: Buffer }>
}

function fsFor(store: Map<string, Entry>, faults: Record<string, unknown> = {}): FsHarness {
  const ctx = new Context().isolate('fs', Symbol('test'))
  const { service, written } = stubService(store, faults)
  return { fs: new DshFileSystem(ctx, service as never, 'm'), written }
}

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const failure = await promise.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(FsError)
  return (failure as FsError).code
}

describe('DshFileSystem', () => {
  it('resolves paths and rejects empty or aborted input', async () => {
    const { fs } = fsFor(files())
    expect(await fs.resolve('sub', { cwd: '/base' })).toMatchObject({ displayPath: '/base/sub' })
    expect(await codeOf(fs.resolve('  '))).toBe('FS_NOT_FOUND')
    const controller = new AbortController()
    controller.abort()
    expect(await codeOf(fs.resolve('/x', { signal: controller.signal }))).toBe('FS_ABORTED')
  })

  it('maps gateway failures on resolve', async () => {
    const { fs } = fsFor(files(), {
      'remoteHosts/localRealpath': new RemoteError('remote-host/invalid-path', 'missing', { path: '/x' }),
    })
    expect(await codeOf(fs.resolve('/x'))).toBe('FS_NOT_FOUND')
    const { fs: unreachable } = fsFor(files(), {
      'remoteHosts/localRealpath': new RemoteError('remote-host/unreachable', 'down', { id: 'm' }),
    })
    expect(await codeOf(unreachable.resolve('/x'))).toBe('FS_IO_ERROR')
  })

  it('exposes process paths, file urls, and containment', () => {
    const { fs } = fsFor(files())
    expect(fs.processPath(target('/a/b'))).toBe('/a/b')
    expect(fs.processPathFromHostPath('/host/x')).toBeUndefined()
    expect(fs.fileUrl(target('/a/b c'))).toBe('file:///a/b%20c')
    expect(() => fs.fileUrl(target('relative'))).toThrow()
    expect(fs.contains(target('/a'), target('/a'))).toBe(true)
    expect(fs.contains(target('/a'), target('/a/b'))).toBe(true)
    expect(fs.contains(target('/a'), target('/a/../b'))).toBe(false)
    expect(fs.contains(target('/a'), target('/other'))).toBe(false)
  })

  it('stats files, directories, and missing paths', async () => {
    const { fs } = fsFor(files({ '/f.txt': text('hi'), '/d': { type: 'directory', content: Buffer.of(), version: 'vd' } }))
    expect(await fs.stat(target('/f.txt'))).toMatchObject({ type: 'file', size: 2 })
    expect(await fs.stat(target('/d'))).toMatchObject({ type: 'directory' })
    expect(await fs.stat(target('/missing'))).toBeUndefined()
    expect(await fs.lstat('/f.txt', { cwd: '/' })).toMatchObject({ type: 'file' })
    expect(await codeOf(fs.lstat('  '))).toBe('FS_NOT_FOUND')
  })

  it('maps symlink and foreign types to other', async () => {
    const { fs } = fsFor(files({
      '/l': { type: 'symlink', content: Buffer.of(), version: 'vl' },
      '/o': { type: 'other', content: Buffer.of(), version: 'vo' },
    }))
    expect(await fs.stat(target('/l'))).toMatchObject({ type: 'other' })
    expect(await fs.lstat('/l', { cwd: '/' })).toMatchObject({ type: 'symlink' })
    expect(await fs.lstat('/o', { cwd: '/' })).toMatchObject({ type: 'other' })
  })

  it('reads text, rejects binaries and invalid utf8', async () => {
    const { fs } = fsFor(files({
      '/ok.txt': text('hello'),
      '/bin.dat': { type: 'file', content: Buffer.from([0x41, 0x00, 0x42]), version: 'vb' },
      '/bad.txt': { type: 'file', content: Buffer.from([0xff, 0xfe]), version: 'vx' },
      '/d': { type: 'directory', content: Buffer.of(), version: 'vd' },
    }))
    expect(await fs.readText(target('/ok.txt'))).toBe('hello')
    expect(await codeOf(fs.readText(target('/bin.dat')))).toBe('FS_NOT_TEXT')
    expect(await codeOf(fs.readText(target('/bad.txt')))).toBe('FS_NOT_TEXT')
    expect(await codeOf(fs.readText(target('/d')))).toBe('FS_NOT_REGULAR_FILE')
    expect(await codeOf(fs.readText(target('/missing')))).toBe('FS_NOT_FOUND')
  })

  it('enforces byte caps and streams text', async () => {
    const { fs } = fsFor(files({ '/ok.txt': text('hello') }))
    expect(await codeOf(fs.readBytes(target('/ok.txt'), undefined, 2))).toBe('FS_TOO_LARGE')
    let collected = ''
    for await (const chunk of await fs.streamText(target('/ok.txt'))) collected += chunk
    expect(collected).toBe('hello')
  })

  it('lists directories sorted with versions', async () => {
    const { fs } = fsFor(files({
      '/d': { type: 'directory', content: Buffer.of(), version: 'vd' },
      '/d/b.txt': text('b', 'v2'),
      '/d/a.txt': text('a', 'v3'),
      '/d/sub': { type: 'directory', content: Buffer.of(), version: 'vd' },
    }))
    const rows = await fs.listDir(target('/d'))
    expect(rows.map(row => row.name)).toEqual(['a.txt', 'b.txt', 'sub'])
    expect(rows[0]).toMatchObject({ type: 'file', version: FsVersion('v3'), size: 1 })
    expect(await codeOf(fs.listDir(target('/missing')))).toBe('FS_NOT_FOUND')
    expect(await codeOf(fs.listDir(target('/d/a.txt')))).toBe('FS_NOT_DIRECTORY')
  })

  it('writes new and existing files with intents', async () => {
    const store = files({ '/e.txt': text('old', 'v9') })
    const { fs, written } = fsFor(store)
    const created = await fs.writeText(target('/n.txt'), 'new\n')
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'new\n' })
    const updated = await fs.writeText(target('/e.txt'), 'new', { kind: 'replaceIfVersion', version: FsVersion('v9') })
    expect(updated).toMatchObject({ operation: 'update', before: 'old' })
    expect(written).toHaveLength(2)
    expect(await codeOf(fs.writeText(target('/e.txt'), 'x', { kind: 'createIfAbsent' }))).toBe('FS_NOT_OBSERVED')
    expect(await codeOf(fs.writeText(target('/e.txt'), 'x', { kind: 'replaceIfVersion', version: FsVersion('stale') }))).toBe(
      'FS_STALE_VERSION',
    )
  })

  it('refuses to write directories', async () => {
    const { fs } = fsFor(files({ '/d': { type: 'directory', content: Buffer.of(), version: 'vd' } }))
    expect(await codeOf(fs.writeText(target('/d'), 'x'))).toBe('FS_NOT_REGULAR_FILE')
  })

  it('edits text with version checks and CRLF round-trip', async () => {
    const { fs, written } = fsFor(files({ '/e.txt': text('a\nb\n', 'v1'), '/c.txt': { type: 'file', content: Buffer.from('a\r\nb\r\n', 'utf8'), version: 'vc' } }))
    const outcome = await fs.editText(target('/e.txt'), { oldString: 'a\n', newString: 'z\n' }, { version: FsVersion('v1') })
    expect(outcome).toMatchObject({ before: 'a\nb\n', after: 'z\nb\n' })
    await fs.editText(target('/c.txt'), { oldString: 'a\n', newString: 'z\n' }, { version: FsVersion('vc') })
    expect(written.at(-1)?.content.toString('utf8')).toBe('z\r\nb\r\n')
    expect(await codeOf(fs.editText(target('/missing'), { oldString: 'a', newString: 'b' }))).toBe('FS_STALE_VERSION')
    expect(await codeOf(fs.editText(target('/e.txt'), { oldString: '', newString: 'b' }, { version: outcome.version }))).toBe(
      'FS_EDIT_NOT_FOUND',
    )
    expect(await codeOf(fs.editText(target('/e.txt'), { oldString: 'zzz', newString: 'b' }, { version: outcome.version }))).toBe(
      'FS_EDIT_NOT_FOUND',
    )
  })

  it('rejects ambiguous edits unless replaceAll', async () => {
    const { fs } = fsFor(files({ '/e.txt': text('x\nx\n', 'v1') }))
    expect(await codeOf(fs.editText(target('/e.txt'), { oldString: 'x\n', newString: 'y\n' }, { version: FsVersion('v1') }))).toBe(
      'FS_AMBIGUOUS_EDIT',
    )
    const outcome = await fs.editText(
      target('/e.txt'),
      { oldString: 'x\n', newString: 'y\n', replaceAll: true },
      { version: FsVersion('v1') },
    )
    expect(outcome.after).toBe('y\ny\n')
  })

  it('serializes concurrent writes to the same key', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const store = files({ '/e.txt': text('old', 'v1') })
    const { service } = stubService(store)
    const inner = service.client()
    let calls = 0
    const blocking = {
      call: async <T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
        if (endpoint === 'remoteHosts/localWrite') {
          calls += 1
          if (calls === 1) await gate
        }
        return inner.call<T>(endpoint, args, signal)
      },
    }
    const ctx = new Context().isolate('fs', Symbol('test'))
    const fs = new DshFileSystem(ctx, { requireHost: service.requireHost, client: () => blocking } as never, 'm')
    const first = fs.writeText(target('/e.txt'), 'one')
    const second = fs.writeText(target('/e.txt'), 'two')
    release()
    await expect(first).resolves.toMatchObject({ operation: 'update' })
    await expect(second).resolves.toMatchObject({ operation: 'update' })
    expect(store.get('/e.txt')?.content.toString('utf8')).toBe('two')
  })

  it('aborts writes and passes FsError through untouched', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fs } = fsFor(files({ '/e.txt': text('old', 'v1') }))
    expect(await codeOf(fs.writeText(target('/e.txt'), 'x', undefined, controller.signal))).toBe('FS_ABORTED')
    const passthrough = new FsError('custom', 'FS_IO_ERROR')
    const { fs: faulty } = fsFor(files(), { 'remoteHosts/localStat': passthrough })
    const failure = await faulty.stat(target('/e.txt')).catch((error: unknown) => error)
    expect(failure).toBe(passthrough)
  })

  it('treats DOMExceptions as aborts', async () => {
    const { fs } = fsFor(files(), {
      'remoteHosts/localStat': new DOMException('gone', 'AbortError'),
    })
    expect(await codeOf(fs.stat(target('/e.txt')))).toBe('FS_ABORTED')
  })

  it('records a null before-image for binary files', async () => {
    const { fs } = fsFor(files({ '/bin.dat': { type: 'file', content: Buffer.from([0x41, 0x00]), version: 'vb' } }))
    const outcome = await fs.writeText(target('/bin.dat'), 'text')
    expect(outcome.before).toBeNull()
  })
})

describe('DshFileSystem gateway failures', () => {
  it('maps read and write transport errors', async () => {
    const down = new RemoteError('remote-host/unreachable', 'down', { id: 'm' })
    const { fs } = fsFor(files({ '/e.txt': text('old', 'v1') }), { 'remoteHosts/localRead': down })
    expect(await codeOf(fs.readText(target('/e.txt')))).toBe('FS_IO_ERROR')
    // The stat probe succeeds, so the diff read throws through instead of resolving null.
    expect(await codeOf(fs.writeText(target('/e.txt'), 'new'))).toBe('FS_IO_ERROR')
    const { fs: failing } = fsFor(files({ '/e.txt': text('old', 'v1') }), { 'remoteHosts/localWrite': down })
    expect(await codeOf(failing.writeText(target('/e.txt'), 'new'))).toBe('FS_IO_ERROR')
  })
})

describe('DshFileSystem edit and list edges', () => {
  it('maps message-shaped not-found errors', async () => {
    const { fs } = fsFor(files(), { 'remoteHosts/localRealpath': new Error('not found: /x') })
    expect(await codeOf(fs.resolve('/x'))).toBe('FS_NOT_FOUND')
  })

  it('fails listings through the gateway', async () => {
    const down = new RemoteError('remote-host/unreachable', 'down', { id: 'm' })
    const { fs } = fsFor(files({ '/d': { type: 'directory', content: Buffer.of(), version: 'vd' } }), {
      'remoteHosts/localListDir': down,
    })
    expect(await codeOf(fs.listDir(target('/d')))).toBe('FS_IO_ERROR')
  })

  it('rejects edits on directories and stale versions', async () => {
    const { fs } = fsFor(files({
      '/d': { type: 'directory', content: Buffer.of(), version: 'vd' },
      '/e.txt': text('a\n', 'v1'),
    }))
    expect(await codeOf(fs.editText(target('/d'), { oldString: 'a', newString: 'b' }))).toBe('FS_NOT_REGULAR_FILE')
    expect(await codeOf(
      fs.editText(target('/e.txt'), { oldString: 'a\n', newString: 'b\n' }, { version: FsVersion('old') }),
    )).toBe('FS_STALE_VERSION')
  })
})

describe('DshFileSystem generic failures', () => {
  it('wraps plain errors as IO failures', async () => {
    const { fs } = fsFor(files(), { 'remoteHosts/localRealpath': new Error('kaput') })
    const failure = await fs.resolve('/x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FsError)
    expect((failure as FsError).code).toBe('FS_IO_ERROR')
    expect((failure as FsError).message).toContain('kaput')
  })
})

describe('DshFileSystem lstat and listing edges', () => {
  it('resolves without options and maps null or foreign stats', async () => {
    const { fs } = fsFor(files({ '/f.txt': text('hi') }))
    expect(await fs.lstat('/f.txt')).toMatchObject({ type: 'file' })
    const { fs: nullable } = fsFor(files(), { 'remoteHosts/localStat': { type: null, version: 'v0' } })
    expect(await nullable.lstat('/x')).toBeUndefined()
    expect(await nullable.stat(target('/x'))).toBeUndefined()
  })

  it('stringifies non-Error transport failures', async () => {
    const { fs } = fsFor(files(), {
      'remoteHosts/localRealpath': () => { throw 'boom-string' },
    })
    const failure = await fs.resolve('/x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FsError)
    expect((failure as FsError).code).toBe('FS_IO_ERROR')
  })

  it('lists foreign entries with path fallback versions', async () => {
    const ctx = new Context().isolate('fs', Symbol('test'))
    const service = {
      requireHost: () => ({ id: 'm', label: 'm', url: 'http://127.0.0.1:3081' }),
      client: () => ({
        call: async <T>(endpoint: string): Promise<T> => {
          if (endpoint === 'remoteHosts/localStat') return { type: 'directory', version: 'vd' } as T
          return [{ name: 'link', path: '/d/link', type: 'symlink' }] as T
        },
      }),
    }
    const fs = new DshFileSystem(ctx, service as never, 'm')
    const rows = await fs.listDir(target('/d'))
    expect(rows).toMatchObject([{ name: 'link', type: 'other', version: '/d/link' }])
  })
})
