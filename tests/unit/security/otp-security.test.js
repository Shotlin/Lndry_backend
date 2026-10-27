import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── In-memory fakes ───────────────────────────────────────────────────────
const kv = new Map()
const fakeRedis = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  set: async (k, v, ...rest) => {
    if (rest.includes('NX') && kv.has(k)) return null
    kv.set(k, v)
    return 'OK'
  },
  del: async (...ks) => { ks.forEach((k) => kv.delete(k)); return ks.length },
  multi: () => {
    const ops = []
    const chain = {
      set: (k, v, ...rest) => { ops.push(() => fakeRedis.set(k, v, ...rest)); return chain },
      incr: (k) => { ops.push(async () => { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, n); return n }); return chain },
      exec: async () => Promise.all(ops.map(async (op) => [null, await op()])),
    }
    return chain
  },
}

const envState = {
  NODE_ENV: 'production',
  SMS_PROVIDER: '2factor',
  OTP_EXPIRY_SECONDS: 300,
  OTP_LOCKOUT_SECONDS: 1800,
  OTP_MAX_ATTEMPTS: 5,
  OTP_LENGTH: 6,
  ALLOW_DEMO_OTP: false,
  DEMO_OTP_PHONE: '',
  DEMO_OTP_CODE: '123456',
  TEST_BYPASS_OTP_PHONES: '',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  JWT_ACCESS_EXPIRY: '15m',
  JWT_REFRESH_EXPIRY: '365d',
}

vi.mock('../../../src/config/env.js', () => ({ env: envState }))
vi.mock('../../../src/config/redis.js', () => ({ redis: fakeRedis }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/database.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))

const smsState = { sendOk: true, verifyOk: false }
vi.mock('../../../src/utils/sms.js', () => ({
  sendSmsOtp: vi.fn(async () =>
    smsState.sendOk ? { success: true, sessionId: 'sess-1' } : { success: false, message: 'down' }),
  verifySmsOtp: vi.fn(async () => ({ success: smsState.verifyOk })),
}))
vi.mock('../../../src/utils/sms-config.js', () => ({ getSmsConfig: vi.fn(async () => ({ apiKey: 'k', template: 't' })) }))

vi.mock('../../../src/modules/auth/refresh-token-store.js', () => ({
  storeRefreshToken: vi.fn(),
  isRefreshTokenValid: vi.fn(async () => true),
  revokeRefreshToken: vi.fn(),
  revokeAllRefreshTokens: vi.fn(),
  ROTATION_GRACE_SECONDS: 120,
}))

const { AuthService } = await import('../../../src/modules/auth/auth.service.js')

function makeRepo() {
  const challenges = new Map()
  let seq = 0
  return {
    challenges,
    createOtpChallenge: vi.fn(async ({ phone, otpHash, accountType, expiresAt }) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
      challenges.set(id, { id, phone, otp_hash: otpHash, account_type: accountType, expires_at: expiresAt, attempts: 0 })
      return { id, expires_at: expiresAt }
    }),
    getOtpChallenge: vi.fn(async (id, phone) => {
      const c = challenges.get(id)
      return c && c.phone === phone ? { ...c } : null
    }),
    reserveOtpAttempt: vi.fn(async (id, phone, max) => {
      const c = challenges.get(id)
      if (!c || c.phone !== phone || c.attempts >= max) return null
      c.attempts += 1
      return { attempts: c.attempts }
    }),
    deleteOtpChallenge: vi.fn(async (id) => { challenges.delete(id) }),
    findByPhone: vi.fn(async (phone) => ({ id: 'user-1', phone, role: 'CUSTOMER', is_active: true, name: 'T' })),
    findActiveShopStaffByUserId: vi.fn(async () => []),
    registerDevice: vi.fn(),
  }
}

const PHONE = '9876543210'

describe('OTP security (production, SMS provider configured)', () => {
  let repo
  let service
  beforeEach(() => {
    kv.clear()
    smsState.sendOk = true
    smsState.verifyOk = false
    envState.NODE_ENV = 'production'
    envState.TEST_BYPASS_OTP_PHONES = ''
    repo = makeRepo()
    service = new AuthService(repo)
  })

  it('REGRESSION: the well-known code 123456 must NOT log anyone in after an SMS was sent', async () => {
    const { challenge_id } = await service.sendOtp(PHONE)
    const result = await service.verifyOtp(PHONE, challenge_id, '123456')
    expect(result.success).toBe(false)
  })

  it('does not store a guessable hash for SMS-delivered codes', async () => {
    const { challenge_id } = await service.sendOtp(PHONE)
    const stored = repo.challenges.get(challenge_id).otp_hash
    const crypto = await import('node:crypto')
    expect(stored).not.toBe(crypto.createHash('sha256').update('123456').digest('hex'))
  })

  it('accepts the code when the SMS provider approves it', async () => {
    const { challenge_id } = await service.sendOtp(PHONE)
    smsState.verifyOk = true
    const result = await service.verifyOtp(PHONE, challenge_id, '482913', { device_id: 'd' })
    expect(result.success).toBe(true)
  })

  it('never echoes the OTP in the response in production', async () => {
    const data = await service.sendOtp(PHONE)
    expect(data.otp).toBeUndefined()
  })

  it('tells the user when the SMS could not be sent instead of silently continuing', async () => {
    smsState.sendOk = false
    await expect(service.sendOtp(PHONE)).rejects.toMatchObject({ statusCode: 503, code: 'OTP_DELIVERY_FAILED' })
  })

  it('does not echo the fixed review code for allow-listed numbers in production', async () => {
    envState.TEST_BYPASS_OTP_PHONES = PHONE
    const data = await service.sendOtp(PHONE)
    expect(data.otp).toBeUndefined()
    const result = await service.verifyOtp(PHONE, data.challenge_id, '123456', { device_id: 'd' })
    expect(result.success).toBe(true)
  })

  it('locks a challenge after 3 wrong codes even when guesses arrive in parallel', async () => {
    const { challenge_id } = await service.sendOtp(PHONE)
    smsState.verifyOk = false
    const guesses = Array.from({ length: 50 }, (_, i) => String(100000 + i))
    const results = await Promise.all(guesses.map((g) => service.verifyOtp(PHONE, challenge_id, g)))
    expect(results.every((r) => r.success === false)).toBe(true)
    // Only 3 attempts were ever allowed to reach the comparison.
    expect(repo.reserveOtpAttempt.mock.results.length).toBe(50)
    const granted = (await Promise.all(repo.reserveOtpAttempt.mock.results.map((r) => r.value))).filter(Boolean)
    expect(granted.length).toBe(3)
  })

  it('locks the phone after repeated failures across fresh challenges', async () => {
    let last
    for (let i = 0; i < 12; i++) {
      kv.delete(`otp_limit:${PHONE}`) // bypass the send-rate cap to model a patient attacker
      const { challenge_id } = await service.sendOtp(PHONE)
      last = await service.verifyOtp(PHONE, challenge_id, '000000')
    }
    expect(last.success).toBe(false)
    expect(last.message).toMatch(/try again after some time/i)
  })

  it('rate-limits OTP requests per phone', async () => {
    for (let i = 0; i < 5; i++) await service.sendOtp(PHONE)
    await expect(service.sendOtp(PHONE)).rejects.toMatchObject({ statusCode: 429 })
  })
})
