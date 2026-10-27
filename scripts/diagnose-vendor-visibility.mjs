#!/usr/bin/env node
/**
 * "Why can't customers see vendor X from here?"
 *
 * Read-only. Prints, for one vendor and one customer location, every rule the
 * marketplace applies (src/modules/discovery/vendor-visibility.js) and whether
 * it passes, plus the real distance against the effective service radius.
 *
 *   node scripts/diagnose-vendor-visibility.mjs --vendor "Spotless Laundry" --lat 22.5726 --lng 88.3639
 *   node scripts/diagnose-vendor-visibility.mjs --vendor <vendor-uuid> --address <customer-address-uuid>
 *   node scripts/diagnose-vendor-visibility.mjs --list-hidden --lat 22.5726 --lng 88.3639
 *
 * Uses the same DB_* variables as the API (.env). Never writes anything.
 */
import dotenv from 'dotenv'
import pg from 'pg'
import { ELIGIBILITY_CHECKS, EFFECTIVE_RADIUS_SQL, distanceKmSql } from '../src/modules/discovery/vendor-visibility.js'

dotenv.config()

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true])
    return acc
  }, [])
)

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
})

const tick = (ok) => (ok ? '✅' : '❌')

async function resolveLocation() {
  if (args.address) {
    const { rows } = await pool.query('SELECT lat, lng, address_line1, pincode FROM addresses WHERE id = $1', [args.address])
    if (!rows[0]) throw new Error(`address ${args.address} not found`)
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lng), label: `${rows[0].address_line1} (${rows[0].pincode})` }
  }
  if (args.lat !== undefined && args.lng !== undefined) return { lat: Number(args.lat), lng: Number(args.lng), label: 'given coordinates' }
  throw new Error('Provide --lat and --lng, or --address <id>')
}

async function main() {
  const loc = await resolveLocation()
  if (![loc.lat, loc.lng].every(Number.isFinite)) throw new Error('Customer location has no valid coordinates — the address was saved without a map pin.')

  if (args['list-hidden']) {
    const { rows } = await pool.query(
      `SELECT v.id, v.name, v.status, ${distanceKmSql('$1', '$2')}::numeric(7,2) AS distance_km, ${EFFECTIVE_RADIUS_SQL} AS radius_km
         FROM vendors v WHERE v.deleted_at IS NULL AND v.lat IS NOT NULL ORDER BY distance_km ASC LIMIT 25`,
      [loc.lat, loc.lng]
    )
    console.log(`\nNearest vendors to ${loc.label} (${loc.lat}, ${loc.lng}):\n`)
    for (const r of rows) console.log(`  ${String(r.distance_km).padStart(7)} km  radius ${String(r.radius_km).padStart(5)} km  ${r.status.padEnd(20)} ${r.name}  [${r.id}]`)
    console.log('\nRe-run with --vendor <id> for the rule-by-rule breakdown.')
    return
  }

  if (!args.vendor) throw new Error('Provide --vendor <id or name>')
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.vendor)
  const { rows: found } = await pool.query(
    isUuid ? 'SELECT id FROM vendors WHERE id = $1' : 'SELECT id FROM vendors WHERE name ILIKE $1 LIMIT 5',
    [isUuid ? args.vendor : `%${args.vendor}%`]
  )
  if (found.length === 0) throw new Error('No vendor matches that id / name')
  if (found.length > 1) console.log('Several vendors match — using the first. Matches:', found.map((f) => f.id).join(', '))
  const vendorId = found[0].id

  const select = ELIGIBILITY_CHECKS.map(([name, sql]) => `(${sql}) AS "${name}"`).join(',\n       ')
  const { rows } = await pool.query(
    `SELECT v.id, v.name, v.status, v.lat, v.lng, v.approved_service_radius_km, v.delivery_radius_km, v.pincode,
            ${EFFECTIVE_RADIUS_SQL} AS effective_radius_km,
            CASE WHEN v.lat IS NOT NULL AND v.lng IS NOT NULL THEN ${distanceKmSql('$2', '$3')} END AS distance_km,
            ${select}
       FROM vendors v WHERE v.id = $1`,
    [vendorId, loc.lat, loc.lng]
  )
  const v = rows[0]

  console.log(`\nVendor : ${v.name}  [${v.id}]`)
  console.log(`Status : ${v.status}`)
  console.log(`Vendor location : ${v.lat ?? 'MISSING'}, ${v.lng ?? 'MISSING'}`)
  console.log(`Customer        : ${loc.label} (${loc.lat}, ${loc.lng})`)
  console.log(`Radius          : approved=${v.approved_service_radius_km ?? 'NULL'} km, delivery=${v.delivery_radius_km ?? 'NULL'} km  →  effective ${v.effective_radius_km} km`)
  console.log(`Distance        : ${v.distance_km == null ? 'cannot compute (vendor has no coordinates)' : `${Number(v.distance_km).toFixed(2)} km`}\n`)

  let blocking = 0
  for (const [name] of ELIGIBILITY_CHECKS) {
    const ok = v[name] === true
    if (!ok) blocking++
    console.log(`  ${tick(ok)}  ${name}`)
  }
  const inRadius = v.distance_km != null && Number(v.distance_km) <= Number(v.effective_radius_km)
  if (!inRadius) blocking++
  console.log(`  ${tick(inRadius)}  inside_service_radius`)

  console.log(blocking === 0 ? '\nRESULT: this vendor SHOULD be shown to this customer.' : `\nRESULT: hidden — ${blocking} rule(s) failing (marked ❌ above).`)
  if (!v.has_active_pickup_slot) console.log('HINT  : add at least one active pickup slot for this vendor.')
  if (!v.has_approved_service_with_active_rate) console.log('HINT  : the vendor needs an APPROVED service with an active rate.')
  if (!v.marketplace_published) console.log('HINT  : marketplace_published=false (publish the vendor, or wait for auto-publish once it is service-ready).')
  if (v.status !== 'APPROVED') console.log('HINT  : status is not APPROVED. Editing a vendor\'s location sets WAITING_FOR_APPROVAL and hides it until an admin re-approves.')
}

main()
  .catch((err) => { console.error(`\nError: ${err.message}\n`); process.exitCode = 1 })
  .finally(() => pool.end())
