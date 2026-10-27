import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

// ── Module mocks (no DB / Redis / gateway) ────────────────────────────────
const dbQuery = vi.fn(async () => ({ rows: [] }))
vi.mock('../../../src/config/database.js', () => ({ query: (...a) => dbQuery(...a), getClient: vi.fn() }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))
vi.mock('../../../src/config/env.js', () => ({ env: { NODE_ENV: 'test', ALLOW_MOCK_PAYMENT: false } }))

const gateway = {
  keySecret: 'key-secret',
  webhookSecret: 'wh-secret',
  client: {
    orders: { fetchPayments: vi.fn(async () => ({ items: [] })) },
    payments: { refund: vi.fn(async () => ({ id: 'rfnd_1' })), capture: vi.fn() },
  },
}
vi.mock('../../../src/config/razorpay.js', () => ({ getRazorpay: vi.fn(async () => ({ keyId: 'rzp_test', mode: 'TEST', ...gateway })) }))

const lifecycle = vi.fn(async () => [])
vi.mock('../../../src/modules/lifecycle-notifications/lifecycle-jobs.js', () => ({ emitLifecycleEvent: (...a) => lifecycle(...a) }))
vi.mock('../../../src/modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: class { async createNotification() { return {} } },
}))
vi.mock('../../../src/modules/notifications/notification-dispatcher.js', () => ({
  NotificationDispatcher: class { async sendToUsers() { return {} } },
}))
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: class {
    async updateStatus(...a) { ordersUpdate(...a) }
    async findById(id) { return orders.get(id) || null }
    async findByIdAndUser(id) { return orders.get(id) || null }
  },
}))
vi.mock('../../../src/modules/wallet/wallet.repository.js', () => ({ WalletRepository: class {} }))
vi.mock('../../../src/modules/wallet-redemption/wallet-redemption.repository.js', () => ({ WalletRedemptionRepository: class {} }))

const placeOrderFromDraft = vi.fn()
vi.mock('../../../src/modules/orders/orders.service.js', () => ({
  OrdersService: class { placeOrderFromDraft(...a) { return placeOrderFromDraft(...a) } },
}))

const orders = new Map()
const ordersUpdate = vi.fn()

// ── In-memory payments repository with the real atomic semantics ───────────
function makeRepo(rows = []) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]))
  const repo = {
    byId,
    async findById(id) { return byId.get(id) ? { ...byId.get(id) } : null },
    async findByRazorpayOrderId(oid) { const r = [...byId.values()].find((x) => x.razorpayOrderId === oid); return r ? { ...r } : null },
    async markPaid(id, { razorpayPaymentId, signature, method } = {}) {
      const r = byId.get(id)
      if (!r) return { transitioned: false, payment: null }
      if (r.status === 'PAID' || r.status === 'REFUNDED') return { transitioned: false, payment: { ...r } }
      if (r.purpose === 'ADVANCE' && [...byId.values()].some((x) => x.id !== id && x.orderDraftId === r.orderDraftId && x.status === 'PAID' && x.purpose === 'ADVANCE')) {
        return { transitioned: false, duplicate: true, constraint: 'uq_payments_one_paid_advance_per_draft', payment: null }
      }
      Object.assign(r, { status: 'PAID', razorpayPaymentId: razorpayPaymentId || r.razorpayPaymentId, razorpaySignature: signature || r.razorpaySignature, method: method || r.method, paidAt: new Date(), failureReason: null, failureCode: null })
      return { transitioned: true, payment: { ...r } }
    },
    async recordFailure(id, { code, message, source }, { terminal } = {}) {
      const r = byId.get(id)
      if (!r || r.status === 'PAID' || r.status === 'REFUNDED') return null
      Object.assign(r, { failureCode: code, failureReason: message, failureSource: source })
      if (terminal && ['PENDING', 'EXPIRED'].includes(r.status)) r.status = 'FAILED'
      return { ...r }
    },
    async updateRefund(id, d) { const r = byId.get(id); Object.assign(r, { status: 'REFUNDED', refundId: d.refundId, refundAmount: d.refundAmount }); return { ...r } },
    async findPaidByOrderDraftId() { return null },
    async findLatestByOrderDraftId() { return null },
    async findByOrderId() { return null },
  }
  return repo
}

