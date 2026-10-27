import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DB_TESTS, applyTestEnv, makePool, seedUser, seedVendor, seedPaidDraft, seedWallet, uid } from './harness.js'

// Its own city so vendors seeded here never crowd another test file's discovery results.
const KOLKATA = { lat: 18.5204, lng: 73.8567 }

describe.skipIf(!DB_TESTS)('payments & order placement under concurrency (real PostgreSQL)', () => {
  let pool, OrdersService, OrdersRepository, PaymentsService, PaymentsRepository, PaymentSettlement, runReconcile

  beforeAll(async () => {
    applyTestEnv()
    pool = makePool()
    ;({ OrdersService } = await import('../../src/modules/orders/orders.service.js'))
    ;({ OrdersRepository } = await import('../../src/modules/orders/orders.repository.js'))
    ;({ PaymentsService } = await import('../../src/modules/payments/payments.service.js'))
    ;({ PaymentsRepository } = await import('../../src/modules/payments/payments.repository.js'))
    ;({ PaymentSettlement } = await import('../../src/modules/payments/payments.settlement.js'))
    ;({ runOnce: runReconcile } = await import('../../src/workers/payment-reconcile.worker.js'))
  })
  afterAll(async () => { await pool?.end() })

  const orders = () => new OrdersService(new OrdersRepository())
  const payments = () => new PaymentsService(new PaymentsRepository())
  const countOrders = async (draftId) => Number((await pool.query('SELECT COUNT(*) FROM orders WHERE id = $1', [draftId])).rows[0].count)

  describe('placing an order from a paid draft', () => {
    it('the app and the webhook placing the same draft at the same instant yield ONE order and no error', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId, paymentId } = await seedPaidDraft(pool, { vendor, user })

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => orders().placeOrderFromDraft(user.id, { orderDraftId: draftId, paymentMethod: 'COD' }))
      )

      expect(results.every((r) => r.status === 'fulfilled' && r.value.success)).toBe(true)
      expect(await countOrders(draftId)).toBe(1)
      const ids = new Set(results.map((r) => r.value.order.id))
      expect(ids.size).toBe(1)
      // The idempotent path must return the same camelCase shape (app shows orderNumber).
      expect(results.every((r) => typeof r.value.order.orderNumber === 'string')).toBe(true)
      const pay = await pool.query('SELECT order_id FROM payments WHERE id = $1', [paymentId])
      expect(pay.rows[0].order_id).toBe(draftId)
    })

    it('a customer\'s explicit COD choice wins over a webhook that defaulted to ONLINE', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user })
      await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId }) // webhook-style: no method
      expect((await pool.query('SELECT payment_method FROM orders WHERE id=$1', [draftId])).rows[0].payment_method).toBe('ONLINE')
      await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId, paymentMethod: 'COD' })  // app's own call
      expect((await pool.query('SELECT payment_method FROM orders WHERE id=$1', [draftId])).rows[0].payment_method).toBe('COD')
    })

    it('SECURITY: another customer cannot read or claim someone else\'s order by guessing the draft id', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const owner = await seedUser(pool)
      const attacker = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user: owner })
      await orders().placeOrderFromDraft(owner.id, { orderDraftId: draftId })
      await expect(orders().placeOrderFromDraft(attacker.id, { orderDraftId: draftId })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' })
    })

    it('REGRESSION: an advance that is paid but whose slot hold lapsed (slow bank) still becomes an order when capacity remains', async () => {
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: 5 })
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user, holdExpired: true })
      const res = await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId })
      expect(res.success).toBe(true)
      expect(await countOrders(draftId)).toBe(1)
    })

    it('...and is rejected with SLOT_FULL (so it gets refunded) when the slot really is full', async () => {
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: 1 })
      const first = await seedUser(pool)
      const second = await seedUser(pool)
      const a = await seedPaidDraft(pool, { vendor, user: first })
      const b = await seedPaidDraft(pool, { vendor, user: second, holdExpired: true })
      await orders().placeOrderFromDraft(first.id, { orderDraftId: a.draftId })
      await expect(orders().placeOrderFromDraft(second.id, { orderDraftId: b.draftId })).rejects.toMatchObject({ code: 'SLOT_FULL' })
    })

    it('a pickup date that already passed can never be honoured (SLOT_EXPIRED)', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user, bookingDate: '2020-01-01', withHold: false })
      await expect(orders().placeOrderFromDraft(user.id, { orderDraftId: draftId })).rejects.toMatchObject({ code: 'SLOT_EXPIRED' })
    })

    it('refuses to create an order when no advance has been paid', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user, paid: false })
      await expect(orders().placeOrderFromDraft(user.id, { orderDraftId: draftId })).rejects.toMatchObject({ code: 'PAYMENT_PENDING' })
    })

    it('REGRESSION: 400 simultaneous checkouts into a 120-place slot → exactly 120 orders; every customer who held a place gets one; nobody over-books', async () => {
      const CAPACITY = 120
      const LATE = 280 // paid after their hold lapsed (slow bank) — competing for the same slot
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: CAPACITY })
      const holders = []
      for (let i = 0; i < CAPACITY; i++) {
        const user = await seedUser(pool)
        holders.push({ user, ...(await seedPaidDraft(pool, { vendor, user })) }) // hold granted while capacity remained
      }
      const late = []
      for (let i = 0; i < LATE; i++) {
        const user = await seedUser(pool)
        late.push({ user, ...(await seedPaidDraft(pool, { vendor, user, withHold: false })) })
      }

      const all = [...holders, ...late].sort(() => Math.random() - 0.5) // arrive in random order
      const started = Date.now()
      const results = await Promise.allSettled(all.map((s) => orders().placeOrderFromDraft(s.user.id, { orderDraftId: s.draftId }).then((r) => ({ s, r }))))
      const elapsedMs = Date.now() - started

      const unexpected = results.filter((r) => r.status === 'rejected' && r.reason?.code !== 'SLOT_FULL')
      expect(unexpected.map((r) => r.reason?.code || r.reason?.message)).toEqual([])

      const placed = await pool.query(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT order_number)::int AS d FROM orders WHERE vendor_slot_id = $1`, [vendor.slotId])
      expect(placed.rows[0].n).toBe(CAPACITY)           // never over-booked
      expect(placed.rows[0].d).toBe(CAPACITY)           // no duplicate order numbers
      const holderOrders = await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE id = ANY($1::uuid[])`, [holders.map((h) => h.draftId)])
      expect(holderOrders.rows[0].n).toBe(CAPACITY)     // late payers never took a held place
      console.log(`      400 concurrent placements settled in ${elapsedMs} ms`)
    }, 180_000)

    it('late payers fill only the places that holders have not claimed', async () => {
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: 20 })
      const holders = []
      for (let i = 0; i < 8; i++) { const user = await seedUser(pool); holders.push({ user, ...(await seedPaidDraft(pool, { vendor, user })) }) }
      const late = []
      for (let i = 0; i < 30; i++) { const user = await seedUser(pool); late.push({ user, ...(await seedPaidDraft(pool, { vendor, user, withHold: false })) }) }
      await Promise.allSettled([...holders, ...late].map((s) => orders().placeOrderFromDraft(s.user.id, { orderDraftId: s.draftId })))
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE vendor_slot_id = $1`, [vendor.slotId])).rows[0].n).toBe(20)
      const holderOrders = await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE id = ANY($1::uuid[])`, [holders.map((h) => h.draftId)])
      expect(holderOrders.rows[0].n).toBe(8)
    }, 60_000)

    it('order-number collisions are retried, not fatal', async () => {
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: 50 })
      const svc = orders()
      // Force the first two generated numbers to collide with an existing order.
      const taken = (await pool.query(`SELECT order_number FROM orders LIMIT 1`)).rows[0]?.order_number
      if (!taken) return
      let calls = 0
      const real = svc._newOrderNumber.bind(svc)
      svc._newOrderNumber = () => (calls++ < 2 ? taken : real())
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user })
      const res = await svc.placeOrderFromDraft(user.id, { orderDraftId: draftId })
      expect(res.success).toBe(true)
      expect(calls).toBeGreaterThanOrEqual(3)
    })

    it('coupon accounting is exact under concurrency (no lost increments)', async () => {
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: 100 })
      const code = `T${uid().slice(0, 8).toUpperCase()}`
      const c = await pool.query(
        `INSERT INTO coupons (code, discount_type, discount_value, per_user_limit, usage_limit, is_active) VALUES ($1,'FLAT',10,5,1000,true) RETURNING id`, [code]
      )
      const draftRuns = []
      for (let i = 0; i < 25; i++) {
        const user = await seedUser(pool)
        draftRuns.push({ user, ...(await seedPaidDraft(pool, { vendor, user, couponCode: code })) })
      }
      await Promise.all(draftRuns.map((d) => orders().placeOrderFromDraft(d.user.id, { orderDraftId: d.draftId })))
      const usage = await pool.query('SELECT COUNT(*)::int AS n FROM coupon_usages WHERE coupon_id = $1', [c.rows[0].id])
      const counter = await pool.query('SELECT used_count FROM coupons WHERE id = $1', [c.rows[0].id])
      expect(usage.rows[0].n).toBe(25)
      expect(counter.rows[0].used_count).toBe(25)
    }, 60_000)
  })

  describe('wallet payments', () => {
    it('REGRESSION: tapping "pay" many times at once debits the wallet exactly once', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user, paid: false })
      await seedWallet(pool, user.id, 500)

      const results = await Promise.all(
        Array.from({ length: 12 }, () => payments().payWithWallet(user.id, { order_draft_id: draftId }))
      )

      expect(results.filter((r) => r.success).length).toBe(1)
      const bal = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [user.id])
      expect(Number(bal.rows[0].balance)).toBe(450)
      const paid = await pool.query(`SELECT COUNT(*)::int AS n FROM payments WHERE order_draft_id = $1 AND status = 'PAID'`, [draftId])
      expect(paid.rows[0].n).toBe(1)
    })

    it('an insufficient wallet is refused without charging', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user, paid: false })
      await seedWallet(pool, user.id, 10)
      const res = await payments().payWithWallet(user.id, { order_draft_id: draftId })
      expect(res.success).toBe(false)
      expect(res.message).toMatch(/insufficient/i)
      expect(Number((await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [user.id])).rows[0].balance)).toBe(10)
    })

    it('a wallet-paid advance that can never become an order is refunded to the wallet', async () => {
      const vendor = await seedVendor(pool, { ...KOLKATA, maxOrders: 1 })
      const holder = await seedUser(pool)
      const loser = await seedUser(pool)
      const a = await seedPaidDraft(pool, { vendor, user: holder })
      await orders().placeOrderFromDraft(holder.id, { orderDraftId: a.draftId })
      const b = await seedPaidDraft(pool, { vendor, user: loser, holdExpired: true })
      await seedWallet(pool, loser.id, 450) // after paying ₹50 from a 500 wallet

      const settlement = new PaymentSettlement({ repo: new PaymentsRepository() })
      const payment = await new PaymentsRepository().findById(b.paymentId)
      const outcome = await settlement.applyPaidSideEffects(payment, { source: 'test' })

      expect(outcome).toBe('REFUNDED')
      expect(Number((await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [loser.id])).rows[0].balance)).toBe(500)
      expect((await pool.query('SELECT status FROM payments WHERE id=$1', [b.paymentId])).rows[0].status).toBe('REFUNDED')
      // refunding twice must not credit twice
      await settlement.refundPayment(await new PaymentsRepository().findById(b.paymentId), { reason: 'again' })
      expect(Number((await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [loser.id])).rows[0].balance)).toBe(500)
    })
  })

  describe('reconciliation worker', () => {
    it('REGRESSION: money taken but the app died before placing the order → the worker places it', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId, paymentId } = await seedPaidDraft(pool, { vendor, user })
      await pool.query(`UPDATE payments SET paid_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [paymentId])
      // Park every other unplaced payment (left by other tests) so this run is about this one.
      await pool.query(`UPDATE payments SET recovery_next_at = NOW() + INTERVAL '1 day' WHERE status = 'PAID' AND order_id IS NULL AND id <> $1`, [paymentId])
      expect(await countOrders(draftId)).toBe(0)

      await runReconcile()

      expect(await countOrders(draftId)).toBe(1)
      const p = await pool.query('SELECT order_id FROM payments WHERE id = $1', [paymentId])
      expect(p.rows[0].order_id).toBe(draftId)
    })

    it('does not touch a payment that was just confirmed (the app is probably still placing it)', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user })
      await runReconcile()
      expect(await countOrders(draftId)).toBe(0)
    })

    it('a PAID balance payment whose order never got updated is finished', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user })
      await orders().placeOrderFromDraft(user.id, { orderDraftId: draftId })
      const p = await pool.query(
        `INSERT INTO payments (user_id, order_id, amount, status, method, purpose, paid_at)
         VALUES ($1, $2, 110, 'PAID', 'upi', 'BALANCE', NOW() - INTERVAL '5 minutes') RETURNING id`, [user.id, draftId]
      )
      await pool.query(`UPDATE orders SET payment_status = 'ADVANCE_PAID' WHERE id = $1`, [draftId])
      await runReconcile()
      expect((await pool.query('SELECT payment_status FROM orders WHERE id=$1', [draftId])).rows[0].payment_status).toBe('PAID')
      expect(p.rows[0].id).toBeTruthy()
    })
  })

  describe('database guards', () => {
    it('refuses a second PAID advance for the same draft at the database level', async () => {
      const vendor = await seedVendor(pool, KOLKATA)
      const user = await seedUser(pool)
      const { draftId } = await seedPaidDraft(pool, { vendor, user })
      await expect(
        pool.query(`INSERT INTO payments (user_id, order_draft_id, amount, status, purpose) VALUES ($1,$2,50,'PAID','ADVANCE')`, [user.id, draftId])
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('refuses the same gateway payment id on two rows', async () => {
      const user = await seedUser(pool)
      const rzp = `pay_${uid().slice(0, 12)}`
      await pool.query(`INSERT INTO payments (user_id, amount, status, purpose, razorpay_payment_id) VALUES ($1,50,'PAID','FULL',$2)`, [user.id, rzp])
      await expect(
        pool.query(`INSERT INTO payments (user_id, amount, status, purpose, razorpay_payment_id) VALUES ($1,50,'PAID','FULL',$2)`, [user.id, rzp])
      ).rejects.toMatchObject({ code: '23505' })
    })
  })
})
