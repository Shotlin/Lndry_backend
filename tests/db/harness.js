/**
 * Real-database test harness.
 *
 * These tests boot the actual Fastify app against a real PostgreSQL + Redis, so
 * SQL, constraints, locks and concurrency are exercised for real (the unit
 * tests mock all of that). They are skipped unless LNDRY_DB_TESTS=1.
 *
 *   docker run -d --name lndry-audit-pg -e POSTGRES_USER=lndry_user \
 *     -e POSTGRES_PASSWORD=audit_pw_local -e POSTGRES_DB=lndry_audit -p 55432:5432 postgres:16-alpine
 *   docker run -d --name lndry-audit-redis -p 56379:6379 redis:7-alpine
 *   DB_HOST=localhost DB_PORT=55432 DB_NAME=lndry_audit DB_USER=lndry_user DB_PASSWORD=audit_pw_local \
 *     node src/database/migrate.js
 *   LNDRY_DB_TESTS=1 npx vitest run tests/db
 */
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'

export const DB_TESTS = process.env.LNDRY_DB_TESTS === '1'

export const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  PORT: '0',
  JWT_ACCESS_SECRET: 'db-test-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'db-test-refresh-secret-0123456789abcdef',
  COOKIE_SECRET: 'db-test-cookie-secret-0123456789',
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: process.env.DB_PORT || '55432',
  DB_NAME: process.env.DB_NAME || 'lndry_audit',
  DB_USER: process.env.DB_USER || 'lndry_user',
  DB_PASSWORD: process.env.DB_PASSWORD || 'audit_pw_local',
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: process.env.REDIS_PORT || '56379',
  BULL_REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  BULL_REDIS_PORT: process.env.REDIS_PORT || '56379',
  RATE_LIMIT_ENABLED: 'true',
  OTP_RATE_LIMIT_MAX: '1000',
  ALLOW_MOCK_PAYMENT: 'false',
  ENABLE_SWAGGER: 'false',
  STRICT_PERMISSION_AUDIT: 'false',
}

export function applyTestEnv(overrides = {}) {
  Object.assign(process.env, TEST_ENV, overrides)
}

export function makePool() {
  return new pg.Pool({
    host: TEST_ENV.DB_HOST,
    port: Number(TEST_ENV.DB_PORT),
    database: TEST_ENV.DB_NAME,
    user: TEST_ENV.DB_USER,
    password: TEST_ENV.DB_PASSWORD,
    max: 10,
  })
}

export const uid = () => crypto.randomUUID()
const rnd = () => crypto.randomBytes(4).toString('hex')

export function tokenFor(user, extra = {}) {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role || 'CUSTOMER', ...extra },
    TEST_ENV.JWT_ACCESS_SECRET,
    { expiresIn: '1h' }
  )
}

export async function seedUser(pool, { role = 'CUSTOMER', name = 'Test User' } = {}) {
  // Random 10-digit numbers collide eventually on a reused database; retry.
  for (let attempt = 0; ; attempt++) {
    const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (phone, name, role) VALUES ($1, $2, $3) RETURNING id, phone, role`,
        [phone, name, role]
      )
      return rows[0]
    } catch (err) {
      if (err.code !== '23505' || attempt >= 8) throw err
    }
  }
}

export async function seedAddress(pool, userId, { lat, lng, isDefault = true, pincode = '700001' }) {
  if (isDefault) await pool.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId])
  const { rows } = await pool.query(
    `INSERT INTO addresses (user_id, label, address_line1, city, state, pincode, lat, lng, is_default)
     VALUES ($1, 'Home', '12 Test Street', 'Kolkata', 'West Bengal', $2, $3, $4, $5) RETURNING id`,
    [userId, pincode, lat, lng, isDefault]
  )
  return rows[0].id
}

/** A fully orderable vendor (approved, published, one service+rate, one slot) unless told otherwise. */
export async function seedVendor(pool, {
  lat, lng, radius = 5, deliveryRadius = 5, name = `Vendor ${rnd()}`,
  status = 'APPROVED', approved = true, published = true, enabled = true, active = true,
  withService = true, withSlot = true, pincode = '700001', maxOrders = 5,
}) {
  const { rows } = await pool.query(
    `INSERT INTO vendors (name, slug, branch_code, address_line1, city, state, pincode, lat, lng,
                          approved_service_radius_km, delivery_radius_km, status, vendor_approved,
                          marketplace_published, account_enabled, is_active)
     VALUES ($1, $2, $3, '1 Vendor Rd', 'Kolkata', 'West Bengal', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${rnd()}`, `VND-${rnd().toUpperCase()}`, pincode, lat, lng,
     radius, deliveryRadius, status, approved, published, enabled, active]
  )
  const vendorId = rows[0].id
  let garmentTypeId = null
  if (withService) {
    const gt = await pool.query('SELECT id, category_id FROM garment_types WHERE is_active = true LIMIT 1')
    garmentTypeId = gt.rows[0].id
    const svc = await pool.query(
      `INSERT INTO vendor_services (vendor_id, name, category_id, status) VALUES ($1, 'Wash & Fold', $2, 'ACTIVE') RETURNING id`,
      [vendorId, gt.rows[0].category_id]
    )
    await pool.query(
      `INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise) VALUES ($1, $2, 8000)`,
      [svc.rows[0].id, garmentTypeId]
    )
  }
  let slotId = null
  if (withSlot) {
    const slot = await pool.query(
      `INSERT INTO vendor_slots (vendor_id, day_of_week, start_time, end_time, max_orders)
       VALUES ($1, EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Asia/Kolkata'))::int, '09:00', '21:00', $2) RETURNING id`,
      [vendorId, maxOrders]
    )
    slotId = slot.rows[0].id
  }
  return { id: vendorId, name, garmentTypeId, slotId }
}

