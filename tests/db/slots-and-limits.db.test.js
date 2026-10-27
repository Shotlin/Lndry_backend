import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcrypt'
import { DB_TESTS, applyTestEnv, makePool, seedUser, seedAddress, seedVendor, tokenFor, buildTestApp, todayIst } from './harness.js'

const spot = () => ({ lat: 8 + Math.random() * 20, lng: 70 + Math.random() * 20 })

describe.skipIf(!DB_TESTS)('slot holds, rate limits & session safety (real PostgreSQL + Redis)', () => {
  let app, pool

  beforeAll(async () => {
    applyTestEnv()
    pool = makePool()
    app = await buildTestApp()
  })
  afterAll(async () => { await app?.close(); await pool?.end() })

  const quoteFor = async (user, vendor) => {
    const q = await pool.query(
      `INSERT INTO quotes (customer_id, vendor_id, estimate_paise, pricing_snapshot, expires_at, booking_type)
       VALUES ($1,$2,16000,'[]',NOW() + INTERVAL '1 hour','STANDARD') RETURNING id`, [user.id, vendor.id])
    return q.rows[0].id
  }
  const hold = (user, vendor, quoteId) => app.inject({
    method: 'POST', url: '/api/v1/slot-holds',
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    payload: { vendor_id: vendor.id, slot_id: vendor.slotId, date: todayIst(), quote_id: quoteId },
  })

  describe('slot holds', () => {
    it('REGRESSION: one customer re-quoting 6 times holds ONE place, not six', async () => {
      const vendor = await seedVendor(pool, { ...spot(), maxOrders: 3 })
      const user = await seedUser(pool)
      for (let i = 0; i < 6; i++) {
        const res = await hold(user, vendor, await quoteFor(user, vendor))
        expect(res.statusCode, `hold #${i + 1}`).toBe(201)
      }
      const active = await pool.query(`SELECT COUNT(*)::int AS n FROM slot_holds WHERE slot_id=$1 AND status='ACTIVE' AND expires_at > NOW()`, [vendor.slotId])
      expect(active.rows[0].n).toBe(1)

      // ...and the other customers still see free places.
      const other = await seedUser(pool)
      expect((await hold(other, vendor, await quoteFor(other, vendor))).statusCode).toBe(201)
    })

    it('capacity is still enforced across different customers', async () => {
      const vendor = await seedVendor(pool, { ...spot(), maxOrders: 2 })
      const users = await Promise.all([seedUser(pool), seedUser(pool), seedUser(pool)])
      const codes = []
      for (const u of users) codes.push((await hold(u, vendor, await quoteFor(u, vendor))).statusCode)
      expect(codes).toEqual([201, 201, 409])
    })

    it('REGRESSION: releasing a hold works (it used to 500 on a missing column)', async () => {
      const vendor = await seedVendor(pool, { ...spot(), maxOrders: 2 })
      const user = await seedUser(pool)
      const created = await hold(user, vendor, await quoteFor(user, vendor))
      const holdId = created.json().data?.id || created.json().id
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/slot-holds/${holdId}`, headers: { authorization: `Bearer ${tokenFor(user)}` } })
      expect(del.statusCode).toBeLessThan(300)
      const row = await pool.query('SELECT status FROM slot_holds WHERE id=$1', [holdId])
      expect(row.rows[0].status).toBe('RELEASED')
    })

    it('50 customers racing for 5 places → exactly 5 get one', async () => {
      const vendor = await seedVendor(pool, { ...spot(), maxOrders: 5 })
      const users = await Promise.all(Array.from({ length: 50 }, () => seedUser(pool)))
      const quotes = await Promise.all(users.map((u) => quoteFor(u, vendor)))
      const res = await Promise.all(users.map((u, i) => hold(u, vendor, quotes[i])))
      expect(res.filter((r) => r.statusCode === 201).length).toBe(5)
      expect(res.filter((r) => r.statusCode === 409).length).toBe(45)
    })
  })

  describe('rate limiting', () => {
    it('coupon-code guessing is throttled per account', async () => {
      const user = await seedUser(pool)
      const headers = { authorization: `Bearer ${tokenFor(user)}` }
      const codes = []
      for (let i = 0; i < 25; i++) {
        const r = await app.inject({ method: 'POST', url: '/api/v1/coupons/validate', headers, payload: { code: `GUESS${i}`, cartTotal: 500 } })
        codes.push(r.statusCode)
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5)
      // a different account is unaffected (limit follows the account, not the shared IP)
      const other = await seedUser(pool)
      const ok = await app.inject({ method: 'POST', url: '/api/v1/coupons/validate', headers: { authorization: `Bearer ${tokenFor(other)}` }, payload: { code: 'GUESS', cartTotal: 500 } })
      expect(ok.statusCode).not.toBe(429)
    })

    it('SECURITY: OTP requests are capped per PHONE no matter which (forged) address they come from', async () => {
      const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
      const results = []
      for (let i = 0; i < 9; i++) {
        const r = await app.inject({
          method: 'POST', url: '/api/v1/auth/send-otp',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}`, 'x-real-ip': `198.51.100.${i + 1}`, 'cf-connecting-ip': `192.0.2.${i + 1}` },
          payload: { phone },
        })
        results.push(r.statusCode)
      }
      // 5 per phone per 10 minutes regardless of the (forged) source address
      expect(results.filter((c) => c === 429).length).toBeGreaterThanOrEqual(4)
    })

  })

  describe('privilege boundaries', () => {
    it('SECURITY: a shop employee\'s token (role ADMIN + shop scope) is NOT a platform admin', async () => {
      const staff = await seedUser(pool, { role: 'ADMIN' })
      const target = await seedUser(pool)
      const headers = { authorization: `Bearer ${tokenFor(staff, { shopId: '00000000-0000-4000-8000-000000000001', shopRole: 'VENDOR_STAFF' })}` }
      const credit = await app.inject({ method: 'POST', url: `/api/v1/wallet/admin/${target.id}/credit`, headers, payload: { amount: 100000, description: 'free money' } })
      expect(credit.statusCode).toBe(403)
      const addMoney = await app.inject({ method: 'POST', url: '/api/v1/wallet/add-money', headers, payload: { amount: 1000 } })
      expect(addMoney.statusCode).toBe(403)
      const bal = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [target.id])
      expect(Number(bal.rows[0]?.balance ?? 0)).toBe(0)
    })

    it('a genuine HQ admin token still passes the same gate', async () => {
      const admin = await seedUser(pool, { role: 'ADMIN' })
      const target = await seedUser(pool)
      const headers = { authorization: `Bearer ${tokenFor(admin, { platform_role: 'SUPER_ADMIN' })}` }
      const res = await app.inject({ method: 'POST', url: `/api/v1/wallet/admin/${target.id}/credit`, headers, payload: { amount: 25, description: 'goodwill' } })
      expect(res.statusCode).toBeLessThan(300)
    })

    it('SECURITY: select-role cannot be used to mint an ADMIN token', async () => {
      const staff = await seedUser(pool, { role: 'CUSTOMER' })
      const vendor = await seedVendor(pool, spot())
      await pool.query(
        `INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_STAFF',true)`, [vendor.id, staff.id]
      )
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/select-role',
        headers: { authorization: `Bearer ${tokenFor(staff)}` },
        payload: { role: 'ADMIN', vendor_id: vendor.id },
      })
      expect(res.statusCode).toBe(403)
    })

    it('SECURITY: an admin account locks after repeated wrong passwords even when the attacker rotates IP addresses', async () => {
      const email = `admin-${Math.random().toString(36).slice(2, 8)}@example.com`
      const hash = await bcrypt.hash('Correct#Horse1', 4)
      await pool.query(
        `INSERT INTO users (phone, email, name, role, password_hash, is_active) VALUES ($1, $2, 'Lock Test', 'ADMIN', $3, true)`,
        [`s:${Math.random().toString(36).slice(2, 10)}`, email, hash]
      )
      const attempt = (ip, password) => app.inject({
        method: 'POST', url: '/api/v1/admin/auth/login', remoteAddress: ip, payload: { email, password },
      })
      const codes = []
      for (let i = 1; i <= 10; i++) codes.push((await attempt(`203.0.113.${i}`, 'wrong-password')).statusCode)
      expect(codes.join(',')).toBe('401,401,401,401,401,401,401,401,429,429')
      expect(codes.slice(8).every((c) => c === 429)).toBe(true)
      // ...and the right password is refused while locked
      expect((await attempt('203.0.113.99', 'Correct#Horse1')).statusCode).toBe(429)
    })

    it('logging out of one session leaves the other devices signed in', async () => {
      const { storeRefreshToken, isRefreshTokenValid } = await import('../../src/modules/auth/refresh-token-store.js')
      const user = await seedUser(pool)
      await storeRefreshToken(user.id, `phone-${user.id}`)
      await storeRefreshToken(user.id, `partner-app-${user.id}`)
      const out = await app.inject({
        method: 'POST', url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${tokenFor(user)}` },
        payload: { refreshToken: `phone-${user.id}` },
      })
      expect(out.statusCode).toBe(200)
      expect(await isRefreshTokenValid(user.id, `phone-${user.id}`)).toBe(false)
      expect(await isRefreshTokenValid(user.id, `partner-app-${user.id}`)).toBe(true)
    })
  })
})
