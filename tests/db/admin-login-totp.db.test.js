import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcrypt'
import { DB_TESTS, applyTestEnv, makePool, buildTestApp, uid } from './harness.js'

/**
 * Authenticator-app (TOTP) two-factor is switched off by default
 * (ADMIN_2FA_ENABLED). The dashboard login must then work for EVERYONE —
 * including admins who had enabled TOTP earlier — and never ask for a code.
 * SMS OTP (2factor.in) is a different feature and is not affected.
 */
describe.skipIf(!DB_TESTS)('admin login with TOTP switched off (real DB)', () => {
  let app, pool
  const password = 'Correct-Horse-9!'
  const created = []

  async function seedAdmin({ totp }) {
    const email = `qa-${uid()}@example.com`
    const hash = await bcrypt.hash(password, 4)
    const { rows } = await pool.query(
      `INSERT INTO users (phone, name, role, email, password_hash, platform_role, totp_enabled, totp_secret)
       VALUES ($1, 'QA Admin', 'ADMIN', $2, $3, 'SUPER_ADMIN', $4, $5) RETURNING id`,
      [`9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, email, hash, totp, totp ? 'JBSWY3DPEHPK3PXP' : null]
    )
    created.push(rows[0].id)
    return email
  }
  const login = (email, pw = password) => app.inject({
    method: 'POST', url: '/api/v1/admin/auth/login',
    remoteAddress: `198.51.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`,
    payload: { email, password: pw },
  })

  describe('flag off (default)', () => {
    beforeAll(async () => {
      applyTestEnv({ ADMIN_2FA_ENABLED: 'false' })
      pool = makePool()
      app = await buildTestApp()
    })
    afterAll(async () => {
      await pool.query('DELETE FROM admin_activity_log WHERE admin_id = ANY($1)', [created]).catch(() => {})
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [created]).catch(() => {})
      await app?.close(); await pool?.end()
    })

    it('an admin WITHOUT TOTP logs straight in', async () => {
      const r = await login(await seedAdmin({ totp: false }))
      expect(r.statusCode).toBe(200)
      expect(r.json().data.requires2FA).toBeUndefined()
      expect(r.json().data.user.platform_role ?? r.json().data.isSuperAdmin).toBeTruthy()
    })

    it('an admin who had TOTP enabled also logs straight in — no MFA_PENDING, no code asked', async () => {
      const r = await login(await seedAdmin({ totp: true }))
      expect(r.statusCode).toBe(200)
      const d = r.json().data
      expect(d.requires2FA).toBeUndefined()
      expect(d.isSuperAdmin).toBe(true)
      expect(JSON.stringify(r.json())).not.toContain('MFA')
    })

    it('a wrong password is still rejected', async () => {
      const r = await login(await seedAdmin({ totp: true }), 'wrong-password')
      expect(r.statusCode).toBe(401)
    })

    it('high-risk (step-up) routes no longer demand a step-up token', async () => {
      const email = await seedAdmin({ totp: true })
      const l = await login(email)
      const token = l.json().data.accessToken
      const r = await app.inject({ method: 'GET', url: '/api/v1/admin/security/step-up', headers: { authorization: `Bearer ${token}` } })
      expect(r.statusCode).toBe(200)
      expect(r.json().data.enabled).toBe(false)
    })
  })
})
