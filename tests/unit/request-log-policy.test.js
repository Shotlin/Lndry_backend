import { describe, it, expect } from 'vitest'
import Fastify, { LogController } from 'fastify'
import {
  isQuietPath,
  shouldDisableRequestLogging,
  shouldLogCompleted,
} from '../../src/utils/request-log-policy.js'

describe('request log policy', () => {
  it('treats only /health and its children as quiet', () => {
    expect(isQuietPath('/health')).toBe(true)
    expect(isQuietPath('/health/ready')).toBe(true)
    expect(isQuietPath('/health?x=1')).toBe(true)
    expect(isQuietPath('/healthz')).toBe(false)
    expect(isQuietPath('/api/v1/health')).toBe(false)
    expect(isQuietPath(undefined)).toBe(false)
  })

  it('all: logs everything except health', () => {
    expect(shouldDisableRequestLogging('/health', 'all')).toBe(true)
    expect(shouldDisableRequestLogging('/api/v1/orders', 'all')).toBe(false)
  })

  it('errors/off: suppress the built-in lines for every route', () => {
    expect(shouldDisableRequestLogging('/api/v1/orders', 'errors')).toBe(true)
    expect(shouldDisableRequestLogging('/api/v1/orders', 'off')).toBe(true)
  })

  it('errors: re-logs failures and slow requests only', () => {
    const base = { mode: 'errors', url: '/api/v1/orders', slowMs: 1000 }
    expect(shouldLogCompleted({ ...base, statusCode: 200, elapsedMs: 40 })).toBe(false)
    expect(shouldLogCompleted({ ...base, statusCode: 200, elapsedMs: 1500 })).toBe(true)
    expect(shouldLogCompleted({ ...base, statusCode: 401, elapsedMs: 3 })).toBe(true)
    expect(shouldLogCompleted({ ...base, statusCode: 500, elapsedMs: 3 })).toBe(true)
    // a slow health probe is not interesting, a failing one is
    expect(shouldLogCompleted({ ...base, url: '/health', statusCode: 200, elapsedMs: 5000 })).toBe(false)
    expect(shouldLogCompleted({ ...base, url: '/health/ready', statusCode: 503, elapsedMs: 5 })).toBe(true)
  })

  it('all/off never re-log from the hook', () => {
    for (const mode of ['all', 'off']) {
      expect(shouldLogCompleted({ mode, url: '/x', statusCode: 500, elapsedMs: 9999, slowMs: 1 })).toBe(false)
    }
  })

  // End-to-end against real Fastify: counts the log lines each mode really emits.
  async function countLines(mode, paths) {
    const lines = []
    const stream = { write: (s) => lines.push(JSON.parse(s)) }
    const app = Fastify({
      logger: { level: 'info', stream },
      logController: new LogController({
        disableRequestLogging: (req) => shouldDisableRequestLogging(req.url, mode),
      }),
    })
    app.get('/health', async () => ({ ok: true }))
    app.get('/api/x', async () => ({ ok: true }))
    app.get('/api/fail', async (_req, reply) => reply.code(404).send({ ok: false }))
    for (const p of paths) await app.inject({ method: 'GET', url: p })
    await app.close()
    return lines.filter((l) => l.msg === 'incoming request' || l.msg === 'request completed').length
  }

  it('real Fastify: all mode emits 2 lines per non-health request and none for health', async () => {
    expect(await countLines('all', ['/api/x'])).toBe(2)
    expect(await countLines('all', ['/health'])).toBe(0)
  })

  it('real Fastify: errors and off modes emit none of the built-in lines', async () => {
    expect(await countLines('errors', ['/api/x', '/api/fail', '/health'])).toBe(0)
    expect(await countLines('off', ['/api/x'])).toBe(0)
  })
})
