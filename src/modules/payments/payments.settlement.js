import { logger } from '../../config/logger.js'
import { query, getClient } from '../../config/database.js'
import { getRazorpay } from '../../config/razorpay.js'
import { orderQueue } from '../../config/bullmq.js'
import { emitLifecycleEvent } from '../lifecycle-notifications/lifecycle-jobs.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { PaymentsRepository } from './payments.repository.js'
import { failureFromGatewayPayment } from './payment-failure.js'

/**
 * One place that decides what a CONFIRMED payment means, whichever way the
 * confirmation reached us:
 *
 *   • the app's signature verify call,
 *   • Razorpay's webhook (even an hour late, even if the app was closed),
 *   • the reconciliation worker polling the gateway.
 *
 * Everything here is idempotent, so any of those can run, repeat or race one
 * another safely. The invariant it enforces: money is never left sitting with
 * no order — a PAID payment is either turned into an order, or refunded.
 */

// placeOrderFromDraft failures that will never succeed on retry.
const PERMANENT_PLACEMENT_CODES = new Set(['DRAFT_NOT_FOUND', 'SLOT_FULL', 'SLOT_EXPIRED', 'VENDOR_UNAVAILABLE', 'OUT_OF_RADIUS'])

// Back-off before each further placement attempt (seconds). Eight tries over ~4 hours,
// then the customer is refunded rather than left waiting.
const RECOVERY_BACKOFF_SECONDS = [60, 120, 300, 600, 1800, 3600, 7200, 7200]
const MAX_RECOVERY_ATTEMPTS = RECOVERY_BACKOFF_SECONDS.length

// How long a gateway order may stay "payment in progress" before we stop extending it.
const MAX_IN_FLIGHT_MS = 2 * 60 * 60 * 1000

const paise = (rupees) => Math.round(Number(rupees) * 100)

export class PaymentSettlement {
  constructor({ repo = new PaymentsRepository(), ordersRepo = new OrdersRepository(), walletRepo = new WalletRepository() } = {}) {
    this.repo = repo
    this.ordersRepo = ordersRepo
    this.walletRepo = walletRepo
  }

  // ───────────────────────────────────────────────────────────────────────
  // Settle a confirmed payment
  // ───────────────────────────────────────────────────────────────────────

  /**
   * @param {object} payment  payments row (camelCase, from the repository)
   * @param {{ razorpayPaymentId?: string, signature?: string, method?: string, source: string }} info
   * @returns {Promise<{ payment: object, transitioned: boolean, outcome: string }>}
   */
  async settle(payment, info) {
    const marked = await this.repo.markPaid(payment.id, {
      razorpayPaymentId: info.razorpayPaymentId || null,
      signature: info.signature || null,
      method: info.method || null,
    })

    if (marked.duplicate) {
      // The customer paid twice for the same checkout (or the same gateway
      // payment was reported twice). The first one stands; give this one back.
      logger.warn({ paymentId: payment.id, constraint: marked.constraint, source: info.source }, 'Duplicate payment detected — refunding the extra charge')
      if (marked.constraint === 'uq_payments_razorpay_payment_id') {
        return { payment, transitioned: false, outcome: 'ALREADY_RECORDED' }
      }
      await this.refundUnrecordedGatewayPayment(payment, info.razorpayPaymentId, 'Duplicate payment for the same booking')
      return { payment, transitioned: false, outcome: 'DUPLICATE_REFUNDED' }
    }

    const current = marked.payment || payment
    if (!marked.transitioned) {
      // Someone else already settled it. Side effects are idempotent, and for a
      // payment still waiting on its order they are exactly what is missing.
      if (current.status === 'PAID' && this._needsSideEffects(current)) {
        await this.applyPaidSideEffects(current, { source: info.source })
      }
      return { payment: current, transitioned: false, outcome: 'ALREADY_PAID' }
    }

    logger.info({ paymentId: current.id, purpose: current.purpose, source: info.source }, 'Payment marked PAID')
    const outcome = await this.applyPaidSideEffects(current, { source: info.source })
    return { payment: current, transitioned: true, outcome }
  }

