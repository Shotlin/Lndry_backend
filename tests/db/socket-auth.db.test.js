import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { io as connect } from 'socket.io-client'
import { DB_TESTS, applyTestEnv, makePool, seedUser, tokenFor, buildTestApp } from './harness.js'

/**
 * The dashboard authenticates its socket with the httpOnly `accessToken`
 * cookie (the JS never sees it), so the server must accept that cookie — but a
 * WebSocket handshake is not subject to CORS, so it must also refuse browser
 * Origins that are not ours (cross-site WebSocket hijacking).
 */
describe.skipIf(!DB_TESTS)('socket.io authentication & origin policy (real server)', () => {
  let app, pool, url, user, token
  const clients = []

  beforeAll(async () => {
    applyTestEnv()
    pool = makePool()
    app = await buildTestApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    url = `http://127.0.0.1:${app.server.address().port}`
    user = await seedUser(pool, { role: 'ADMIN', name: 'Socket Admin' })
    token = tokenFor(user)
  })
  afterAll(async () => {
    clients.forEach((c) => c.close())
    // Long-poll requests from the polling-transport cases keep sockets open.
    app?.server.closeAllConnections?.()
    await app?.close()
    await pool?.end()
  }, 30000)

  // Resolves 'connected' or the server's rejection message.
  const attempt = (opts) =>
    new Promise((resolve) => {
      const c = connect(url, { reconnection: false, timeout: 4000, ...opts })
      clients.push(c)
      c.on('connect', () => resolve('connected'))
      c.on('connect_error', (err) => resolve(`rejected:${err.message}`))
    })

  for (const transport of ['websocket', 'polling']) {
    describe(`transport=${transport}`, () => {
      const base = { transports: [transport] }

      it('accepts the httpOnly accessToken cookie from an allowed origin', async () => {
        const r = await attempt({ ...base, extraHeaders: { origin: 'https://admin.lndry.in', cookie: `accessToken=${token}` } })
        expect(r).toBe('connected')
      })

      it('accepts an explicit auth.token', async () => {
        const r = await attempt({ ...base, auth: { token } })
        expect(r).toBe('connected')
      })

      it('SECURITY: refuses a valid session cookie when the Origin is a foreign site (CSWSH)', async () => {
        const r = await attempt({ ...base, extraHeaders: { origin: 'https://evil.example', cookie: `accessToken=${token}` } })
        expect(r.startsWith('rejected:')).toBe(true)
        expect(r).not.toBe('connected')
      })

      it('SECURITY: refuses look-alike origins', async () => {
        const r = await attempt({ ...base, extraHeaders: { origin: 'https://lndry.in.evil.example', cookie: `accessToken=${token}` } })
        expect(r.startsWith('rejected:')).toBe(true)
      })

      it('refuses a connection with no credentials', async () => {
        const r = await attempt({ ...base, extraHeaders: { origin: 'https://admin.lndry.in' } })
        expect(r.startsWith('rejected:')).toBe(true)
      })

      it('refuses a forged or garbage token', async () => {
        const forged = tokenFor(user).slice(0, -4) + 'AAAA'
        expect((await attempt({ ...base, auth: { token: forged } })).startsWith('rejected:')).toBe(true)
        expect((await attempt({ ...base, extraHeaders: { cookie: 'accessToken=not-a-jwt' } })).startsWith('rejected:')).toBe(true)
      })
    })
  }
})
