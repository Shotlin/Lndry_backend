/**
 * Payment reconciliation worker.
 *
 * Guarantees the invariant the checkout depends on: a customer's money is
 * never left with no order behind it. Every minute (one instance at a time)
 * it does five things:
 *
 *   1. PAID advance with no order  → place the order from the draft the
 *      customer paid for (backs off, then refunds if it can never work).
 *   2. PAID balance / full payment whose order was not updated → finish it.
 *   3. PENDING / EXPIRED online payments → ask Razorpay what really happened.
 *      This is what rescues a payment whose bank took 20-60 minutes to
 *      confirm, or whose webhook never arrived. A payment still being
 *      processed gets more time instead of being cancelled; one that
 *      completed is settled; one that failed records the reason.
 *   4. Pending wallet top-ups → credit the ones the gateway says were paid.
 *   5. Housekeeping of old webhook-event records.
 *
 * All steps are idempotent, so overlapping with the webhook / the app's own
 * verify call (or a second server instance) can never double-apply anything.
 */
import { randomUUID } from 'node:crypto'
import { redis } from '../config/redis.js'
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { PaymentsRepository } from '../modules/payments/payments.repository.js'
import { PaymentSettlement, MAX_RECOVERY_ATTEMPTS } from '../modules/payments/payments.settlement.js'

const TICK_MS = 60 * 1000
const LOCK_KEY = 'lndry:payments:reconcile:lock'
const LOCK_TTL_MS = 150 * 1000
const SETTLE_GRACE = "INTERVAL '45 seconds'"

let _handle = null
let _lastCleanup = 0

export function startPaymentReconcileWorker() {
  if (_handle) return
  logger.info('Payment reconciliation worker started (every 60s)')
  _handle = setInterval(() => { tick().catch((err) => logger.error({ err: err.message }, 'Payment reconcile tick crashed')) }, TICK_MS)
  _handle.unref?.()
  setTimeout(() => { tick().catch(() => {}) }, 15_000).unref?.()
}

export function stopPaymentReconcileWorker() {
  if (_handle) clearInterval(_handle)
  _handle = null
}

async function tick() {
  const token = randomUUID()
  // Only one API instance (PM2 runs several) does the work at a time.
  const got = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX')
  if (!got) return
  try {
    await runOnce()
  } finally {
    try {
      if ((await redis.get(LOCK_KEY)) === token) await redis.del(LOCK_KEY)
    } catch { /* lock simply expires */ }
  }
}

