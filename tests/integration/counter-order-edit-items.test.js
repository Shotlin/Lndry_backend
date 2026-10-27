/**
 * Integration tests for editing the garment lines of a counter order (real migrated Postgres, skipped if unreachable).
 * Everything created here is removed in afterAll.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))
vi.mock('../../src/modules/invoices/invoice-jobs.js', () => ({ scheduleInvoiceForDeliveredOrder: vi.fn() }))

const { pool, query } = await import('../../src/config/database.js')
const { VendorAppModeService } = await import('../../src/modules/vendor-app-mode/vendor-app-mode.service.js')
const { VendorCounterOrdersService } = await import('../../src/modules/vendor-counter-orders/vendor-counter-orders.service.js')
const { InvoicesService, InvoiceError } = await import('../../src/modules/invoices/invoices.service.js')
const { VendorPosDashboardService } = await import('../../src/modules/vendor-pos-dashboard/vendor-pos-dashboard.service.js')
const { HOME_TILE_KEYS } = await import('../../src/modules/vendor-pos-dashboard/home-tile-filters.js')

let dbUp = false
try {
  await query('SELECT delivery_mode, is_express FROM store_orders WHERE false')
  dbUp = true
} catch { /* skipped below */ }

const created = { userIds: [], vendorIds: [] }
const phone = (n) => `95${String(Date.now()).slice(-7)}${n}`
const appMode = new VendorAppModeService()
const orders = new VendorCounterOrdersService()
const invoices = new InvoicesService()
const dashboard = new VendorPosDashboardService()
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString() === '%PDF-'

async function makeShop(n) {
  const { rows } = await query(`INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`, [phone(n), `Owner ${n}`])
  const user = { id: rows[0].id }
  created.userIds.push(user.id)
  const { appMode: mode } = await appMode.start(user)
  const vendorId = mode.vendorId
  created.vendorIds.push(vendorId)
  const actor = { userId: user.id, role: 'VENDOR_OWNER', vendorId }
  await appMode.saveStep(vendorId, actor, 'shop', { name: `Shop ${n}`, ownerName: 'Owner', addressLine1: '1 Road', city: 'Pune', pincode: '411001' })
  await appMode.saveStep(vendorId, actor, 'tax', { gstEnabled: false })
  await appMode.saveStep(vendorId, actor, 'counter', { printerProfile: 'none', orderSeriesPrefix: 'T', defaultDeliveryDays: 2 })
  await appMode.saveStep(vendorId, actor, 'pricelist', { choice: 'starter' })
  expect((await appMode.complete(vendorId, actor)).success).toBe(true)
  const { rows: p } = await query(`SELECT garment_id, service_id FROM pos_prices WHERE vendor_id = $1 ORDER BY created_at LIMIT 1`, [vendorId])
  return { user, vendorId, actor, line: { garmentId: p[0].garment_id, serviceId: p[0].service_id } }
}

const book = async (shop, customerPhone, paymentMode = 'PAY_LATER') => {
  const res = await orders.book(shop.vendorId, shop.actor, {
    customer: { name: 'Asha', phone: customerPhone }, expectedDeliveryDate: addDays(2), items: [{ ...shop.line, qty: 2 }], paymentMode,
  })
  expect(res.success).toBe(true)
  return res.order
}

describe.skipIf(!dbUp)('editing the garments of a counter order (real database)', () => {
  afterAll(async () => {
    if (dbUp) {
      for (const id of created.vendorIds) {
        for (const t of ['vendor_customer_ledger', 'store_order_status_events', 'store_order_payments', 'vendor_garment_units', 'vendor_laundry_containers', 'vendor_production_tasks', 'store_orders',
          'pos_prices', 'pos_garments', 'pos_categories', 'pos_services', 'vendor_employees']) {
          await query(`DELETE FROM ${t} WHERE vendor_id = $1`, [id]).catch(() => {})
        }
        await query(`DELETE FROM vendors WHERE id = $1`, [id]).catch(() => {})
      }
      if (created.userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.userIds]).catch(() => {})
    }
    await pool.end().catch(() => {})
  })

  it('changing a quantity re-prices the order and keeps/cancels/issues tags to match', async () => {
    const shop = await makeShop(21)
    const order = await book(shop, phone(22)) // qty 2
    const rate = order.items[0].ratePaise
    const grown = await orders.update(shop.vendorId, shop.actor, order.id, { items: [{ ...shop.line, qty: 4 }] })
    expect(grown.success).toBe(true)
    expect(grown.order.subtotalPaise).toBe(rate * 4)
    expect(grown.order.totalPaise).toBe(rate * 4)
    expect(grown.order.items[0].qty).toBe(4)
    const live = async () => (await query(`SELECT state FROM vendor_garment_units WHERE order_id = $1 AND state <> 'CANCELLED'`, [order.id])).rows.length
    expect(await live()).toBe(4)
    const peek = await orders.update(shop.vendorId, shop.actor, order.id, { items: [{ ...shop.line, qty: 3 }], preview: true })
    expect(peek.preview.totalPaise).toBe(rate * 3)
    expect((await orders.getOrder(shop.vendorId, order.id)).totalPaise).toBe(rate * 4) // a preview changes nothing
    const shrunk = await orders.update(shop.vendorId, shop.actor, order.id, { items: [{ ...shop.line, qty: 1 }] })
    expect(shrunk.order.totalPaise).toBe(rate)
    expect(await live()).toBe(1)
  })

  it('refuses once processing has started, when the total would fall below what was paid, and for an empty list', async () => {
    const shop = await makeShop(23)
    const paid = await book(shop, phone(24), 'CASH')
    const low = await orders.update(shop.vendorId, shop.actor, paid.id, { items: [{ ...shop.line, qty: 1 }] })
    expect(low).toMatchObject({ success: false, code: 'TOTAL_BELOW_PAID' })
    const empty = await orders.update(shop.vendorId, shop.actor, paid.id, { items: [] })
    expect(empty.success).toBe(false)

    const later = await book(shop, phone(25))
    await query(`UPDATE vendor_garment_units SET state = 'PROCESSING' WHERE order_id = $1`, [later.id])
    const locked = await orders.update(shop.vendorId, shop.actor, later.id, { items: [{ ...shop.line, qty: 3 }] })
    expect(locked).toMatchObject({ success: false, code: 'ITEMS_LOCKED' })
  })
})
