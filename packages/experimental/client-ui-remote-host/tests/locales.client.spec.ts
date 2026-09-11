// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

describe('remote-host locales', () => {
  it('keeps English and Chinese keys aligned', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(NS).toBe('remoteHosts')
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })

  it('exposes a no-op host half', () => {
    expect(hostApply()).toBeUndefined()
  })
})
