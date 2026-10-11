/**
 * Integration tests for Phase 2 of the POS-mode initiative (real migrated Postgres, skipped if unreachable):
 *   - migration 153 (store_orders.delivery_mode / is_express) is idempotent and defaults safely
 *   - counter orders accept / return / update / filter deliveryMode + isExpress
 *   - GET /vendor/pos/dashboard `home` tiles equal what is in the database; an empty vendor gets zeros;
 *     another vendor's orders never leak in.
 * Everything created here is removed in afterAll.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))

const { pool, query } = await import('../../src/config/database.js')
const { VendorAppModeService } = await import('../../src/modules/vendor-app-mode/vendor-app-mode.service.js')
const { VendorCounterOrdersService } = await import('../../src/modules/vendor-counter-orders/vendor-counter-orders.service.js')
const { VendorPosDashboardService } = await import('../../src/modules/vendor-pos-dashboard/vendor-pos-dashboard.service.js')

let dbUp = false
try {
  await query('SELECT delivery_mode, is_express FROM store_orders WHERE false')
  dbUp = true
} catch { /* skipped below */ }

const created = { userIds: [], vendorIds: [] }
const phone = (n) => `96${String(Date.now()).slice(-7)}${n}`
const appMode = new VendorAppModeService()
const orders = new VendorCounterOrdersService()
const dashboard = new VendorPosDashboardService()
const today = new Date().toISOString().slice(0, 10)
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

async function makeShop(n, { withCatalogue = true } = {}) {
  const { rows } = await query(`INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`, [phone(n), `Owner ${n}`])
  const user = { id: rows[0].id }
  created.userIds.push(user.id)
  const { appMode: mode } = await appMode.start(user)
  const vendorId = mode.vendorId
  created.vendorIds.push(vendorId)
  const actor = { userId: user.id, role: 'VENDOR_OWNER', vendorId }
  if (withCatalogue) {
    await appMode.saveStep(vendorId, actor, 'shop', { name: `Shop ${n}`, ownerName: 'Owner', addressLine1: '1 Road', city: 'Pune', pincode: '411001' })
    await appMode.saveStep(vendorId, actor, 'tax', { gstEnabled: false })
    await appMode.saveStep(vendorId, actor, 'counter', { printerProfile: 'none', orderSeriesPrefix: 'T', defaultDeliveryDays: 2 })
    await appMode.saveStep(vendorId, actor, 'pricelist', { choice: 'starter' })
    expect((await appMode.complete(vendorId, actor)).success).toBe(true)
  }
  return { user, vendorId, actor }
}

async function firstLine(vendorId) {
  const { rows } = await query(
    `SELECT p.garment_id, p.service_id FROM pos_prices p WHERE p.vendor_id = $1 ORDER BY p.created_at LIMIT 1`, [vendorId])
  return { garmentId: rows[0].garment_id, serviceId: rows[0].service_id }
}

