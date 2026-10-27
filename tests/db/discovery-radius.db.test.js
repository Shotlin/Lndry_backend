import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DB_TESTS, applyTestEnv, makePool, seedUser, seedAddress, seedVendor, tokenFor, northOf, buildTestApp } from './harness.js'

// A fresh random spot per run, so vendors left behind by earlier runs on a reused
// database can never crowd the results (a dedicated test DB is not cleaned between runs).
const KOLKATA = { lat: 8 + Math.random() * 20, lng: 70 + Math.random() * 20 }

describe.skipIf(!DB_TESTS)('vendor discovery & serviceability (real PostgreSQL)', () => {
  let app, pool, customer, auth

  beforeAll(async () => {
    applyTestEnv()
    pool = makePool()
    app = await buildTestApp()
    customer = await seedUser(pool)
    auth = { authorization: `Bearer ${tokenFor(customer)}` }
  })
  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  const listAt = async (point, qs = '') => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/discovery/vendors?lat=${point.lat}&lng=${point.lng}&limit=50${qs}` })
    expect(res.statusCode).toBe(200)
    return res.json().data
  }
  const ids = (list) => list.map((v) => v.id)

  it('REGRESSION: a vendor with a 5 km radius IS shown to a customer 4.5 km away, and NOT at 5.5 km', async () => {
    const vendor = await seedVendor(pool, { ...KOLKATA, radius: 5 })
    const inside = northOf(KOLKATA.lat, KOLKATA.lng, 4.5)
    const outside = northOf(KOLKATA.lat, KOLKATA.lng, 5.5)

    const near = await listAt(inside)
    const hit = near.find((v) => v.id === vendor.id)
    expect(hit, 'vendor 4.5 km away must be listed').toBeTruthy()
    expect(Number(hit.distance_km)).toBeGreaterThan(4.4)
    expect(Number(hit.distance_km)).toBeLessThan(4.6)

    expect(ids(await listAt(outside))).not.toContain(vendor.id)
  })

  it('a vendor whose approved radius is missing falls back to its delivery radius instead of vanishing', async () => {
    const vendor = await seedVendor(pool, { ...KOLKATA, radius: 5, deliveryRadius: 8 })
    await pool.query('UPDATE vendors SET approved_service_radius_km = NULL WHERE id = $1', [vendor.id])
    expect(ids(await listAt(northOf(KOLKATA.lat, KOLKATA.lng, 7)))).toContain(vendor.id)
    expect(ids(await listAt(northOf(KOLKATA.lat, KOLKATA.lng, 9)))).not.toContain(vendor.id)
  })

  it('a zero approved radius is treated as "not set", not as "serves nobody"', async () => {
    const vendor = await seedVendor(pool, { ...KOLKATA, radius: 0, deliveryRadius: 6 })
    expect(ids(await listAt(northOf(KOLKATA.lat, KOLKATA.lng, 4)))).toContain(vendor.id)
  })

  it.each([
    ['not published', { published: false }],
    ['not approved by admin', { approved: false }],
    ['account disabled', { enabled: false }],
    ['inactive', { active: false }],
    ['status not APPROVED (e.g. location edited, waiting re-approval)', { status: 'WAITING_FOR_APPROVAL' }],
    ['no service with a rate', { withService: false }],
    ['no pickup slot', { withSlot: false }],
  ])('a vendor that is %s is never shown', async (_label, opts) => {
    const vendor = await seedVendor(pool, { ...KOLKATA, ...opts })
    expect(ids(await listAt(KOLKATA))).not.toContain(vendor.id)
  })

  it('validate-location agrees with the vendor list (same rules, no drift)', async () => {
    const lonely = { lat: 8 + Math.random() * 20, lng: 70 + Math.random() * 20 }
    const v = await seedVendor(pool, { ...lonely, radius: 5 })
    const check = async (p) =>
      (await app.inject({ method: 'POST', url: '/api/v1/addresses/validate-location', headers: auth, payload: p })).json().data

    const inside = northOf(lonely.lat, lonely.lng, 4.5)
    expect((await check(inside)).serviceable).toBe(true)
    expect(ids(await listAt(inside))).toContain(v.id)

    const outside = northOf(lonely.lat, lonely.lng, 6)
    expect((await check(outside)).serviceable).toBe(false)
    expect(ids(await listAt(outside))).not.toContain(v.id)
  })

  it('validate-location does NOT count a vendor that discovery would hide (e.g. unpublished)', async () => {
    const remote = { lat: 8 + Math.random() * 20, lng: 70 + Math.random() * 20 }
    await seedVendor(pool, { ...remote, radius: 5, published: false })
    const res = await app.inject({ method: 'POST', url: '/api/v1/addresses/validate-location', headers: auth, payload: remote })
    expect(res.json().data.serviceable).toBe(false)
  })

  it('validate-pincode accepts a pincode no vendor lists when the exact point is covered', async () => {
    const point = { lat: 8 + Math.random() * 20, lng: 70 + Math.random() * 20 }
    await seedVendor(pool, { ...point, radius: 5, pincode: '400001' })
    // A legacy vendor elsewhere has a pincode list, which used to make every OTHER pincode "unavailable".
    await pool.query(`UPDATE vendors SET serviceable_pincodes = ARRAY['999999'] WHERE pincode = '700001' AND id = (SELECT id FROM vendors WHERE pincode='700001' LIMIT 1)`)
    const near = northOf(point.lat, point.lng, 3)
    const res = await app.inject({ method: 'POST', url: '/api/v1/addresses/validate-pincode', headers: auth, payload: { pincode: '400099', ...near } })
    expect(res.json().data.available).toBe(true)
  })

  it('quotes use the address chosen at checkout, not just the default address', async () => {
    const vendor = await seedVendor(pool, { ...KOLKATA, radius: 5 })
    const user = await seedUser(pool)
    const far = northOf(KOLKATA.lat, KOLKATA.lng, 40)
    const near = northOf(KOLKATA.lat, KOLKATA.lng, 2)
    await seedAddress(pool, user.id, { ...far, isDefault: true })           // default is OUT of range
    const nearId = await seedAddress(pool, user.id, { ...near, isDefault: false }) // the one the customer picks
    const headers = { authorization: `Bearer ${tokenFor(user)}` }
    const body = { vendor_id: vendor.id, garment_lines: [{ garment_type_id: vendor.garmentTypeId, quantity: 2 }] }

    const withoutAddress = await app.inject({ method: 'POST', url: '/api/v1/quotes', headers, payload: body })
    expect(withoutAddress.statusCode).toBe(400)
    expect(withoutAddress.json().code).toBe('VENDOR_OUT_OF_RADIUS')

    const withAddress = await app.inject({ method: 'POST', url: '/api/v1/quotes', headers, payload: { ...body, address_id: nearId } })
    expect(withAddress.statusCode).toBe(201)
  })

  it('rejects absurd paging / coordinates instead of running an expensive query', async () => {
    const big = await app.inject({ method: 'GET', url: '/api/v1/discovery/vendors?lat=22.5&lng=88.3&limit=100000' })
    expect(big.statusCode).toBe(400)
    const badLat = await app.inject({ method: 'GET', url: '/api/v1/discovery/vendors?lat=999&lng=88.3' })
    expect(badLat.statusCode).toBe(400)
  })
})