/** A point `km` due north of (lat,lng). */
export function northOf(lat, lng, km) {
  return { lat: lat + km / 111.195, lng }
}

export async function buildTestApp() {
  const { buildApp } = await import('../../src/app.js')
  const app = await buildApp()
  await app.ready()
  return app
}

export const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

/**
 * A checkout the customer has completed up to (and including) paying the advance:
 * quote → order draft → slot hold → PAID advance payment. Returns the ids.
 */
export async function seedPaidDraft(pool, { vendor, user, paid = true, withHold = true, holdExpired = false,
  bookingDate = todayIst(), method = 'LNDRY_WALLET', couponCode = null, lat = 22.5726, lng = 88.3639 } = {}) {
  const addressId = await seedAddress(pool, user.id, { lat, lng })
  const q = await pool.query(
    `INSERT INTO quotes (customer_id, vendor_id, estimate_paise, pricing_snapshot, expires_at, booking_type)
     VALUES ($1, $2, 16000, '[]', NOW() + INTERVAL '1 hour', 'STANDARD') RETURNING id`,
    [user.id, vendor.id]
  )
  const quoteId = q.rows[0].id
  const lines = [{ garment_type_id: vendor.garmentTypeId, name: 'Wash & Fold', rate_paise: 8000, total_paise: 16000, quantity: 2, unit: 'PIECE' }]
  const snapshot = {
    quote: { quote_id: quoteId },
    booking_date: bookingDate,
    is_express_pickup: false,
    address: { id: addressId, address_line1: '12 Test Street', city: 'Kolkata', pincode: '700001' },
    coupon_code: couponCode,
    fee_breakdown: {
      subtotal_paise: 16000, delivery_fee_paise: 0, platform_fee_paise: 0, tax_paise: 0,
      express_fee_paise: 0, discount_paise: 0, total_payable_paise: 16000,
    },
  }
  const d = await pool.query(
    `INSERT INTO order_drafts (user_id, vendor_id, slot_id, address_id, garment_lines, payable_amount_paise, snapshot, booking_type)
     VALUES ($1, $2, $3, $4, $5, 16000, $6, 'STANDARD') RETURNING id`,
    [user.id, vendor.id, vendor.slotId, addressId, JSON.stringify(lines), JSON.stringify(snapshot)]
  )
  const draftId = d.rows[0].id
  if (withHold) {
    await pool.query(
      `INSERT INTO slot_holds (vendor_id, slot_id, user_id, customer_id, quote_id, booking_date, expires_at, status)
       VALUES ($1, $2, $3, $3, $4, $5, ${holdExpired ? "NOW() - INTERVAL '5 minutes'" : "NOW() + INTERVAL '15 minutes'"}, 'ACTIVE')`,
      [vendor.id, vendor.slotId, user.id, quoteId, bookingDate]
    )
  }
  let paymentId = null
  if (paid) {
    const p = await pool.query(
      `INSERT INTO payments (user_id, order_draft_id, amount, status, method, purpose, paid_at)
       VALUES ($1, $2, 50, 'PAID', $3, 'ADVANCE', NOW()) RETURNING id`,
      [user.id, draftId, method]
    )
    paymentId = p.rows[0].id
  }
  return { draftId, quoteId, addressId, paymentId }
}

export async function seedWallet(pool, userId, balance) {
  await pool.query(
    `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
    [userId, balance]
  )
}