describe.skipIf(!dbUp)('counter order delivery flags + POS Home tiles (real database)', () => {
  afterAll(async () => {
    if (dbUp) {
      for (const id of created.vendorIds) {
        for (const t of ['store_order_status_events', 'store_order_payments', 'vendor_garment_units', 'vendor_laundry_containers', 'vendor_production_tasks', 'store_orders',
          'pos_prices', 'pos_garments', 'pos_categories', 'pos_services', 'vendor_employees']) {
          await query(`DELETE FROM ${t} WHERE ${t === 'store_order_status_events' ? 'vendor_id' : 'vendor_id'} = $1`, [id]).catch(() => {})
        }
        await query(`DELETE FROM vendors WHERE id = $1`, [id]).catch(() => {})
      }
      if (created.userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.userIds]).catch(() => {})
    }
    await pool.end().catch(() => {})
  })

  it('migration 153 is idempotent and existing/default rows are WALK_IN, not express', async () => {
    const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/database/migrations/153_counter_order_delivery_flags.sql'), 'utf8')
    await query(sql)
    await query(sql)
    const { rows } = await query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'store_orders' AND column_name IN ('delivery_mode','is_express') ORDER BY 1`)
    expect(rows.map((r) => [r.column_name, r.is_nullable])).toEqual([['delivery_mode', 'NO'], ['is_express', 'NO']])
    const bad = await query(`SELECT 1 FROM store_orders WHERE delivery_mode NOT IN ('WALK_IN','HOME_DELIVERY','PICKUP')`)
    expect(bad.rows).toHaveLength(0)
  })

  it('books, returns, filters and edits deliveryMode / isExpress; bad values are rejected', async () => {
    const shop = await makeShop(1)
    const line = await firstLine(shop.vendorId)
    const base = { customer: { name: 'Asha', phone: phone(9) }, expectedDeliveryDate: addDays(2), items: [{ ...line, qty: 1 }], paymentMode: 'PAY_LATER' }

    const plain = await orders.book(shop.vendorId, shop.actor, base)
    expect(plain).toMatchObject({ success: true })
    expect(plain.order).toMatchObject({ deliveryMode: 'WALK_IN', isExpress: false })

    const home = await orders.book(shop.vendorId, shop.actor, { ...base, deliveryMode: 'home_delivery', isExpress: true })
    expect(home.order).toMatchObject({ deliveryMode: 'HOME_DELIVERY', isExpress: true })

    expect(await orders.book(shop.vendorId, shop.actor, { ...base, deliveryMode: 'TELEPORT' })).toMatchObject({ success: false, code: 'VALIDATION_ERROR' })
    expect(await orders.book(shop.vendorId, shop.actor, { ...base, isExpress: 'yes' })).toMatchObject({ success: false, code: 'VALIDATION_ERROR' })

    expect((await orders.listOrders(shop.vendorId, {})).length).toBe(2)
    expect((await orders.listOrders(shop.vendorId, { deliveryMode: 'HOME_DELIVERY' })).map((o) => o.id)).toEqual([home.order.id])
    expect((await orders.listOrders(shop.vendorId, { express: 'true' })).map((o) => o.id)).toEqual([home.order.id])
    expect((await orders.listOrders(shop.vendorId, { express: true })).map((o) => o.id)).toEqual([home.order.id])

    // Editing: absent fields are left alone, present ones change.
    const edited = await orders.update(shop.vendorId, shop.actor, plain.order.id, { deliveryMode: 'PICKUP' })
    expect(edited.order).toMatchObject({ deliveryMode: 'PICKUP', isExpress: false })
    const edited2 = await orders.update(shop.vendorId, shop.actor, plain.order.id, { isExpress: true })
    expect(edited2.order).toMatchObject({ deliveryMode: 'PICKUP', isExpress: true })
    expect(await orders.update(shop.vendorId, shop.actor, plain.order.id, { deliveryMode: 'x' })).toMatchObject({ success: false })
  })

  it('two shops that enter different names for the same phone each see only their own name (list, detail, search, export)', async () => {
    const one = await makeShop(6)
    const two = await makeShop(7)
    const customerPhone = phone(5)
    const lineOne = await firstLine(one.vendorId)
    const lineTwo = await firstLine(two.vendorId)
    const mk = (shop, line, name) => orders.book(shop.vendorId, shop.actor, { customer: { name, phone: customerPhone }, expectedDeliveryDate: addDays(2), items: [{ ...line, qty: 1 }], paymentMode: 'PAY_LATER' })
    const a = await mk(one, lineOne, 'Asha Rao')
    const b = await mk(two, lineTwo, 'Ashu Bhai')
    expect(a.success && b.success).toBe(true)
    expect((await orders.listOrders(one.vendorId, {}))[0].customer.name).toBe('Asha Rao')
    expect((await orders.listOrders(two.vendorId, {}))[0].customer.name).toBe('Ashu Bhai')
    expect((await orders.getOrder(two.vendorId, b.order.id))?.order?.customer?.name ?? (await orders.getOrder(two.vendorId, b.order.id))?.customer?.name).toBe('Ashu Bhai')
    expect((await orders.listOrders(two.vendorId, { search: 'Ashu' })).map((o) => o.id)).toEqual([b.order.id])
    expect(await orders.listOrders(two.vendorId, { search: 'Asha Rao' })).toHaveLength(0)
    const csv = await dashboard.exportCounterSalesCsv(two.vendorId, today, today)
    expect(csv).toContain('Ashu Bhai')
    expect(csv).not.toContain('Asha Rao')
    expect((await dashboard.search(two.vendorId, 'Ashu')).results.customers.map((c) => c.name)).toEqual(['Ashu Bhai'])
  })

  it('a malformed customer id is a 400 validation error, not a 500', async () => {
    const shop = await makeShop(5)
    const line = await firstLine(shop.vendorId)
    const body = { customer: { id: 'not-a-uuid' }, expectedDeliveryDate: addDays(2), items: [{ ...line, qty: 1 }], paymentMode: 'PAY_LATER' }
    expect(await orders.quote(shop.vendorId, body)).toMatchObject({ success: false, code: 'VALIDATION_ERROR', status: 400, message: 'Choose a valid customer.' })
    expect(await orders.book(shop.vendorId, shop.actor, body)).toMatchObject({ success: false, code: 'VALIDATION_ERROR', status: 400 })
    expect(await orders.quote(shop.vendorId, { ...body, customer: undefined, customerId: '1; drop table users' })).toMatchObject({ success: false, status: 400 })
    // no customer at all still prices (the POS shows a bill before a customer is chosen)
    expect((await orders.quote(shop.vendorId, { ...body, customer: undefined })).success).toBe(true)
  })

  it('an empty vendor gets zeros (not errors, not nulls)', async () => {
    const empty = await makeShop(2, { withCatalogue: false })
    const d = await dashboard.dashboard(empty.vendorId)
    expect(d.home).toEqual({
      todayRevenuePaise: 0, todayCollectionPaise: 0, onlineOrderRequests: 0, washingToStore: 0, bookingsToday: 0, deliveriesToday: 0, deliveredToday: 0,
      pendingOrders: 0, unassignedPickups: 0, upcomingDeliveries: 0, unassignedDeliveries: 0, expressOrders: 0, collectionDuePaise: 0,
    })
  })

  it('home tiles equal the database for a seeded vendor, and never include another vendor', async () => {
    const shop = await makeShop(3)
    const other = await makeShop(4)
    const line = await firstLine(shop.vendorId)
    const otherLine = await firstLine(other.vendorId)
    const mk = (extra) => orders.book(shop.vendorId, shop.actor, {
      customer: { name: 'Ravi', phone: phone(8) }, expectedDeliveryDate: addDays(3), items: [{ ...line, qty: 1 }], paymentMode: 'PAY_LATER', ...extra,
    })

    const a = await mk({ deliveryMode: 'PICKUP' })                       // booked, pickup, no rider -> unassigned pickup
    const b = await mk({ deliveryMode: 'HOME_DELIVERY', isExpress: true, expectedDeliveryDate: today }) // due today, express
    const c = await mk({ paymentMode: 'CASH' })                          // paid in full
    const d = await mk({ expectedDeliveryDate: addDays(-1) })            // overdue -> upcoming(due today or earlier)
    const e = await mk({})                                               // will be cancelled
    for (const r of [a, b, c, d, e]) expect(r.success).toBe(true)
    expect((await orders.cancel(shop.vendorId, shop.actor, e.order.id, 'test')).success).toBe(true)
    // b -> READY with a home delivery and no rider = unassigned delivery
    await query(`UPDATE store_orders SET status = 'READY' WHERE id = $1`, [b.order.id])
    // c -> DELIVERED today (with the history event the tile reads)
    await query(`UPDATE store_orders SET status = 'DELIVERED' WHERE id = $1`, [c.order.id])
    await query(`INSERT INTO store_order_status_events (store_order_id, vendor_id, from_status, to_status, actor_user_id) VALUES ($1,$2,'READY','DELIVERED',$3)`, [c.order.id, shop.vendorId, shop.user.id])
    // A mirrored Epic row must be ignored by the queue tiles.
    await query(`UPDATE store_orders SET source = 'DESKTOP_PUSH' WHERE id = $1`, [d.order.id])
    // other vendor with a big express order: must not appear
    const o = await orders.book(other.vendorId, other.actor, { customer: { name: 'Zed', phone: phone(7) }, expectedDeliveryDate: today, items: [{ ...otherLine, qty: 5 }], paymentMode: 'PAY_LATER', isExpress: true, deliveryMode: 'PICKUP' })
    expect(o.success).toBe(true)

    // Expected values are computed straight from SQL, independently of the dashboard code.
    const sql = async (text) => (await query(text, [shop.vendorId])).rows[0]
    const rev = await sql(`SELECT COALESCE(SUM(total_paise),0)::int AS v FROM store_orders WHERE vendor_id=$1 AND source<>'DESKTOP_PUSH' AND status<>'CANCELLED' AND placed_at::date = CURRENT_DATE`)
    const paidToday = await sql(`SELECT COALESCE(SUM(p.amount_paise),0)::int AS v FROM store_order_payments p JOIN store_orders so ON so.id=p.store_order_id WHERE p.vendor_id=$1 AND so.source<>'DESKTOP_PUSH'`)
    const due = await sql(`SELECT COALESCE(SUM(total_paise-amount_paid_paise),0)::int AS v FROM store_orders WHERE vendor_id=$1 AND source<>'DESKTOP_PUSH' AND status<>'CANCELLED'`)

    const h = (await dashboard.dashboard(shop.vendorId)).home
    expect(h).toEqual({
      todayRevenuePaise: rev.v, todayCollectionPaise: paidToday.v, collectionDuePaise: due.v,
      onlineOrderRequests: 0, washingToStore: 0,
      bookingsToday: 3,        // a, b, c   (d is a mirrored Epic row, e is cancelled)
      deliveriesToday: 1,      // b is the only open order due today
      deliveredToday: 1,       // c
      pendingOrders: 2,        // a, b
      unassignedPickups: 1,    // a
      upcomingDeliveries: 1,   // b (due today); d is overdue but mirrored, so it is excluded
      unassignedDeliveries: 1, // b: READY home delivery without a rider
      expressOrders: 1,        // b
    })
    expect(h.todayRevenuePaise).toBe(a.order.totalPaise + b.order.totalPaise + c.order.totalPaise)
    expect(h.todayCollectionPaise).toBe(c.order.totalPaise)       // only c was paid
    expect(h.collectionDuePaise).toBe(a.order.totalPaise + b.order.totalPaise)

    // The other vendor sees only its own order (an express pickup due today, still BOOKED).
    const ho = (await dashboard.dashboard(other.vendorId)).home
    expect(ho).toMatchObject({ bookingsToday: 1, pendingOrders: 1, expressOrders: 1, unassignedPickups: 1, deliveriesToday: 1, deliveredToday: 0 })
    expect(ho.todayRevenuePaise).toBe(o.order.totalPaise)

    // A rider assignment removes the unassigned-delivery tile entry.
    await query(`UPDATE store_orders SET delivery_rider_employee_id = (SELECT id FROM vendor_employees WHERE vendor_id = $1 LIMIT 1) WHERE id = $2`, [shop.vendorId, b.order.id])
    expect((await dashboard.dashboard(shop.vendorId)).home.unassignedDeliveries).toBe(0)
  })
})
