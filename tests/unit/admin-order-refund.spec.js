import { describe, it, expect, vi, beforeEach } from 'vitest'

const refund = vi.fn()
const calls = []
let paymentRow

vi.mock('../../src/config/razorpay.js', () => ({
  getRazorpay: vi.fn(async () => ({ client: { payments: { refund } } })),
}))
vi.mock('../../src/config/bullmq.js', () => ({ notificationQueue: { add: vi.fn() }, orderQueue: { add: vi.fn() } }))
vi.mock('../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../src/modules/invoices/invoices.service.js', () => ({ InvoicesService: class {} }))
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(async () => ({
    query: vi.fn(async (sql, params) => {
      calls.push([sql.trim().split(/\s+/)[0], params])
      if (/FROM payments p JOIN orders/.test(sql)) return { rows: paymentRow ? [paymentRow] : [] }
      return { rows: [] }
    }),
    release: vi.fn(),
  })),
}))

const { AdminOrdersService, computeOrderFinancials } = await import('../../src/modules/admin/orders/orders.service.js')

const basePayment = () => ({
  id: 'pay-1', order_id: 'o-1', status: 'PAID', method: 'upi', amount: '50.00', refund_amount: null,
  razorpay_payment_id: 'pay_RZP1', metadata: {}, order_number: 'LNDR-1', order_user_id: 'u-1',
})

describe('AdminOrdersService.refundPayment (Razorpay)', () => {
  const svc = new AdminOrdersService({}, {})
  beforeEach(() => { refund.mockReset(); calls.length = 0; paymentRow = basePayment() })

  it('sends a partial refund to Razorpay in paise and keeps the payment PAID', async () => {
    refund.mockResolvedValue({ id: 'rfnd_1' })
    const r = await svc.refundPayment('o-1', 'pay-1', { amount: 12.5, reason: 'late' }, 'admin-1', '1.1.1.1')
    expect(refund).toHaveBeenCalledWith('pay_RZP1', expect.objectContaining({ amount: 1250 }))
    expect(r).toMatchObject({ refundId: 'rfnd_1', refundAmount: 12.5, totalRefunded: 12.5, fullyRefunded: false })
    expect(calls.map((c) => c[0])).toEqual(expect.arrayContaining(['BEGIN', 'UPDATE', 'COMMIT']))
  })

  it('marks the payment fully refunded when the whole amount goes back', async () => {
    refund.mockResolvedValue({ id: 'rfnd_2' })
    const r = await svc.refundPayment('o-1', 'pay-1', {}, 'admin-1')
    expect(refund).toHaveBeenCalledWith('pay_RZP1', expect.objectContaining({ amount: 5000 }))
    expect(r.fullyRefunded).toBe(true)
  })

  it('refuses more than what is left', async () => {
    paymentRow = { ...basePayment(), refund_amount: '40.00' }
    await expect(svc.refundPayment('o-1', 'pay-1', { amount: 11 }, 'a')).rejects.toMatchObject({ statusCode: 400 })
    expect(refund).not.toHaveBeenCalled()
  })

  it('writes nothing and rolls back when Razorpay rejects', async () => {
    refund.mockRejectedValue({ error: { description: 'insufficient balance' } })
    await expect(svc.refundPayment('o-1', 'pay-1', {}, 'a')).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('insufficient balance') })
    const kinds = calls.map((c) => c[0])
    expect(kinds).toContain('ROLLBACK')
    expect(kinds).not.toContain('UPDATE')
  })
})

describe('computeOrderFinancials', () => {
  it('counts only money actually received, minus refunds', () => {
    const f = computeOrderFinancials(
      { total_amount: '139', payable_amount_paise: 0, booking_type: 'ASSISTED', status: 'PENDING' },
      [
        { status: 'PAID', amount: '50', refund_amount: '0' },
        { status: 'PENDING', amount: '89' },
      ],
    )
    expect(f).toMatchObject({ total: 139, paid: 50, balance_due: 89, payment_state: 'PARTIALLY_PAID', is_estimate: true })
  })
  it('owes nothing on a cancelled order', () => {
    const f = computeOrderFinancials({ total_amount: '100', status: 'CANCELLED' }, [{ status: 'PAID', amount: '30', refund_amount: '30' }])
    expect(f).toMatchObject({ balance_due: 0, payment_state: 'REFUNDED', net_paid: 0 })
  })
})
