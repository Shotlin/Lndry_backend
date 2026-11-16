import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
const redisMock = {
  get: vi.fn(async (k) => store.get(k) ?? null),
  set: vi.fn(async (k, v) => { store.set(k, v); return 'OK' }),
  del: vi.fn(async (...ks) => { ks.forEach((k) => store.delete(k)); return ks.length }),
  scan: vi.fn(async () => ['0', []]),
}
vi.mock('../../src/config/redis.js', () => ({ redis: redisMock }))
vi.mock('../../src/config/env.js', () => ({ env: { REDIS_TTL_DEFAULT: 60 } }))
vi.mock('../../src/config/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { cacheWrap, cacheGet, cacheSet, cacheDel, CACHE_OP_TIMEOUT_MS, _resetCacheBreaker } = await import('../../src/utils/cache.js')

beforeEach(() => {
  _resetCacheBreaker()
  store.clear()
  vi.clearAllMocks()
  redisMock.get.mockImplementation(async (k) => store.get(k) ?? null)
  redisMock.set.mockImplementation(async (k, v) => { store.set(k, v); return 'OK' })
  redisMock.del.mockImplementation(async (...ks) => { ks.forEach((k) => store.delete(k)); return ks.length })
})

describe('cacheWrap', () => {
  it('runs the loader once, then serves from cache', async () => {
    const loader = vi.fn(async () => [{ id: 1 }])
    expect(await cacheWrap('k', 60, loader)).toEqual([{ id: 1 }])
    expect(await cacheWrap('k', 60, loader)).toEqual([{ id: 1 }])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(redisMock.set).toHaveBeenCalledWith('k', JSON.stringify([{ id: 1 }]), 'EX', 60)
  })

  it('collapses concurrent misses into ONE loader call (no stampede)', async () => {
    let resolve
    const loader = vi.fn(() => new Promise((r) => { resolve = r }))
    const calls = Promise.all([cacheWrap('s', 60, loader), cacheWrap('s', 60, loader), cacheWrap('s', 60, loader)])
    await new Promise((r) => setTimeout(r, 10))
    resolve(['x'])
    expect(await calls).toEqual([['x'], ['x'], ['x']])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not cache null/undefined', async () => {
    const loader = vi.fn(async () => null)
    await cacheWrap('n', 60, loader)
    await cacheWrap('n', 60, loader)
    expect(loader).toHaveBeenCalledTimes(2)
    expect(redisMock.set).not.toHaveBeenCalled()
  })

  it('falls back to the loader when Redis throws', async () => {
    redisMock.get.mockRejectedValue(new Error('ECONNREFUSED'))
    redisMock.set.mockRejectedValue(new Error('ECONNREFUSED'))
    const loader = vi.fn(async () => ['db'])
    expect(await cacheWrap('d', 60, loader)).toEqual(['db'])
  })

  it('falls back (fast) when Redis HANGS instead of hanging the request', async () => {
    redisMock.get.mockImplementation(() => new Promise(() => {}))
    redisMock.set.mockImplementation(() => new Promise(() => {}))
    const loader = vi.fn(async () => ['db'])
    const t0 = Date.now()
    expect(await cacheWrap('h', 60, loader)).toEqual(['db'])
    expect(Date.now() - t0).toBeLessThan(CACHE_OP_TIMEOUT_MS * 4 + 200)
  })

  it('after one failure the breaker skips Redis, so later requests pay nothing', async () => {
    redisMock.get.mockImplementation(() => new Promise(() => {}))
    const loader = vi.fn(async () => ['db'])
    await cacheWrap('b1', 60, loader) // pays the timeout once
    redisMock.get.mockClear()
    const t0 = Date.now()
    await cacheWrap('b2', 60, loader)
    expect(Date.now() - t0).toBeLessThan(50)
    expect(redisMock.get).not.toHaveBeenCalled()
  })

  it('a loader error is propagated and not cached', async () => {
    const loader = vi.fn(async () => { throw new Error('db down') })
    await expect(cacheWrap('e', 60, loader)).rejects.toThrow('db down')
    const ok = vi.fn(async () => ['ok'])
    expect(await cacheWrap('e', 60, ok)).toEqual(['ok'])
  })
})

describe('plain helpers fail open', () => {
  it('cacheGet returns null, cacheSet/cacheDel do not throw when Redis is down', async () => {
    redisMock.get.mockRejectedValue(new Error('down'))
    redisMock.set.mockRejectedValue(new Error('down'))
    redisMock.del.mockRejectedValue(new Error('down'))
    expect(await cacheGet('x')).toBeNull()
    await expect(cacheSet('x', 1)).resolves.toBeUndefined()
    await expect(cacheDel('x')).resolves.toBeUndefined()
  })
})