const basePayment = (over = {}) => ({
  id: 'pay-1', userId: 'user-1', status: 'PENDING', purpose: 'ADVANCE', amount: 50,
  orderId: null, orderDraftId: 'draft-1', razorpayOrderId: 'order_rzp_1', razorpayPaymentId: null,
  method: null, recoveryAttempts: 0, metadata: {}, createdAt: new Date(), ...over,
})

const { PaymentSettlement } = await import('../../../src/modules/payments/payments.settlement.js')
const { PaymentsService } = await import('../../../src/modules/payments/payments.service.js')

function signedWebhook(body, secret = gateway.webhookSecret) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  return { raw, signature: crypto.createHmac('sha256', secret).update(raw).digest('hex') }
}

beforeEach(() => {
  vi.clearAllMocks()
  orders.clear()
  dbQuery.mockImplementation(async (sql) => {
    if (/INSERT INTO payment_webhook_events/.test(sql)) return { rows: [{ processed_at: null }] }
    return { rows: [] }
  })
  placeOrderFromDraft.mockResolvedValue({ success: true, order: { id: 'draft-1' } })
})

describe('late / lost payment confirmations never strand a customer\'s money', () => {
  it('REGRESSION: a webhook for a balance (order-based) payment now updates the order', async () => {
    const repo = makeRepo([basePayment({ purpose: 'BALANCE', orderId: 'order-1', orderDraftId: null })])
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_rzp_1', method: 'upi' } } } })

    const res = await svc.handleWebhook(raw, signature, 'evt-1')

    expect(res.success).toBe(true)
    expect(repo.byId.get('pay-1').status).toBe('PAID')
    expect(ordersUpdate).toHaveBeenCalledWith('order-1', undefined, { paymentStatus: 'PAID' })
    expect(placeOrderFromDraft).not.toHaveBeenCalled()
  })

  it('a payment captured AFTER it was marked EXPIRED is still honoured and the order is placed', async () => {
    const repo = makeRepo([basePayment({ status: 'EXPIRED' })])
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_late', order_id: 'order_rzp_1', method: 'netbanking' } } } })

    await svc.handleWebhook(raw, signature, 'evt-late')

    expect(repo.byId.get('pay-1').status).toBe('PAID')
    expect(placeOrderFromDraft).toHaveBeenCalledWith('user-1', expect.objectContaining({ orderDraftId: 'draft-1' }))
  })

  it('a payment captured after an earlier failed attempt on the same gateway order is honoured', async () => {
    const repo = makeRepo([basePayment({ failureReason: 'bank declined', failureCode: 'BANK_DECLINED' })])
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_retry', order_id: 'order_rzp_1' } } } })
    await svc.handleWebhook(raw, signature, 'evt-retry')
    expect(repo.byId.get('pay-1').status).toBe('PAID')
    expect(repo.byId.get('pay-1').failureReason).toBeNull()
  })

  it('the same webhook delivered twice is applied once', async () => {
    const repo = makeRepo([basePayment()])
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_rzp_1' } } } })

    let calls = 0
    dbQuery.mockImplementation(async (sql) => {
      if (/INSERT INTO payment_webhook_events/.test(sql)) { calls++; return { rows: [{ processed_at: calls > 1 ? new Date() : null }] } }
      return { rows: [] }
    })
    await svc.handleWebhook(raw, signature, 'evt-dup')
    const second = await svc.handleWebhook(raw, signature, 'evt-dup')

    expect(second.duplicate).toBe(true)
    expect(placeOrderFromDraft).toHaveBeenCalledTimes(1)
  })

  it('a transient processing error is surfaced (so Razorpay retries) and not marked processed', async () => {
    const repo = makeRepo([basePayment()])
    repo.markPaid = vi.fn(async () => { throw new Error('db down') })
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'p', order_id: 'order_rzp_1' } } } })

    await expect(svc.handleWebhook(raw, signature, 'evt-err')).rejects.toThrow('db down')
    expect(dbQuery.mock.calls.some(([sql]) => /SET processed_at = NOW\(\)/.test(sql))).toBe(false)
  })

  it('rejects an unsigned / wrongly signed webhook with 400', async () => {
    const svc = new PaymentsService(makeRepo([basePayment()]))
    const { raw } = signedWebhook({ event: 'payment.captured', payload: {} })
    const res = await svc.handleWebhook(raw, 'deadbeef', 'evt-bad')
    expect(res).toMatchObject({ success: false, status: 400 })
  })
})

