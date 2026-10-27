#!/usr/bin/env node
/**
 * Seeds a realistic marketplace for load testing (bulk SQL, a few seconds):
 *   N vendors spread over a city, each orderable (service+rate+slot),
 *   M customers each with a default address, and a JWT per customer.
 *
 *   DB_HOST=… DB_PORT=… DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   node scripts/load/seed-load-data.mjs --vendors 400 --users 1000 --out /tmp/load-tokens.json
 *
 * ⚠ Writes data. Point it at a TEST database only — never production.
 */
import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const VENDORS = Number(arg('vendors', 400))
const USERS = Number(arg('users', 1000))
const OUT = arg('out', '/tmp/load-tokens.json')
const CENTER = { lat: Number(arg('lat', 22.5726)), lng: Number(arg('lng', 88.3639)) }

if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed load data with NODE_ENV=production'); process.exit(1) }
const host = process.env.DB_HOST || 'localhost'
if (!['localhost', '127.0.0.1', 'postgres'].includes(host) && arg('i-know-this-is-a-test-db', null) === null) {
  console.error(`DB_HOST=${host} is not local. Re-run with --i-know-this-is-a-test-db if this really is a disposable database.`); process.exit(1)
}

const pool = new pg.Pool({ host, port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 4 })

const gt = (await pool.query('SELECT id, category_id FROM garment_types WHERE is_active = true LIMIT 1')).rows[0]
// ~0.18 deg ≈ 20 km box around the centre
await pool.query(`
  WITH v AS (
    INSERT INTO vendors (name, slug, branch_code, address_line1, city, state, pincode, lat, lng,
                         approved_service_radius_km, delivery_radius_km, status, vendor_approved,
                         marketplace_published, account_enabled, is_active)
    SELECT 'Load Vendor ' || g, 'load-vendor-' || g || '-' || substr(md5(random()::text),1,6), 'LV-' || substr(md5(random()::text),1,8),
           '1 Load Rd', 'Kolkata', 'West Bengal', '700001',
           $1 + (random() - 0.5) * 0.18, $2 + (random() - 0.5) * 0.18,
           5 + (random() * 5)::int, 5, 'APPROVED', true, true, true, true
    FROM generate_series(1, $3) g
    RETURNING id)
  , s AS (INSERT INTO vendor_services (vendor_id, name, category_id, status) SELECT id, 'Wash & Fold', $4, 'ACTIVE' FROM v RETURNING id)
  , r AS (INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise) SELECT id, $5, 8000 FROM s RETURNING 1)
  INSERT INTO vendor_slots (vendor_id, day_of_week, start_time, end_time, max_orders)
  SELECT id, d, '09:00', '21:00', 50 FROM v, generate_series(0,6) d`,
  [CENTER.lat, CENTER.lng, VENDORS, gt.category_id, gt.id])

const users = (await pool.query(`
  WITH u AS (
    INSERT INTO users (phone, name, role)
    SELECT '9' || lpad((floor(random()*1e9))::bigint::text, 9, '0') || '', 'Load User ' || g, 'CUSTOMER' FROM generate_series(1, $1) g
    ON CONFLICT DO NOTHING RETURNING id, phone)
  , a AS (INSERT INTO addresses (user_id, label, address_line1, city, state, pincode, lat, lng, is_default)
          SELECT id, 'Home', '12 Load St', 'Kolkata', 'West Bengal', '700001', $2 + (random()-0.5)*0.14, $3 + (random()-0.5)*0.14, true FROM u RETURNING 1)
  SELECT id, phone FROM u`, [USERS, CENTER.lat, CENTER.lng])).rows

const secret = process.env.JWT_ACCESS_SECRET
const tokens = users.map((u) => jwt.sign({ id: u.id, phone: u.phone, role: 'CUSTOMER' }, secret, { expiresIn: '6h' }))
fs.writeFileSync(OUT, JSON.stringify({ center: CENTER, tokens }))
console.log(`Seeded ${VENDORS} vendors, ${users.length} customers → ${OUT}`)
await pool.end()
