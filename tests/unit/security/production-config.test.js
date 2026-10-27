import { describe, it, expect, vi } from 'vitest'

// env.js validates process.env at import; give it a minimal valid environment.
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40)
process.env.JWT_REFRESH_SECRET = 'b'.repeat(40)
process.env.DB_NAME = 't'
process.env.DB_USER = 't'
process.env.DB_PASSWORD = 'testpassword'
vi.spyOn(process, 'exit').mockImplementation(() => undefined)

const { findProductionConfigProblems } = await import('../../../src/config/env.js')

const safe = {
  NODE_ENV: 'production',
  TEST_BYPASS_OTP_PHONES: '',
  ALLOW_DEMO_OTP: false,
  ALLOW_MOCK_PAYMENT: false,
  ALLOW_ALL_PINCODES: false,
  ALLOW_DEMO_DELIVERY_ACTIONS: false,
  ALLOW_AUTO_APPROVE_VENDOR: false,
  RATE_LIMIT_ENABLED: true,
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_REFRESH_SECRET: 'y'.repeat(40),
  DB_PASSWORD: 'a-real-db-password',
  CORS_ALLOWED_VERCEL_HOSTS: 'lndry.vercel.app',
  REDIS_PASSWORD: 'r',
  SENTRY_DSN: 'https://x@y/1',
  STRICT_SESSION_VERSION_CHECK: true,
  DB_HOST: 'localhost',
}

describe('production safety gate', () => {
  it('passes a clean production config', () => {
    expect(findProductionConfigProblems(safe).fatal).toEqual([])
  })
  it('does nothing outside production', () => {
    expect(findProductionConfigProblems({ ...safe, NODE_ENV: 'development', TEST_BYPASS_OTP_PHONES: '*' }).fatal).toEqual([])
  })
  it('refuses the wildcard OTP bypass', () => {
    expect(findProductionConfigProblems({ ...safe, TEST_BYPASS_OTP_PHONES: '*' }).fatal.join()).toMatch(/TEST_BYPASS_OTP_PHONES/)
    expect(findProductionConfigProblems({ ...safe, TEST_BYPASS_OTP_PHONES: '9876543210, *' }).fatal.length).toBe(1)
  })
  it('allows a short explicit allow-list', () => {
    expect(findProductionConfigProblems({ ...safe, TEST_BYPASS_OTP_PHONES: '9876543210' }).fatal).toEqual([])
  })
  it.each([
    ['ALLOW_DEMO_OTP'], ['ALLOW_MOCK_PAYMENT'], ['ALLOW_ALL_PINCODES'],
    ['ALLOW_DEMO_DELIVERY_ACTIONS'], ['ALLOW_AUTO_APPROVE_VENDOR'],
  ])('refuses %s=true', (flag) => {
    expect(findProductionConfigProblems({ ...safe, [flag]: true }).fatal.join()).toMatch(new RegExp(flag))
  })
  it('refuses disabled rate limiting, identical or placeholder secrets', () => {
    expect(findProductionConfigProblems({ ...safe, RATE_LIMIT_ENABLED: false }).fatal.length).toBe(1)
    expect(findProductionConfigProblems({ ...safe, JWT_REFRESH_SECRET: safe.JWT_ACCESS_SECRET }).fatal.length).toBe(1)
    expect(findProductionConfigProblems({ ...safe, DB_PASSWORD: 'replace-me-please' }).fatal.length).toBe(1)
  })
  it('warns (does not block) about softer issues', () => {
    const r = findProductionConfigProblems({ ...safe, CORS_ALLOWED_VERCEL_HOSTS: undefined, SENTRY_DSN: undefined })
    expect(r.fatal).toEqual([])
    expect(r.warn.length).toBeGreaterThanOrEqual(2)
  })
})