  _needsSideEffects(payment) {
    return payment.purpose === 'ADVANCE' ? !payment.orderId && !!payment.orderDraftId : false
  }

  /**
   * Turn a PAID payment into its business consequence. Safe to call repeatedly.
   * @returns {Promise<'ORDER_PLACED'|'BALANCE_APPLIED'|'ORDER_CONFIRMED'|'REFUNDED'|'RETRY_LATER'|'NOOP'>}
   */
  async applyPaidSideEffects(payment, { source = 'unknown' } = {}) {
    try {
      if (payment.purpose === 'ADVANCE' && payment.orderDraftId) {
        return await this.placeOrderForPaidDraft(payment, { source })
      }
      if (payment.purpose === 'BALANCE' && payment.orderId) {
        await this.ordersRepo.updateStatus(payment.orderId, undefined, { paymentStatus: 'PAID' })
        const key = `payment:${payment.id}`
        const extra = { amountPaise: paise(payment.amount) }
        await emitLifecycleEvent('BALANCE_PAID', { orderId: payment.orderId, dedupe: key, extra })
        await emitLifecycleEvent('VENDOR_PAYMENT_UPDATE', { orderId: payment.orderId, dedupe: key, extra })
        await emitLifecycleEvent('CAPTAIN_PAYMENT_COMPLETED', { orderId: payment.orderId, dedupe: key, extra })
        return 'BALANCE_APPLIED'
      }
      if (payment.purpose === 'FULL' && payment.orderId) {
        return await this.confirmFullPaymentOrder(payment)
      }
      return 'NOOP'
    } catch (err) {
      logger.error({ err: err.message, paymentId: payment.id, source }, 'Applying a paid payment failed — reconciliation will retry')
      return 'RETRY_LATER'
    }
  }

  /** ADVANCE → place the real order from the draft the customer paid for. */
  async placeOrderForPaidDraft(payment, { source }) {
    const { OrdersService } = await import('../orders/orders.service.js')
    const ordersService = new OrdersService(new OrdersRepository())
    try {
      const res = await ordersService.placeOrderFromDraft(payment.userId, {
        orderDraftId: payment.orderDraftId,
        paymentMethod: payment.metadata?.paymentMethod || undefined,
      })
      if (res?.success) {
        logger.info({ paymentId: payment.id, orderId: res.order?.id, source }, 'Order placed for paid draft')
        return 'ORDER_PLACED'
      }
      throw Object.assign(new Error(res?.message || 'Order placement returned failure'), { code: res?.code })
    } catch (err) {
      if (PERMANENT_PLACEMENT_CODES.has(err.code)) {
        logger.warn({ paymentId: payment.id, code: err.code }, 'Paid draft can never become an order — refunding')
        await this.refundPayment(payment, {
          reason: `Order could not be placed (${err.code})`,
          customerTitle: 'Payment refunded',
          customerBody: 'We could not confirm your booking, so your payment is being refunded to the original payment method.',
        })
        return 'REFUNDED'
      }
      await this.scheduleRecoveryRetry(payment, err)
      return 'RETRY_LATER'
    }
  }

