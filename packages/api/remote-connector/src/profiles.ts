/** Saved remote DSH profiles: named targets with credentials kept out of the profile file. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One saved remote target. The profile file never stores the launch token. */
export interface RemoteProfile {
  readonly id: string
  /** Remote origin without credentials, path, query, or hash. */
  readonly baseUrl: string
}

/** Stored profile-file record: exactly the non-secret fields. */
interface StoredProfile {
  readonly id: string
  readonly baseUrl: string
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/**
 * Validate one user-supplied profile id.
 * @param id - candidate profile id.
 * @returns the id unchanged.
 */
function assertProfileId(id: string): string {
  if (!PROFILE_ID_PATTERN.test(id)) throw new Error(`profile id "${id}" must match ${PROFILE_ID_PATTERN.source}`)
  return id
}

/**
 * Validate a login URL and detach its token.
 * @param loginUrl - the remote's root URL carrying exactly one token query parameter.
 * @returns the origin plus the token, split for separate storage.
 */
function splitLoginUrl(loginUrl: string): { origin: string; token: string } {
  let url: URL
  try {
    url = new URL(loginUrl)
  } catch {
    throw new Error(`"${loginUrl}" is not a valid remote login URL`)
  }
  const token = url.searchParams.get('token')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.hash || token === null) {
    throw new Error(`"${loginUrl}" must be a root HTTP(S) login URL carrying a token query parameter`)
  }
  url.searchParams.delete('token')
  url.search = ''
  url.hash = ''
  url.pathname = ''
  return { origin: url.origin + url.pathname, token }
}

/**
 * Build the profile store. File writes land through rename so a crash leaves
 * the previous file intact; the launch token never touches the profile file.
 * Loading is an effect on `ctx`: activation reads the store, disposal is a
 * no-op because the store holds no live resources.
 * @param ctx - plugin context owning the load effect.
 * @param filePath - absolute JSON file holding the non-secret profiles.
 * @returns store operations available after activation.
 */
export function createProfileStore(ctx: Context, filePath: string): {
  list(): readonly RemoteProfile[]
  upsert(input: { id: string; loginUrl: string }): Promise<void>
  remove(id: string): Promise<void>
  connectUrl(id: string): Promise<string>
} {
  const profiles = new Map<string, StoredProfile>()
  const tokens = new Map<string, string>()

  async function persist(): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const document = JSON.stringify({ profiles: [...profiles.values()] }, null, 2) + '\n'
    const staged = `${filePath}.${randomUUID()}.tmp`
    await writeFile(staged, document, 'utf8')
    await rename(staged, filePath)
  }

  ctx.effect(async () => {
    let raw: string | undefined
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { profiles?: unknown }).profiles)) {
      throw new Error(`profile file ${JSON.stringify(filePath)} does not hold a profiles array`)
    }
    for (const entry of (parsed as { profiles: unknown }).profiles) {
      if (typeof entry !== 'object' || entry === null) throw new Error('profile file holds a non-object entry')
      const record = entry as { id?: unknown; baseUrl?: unknown }
      if (typeof record.id !== 'string' || typeof record.baseUrl !== 'string') {
        throw new Error('profile file entry needs string id and baseUrl')
      }
      assertProfileId(record.id)
      profiles.set(record.id, { id: record.id, baseUrl: record.baseUrl })
    }
  }, 'remote-connector: load profiles')

  return {
    list() {
      return [...profiles.values()].map(profile => ({ ...profile }))
    },
    async upsert(input) {
      const id = assertProfileId(input.id)
      const { origin, token } = splitLoginUrl(input.loginUrl)
      profiles.set(id, { id, baseUrl: origin })
      tokens.set(id, token)
      await persist()
    },
    async remove(id) {
      assertProfileId(id)
      if (!profiles.delete(id)) throw new Error(`profile "${id}" does not exist`)
      tokens.delete(id)
      await persist()
    },
    async connectUrl(id) {
      assertProfileId(id)
      const profile = profiles.get(id)
      const token = tokens.get(id)
      if (profile === undefined || token === undefined) throw new Error(`profile "${id}" does not exist`)
      return `${profile.baseUrl}?token=${encodeURIComponent(token)}`
    },
  }
}
