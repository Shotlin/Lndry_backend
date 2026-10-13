import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_ACCESS_SECRET: 'j'.repeat(40), SETTINGS_ENCRYPTION_KEY: 'k'.repeat(40) },
}))
vi.mock('../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../src/config/database.js', () => ({ query: vi.fn(), pool: { query: vi.fn() } }))
vi.mock('../../src/config/razorpay.js', () => ({ getRazorpay: vi.fn(async () => null) }))

const { encryptSecret, decryptSecret, maskSecret } = await import('../../src/utils/secret-box.js')
const { RazorpaySettingsService } = await import('../../src/modules/admin/razorpay-settings/razorpay-settings.service.js')
const { TwoFactorSettingsService } = await import('../../src/modules/admin/two-factor-settings/two-factor-settings.service.js')

describe('secret-box', () => {
  it('round-trips, never stores plaintext, and detects tampering', () => {
    const blob = encryptSecret('super-secret-value')
    expect(blob).not.toContain('super-secret-value')
    expect(decryptSecret(blob)).toBe('super-secret-value')
    expect(encryptSecret('super-secret-value')).not.toBe(blob) // random IV
    expect(() => decryptSecret(blob.slice(0, -4) + 'AAAA')).toThrow()
    expect(encryptSecret('')).toBeNull()
    expect(decryptSecret(null)).toBeNull()
  })
  it('masks to the last four characters only', () => {
    expect(maskSecret('abcdefgh1234')).toBe('••••1234')
    expect(maskSecret(null)).toBeNull()
  })
})

describe('Razorpay key/mode guard (no network reached)', () => {
  const svc = new RazorpaySettingsService({})
  it('rejects a live key in the TEST slot and vice versa', async () => {
    const a = await svc._ping('TEST', 'rzp_live_ABCDEF123456', 'x')
    expect(a.success).toBe(false)
    expect(a.message).toMatch(/LIVE key.*Live section/)
    const b = await svc._ping('LIVE', 'rzp_test_ABCDEF123456', 'x')
    expect(b.message).toMatch(/TEST key.*Test section/)
  })
  it('rejects malformed key ids and missing fields', async () => {
    expect((await svc._ping('TEST', 'nonsense', 'x')).success).toBe(false)
    expect((await svc._ping('TEST', '', '')).success).toBe(false)
  })
  it('only accepts TEST or LIVE', () => {
    expect(svc._mode('live')).toBe('LIVE')
    expect(() => svc._mode('staging')).toThrow()
  })
})

describe('2Factor input validation', () => {
  const svc = new TwoFactorSettingsService({ get: vi.fn(async () => null) })
  it('rejects odd template names before touching the network', async () => {
    await expect(svc.save({ template: 'bad/../tpl' }, null)).rejects.toMatchObject({ statusCode: 400 })
  })
  it('rejects an invalid phone for the test OTP', async () => {
    await expect(svc.sendTestOtp('12345')).rejects.toMatchObject({ statusCode: 400 })
  })
})
