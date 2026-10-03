import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

vi.mock('../../src/config/env.js', () => ({ env: { CORS_ORIGINS: 'http://localhost:5199', CORS_ALLOWED_VERCEL_HOSTS: '' } }))

describe('CORS preflight for the counter website', () => {
  it('lets the browser send the Idempotency-Key header on writes', async () => {
    const app = Fastify()
    await app.register((await import('../../src/plugins/cors.plugin.js')).default)
    app.post('/x', async () => ({ ok: true }))
    for (const origin of ['http://localhost:5199', 'https://pos.lndry.in', 'https://my-pos.vercel.app']) {
      const res = await app.inject({
        method: 'OPTIONS', url: '/x',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
      })
      expect(res.statusCode).toBe(204)
      expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key')
    }
  })

  it('still refuses unknown origins', async () => {
    const app = Fastify()
    await app.register((await import('../../src/plugins/cors.plugin.js')).default)
    app.post('/x', async () => ({ ok: true }))
    const res = await app.inject({ method: 'OPTIONS', url: '/x', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