describe('payment failures are explained and never corrupt a live order', () => {
  it('records a human reason from the gateway error and keeps the payment open for a retry', async () => {
    const repo = makeRepo([basePayment()])
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_f', order_id: 'order_rzp_1', error_code: 'BAD_REQUEST_ERROR', error_description: 'Your payment was declined by the bank due to insufficient funds', error_source: 'customer' } } },
    })
    await svc.handleWebhook(raw, signature, 'evt-fail')
    const p = repo.byId.get('pay-1')
    expect(p.status).toBe('PENDING')
    expect(p.failureCode).toBe('INSUFFICIENT_FUNDS')
    expect(p.failureReason).toMatch(/insufficient balance/i)
  })

  it('a failed BALANCE attempt does not flip an in-delivery order to PAYMENT_FAILED', async () => {
    orders.set('order-1', { id: 'order-1', status: 'OUT_FOR_DELIVERY' })
    const repo = makeRepo([basePayment({ purpose: 'BALANCE', orderId: 'order-1', orderDraftId: null })])
    const svc = new PaymentsService(repo)
    const { raw, signature } = signedWebhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pf', order_id: 'order_rzp_1', error_description: 'declined' } } } })
    await svc.handleWebhook(raw, signature, 'evt-bal-fail')
    expect(ordersUpdate).not.toHaveBeenCalledWith('order-1', 'PAYMENT_FAILED', expect.anything())
  })

  it('getPaymentStatus shows the reason for a failure and CONFIRMING while the bank is slow', async () => {
    const failing = makeRepo([basePayment({ failureReason: 'Your bank declined the payment.', failureCode: 'BANK_DECLINED' })])
    const s1 = await new PaymentsService(failing).getPaymentStatus('user-1', { paymentId: 'pay-1' })
    expect(s1.data.status).toBe('FAILED')
    expect(s1.data.message).toMatch(/declined/)

    const slow = makeRepo([basePayment({ lastGatewayCheckAt: new Date() })])
    const s2 = await new PaymentsService(slow).getPaymentStatus('user-1', { paymentId: 'pay-1' })
    expect(s2.data.status).toBe('CONFIRMING')
    expect(s2.data.message).toMatch(/do not need to pay again|automatically/i)
  })

  it('a bad client signature is rejected without failing the payment', async () => {
    const repo = makeRepo([basePayment()])
    const svc = new PaymentsService(repo)
    const res = await svc.verifyPayment('user-1', { razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'pay_x', razorpaySignature: 'forged' })
    expect(res.success).toBe(false)
    expect(repo.byId.get('pay-1').status).toBe('PENDING')
  })

  it('another user cannot verify someone else\'s payment', async () => {
    const svc = new PaymentsService(makeRepo([basePayment()]))
    const res = await svc.verifyPayment('attacker', { razorpayOrderId: 'order_rzp_1', razorpayPaymentId: 'p', razorpaySignature: 's' })
    expect(res).toMatchObject({ success: false, message: 'Unauthorized' })
  })
})

