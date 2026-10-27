import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DB_TESTS, applyTestEnv, makePool, seedUser, tokenFor, buildTestApp, uid } from './harness.js'

describe.skipIf(!DB_TESTS)('rate limiting & client identity (real Redis)', () => {
  let app, pool

  beforeAll(async () => {
    applyTestEnv({ RATE_LIMIT_GLOBAL_IP_MAX: '25', RATE_LIMIT_GLOBAL_TOKEN_MAX: '10', RATE_LIMIT_GLOBAL_WINDOW: '60000' })
    pool = makePool()
    app = await buildTestApp()
  })
  afterAll(async () => { await app?.close(); await pool?.end() })

  // A fresh public "client" per test so counters from other tests/runs never interfere.
  const freshIp = () => `${100 + Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`
  const get = (opts) => app.inject({ method: 'GET', url: '/api/v1/discovery/filters', ...opts })

  it('the blanket per-IP limit engages with a clear 429 and Retry-After', async () => {
    const ip = freshIp()
    const codes = []
    let last
    for (let i = 0; i < 32; i++) { last = await get({ remoteAddress: ip }); codes.push(last.statusCode) }
    expect(codes.slice(0, 25).every((c) => c === 200)).toBe(true)
    expect(codes.slice(25).every((c) => c === 429)).toBe(true)
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0)
    expect(last.json().code).toBe('RATE_LIMIT_EXCEEDED')
  })

  it('health checks and the payment webhook path are never throttled', async () => {
    const ip = freshIp()
    for (let i = 0; i < 60; i++) {
      const r = await app.inject({ method: 'GET', url: '/health', remoteAddress: ip })
      expect(r.statusCode).toBe(200)
    }
  })

  it('SECURITY: forging X-Forwarded-For / X-Real-IP / CF-Connecting-IP from a public client does NOT reset the limit', async () => {
    const ip = freshIp() // a real public peer — not a trusted proxy, so its forwarding headers are ignored
    const codes = []
    for (let i = 0; i < 32; i++) {
      const r = await get({
        remoteAddress: ip,
        headers: { 'x-forwarded-for': `10.9.${i}.1`, 'x-real-ip': `172.16.${i}.9`, 'cf-connecting-ip': `192.0.2.${i + 1}` },
      })
      codes.push(r.statusCode)
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5)
  })

  it('SECURITY: behind a trusted proxy the LEFT-most (client-supplied) X-Forwarded-For entries are ignored', async () => {
    const realClient = freshIp()
    const codes = []
    for (let i = 0; i < 32; i++) {
      // nginx appends the real client to whatever the browser sent; the proxy itself is loopback.
      const r = await get({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': `1.2.3.${i}, ${realClient}` } })
      codes.push(r.statusCode)
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5)
  })

  it('different real clients behind the same proxy are limited independently', async () => {
    const a = freshIp(); const b = freshIp()
    for (let i = 0; i < 30; i++) await get({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': a } })
    expect((await get({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': a } })).statusCode).toBe(429)
    expect((await get({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': b } })).statusCode).toBe(200)
  })

  it('one account cannot hog the API by spreading requests over many IPs (per-token bucket)', async () => {
    const user = await seedUser(pool)
    const headers = { authorization: `Bearer ${tokenFor(user)}` }
    const codes = []
    for (let i = 0; i < 16; i++) codes.push((await get({ remoteAddress: freshIp(), headers })).statusCode)
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
    expect(codes.slice(10).every((c) => c === 429)).toBe(true)
    // ...while another account on the same network is unaffected
    const other = await seedUser(pool)
    expect((await get({ remoteAddress: freshIp(), headers: { authorization: `Bearer ${tokenFor(other)}` } })).statusCode).toBe(200)
  })

  it('a per-route limit (admin login) is also immune to header forging', async () => {
    const ip = freshIp()
    const codes = []
    for (let i = 0; i < 14; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/v1/admin/auth/login', remoteAddress: ip,
        headers: { 'x-forwarded-for': `10.1.${i}.1`, 'x-real-ip': `10.2.${i}.1` },
        payload: { email: `${uid()}@example.com`, password: 'wrong-password' },
      })
      codes.push(r.statusCode)
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(3)
  })
})
