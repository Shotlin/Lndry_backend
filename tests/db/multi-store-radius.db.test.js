import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DB_TESTS, applyTestEnv, makePool, seedUser, seedAddress, seedVendor, tokenFor, buildTestApp } from './harness.js'

// A fresh random spot per run so vendors left by earlier runs never mix in.
const HOME = { lat: 8 + Math.random() * 20, lng: 70 + Math.random() * 20 }

/** A point `km` away from `p` in compass direction `bearingDeg` (0 = north, 90 = east). */
function at(p, km, bearingDeg) {
  const b = (bearingDeg * Math.PI) / 180
  return {
    lat: p.lat + (km * Math.cos(b)) / 111.195,
    lng: p.lng + (km * Math.sin(b)) / (111.195 * Math.cos((p.lat * Math.PI) / 180)),
  }
}

describe.skipIf(!DB_TESTS)('several stores around one customer (real PostgreSQL)', () => {
  let app, pool, customer, auth
  const expected = new Map() // id -> label, stores that MUST be listed
  const hidden = new Map() // id -> label, stores that MUST NOT be listed

  beforeAll(async () => {
    applyTestEnv()
    pool = makePool()
    app = await buildTestApp()
    customer = await seedUser(pool)
    auth = { authorization: `Bearer ${tokenFor(customer)}` }
    await seedAddress(pool, customer.id, { ...HOME })

    // Stores that must show: all directions, near to the 5 km edge, all with the standard 5 km radius.
    const shows = [[0.3, 0], [1.2, 90], [2.5, 180], [3.8, 270], [4.5, 45], [4.9, 135], [4.7, 225], [4.95, 315]]
    for (const [km, bearing] of shows) {
      const v = await seedVendor(pool, { ...at(HOME, km, bearing), radius: 5, name: `Shows ${km}km@${bearing}` })
      expected.set(v.id, `${km}km@${bearing}`)
    }
    // A store whose own approved radius is larger reaches a customer further away.
    const wide = await seedVendor(pool, { ...at(HOME, 7, 10), radius: 10, deliveryRadius: 10, name: 'Wide 10km store' })
    expected.set(wide.id, '7km store with 10km radius')

    // Stores that must NOT show.
    const no = [
      ['beyond 5km (5.3)', { ...at(HOME, 5.3, 0), radius: 5 }],
      ['far away (9)', { ...at(HOME, 9, 90), radius: 5 }],
      ['own radius only 3km, customer 4km away', { ...at(HOME, 4, 180), radius: 3, deliveryRadius: 3 }],
      ['not published', { ...at(HOME, 1, 0), published: false }],
      ['not approved', { ...at(HOME, 1, 90), approved: false, status: 'WAITING_FOR_APPROVAL' }],
      ['account disabled', { ...at(HOME, 1, 180), enabled: false }],
      ['inactive', { ...at(HOME, 1, 270), active: false }],
    ]
    for (const [label, opts] of no) {
      const v = await seedVendor(pool, { ...opts, name: `Hidden ${label}` })
      hidden.set(v.id, label)
    }
  })
  afterAll(async () => { await app?.close(); await pool?.end() })

  const list = async (qs = '') => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/discovery/vendors?lat=${HOME.lat}&lng=${HOME.lng}${qs}`, headers: auth })
    expect(res.statusCode).toBe(200)
    return res.json().data
  }

  it('lists EVERY eligible store around the customer, and none of the ineligible ones', async () => {
    const data = await list('&limit=50')
    const shown = new Set(data.map((v) => v.id))
    for (const [id, label] of expected) expect(shown.has(id), `must show: ${label}`).toBe(true)
    for (const [id, label] of hidden) expect(shown.has(id), `must hide: ${label}`).toBe(false)
    expect(data.length).toBe(expected.size)
  })

  it('returns the stores nearest first, each with a believable distance', async () => {
    const data = await list('&limit=50')
    const dist = data.map((v) => Number(v.distance_km))
    expect(dist).toEqual([...dist].sort((a, b) => a - b))
    expect(dist[0]).toBeLessThan(0.5)
    expect(Math.max(...dist.slice(0, -1))).toBeLessThan(5.05)
  })

  it('the Home screen shows the nearest stores first', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/discovery/home', headers: auth })
    expect(res.statusCode).toBe(200)
    const nearby = res.json().data.nearby_vendors
    expect(nearby.length).toBeGreaterThan(0)
    expect(nearby.length).toBeLessThanOrEqual(10)
    const dist = nearby.map((v) => Number(v.distance_km))
    expect(dist).toEqual([...dist].sort((a, b) => a - b))
    for (const v of nearby) expect(hidden.has(v.id)).toBe(false)
  })

  it('with many stores nobody is lost across pages (45 more stores inside 4 km)', async () => {
    const extra = []
    for (let i = 0; i < 45; i++) {
      const v = await seedVendor(pool, { ...at(HOME, 0.5 + (i % 9) * 0.4, i * 8), radius: 5, name: `Crowd ${i}` })
      extra.push(v.id)
    }
    const total = expected.size + extra.length
    const first = await list('&limit=20&page=1')
    expect(first.length).toBe(20)

    // The list endpoint returns pagination separately; fetch raw to read it.
    const res = await app.inject({ method: 'GET', url: `/api/v1/discovery/vendors?lat=${HOME.lat}&lng=${HOME.lng}&limit=20&page=1`, headers: auth })
    const body = res.json()
    const pg = body.pagination || body.meta?.pagination || body.data?.pagination
    if (pg) expect(pg.total).toBe(total)

    const seen = new Set()
    for (let page = 1; page <= Math.ceil(total / 20); page++) {
      for (const v of await list(`&limit=20&page=${page}`)) seen.add(v.id)
    }
    expect(seen.size, 'every store reachable by paging, no duplicates, none missing').toBe(total)
    for (const id of [...expected.keys(), ...extra]) expect(seen.has(id)).toBe(true)
    for (const id of hidden.keys()) expect(seen.has(id)).toBe(false)
  })
})
