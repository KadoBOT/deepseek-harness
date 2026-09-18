/** Profile store behavior: persistence, credential isolation, and lifecycle. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { createProfileStore } from '../src/profiles.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Boot a fresh profile store over its own temporary directory. */
async function boot(): Promise<{ ctx: Context; profiles: ReturnType<typeof createProfileStore>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-profiles-'))
  roots.push(root)
  const ctx = new Context()
  const profiles = createProfileStore(ctx, join(root, 'remotes.json'))
  return { ctx, profiles, root }
}

describe('remote profiles', () => {
  it('round-trips a profile and keeps the token out of the profile file', async () => {
    const { ctx, profiles, root } = await boot()
    try {
      await profiles.upsert({ id: 'lab', loginUrl: 'http://10.0.0.8:3080/?token=secret-token' })
      expect(profiles.list()).toEqual([{ id: 'lab', baseUrl: 'http://10.0.0.8:3080/' }])
      expect(await profiles.connectUrl('lab')).toBe('http://10.0.0.8:3080/?token=secret-token')
    } finally {
      await ctx.fiber.dispose()
    }
    const onDisk = await readFile(join(root, 'remotes.json'), 'utf8')
    expect(onDisk).not.toContain('secret-token')
  })

  it('rejects an id and URL that fail validation', async () => {
    const { ctx, profiles } = await boot()
    try {
      await expect(profiles.upsert({ id: 'Bad_ID', loginUrl: 'http://x/?token=a' })).rejects.toThrow('id')
      await expect(profiles.upsert({ id: 'lab', loginUrl: 'not-a-url' })).rejects.toThrow('login URL')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes a profile and its stored token, then disposes cleanly', async () => {
    const { ctx, profiles } = await boot()
    try {
      await profiles.upsert({ id: 'lab', loginUrl: 'http://10.0.0.8:3080/?token=secret-token' })
      await profiles.remove('lab')
      expect(profiles.list()).toEqual([])
      await expect(profiles.connectUrl('lab')).rejects.toThrow('lab')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
