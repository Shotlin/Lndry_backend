import { query } from '../../config/database.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { PaymentSettlement } from '../payments/payments.settlement.js'

/**
 * One place that gives the customer their money back when an order does not go ahead
 * (customer cancelled, laundry rejected, laundry did not answer in time).
 *
 * It uses PaymentSettlement.refundPayment, which is idempotent, credits the wallet for wallet
 * payments (inside a locked transaction) and refunds through the gateway for online payments.
 * Before this helper existed:
 *   - a laundry rejection queued an 'auto-refund' job that nothing consumed, so the advance was never returned;
 *   - the auto-reject worker wrote "REFUNDED" with a mock id for wallet payments without crediting the wallet.
 *
 * IMPORTANT: call this AFTER the order transaction has committed. refundPayment updates the order row
 * on its own connection, so calling it while the caller still holds that row locked would deadlock.
 */
let settlement
const getSettlement = () => (settlement ||= new PaymentSettlement())

/** The order id and its checkout draft id are the same value; payments may reference either column. */
export async function refundOrderPayments(orderId, { reason, customerTitle, customerBody } = {}) {
  const { rows } = await query(
    `SELECT id FROM payments WHERE status = 'PAID' AND (order_id = $1 OR order_draft_id = $1) ORDER BY created_at`,
    [orderId]
  )
  let refunded = 0
  let failed = 0
  for (const row of rows) {
    const r = await getSettlement().refundPayment({ id: row.id }, { reason, customerTitle, customerBody })
    if (r?.success) refunded++
    else failed++
  }
  return { attempted: rows.length, refunded, failed }
}

/**
 * Refund now; if any payment could not be refunded (gateway down, etc.) hand it to the retrying
 * 'auto-refund' job so the customer is never left out of pocket silently.
 */
export async function refundOrderOrRetry(orderId, opts = {}) {
  try {
    const res = await refundOrderPayments(orderId, opts)
    if (res.failed > 0) throw new Error(`${res.failed} payment(s) not refunded`)
    return res
  } catch (err) {
    logger.error({ err: err.message, orderId }, 'Refund failed — queued for retry')
    await queueRefundRetry(orderId, opts.reason)
    return { attempted: 0, refunded: 0, failed: 1, queued: true }
  }
}

export async function queueRefundRetry(orderId, reason) {
  await orderQueue.add('auto-refund', { type: 'auto-refund', orderId, reason: reason || 'Order not fulfilled' }, {
    jobId: `auto-refund-${orderId}`,
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
  })
}