  /** Legacy order-first payment (FULL). */
  async confirmFullPaymentOrder(payment) {
    const order = await this.ordersRepo.findById(payment.orderId)
    if (!order) {
      await this.refundPayment(payment, { reason: 'Order not found for paid payment' })
      return 'REFUNDED'
    }
    if (order.status === 'PENDING' || order.status === 'PAYMENT_FAILED') {
      await this.ordersRepo.updateStatus(payment.orderId, 'WAITING_VENDOR_CONFIRMATION', { paymentStatus: 'PAID' })
      try {
        await orderQueue.add(
          'auto-reject',
          { type: 'auto-reject', orderId: payment.orderId },
          { jobId: `auto-reject-${payment.orderId}`, delay: 15 * 60 * 1000, removeOnComplete: true }
        )
      } catch (err) {
        logger.warn({ err: err.message, orderId: payment.orderId }, 'Failed to queue auto-reject on settled payment')
      }
      await emitLifecycleEvent('ORDER_PLACED', { orderId: payment.orderId })
      await emitLifecycleEvent('VENDOR_NEW_ORDER', { orderId: payment.orderId })
      return 'ORDER_CONFIRMED'
    }
    if (order.paymentStatus === 'PAID' || order.status === 'WAITING_VENDOR_CONFIRMATION') return 'NOOP'

    // Order already cancelled / expired / rejected: the money has no order to pay for.
    await this.refundPayment(payment, {
      reason: `Payment arrived for an order in status ${order.status}`,
      customerTitle: 'Payment refunded',
      customerBody: `Your payment arrived after order ${order.orderNumber || ''} had already been closed, so it is being refunded.`,
    })
    return 'REFUNDED'
  }

  async scheduleRecoveryRetry(payment, err) {
    const attempts = (payment.recoveryAttempts || 0) + 1
    const nextIdx = Math.min(attempts - 1, RECOVERY_BACKOFF_SECONDS.length - 1)
    await query(
      `UPDATE payments
          SET recovery_attempts = $2,
              recovery_last_error = $3,
              recovery_next_at = NOW() + ($4 || ' seconds')::interval,
              updated_at = NOW()
        WHERE id = $1`,
      [payment.id, attempts, String(err?.message || err).slice(0, 500), String(RECOVERY_BACKOFF_SECONDS[nextIdx])]
    )
    logger.warn({ paymentId: payment.id, attempts, err: err?.message }, 'Order placement for paid draft failed — will retry')
  }

  // ───────────────────────────────────────────────────────────────────────
  // Refunds
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Give a PAID payment back: to the wallet for wallet payments, to the
   * original method through Razorpay otherwise. Idempotent.
   */
  async refundPayment(payment, { reason, customerTitle, customerBody } = {}) {
    const fresh = await this.repo.findById(payment.id)
    if (!fresh || fresh.status === 'REFUNDED' || fresh.refundId) return { success: true, alreadyRefunded: true }
    if (fresh.status !== 'PAID') return { success: false, message: 'Payment is not paid' }

    const amountRupees = Number(fresh.amount)
    try {
      if (fresh.method === 'LNDRY_WALLET' || !fresh.razorpayPaymentId) {
        await this._refundToWallet(fresh, amountRupees, reason)
      } else {
        const rzp = await getRazorpay()
        if (!rzp) throw new Error('Payment gateway not configured')
        const rzpRefund = await rzp.client.payments.refund(fresh.razorpayPaymentId, {
          amount: paise(amountRupees),
          speed: 'optimum',
          notes: { reason: String(reason || 'Auto refund').slice(0, 250), paymentId: fresh.id },
          receipt: `rf_${fresh.id}`.slice(0, 40),
        })
        await this.repo.updateRefund(fresh.id, { refundId: rzpRefund.id, refundAmount: amountRupees, refundStatus: 'PROCESSED' })
      }
    } catch (err) {
      logger.error({ err: err?.message || err, paymentId: fresh.id }, 'AUTOMATIC REFUND FAILED — needs manual attention')
      await query(
        `UPDATE payments SET recovery_last_error = $2, updated_at = NOW() WHERE id = $1`,
        [fresh.id, `refund failed: ${String(err?.error?.description || err?.message || err).slice(0, 400)}`]
      )
      return { success: false, message: err?.message || 'Refund failed' }
    }

    if (fresh.orderId) {
      await this.ordersRepo.updateStatus(fresh.orderId, undefined, { paymentStatus: 'REFUNDED' }).catch(() => {})
    }
    await this.notifyCustomer(fresh.userId, {
      title: customerTitle || 'Payment refunded',
      body: customerBody || `₹${amountRupees} has been refunded to your original payment method.`,
      data: { type: 'PAYMENT_REFUNDED', paymentId: fresh.id },
    })
    logger.info({ paymentId: fresh.id, amount: amountRupees, reason }, 'Payment refunded automatically')
    return { success: true }
  }

