import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  DB_TESTS, applyTestEnv, makePool, seedUser, seedVendor, seedPaidDraft, seedWallet, tokenFor, buildTestApp, uid,
} from './harness.js'

// Regression tests for the defects found in the 2026-11-07 full-API test (real PostgreSQL + Redis):
//  D1 customer could not cancel any current order · D14 rejected / auto-rejected orders never refunded
//  D15 vendor reject deleted everyone's slot holds · D3 /auth/my-vendors crashed · D2 four reports crashed
const CITY = { lat: 12.3456, lng: 76.5432 }

describe.skipIf(!DB_TESTS)('order cancellation, refunds, my-vendors and reports (real PostgreSQL)', () => {
  let app, pool, OrdersService, OrdersRepository, processOrderJob, VendorOrdersService, AuthRepository, AdminReportsRepository, ShopReportsRepository

  beforeAll(async () => {
    applyTestEnv()
    pool = makePool()
    app = await buildTestApp()
    ;({ OrdersService } = await import('../../src/modules/orders/orders.service.js'))
    ;({ OrdersRepository } = await import('../../src/modules/orders/orders.repository.js'))
    ;({ processOrderJob } = await import('../../src/workers/processors.js'))
    ;({ VendorOrdersService } = await import('../../src/modules/vendor-orders/vendor-orders.service.js'))
    ;({ AuthRepository } = await import('../../src/modules/auth/auth.repository.js'))
    ;({ AdminReportsRepository } = await import('../../src/modules/admin/reports/repository.js'))
    ;({ ShopReportsRepository } = await import('../../src/modules/shop-reports/repository.js'))
  })
  afterAll(async () => { await app?.close(); await pool?.end() })

  const orders = () => new OrdersService(new OrdersRepository())
  const wallet = async (userId) => Number((await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [userId])).rows[0].balance)
  const pay = async (draftId) => (await pool.query('SELECT status, refund_status FROM payments WHERE order_draft_id=$1', [draftId])).rows[0]

  /** A placed, advance-paid order for a customer with a ₹500 wallet (advance ₹50 already taken). */
  async function placedOrder({ maxOrders = 5 } = {}) {
    const vendor = await seedVendor(pool, { ...CITY, maxOrders })
    const user = await seedUser(pool)
    await seedWallet(pool, user.id, 500)
    const { draftId } = await seedPaidDraft(pool, { vendor, user, method: 'LNDRY_WALLET' })
    const placed = await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId, paymentMethod: 'COD' })
    expect(placed.success).toBe(true)
    return { vendor, user, orderId: placed.order.id }
  }
  const cancel = (user, orderId, reason = 'changed my mind') => app.inject({
    method: 'POST', url: `/api/v1/orders/${orderId}/cancel`,
    headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { reason },
  })

  describe('D1 — customer cancellation', () => {
    it('cancels a WAITING_VENDOR_CONFIRMATION order and refunds the wallet advance', async () => {
      const { user, orderId } = await placedOrder()
      expect((await pool.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('WAITING_VENDOR_CONFIRMATION')
      const before = await wallet(user.id)

      const res = await cancel(user, orderId)
      expect(res.statusCode, res.body).toBe(200)

      expect((await pool.query('SELECT status, cancelled_reason FROM orders WHERE id=$1', [orderId])).rows[0]).toMatchObject({ status: 'CUSTOMER_CANCELLED', cancelled_reason: 'changed my mind' })
      expect(await pay(orderId)).toMatchObject({ status: 'REFUNDED', refund_status: 'PROCESSED' })
      expect(await wallet(user.id)).toBe(before + 50)
      const ev = await pool.query(`SELECT new_status, actor_role FROM order_events WHERE order_id=$1 ORDER BY timestamp DESC LIMIT 1`, [orderId])
      expect(ev.rows[0]).toMatchObject({ new_status: 'CUSTOMER_CANCELLED', actor_role: 'CUSTOMER' })
    })

    it('cancelling twice is refused and refunds only once', async () => {
      const { user, orderId } = await placedOrder()
      const before = await wallet(user.id)
      expect((await cancel(user, orderId)).statusCode).toBe(200)
      const again = await cancel(user, orderId)
      expect(again.statusCode).toBe(400)
      expect(again.json().code).toBe('ALREADY_CANCELLED')
      expect(await wallet(user.id)).toBe(before + 50)
    })

    it('simultaneous cancel taps refund exactly once', async () => {
      const { user, orderId } = await placedOrder()
      const before = await wallet(user.id)
      const rs = await Promise.all(Array.from({ length: 8 }, () => cancel(user, orderId)))
      expect(rs.filter((r) => r.statusCode === 200).length).toBe(1)
      expect(rs.every((r) => [200, 400].includes(r.statusCode))).toBe(true)
      expect(await wallet(user.id)).toBe(before + 50)
    })

    it("another customer cannot cancel someone else's order (404)", async () => {
      const { orderId } = await placedOrder()
      const stranger = await seedUser(pool)
      expect((await cancel(stranger, orderId)).statusCode).toBe(404)
      expect((await pool.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('WAITING_VENDOR_CONFIRMATION')
    })

    it('cannot cancel once the pickup has started, and nothing is refunded', async () => {
      const { user, orderId } = await placedOrder()
      await pool.query(`UPDATE orders SET status='PICKED_UP' WHERE id=$1`, [orderId])
      const before = await wallet(user.id)
      const res = await cancel(user, orderId)
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('CANCEL_NOT_ALLOWED')
      expect(await wallet(user.id)).toBe(before)
    })

    it('can still cancel after the laundry accepted (before pickup)', async () => {
      const { user, orderId } = await placedOrder()
      await pool.query(`UPDATE orders SET status='VENDOR_ACCEPTED' WHERE id=$1`, [orderId])
      expect((await cancel(user, orderId)).statusCode).toBe(200)
    })

    it('frees the place in the slot so another customer can book it', async () => {
      const { vendor, orderId, user } = await placedOrder({ maxOrders: 1 })
      const other = await seedUser(pool)
      await seedWallet(pool, other.id, 500)
      const second = await seedPaidDraft(pool, { vendor, user: other, holdExpired: true })
      await expect(orders().placeOrderFromDraft(other.id, { orderDraftId: second.draftId })).rejects.toMatchObject({ code: 'SLOT_FULL' })
      expect((await cancel(user, orderId)).statusCode).toBe(200)
      const retry = await seedPaidDraft(pool, { vendor, user: other, holdExpired: true })
      expect((await orders().placeOrderFromDraft(other.id, { orderDraftId: retry.draftId })).success).toBe(true)
    })
  })

  describe('D14 — rejected and auto-rejected orders are refunded', () => {
    it('auto-reject (laundry did not answer) credits the wallet, once', async () => {
      const { user, orderId } = await placedOrder()
      const before = await wallet(user.id)
      await processOrderJob({ id: 'j1', data: { type: 'auto-reject', orderId } })
      expect((await pool.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('AUTO_REJECTED')
      expect(await pay(orderId)).toMatchObject({ status: 'REFUNDED', refund_status: 'PROCESSED' })
      expect(await wallet(user.id)).toBe(before + 50)
      await processOrderJob({ id: 'j2', data: { type: 'auto-refund', orderId } }) // a repeat must not pay again
      expect(await wallet(user.id)).toBe(before + 50)
    })

    it("a laundry's rejection queues a refund and the 'auto-refund' job now pays it back", async () => {
      const { vendor, user, orderId } = await placedOrder()
      const staff = await seedUser(pool, { role: 'ADMIN' })
      await pool.query(`INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [vendor.id, staff.id])
      const before = await wallet(user.id)

      await new VendorOrdersService({ fastify: app }).rejectOrder(staff.id, orderId, 'closed today')
      expect((await pool.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('VENDOR_REJECTED')
      await processOrderJob({ id: 'j3', data: { type: 'auto-refund', orderId, reason: 'closed today' } })

      expect(await pay(orderId)).toMatchObject({ status: 'REFUNDED' })
      expect(await wallet(user.id)).toBe(before + 50)
    })

    it('D15 — a rejection releases only that customer\'s slot hold, not other people\'s', async () => {
      const { vendor, user, orderId } = await placedOrder()
      const bystander = await seedUser(pool)
      const q = await pool.query(`INSERT INTO quotes (customer_id, vendor_id, estimate_paise, pricing_snapshot, expires_at, booking_type) VALUES ($1,$2,100,'[]',NOW()+INTERVAL '1 hour','STANDARD') RETURNING id`, [bystander.id, vendor.id])
      const order = (await pool.query('SELECT vendor_slot_id, pickup_date FROM orders WHERE id=$1', [orderId])).rows[0]
      await pool.query(
        `INSERT INTO slot_holds (vendor_id, slot_id, user_id, customer_id, quote_id, booking_date, expires_at, status) VALUES ($1,$2,$3,$3,$4,$5,NOW()+INTERVAL '10 minutes','ACTIVE')`,
        [vendor.id, order.vendor_slot_id, bystander.id, q.rows[0].id, order.pickup_date]
      )
      const staff = await seedUser(pool, { role: 'ADMIN' })
      await pool.query(`INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [vendor.id, staff.id])
      await new VendorOrdersService({ fastify: app }).rejectOrder(staff.id, orderId, 'x')
      const left = await pool.query(`SELECT count(*)::int n FROM slot_holds WHERE user_id=$1 AND status='ACTIVE'`, [bystander.id])
      expect(left.rows[0].n).toBe(1)
      void user
    })
  })

  describe('D3 — GET /auth/my-vendors', () => {
    it('lists the user\'s active shops in the documented shape', async () => {
      const vendor = await seedVendor(pool, CITY)
      const staff = await seedUser(pool, { role: 'ADMIN' })
      await pool.query(`INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [vendor.id, staff.id])

      const repoRes = await new AuthRepository().loadActiveShopAssignmentsPaginated(staff.id, { page: 1, limit: 20 })
      expect(repoRes.total).toBe(1)
      expect(repoRes.items[0]).toMatchObject({ vendor_id: vendor.id, shop_name: vendor.name, shop_role: 'VENDOR_OWNER' })

      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/my-vendors', headers: { authorization: `Bearer ${tokenFor(staff, { role: 'ADMIN' })}` } })
      expect(res.statusCode, res.body).toBe(200)
      const data = res.json().data
      expect(data.vendors).toHaveLength(1)
      expect(data.vendors[0].vendor_id).toBe(vendor.id)
      expect(data.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 })
    })

    it('returns an empty list (not a 500) for a user with no shops', async () => {
      const nobody = await seedUser(pool)
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/my-vendors', headers: { authorization: `Bearer ${tokenFor(nobody)}` } })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.vendors).toEqual([])
    })
  })

  describe('D2 — the four crashing reports now run against the real schema', () => {
    const filters = [{}, { from: '2020-01-01', to: '2030-01-01' }]
    for (const f of filters) {
      const label = Object.keys(f).length ? 'with a date range' : 'with no filters'
      it(`admin reports ${label}`, async () => {
        const repo = new AdminReportsRepository()
        for (const method of ['getCouponUsage', 'getLowStock', 'getRiderPerformance']) {
          const r = await repo[method](f, 1, 10)
          expect(Array.isArray(r.data), method).toBe(true)
          expect(typeof r.total, method).toBe('number')
        }
      })
      it(`shop reports ${label}`, async () => {
        const vendor = await seedVendor(pool, CITY)
        const repo = new ShopReportsRepository()
        for (const method of ['getCouponUsage', 'getLowStock', 'getRiderPerformance', 'getStaffActivity']) {
          const r = await repo[method](vendor.id, f, 1, 10)
          expect(Array.isArray(r.data), method).toBe(true)
        }
      })
    }

    it('coupon usage counts real redemptions', async () => {
      const vendor = await seedVendor(pool, CITY)
      const user = await seedUser(pool)
      const code = `R${uid().slice(0, 7).toUpperCase()}`
      const c = await pool.query(`INSERT INTO coupons (code, discount_type, discount_value, per_user_limit, usage_limit, is_active) VALUES ($1,'FLAT',10,5,100,true) RETURNING id`, [code])
      const { draftId } = await seedPaidDraft(pool, { vendor, user, couponCode: code })
      const placed = await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId })
      expect(placed.success).toBe(true)
      const rows = (await new ShopReportsRepository().getCouponUsage(vendor.id, {}, 1, 10)).data
      const mine = rows.find((r) => r.coupon_id === c.rows[0].id)
      expect(mine).toBeTruthy()
      expect(Number(mine.usage_count)).toBe(1)
    })

    it('rider performance counts delivered time from the OUT_FOR_DELIVERY event', async () => {
      const vendor = await seedVendor(pool, CITY)
      const user = await seedUser(pool)
      const rider = await seedUser(pool, { role: 'RIDER' })
      const { draftId } = await seedPaidDraft(pool, { vendor, user })
      const placed = await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId })
      await pool.query(`UPDATE orders SET rider_id=$2, status='DELIVERED', delivered_at=NOW() WHERE id=$1`, [placed.order.id, rider.id])
      await pool.query(`INSERT INTO order_events (order_id, old_status, new_status, actor_role, timestamp) VALUES ($1,'PACKED','OUT_FOR_DELIVERY','RIDER', NOW() - INTERVAL '30 minutes')`, [placed.order.id])
      const row = (await new ShopReportsRepository().getRiderPerformance(vendor.id, {}, 1, 10)).data.find((r) => r.rider_id === rider.id)
      expect(Number(row.deliveries)).toBe(1)
      expect(Number(row.avg_delivery_seconds)).toBeGreaterThan(1700)
    })
  })

  describe('D8 — payment limits follow the account, not the IP', () => {
    it('two customers on the SAME IP each get their own wallet-payment allowance', async () => {
      const a = await seedUser(pool); const b = await seedUser(pool)
      const hit = (u) => app.inject({ method: 'POST', url: '/api/v1/payments/pay-with-wallet', headers: { authorization: `Bearer ${tokenFor(u)}` }, remoteAddress: '203.0.113.7', payload: { order_draft_id: uid() } })
      for (let i = 0; i < 20; i++) expect((await hit(a)).statusCode).not.toBe(429)
      expect((await hit(a)).statusCode).toBe(429) // A used up A's 20
      expect((await hit(b)).statusCode).not.toBe(429) // B, same IP, is unaffected
    })
  })
})
