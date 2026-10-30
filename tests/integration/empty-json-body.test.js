/**
 * Regression test for the "Content-Type: application/json" + empty body
 * bug (2026-10-30).
 *
 * Every client this backend serves (Dio in both Flutter apps, axios in the
 * dashboard) sets `Content-Type: application/json` on every request by
 * default, including a bodyless DELETE. Fastify's built-in JSON parser
 * rejects that with FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be empty
 * when content-type is set to 'application/json'") before the request
 * reaches auth or any route handler — so every no-body DELETE (remove
 * staff, delete a pickup slot, delete a garment rate, ...) 400'd
 * unconditionally, regardless of the route or the caller's permissions.
 * src/app.js now registers a custom 'application/json' content-type
 * parser that treats an empty body as `{}` instead of throwing.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  getClient: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  }),
}))

vi.mock('../../src/config/redis.js', () => {
  const store = new Map()
  return {
    redis: {
      set: vi.fn((key, val) => {
        store.set(key, val)
        return 'OK'
      }),
      get: vi.fn((key) => store.get(key) || null),
      del: vi.fn((key) => {
        store.delete(key)
        return 1
      }),
      multi: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        incr: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 0], [null, 1]]),
      })),
      scan: vi.fn().mockResolvedValue(['0', []]),
    },
  }
})

vi.mock('../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
  notificationQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  vendorAutoRejectQueue: { add: vi.fn() },
  slotHoldExpiryQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    JWT_ACCESS_SECRET: 'test-access-secret-32-chars-minimum-xx',
    JWT_ACCESS_EXPIRY: '24h',
    JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-minimum-xx',
    JWT_REFRESH_EXPIRY: '7d',
    COOKIE_SECRET: 'test-cookie-secret',
    ALLOW_DEMO_OTP: false,
    DEMO_OTP_PHONE: '',
    DEMO_OTP_CODE: '123456',
    OTP_EXPIRY_SECONDS: 300,
    SMS_PROVIDER: 'none',
    CORS_ORIGIN: '*',
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW: '1 minute',
    STRICT_SESSION_VERSION_CHECK: false,
    MULTI_VENDOR_PRODUCT_APPROVAL: false,
  },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}))

vi.mock('../../src/config/firebase.js', () => ({ messaging: { send: vi.fn() } }))
vi.mock('../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../src/utils/permission-audit.js', () => ({ installRouteCollector: vi.fn(() => []) }))
vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  default: async () => {},
  getSocketIo: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })) })),
}))

let app

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js')
  app = await buildApp()
  await app.ready()
}, 30000)

afterAll(async () => {
  if (app) await app.close()
})

describe('empty JSON body with Content-Type: application/json', () => {
  it('a bodyless DELETE no longer fails with FST_ERR_CTP_EMPTY_JSON_BODY', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/vendor/employees/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })

    const body = JSON.parse(res.body)
    expect(body.code).not.toBe('FST_ERR_CTP_EMPTY_JSON_BODY')
    // No token was sent, so it should fail auth (401) — proof the request
    // reached the route's auth guard instead of dying at body-parsing.
    expect(res.statusCode).toBe(401)
  })

  it('a genuinely malformed JSON body still 400s', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/vendor/employees/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    })

    expect(res.statusCode).toBe(400)
  })
})