  async _refundToWallet(payment, amountRupees, reason) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Lock the payment row so two refund attempts cannot both credit.
      const { rows } = await client.query(`SELECT status, refund_id FROM payments WHERE id = $1 FOR UPDATE`, [payment.id])
      if (!rows[0] || rows[0].status !== 'PAID') {
        await client.query('ROLLBACK')
        return
      }
      let wallet = await this.walletRepo.getForUpdate(client, payment.userId)
      if (!wallet) {
        await client.query(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [payment.userId])
        wallet = await this.walletRepo.getForUpdate(client, payment.userId)
      }
      await this.walletRepo.credit(client, wallet.id, amountRupees, `Refund: ${reason || 'booking not confirmed'}`, payment.orderDraftId || payment.orderId || payment.id)
      await client.query(
        `UPDATE payments SET status = 'REFUNDED', refund_id = $2, refund_amount = $3, refund_status = 'PROCESSED', updated_at = NOW() WHERE id = $1`,
        [payment.id, `wallet_${payment.id}`, amountRupees]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** A gateway payment we never recorded as PAID (duplicate): refund it directly at the gateway. */
  async refundUnrecordedGatewayPayment(payment, razorpayPaymentId, reason) {
    if (!razorpayPaymentId) return
    try {
      const rzp = await getRazorpay()
      if (!rzp) return
      const rzpRefund = await rzp.client.payments.refund(razorpayPaymentId, {
        amount: paise(payment.amount),
        speed: 'optimum',
        notes: { reason, paymentId: payment.id },
        receipt: `rf_${payment.id}`.slice(0, 40),
      })
      await query(
        `UPDATE payments
            SET status = 'REFUNDED', razorpay_payment_id = COALESCE(razorpay_payment_id, $2),
                refund_id = $3, refund_amount = amount, refund_status = 'PROCESSED', updated_at = NOW()
          WHERE id = $1 AND status <> 'PAID'`,
        [payment.id, razorpayPaymentId, rzpRefund.id]
      )
      await this.notifyCustomer(payment.userId, {
        title: 'Duplicate payment refunded',
        body: `You were charged twice for the same booking. ₹${payment.amount} is being refunded.`,
        data: { type: 'PAYMENT_REFUNDED', paymentId: payment.id },
      })
    } catch (err) {
      logger.error({ err: err?.message || err, paymentId: payment.id }, 'DUPLICATE REFUND FAILED — needs manual attention')
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Failures
  // ───────────────────────────────────────────────────────────────────────

  /** Record why an attempt failed (shown to the customer). */
  async recordGatewayFailure(payment, gatewayPaymentEntity, { terminal = false } = {}) {
    const f = failureFromGatewayPayment(gatewayPaymentEntity)
    await this.repo.recordFailure(payment.id, { code: f.code, message: f.message, source: f.source || 'razorpay' }, { terminal })
    return f
  }

  // ───────────────────────────────────────────────────────────────────────
  // Ask the gateway what really happened
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Reads the gateway's view of a payment's Razorpay order and acts on it.
   * @returns {Promise<{ state: 'PAID'|'IN_FLIGHT'|'FAILED'|'NONE'|'UNKNOWN', payment: object }>}
   */
  async checkGateway(payment, { source = 'poll' } = {}) {
    if (!payment.razorpayOrderId || payment.razorpayOrderId.startsWith('order_mock_')) {
      return { state: 'UNKNOWN', payment }
    }
    const rzp = await getRazorpay()
    if (!rzp) return { state: 'UNKNOWN', payment }

    let items
    try {
      const res = await rzp.client.orders.fetchPayments(payment.razorpayOrderId)
      items = Array.isArray(res?.items) ? res.items : []
    } catch (err) {
      logger.warn({ err: err?.error?.description || err?.message, paymentId: payment.id }, 'Could not read payment status from the gateway')
      return { state: 'UNKNOWN', payment }
    }

    await query(`UPDATE payments SET last_gateway_check_at = NOW() WHERE id = $1`, [payment.id])

    let captured = items.find((p) => p.status === 'captured')
    if (!captured) {
      // Accounts set to manual capture leave a successful payment "authorized";
      // un-captured ones are auto-refunded by the gateway after a few days.
      const authorized = items.find((p) => p.status === 'authorized')
      if (authorized) {
        try {
          captured = await rzp.client.payments.capture(authorized.id, authorized.amount, authorized.currency || 'INR')
        } catch (err) {
          logger.warn({ err: err?.error?.description || err?.message, gatewayPaymentId: authorized.id }, 'Capturing an authorized payment failed')
        }
      }
    }

    if (captured) {
      const res = await this.settle(payment, { razorpayPaymentId: captured.id, method: captured.method, source })
      return { state: 'PAID', payment: res.payment }
    }

    const inFlight = items.find((p) => p.status === 'created' || p.status === 'authorized')
    if (inFlight) return { state: 'IN_FLIGHT', payment }

    const failures = items.filter((p) => p.status === 'failed')
    if (failures.length > 0) {
      const latest = failures.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
      await this.recordGatewayFailure(payment, latest, { terminal: false })
      return { state: 'FAILED', payment }
    }
    return { state: 'NONE', payment }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Expiry
  // ───────────────────────────────────────────────────────────────────────

  /**
   * A PENDING payment is past its window. Before giving up, ask the gateway:
   * a payment that is genuinely still being processed (slow UPI / netbanking)
   * gets more time, and one that completed gets settled instead of cancelled.
   * @returns {Promise<'SETTLED'|'EXTENDED'|'EXPIRED'|'SKIPPED'>}
   */
  async expireOrExtend(payment) {
    const check = await this.checkGateway(payment, { source: 'expiry-check' })
    if (check.state === 'PAID') return 'SETTLED'

    const age = Date.now() - new Date(payment.createdAt).getTime()
    if (check.state === 'IN_FLIGHT' && age < MAX_IN_FLIGHT_MS) {
      await query(`UPDATE payments SET expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW() WHERE id = $1 AND status = 'PENDING'`, [payment.id])
      return 'EXTENDED'
    }
    // 'UNKNOWN' (gateway unreachable) must not cancel anything — try again next tick.
    if (check.state === 'UNKNOWN' && payment.razorpayOrderId && !payment.razorpayOrderId.startsWith('order_mock_')) return 'SKIPPED'

    const { rows } = await query(
      `UPDATE payments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [payment.id]
    )
    return rows.length ? 'EXPIRED' : 'SKIPPED'
  }

  // ───────────────────────────────────────────────────────────────────────
  // Notifications
  // ───────────────────────────────────────────────────────────────────────

  async notifyCustomer(userId, { title, body, data = {} }) {
    try {
      const [{ NotificationsRepository }, { NotificationDispatcher }] = await Promise.all([
        import('../notifications/notifications.repository.js'),
        import('../notifications/notification-dispatcher.js'),
      ])
      await new NotificationsRepository().createNotification(userId, { title, body, type: 'PAYMENT', data })
      await new NotificationDispatcher().sendToUsers([userId], { title, body, legacyType: 'PAYMENT', data })
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Payment notification failed (non-critical)')
    }
  }
}

export { PERMANENT_PLACEMENT_CODES, RECOVERY_BACKOFF_SECONDS, MAX_RECOVERY_ATTEMPTS }
