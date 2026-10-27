import { describe, it, expect, vi, beforeEach } from 'vitest'

const kv = new Map()
const zs = new Map()
vi.mock('../../src/config/redis.js', () => ({
  redis: {
    set: async (k, v) => { kv.set(k, v) },
    get: async (k) => kv.get(k) ?? null,
    exists: async (k) => (kv.has(k) ? 1 : 0),
    del: async (...ks) => { ks.forEach((k) => { kv.delete(k); zs.delete(k) }) },
    expire: async () => {},
    zadd: async (k, s, m) => { const a = zs.get(k) || new Map(); a.set(m, s); zs.set(k, a) },
    zremrangebyscore: async () => {},
    zcard: async (k) => (zs.get(k) || new Map()).size,
    zrange: async (k, a, b) => {
      const e = [...(zs.get(k) || new Map())].sort((x, y) => x[1] - y[1]).map((x) => x[0])
      return e.slice(a, b < 0 ? undefined : b + 1)
    },
    zrem: async (k, ...m) => { m.forEach((x) => zs.get(k)?.delete(x)) },
  },
}))

const { storeRefreshToken, isRefreshTokenValid, revokeRefreshToken, revokeAllRefreshTokens } =
  await import('../../src/modules/auth/refresh-token-store.js')

describe('refresh-token-store', () => {
  beforeEach(() => { kv.clear(); zs.clear() })

  it('a second login does not invalidate the first session', async () => {
    await storeRefreshToken('u1', 'phone-token')
    await storeRefreshToken('u1', 'other-device-token')
    expect(await isRefreshTokenValid('u1', 'phone-token')).toBe(true)
    expect(await isRefreshTokenValid('u1', 'other-device-token')).toBe(true)
  })

  it('rejects unknown tokens and other users', async () => {
    await storeRefreshToken('u1', 'a')
    expect(await isRefreshTokenValid('u1', 'nope')).toBe(false)
    expect(await isRefreshTokenValid('u2', 'a')).toBe(false)
  })

  it('still accepts a token issued before this change (legacy single slot)', async () => {
    kv.set('refresh:u1', 'old-token')
    expect(await isRefreshTokenValid('u1', 'old-token')).toBe(true)
  })

  it('rotation revokes only the rotated session', async () => {
    await storeRefreshToken('u1', 'a')
    await storeRefreshToken('u1', 'b')
    await storeRefreshToken('u1', 'a2')
    await revokeRefreshToken('u1', 'a')
    expect(await isRefreshTokenValid('u1', 'a')).toBe(false)
    expect(await isRefreshTokenValid('u1', 'a2')).toBe(true)
    expect(await isRefreshTokenValid('u1', 'b')).toBe(true)
  })

  it('revokeAll ends every session including the legacy one', async () => {
    kv.set('refresh:u1', 'old')
    await storeRefreshToken('u1', 'a')
    await storeRefreshToken('u1', 'b')
    await revokeAllRefreshTokens('u1')
    for (const t of ['old', 'a', 'b']) expect(await isRefreshTokenValid('u1', t)).toBe(false)
  })

  it('keeps at most 10 live sessions per user (oldest dropped)', async () => {
    for (let i = 0; i < 12; i++) { await storeRefreshToken('u1', `t${i}`); await new Promise((r) => setTimeout(r, 2)) }
    expect(await isRefreshTokenValid('u1', 't0')).toBe(false)
    expect(await isRefreshTokenValid('u1', 't1')).toBe(false)
    expect(await isRefreshTokenValid('u1', 't11')).toBe(true)
  })

  describe('rotation grace window (prevents random logouts on flaky networks)', () => {
    it('a rotated-away token still works briefly so a lost response can be retried', async () => {
      await storeRefreshToken('u1', 'old')
      await storeRefreshToken('u1', 'new')
      await revokeRefreshToken('u1', 'old', { graceSeconds: 120 })
      expect(await isRefreshTokenValid('u1', 'old')).toBe(true)
      expect(await isRefreshTokenValid('u1', 'new')).toBe(true)
    })

    it('stops working once the grace window has elapsed', async () => {
      await storeRefreshToken('u1', 'old')
      await revokeRefreshToken('u1', 'old', { graceSeconds: 120 })
      for (const k of [...kv.keys()]) if (k.startsWith('refresh_grace:')) kv.delete(k) // TTL expiry
      expect(await isRefreshTokenValid('u1', 'old')).toBe(false)
    })

    it('an explicit logout of a session is immediate (no grace)', async () => {
      await storeRefreshToken('u1', 'a')
      await revokeRefreshToken('u1', 'a', { graceSeconds: 0 })
      expect(await isRefreshTokenValid('u1', 'a')).toBe(false)
    })

    it('logout-everywhere also kills tokens that are inside a grace window', async () => {
      await storeRefreshToken('u1', 'old')
      await storeRefreshToken('u1', 'new')
      await revokeRefreshToken('u1', 'old', { graceSeconds: 120 })
      await revokeAllRefreshTokens('u1')
      expect(await isRefreshTokenValid('u1', 'old')).toBe(false)
      expect(await isRefreshTokenValid('u1', 'new')).toBe(false)
    })

    it('a fresh login right after logout-everywhere still works', async () => {
      await revokeAllRefreshTokens('u1')
      await storeRefreshToken('u1', 'fresh')
      expect(await isRefreshTokenValid('u1', 'fresh')).toBe(true)
    })

    it('grace is per user — it never lets another user in', async () => {
      await storeRefreshToken('u1', 'old')
      await revokeRefreshToken('u1', 'old', { graceSeconds: 120 })
      expect(await isRefreshTokenValid('u2', 'old')).toBe(false)
    })
  })
})