export async function runOnce({ repo = new PaymentsRepository(), settlement = new PaymentSettlement({ repo }) } = {}) {
  const stats = { advancesRecovered: 0, orderPaymentsFixed: 0, gatewayChecked: 0, expired: 0, extended: 0, settledFromGateway: 0, topUpsCredited: 0 }

  await safely('recoverUnplacedAdvances', async () => {
    const { rows } = await query(
      `SELECT id FROM payments
        WHERE status = 'PAID' AND purpose = 'ADVANCE' AND order_id IS NULL AND order_draft_id IS NOT NULL
          AND COALESCE(paid_at, updated_at) < NOW() - ${SETTLE_GRACE}
          AND (recovery_next_at IS NULL OR recovery_next_at <= NOW())
        ORDER BY COALESCE(paid_at, updated_at) ASC
        LIMIT 25`
    )
    for (const { id } of rows) {
      const payment = await repo.findById(id)
      if (!payment || payment.status !== 'PAID' || payment.orderId) continue
      if (payment.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        logger.error({ paymentId: id }, 'Paid draft could not be turned into an order after repeated attempts — refunding')
        await settlement.refundPayment(payment, {
          reason: 'Order could not be placed after repeated attempts',
          customerTitle: 'Payment refunded',
          customerBody: 'We could not confirm your booking, so your payment is being refunded to the original payment method.',
        })
        continue
      }
      const outcome = await settlement.applyPaidSideEffects(payment, { source: 'reconcile' })
      if (outcome === 'ORDER_PLACED') stats.advancesRecovered++
    }
  })

  await safely('recoverUnsettledOrderPayments', async () => {
    const { rows } = await query(
      `SELECT p.id FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'PAID' AND p.purpose IN ('BALANCE', 'FULL')
          AND COALESCE(p.paid_at, p.updated_at) < NOW() - ${SETTLE_GRACE}
          AND COALESCE(o.payment_status, '') NOT IN ('PAID', 'REFUNDED')
          AND p.recovery_attempts < ${MAX_RECOVERY_ATTEMPTS}
          AND (p.recovery_next_at IS NULL OR p.recovery_next_at <= NOW())
        LIMIT 25`
    )
    for (const { id } of rows) {
      const payment = await repo.findById(id)
      if (!payment) continue
      const outcome = await settlement.applyPaidSideEffects(payment, { source: 'reconcile' })
      if (outcome === 'RETRY_LATER') await settlement.scheduleRecoveryRetry(payment, new Error('order update failed'))
      else stats.orderPaymentsFixed++
    }
  })

  await safely('pollGatewayForPending', async () => {
    const { rows } = await query(
      `SELECT id FROM payments
        WHERE status IN ('PENDING', 'EXPIRED')
          AND razorpay_order_id IS NOT NULL AND razorpay_order_id NOT LIKE 'order\\_mock\\_%'
          AND created_at > NOW() - INTERVAL '24 hours'
          AND created_at < NOW() - INTERVAL '75 seconds'
          AND (last_gateway_check_at IS NULL
               OR last_gateway_check_at < NOW() - (CASE WHEN created_at > NOW() - INTERVAL '30 minutes'
                                                        THEN INTERVAL '1 minute' ELSE INTERVAL '10 minutes' END))
        ORDER BY last_gateway_check_at ASC NULLS FIRST
        LIMIT 40`
    )
    for (const { id } of rows) {
      const payment = await repo.findById(id)
      if (!payment || !['PENDING', 'EXPIRED'].includes(payment.status)) continue
      stats.gatewayChecked++

      const windowOver = payment.status === 'PENDING' && payment.expiresAt && new Date(payment.expiresAt) <= new Date()
      // Order-first payments are expired by payment-expiry.worker (it also cancels the order).
      if (windowOver && !payment.orderId) {
        const outcome = await settlement.expireOrExtend(payment)
        if (outcome === 'SETTLED') stats.settledFromGateway++
        else if (outcome === 'EXPIRED') stats.expired++
        else if (outcome === 'EXTENDED') stats.extended++
      } else {
        const check = await settlement.checkGateway(payment, { source: 'reconcile' })
        if (check.state === 'PAID') stats.settledFromGateway++
      }
    }
  })

  await safely('reconcilePendingTopUps', async () => {
    const { WalletService } = await import('../modules/wallet/wallet.service.js')
    const { WalletRepository } = await import('../modules/wallet/wallet.repository.js')
    stats.topUpsCredited = await new WalletService(new WalletRepository()).reconcilePendingTopUps()
  })

  await safely('cleanup', async () => {
    if (Date.now() - _lastCleanup < 60 * 60 * 1000) return
    _lastCleanup = Date.now()
    await query(`DELETE FROM payment_webhook_events WHERE received_at < NOW() - INTERVAL '30 days'`)
    // Tables that otherwise only ever grow: spent / abandoned OTP challenges, and holds that lapsed.
    await query(`DELETE FROM otp_challenges WHERE created_at < NOW() - INTERVAL '1 day'`)
    await query(`UPDATE slot_holds SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at < NOW() - INTERVAL '1 hour'`)
  })

  const acted = stats.advancesRecovered + stats.orderPaymentsFixed + stats.expired + stats.extended + stats.settledFromGateway + stats.topUpsCredited
  if (acted > 0) logger.info(stats, 'Payment reconciliation acted')
  return stats
}

async function safely(step, fn) {
  try {
    await fn()
  } catch (err) {
    logger.error({ err: err?.message || err, step }, 'Payment reconcile step failed')
  }
}
