/**
 * Integration tests for GET /vendor/pos/report (Phase 4 of the POS-mode initiative; real migrated Postgres,
 * skipped if unreachable). Every expected number is computed with independent SQL, never by the report code.
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

describe.skipIf(!dbUp)('POS report (real database)', () => {
  afterAll(async () => {
    if (dbUp) {
      for (const id of created.vendorIds) {
        for (const t of ['vendor_expenses', 'store_order_status_events', 'store_order_payments', 'vendor_garment_units', 'vendor_laundry_containers', 'vendor_production_tasks', 'store_orders',
          'pos_prices', 'pos_garments', 'pos_categories', 'pos_services', 'vendor_employees']) {
          await query(`DELETE FROM ${t} WHERE vendor_id = $1`, [id]).catch(() => {})
        }
        await query(`DELETE FROM vendors WHERE id = $1`, [id]).catch(() => {})
      }
      if (created.userIds.length) await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.userIds]).catch(() => {})
    }
    await pool.end().catch(() => {})
  })

  it('rejects bad ranges with a clear sentence', async () => {
    const shop = await makeShop(1)
    for (const [from, to] of [['2026-02-31', today], [today, 'x'], [addDays(1), today], ['2020-01-01', today]]) {
      const r = await dashboard.report(shop.vendorId, from, to)
      expect(r.success, `${from}..${to}`).toBe(false)
      expect(r.message).toBeTruthy()
    }
  })

  it('an empty shop gets zeros and one zero row per day', async () => {
    const shop = await makeShop(2, { withCatalogue: false })
    const { report } = await dashboard.report(shop.vendorId, addDays(-2), today)
    expect(report).toMatchObject({ orderCount: 0, revenuePaise: 0, collectionPaise: 0, duesPaise: 0, expensesPaise: 0, netPaise: 0, days: 3 })
    expect(report.daily).toHaveLength(3)
    expect(report.daily.every((d) => d.revenuePaise === 0 && d.collectionPaise === 0 && d.expensesPaise === 0)).toBe(true)
    expect(report.topGarments).toEqual([])
  })

  it('every figure equals the database; cancelled / mirrored / other-shop rows never count', async () => {
    const shop = await makeShop(3)
    const other = await makeShop(4)
    const line = await firstLine(shop.vendorId)
    const otherLine = await firstLine(other.vendorId)
    const mk = (extra) => orders.book(shop.vendorId, shop.actor, {
      customer: { name: 'Ravi', phone: phone(8) }, expectedDeliveryDate: addDays(3), items: [{ ...line, qty: 2 }], paymentMode: 'PAY_LATER', ...extra,
    })
    const a = await mk({})                       // unpaid
    const b = await mk({ paymentMode: 'CASH' })  // paid in cash at booking
    const c = await mk({})                       // part paid by UPI
    const d = await mk({})                       // cancelled
    const e = await mk({})                       // mirrored Epic row
    for (const r of [a, b, c, d, e]) expect(r.success).toBe(true)
    expect((await orders.collectPayment(shop.vendorId, shop.actor, c.order.id, { amountPaise: 1000, mode: 'UPI' })).success).toBe(true)
    expect((await orders.cancel(shop.vendorId, shop.actor, d.order.id, 'test')).success).toBe(true)
    await query(`UPDATE store_orders SET source = 'DESKTOP_PUSH' WHERE id = $1`, [e.order.id])
    // An order placed 3 days ago, outside "today"
    const old = await mk({})
    await query(`UPDATE store_orders SET placed_at = now() - interval '3 days' WHERE id = $1`, [old.order.id])
    // Expenses: two paid today (one cash), one cancelled, one old
    const exp = (extra) => query(
      `INSERT INTO vendor_expenses (vendor_id, expense_name, expense_date, amount_paise, category, payment_mode, status, created_by) VALUES ($1,'x',$2,$3,$4,'CASH',$5,$6)`,
      [shop.vendorId, extra.date ?? today, extra.amount, extra.category, extra.status ?? 'PAID', shop.user.id])
    await exp({ amount: 700, category: 'RENT' })
    await exp({ amount: 300, category: 'TEA' })
    await exp({ amount: 999, category: 'RENT', status: 'CANCELLED' })
    await exp({ amount: 5000, category: 'RENT', date: addDays(-3) })
    // Another shop's big order must not leak
    expect((await orders.book(other.vendorId, other.actor, { customer: { name: 'Zed', phone: phone(7) }, expectedDeliveryDate: today, items: [{ ...otherLine, qty: 9 }], paymentMode: 'CASH' })).success).toBe(true)

    const v = shop.vendorId
    const one = async (text, p = [v, today, today]) => (await query(text, p)).rows[0]
    const revenue = await one(`SELECT COALESCE(SUM(total_paise),0)::int AS v, COUNT(*)::int AS n FROM store_orders WHERE vendor_id=$1 AND source<>'DESKTOP_PUSH' AND status<>'CANCELLED' AND placed_at::date BETWEEN $2 AND $3`)
    const collected = await one(`SELECT COALESCE(SUM(p.amount_paise),0)::int AS v FROM store_order_payments p JOIN store_orders so ON so.id=p.store_order_id WHERE p.vendor_id=$1 AND so.source<>'DESKTOP_PUSH' AND p.created_at::date BETWEEN $2 AND $3`)
    const cash = await one(`SELECT COALESCE(SUM(p.amount_paise),0)::int AS v FROM store_order_payments p WHERE p.vendor_id=$1 AND p.mode='CASH' AND p.created_at::date BETWEEN $2 AND $3`)
    const dues = await one(`SELECT COALESCE(SUM(total_paise-amount_paid_paise),0)::int AS v FROM store_orders WHERE vendor_id=$1 AND source<>'DESKTOP_PUSH' AND status<>'CANCELLED' AND placed_at::date BETWEEN $2 AND $3`)
    const spent = await one(`SELECT COALESCE(SUM(amount_paise),0)::int AS v FROM vendor_expenses WHERE vendor_id=$1 AND status='PAID' AND expense_date BETWEEN $2 AND $3`)

    const { report } = await dashboard.report(v, today, today)
    expect(report.revenuePaise).toBe(revenue.v)
    expect(report.revenuePaise).toBe(a.order.totalPaise + b.order.totalPaise + c.order.totalPaise)
    expect(report.orderCount).toBe(3)
    expect(report.collectionPaise).toBe(collected.v)
    expect(report.collectionPaise).toBe(b.order.totalPaise + 1000)
    expect(report.paymentMix).toEqual({ cashPaise: cash.v, upiPaise: 1000, cardPaise: 0, bankPaise: 0, walletPaise: 0 })
    expect(report.duesPaise).toBe(dues.v)
    expect(report.duesPaise).toBe(a.order.totalPaise + c.order.totalPaise - 1000)
    expect(report.duesOrderCount).toBe(2)
    expect(report.expensesPaise).toBe(spent.v)
    expect(report.expensesPaise).toBe(1000)
    expect(report.expenseCount).toBe(2)
    expect(report.netPaise).toBe(collected.v - spent.v)
    expect(report.expenseByCategory).toEqual([{ category: 'RENT', totalPaise: 700 }, { category: 'TEA', totalPaise: 300 }])
    expect(report.ordersByStatus).toEqual({ booked: 3, inProcess: 0, ready: 0, delivered: 0, cancelled: 1 })
    expect(report.daily).toEqual([{ date: today, revenuePaise: revenue.v, collectionPaise: collected.v, expensesPaise: spent.v }])
    expect(report.topGarments).toHaveLength(1)
    expect(report.topGarments[0]).toMatchObject({ qty: 6, revenuePaise: a.order.items[0].amountPaise * 3 })

    // A wider range adds the old order and the old expense, and the daily rows add up to the totals.
    const wide = (await dashboard.report(v, addDays(-3), today)).report
    expect(wide.days).toBe(4)
    expect(wide.revenuePaise).toBe(report.revenuePaise + old.order.totalPaise)
    expect(wide.expensesPaise).toBe(6000)
    for (const [k, total] of [['revenuePaise', wide.revenuePaise], ['collectionPaise', wide.collectionPaise], ['expensesPaise', wide.expensesPaise]]) {
      expect(wide.daily.reduce((s, x) => s + x[k], 0), k).toBe(total)
    }
    expect(wide.daily.map((x) => x.date)).toEqual([addDays(-3), addDays(-2), addDays(-1), today])

    // The other shop sees only itself.
    const o = (await dashboard.report(other.vendorId, today, today)).report
    expect(o.orderCount).toBe(1)
    expect(o.expensesPaise).toBe(0)
  })
})
