/**
 * Integration tests for Phase 3 of the POS-mode initiative (real migrated Postgres, skipped if unreachable):
 *   - GET /vendor/counter/orders: comma-separated status tabs, offset paging, paymentDue filter
 *   - the vendor's own invoice PDFs: mini bill (58 / 80 mm) at any stage but cancelled, A4 invoice only after delivery,
 *     and another shop can never read them
 * Everything created here is removed in afterAll.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))
vi.mock('../../src/modules/invoices/invoice-jobs.js', () => ({ scheduleInvoiceForDeliveredOrder: vi.fn() }))

const { pool, query } = await import('../../src/config/database.js')
const { VendorAppModeService } = await import('../../src/modules/vendor-app-mode/vendor-app-mode.service.js')
const { VendorCounterOrdersService } = await import('../../src/modules/vendor-counter-orders/vendor-counter-orders.service.js')
const { InvoicesService, InvoiceError } = await import('../../src/modules/invoices/invoices.service.js')

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

describe.skipIf(!dbUp)('counter order lifecycle: list filters + vendor invoice PDFs (real database)', () => {
  afterAll(async () => {
    if (dbUp) {
      for (const id of created.vendorIds) {
        for (const t of ['invoices', 'store_order_status_events', 'store_order_payments', 'vendor_garment_units', 'vendor_laundry_containers', 'vendor_production_tasks', 'store_orders',
          'pos_prices', 'pos_garments', 'pos_categories', 'pos_services', 'vendor_employees']) {
          await query(`DELETE FROM ${t} WHERE vendor_id = $1`, [id]).catch(() => {})
        }
        await query(`DELETE FROM vendors WHERE id = $1`, [id]).catch(() => {})
      }
      if (created.userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.userIds]).catch(() => {})
    }
    await pool.end().catch(() => {})
  })

  it('status tabs, offset paging and paymentDue filter the list', async () => {
    const shop = await makeShop(1)
    const a = await book(shop, phone(2))
    const b = await book(shop, phone(3))
    const c = await book(shop, phone(4), 'CASH')
    const d = await book(shop, phone(5))
    // a -> IN_PROCESS, b -> cancelled
    expect((await orders.transition(shop.vendorId, shop.actor, a.id, 'IN_PROCESS')).success).toBe(true)
    expect((await orders.cancel(shop.vendorId, shop.actor, b.id, 'Customer changed mind')).success).toBe(true)

    const all = await orders.listOrders(shop.vendorId, {})
    expect(all.map((o) => o.id)).toEqual([d.id, c.id, b.id, a.id])

    // a comma list is a tab; one value still works as before; unknown / empty values are ignored
    expect((await orders.listOrders(shop.vendorId, { status: 'BOOKED,PICKED_UP' })).map((o) => o.id).sort()).toEqual([c.id, d.id].sort())
    expect((await orders.listOrders(shop.vendorId, { status: 'in_process' })).map((o) => o.id)).toEqual([a.id])
    expect((await orders.listOrders(shop.vendorId, { status: ',,' }))).toHaveLength(4)

    // paging: every order exactly once, newest first, stable
    const p1 = await orders.listOrders(shop.vendorId, { limit: 3, offset: 0 })
    const p2 = await orders.listOrders(shop.vendorId, { limit: 3, offset: 3 })
    expect([...p1, ...p2].map((o) => o.id)).toEqual([d.id, c.id, b.id, a.id])
    expect(await orders.listOrders(shop.vendorId, { limit: 3, offset: 99 })).toEqual([])
    expect(await orders.listOrders(shop.vendorId, { limit: 3, offset: -5 })).toHaveLength(3) // a bad offset is treated as 0
    expect(await orders.listOrders(shop.vendorId, { limit: 3, offset: 'abc' })).toHaveLength(3)

    // paymentDue: the cash order is paid, the cancelled one owes nothing
    expect((await orders.listOrders(shop.vendorId, { paymentDue: 'true' })).map((o) => o.id).sort()).toEqual([a.id, d.id].sort())
    expect((await orders.listOrders(shop.vendorId, { paymentDue: true, status: 'BOOKED' })).map((o) => o.id)).toEqual([d.id])
  })

  it('another shop never sees these orders in any filter', async () => {
    const mine = await makeShop(6)
    const other = await makeShop(7)
    await book(mine, phone(8))
    expect(await orders.listOrders(other.vendorId, { status: 'BOOKED', paymentDue: true })).toEqual([])
  })

  it('mini bill: 58 and 80 mm, any stage except cancelled; A4 invoice only once delivered', async () => {
    const shop = await makeShop(9)
    const o = await book(shop, phone(1))

    const mini80 = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'mini', paperMm: 80 })
    const mini58 = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'mini', paperMm: 58 })
    expect(isPdf(mini80.buffer) && isPdf(mini58.buffer)).toBe(true)
    expect(mini80.contentType).toBe('application/pdf')
    expect(mini80.buffer.equals(mini58.buffer)).toBe(false) // different paper, different page

    await expect(invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'full' })).rejects.toMatchObject({ code: 'INVOICE_NOT_AVAILABLE', statusCode: 409 })

    // pay, move through, deliver -> the issued invoice
    expect((await orders.collectPayment(shop.vendorId, shop.actor, o.id, { amountPaise: o.totalPaise, mode: 'CASH' })).success).toBe(true)
    for (const [state, extra] of [['IN_PROCESS', {}], ['READY', { allowIncomplete: true }], ['DELIVERED', {}]]) {
      const r = await orders.transition(shop.vendorId, shop.actor, o.id, state, extra)
      expect(r.success, JSON.stringify(r)).toBe(true)
    }
    const full = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'full' })
    expect(isPdf(full.buffer)).toBe(true)
    const again = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'full' })
    expect(again.buffer.equals(full.buffer)).toBe(true) // issued once, the same file every time
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM invoices WHERE order_id = $1`, [o.id])
    expect(rows[0].n).toBe(1)

    // after delivery the mini bill shows the invoice number, so the two documents agree
    const after = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'mini', paperMm: 80 })
    expect(isPdf(after.buffer)).toBe(true)
  })

  it('a cancelled order has no mini bill; another shop gets "not found" for both formats', async () => {
    const shop = await makeShop(2)
    const stranger = await makeShop(3)
    const o = await book(shop, phone(4))
    await expect(invoices.getPdfForVendor(stranger.vendorId, o.id, { format: 'mini' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(invoices.getPdfForVendor(stranger.vendorId, o.id, { format: 'full' })).rejects.toMatchObject({ statusCode: 404 })

    expect((await orders.cancel(shop.vendorId, shop.actor, o.id, 'Customer changed mind')).success).toBe(true)
    await expect(invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'mini' })).rejects.toBeInstanceOf(InvoiceError)
    await expect(invoices.getPdfForVendor(shop.vendorId, '00000000-0000-4000-8000-000000000000', { format: 'mini' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('an unknown paper size falls back to 80 mm instead of breaking', async () => {
    const shop = await makeShop(5)
    const o = await book(shop, phone(6))
    const odd = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'mini', paperMm: 12 })
    const eighty = await invoices.getPdfForVendor(shop.vendorId, o.id, { format: 'mini', paperMm: 80 })
    expect(isPdf(odd.buffer)).toBe(true)
    expect(odd.buffer.length).toBeGreaterThan(0)
    expect(Math.abs(odd.buffer.length - eighty.buffer.length)).toBeLessThan(200) // same layout (only the PDF timestamp differs)
  })
})