describe('a paid draft is either turned into an order or refunded — never abandoned', () => {
  it('permanent placement failure (slot gone) refunds the customer through the gateway', async () => {
    placeOrderFromDraft.mockRejectedValue(Object.assign(new Error('full'), { code: 'SLOT_FULL' }))
    const repo = makeRepo([basePayment({ status: 'PAID', razorpayPaymentId: 'pay_x' })])
    const settlement = new PaymentSettlement({ repo })
    const outcome = await settlement.applyPaidSideEffects(await repo.findById('pay-1'), { source: 'test' })
    expect(outcome).toBe('REFUNDED')
    expect(gateway.client.payments.refund).toHaveBeenCalledWith('pay_x', expect.objectContaining({ amount: 5000 }))
    expect(repo.byId.get('pay-1').status).toBe('REFUNDED')
  })

  it('transient placement failure schedules a back-off retry instead of refunding', async () => {
    placeOrderFromDraft.mockRejectedValue(new Error('connection reset'))
    const repo = makeRepo([basePayment({ status: 'PAID', razorpayPaymentId: 'pay_x' })])
    const settlement = new PaymentSettlement({ repo })
    const outcome = await settlement.applyPaidSideEffects(await repo.findById('pay-1'), { source: 'test' })
    expect(outcome).toBe('RETRY_LATER')
    expect(gateway.client.payments.refund).not.toHaveBeenCalled()
    expect(dbQuery.mock.calls.some(([sql]) => /recovery_attempts = \$2/.test(sql))).toBe(true)
  })

  it('paying twice for the same booking refunds the second charge', async () => {
    const repo = makeRepo([
      basePayment({ id: 'pay-1', status: 'PAID', razorpayPaymentId: 'pay_first' }),
      basePayment({ id: 'pay-2', razorpayOrderId: 'order_rzp_2' }),
    ])
    const settlement = new PaymentSettlement({ repo })
    const res = await settlement.settle(await repo.findById('pay-2'), { razorpayPaymentId: 'pay_second', source: 'test' })
    expect(res.outcome).toBe('DUPLICATE_REFUNDED')
    expect(gateway.client.payments.refund).toHaveBeenCalledWith('pay_second', expect.anything())
    expect(placeOrderFromDraft).not.toHaveBeenCalled()
  })

  it('a refund is idempotent — asking twice never refunds twice', async () => {
    const repo = makeRepo([basePayment({ status: 'PAID', razorpayPaymentId: 'pay_x' })])
    const settlement = new PaymentSettlement({ repo })
    await settlement.refundPayment(await repo.findById('pay-1'), { reason: 'x' })
    await settlement.refundPayment(await repo.findById('pay-1'), { reason: 'x' })
    expect(gateway.client.payments.refund).toHaveBeenCalledTimes(1)
  })

  it('checkGateway settles a payment the gateway says is captured even though no webhook ever came', async () => {
    gateway.client.orders.fetchPayments.mockResolvedValueOnce({ items: [{ id: 'pay_cap', status: 'captured', method: 'upi', amount: 5000 }] })
    const repo = makeRepo([basePayment({ status: 'EXPIRED' })])
    const settlement = new PaymentSettlement({ repo })
    const out = await settlement.checkGateway(await repo.findById('pay-1'), { source: 'poll' })
    expect(out.state).toBe('PAID')
    expect(repo.byId.get('pay-1').status).toBe('PAID')
    expect(placeOrderFromDraft).toHaveBeenCalled()
  })

  it('a payment still in flight at the gateway is given more time, not cancelled', async () => {
    gateway.client.orders.fetchPayments.mockResolvedValueOnce({ items: [{ id: 'pay_wait', status: 'created' }] })
    const repo = makeRepo([basePayment({ status: 'PENDING', createdAt: new Date(Date.now() - 20 * 60 * 1000) })])
    const settlement = new PaymentSettlement({ repo })
    const out = await settlement.expireOrExtend(await repo.findById('pay-1'))
    expect(out).toBe('EXTENDED')
    expect(dbQuery.mock.calls.some(([sql]) => /SET expires_at = NOW\(\) \+ INTERVAL '10 minutes'/.test(sql))).toBe(true)
  })

  it('a gateway outage never expires a payment (it retries next tick)', async () => {
    gateway.client.orders.fetchPayments.mockRejectedValueOnce(new Error('gateway 502'))
    const repo = makeRepo([basePayment({ status: 'PENDING' })])
    const settlement = new PaymentSettlement({ repo })
    expect(await settlement.expireOrExtend(await repo.findById('pay-1'))).toBe('SKIPPED')
  })
})
