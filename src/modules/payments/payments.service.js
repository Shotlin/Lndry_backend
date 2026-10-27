import crypto from 'node:crypto'
import { PaymentSettlement } from './payments.settlement.js'
import { friendlyPaymentFailure } from './payment-failure.js'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { getRazorpay } from '../../config/razorpay.js'
import { orderQueue } from '../../config/bullmq.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { WalletRedemptionRepository } from '../wallet-redemption/wallet-redemption.repository.js'
import { query, getClient } from '../../config/database.js'
import { getAdvanceAmountPaise } from '../../utils/advance-amount.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Payments service — Razorpay integration + payment management
 */
import { emitLifecycleEvent } from '../lifecycle-notifications/lifecycle-jobs.js'

export class PaymentsService {
  /**
   * A payment on the balance leg cleared: tell the customer, the laundry and the
   * delivery captain (who can now complete the delivery). Idempotent per payment.
   */
  async _announceBalancePaid(orderId, amountPaise, key) {
    const extra = { amountPaise }
    await emitLifecycleEvent('BALANCE_PAID', { orderId, dedupe: key, extra })
    await emitLifecycleEvent('VENDOR_PAYMENT_UPDATE', { orderId, dedupe: key, extra })
    await emitLifecycleEvent('CAPTAIN_PAYMENT_COMPLETED', { orderId, dedupe: key, extra })
  }

  constructor(repository) {
    this.repo = repository
    this.ordersRepo = new OrdersRepository()
    this.walletRepo = new WalletRepository()
    this.settlement = new PaymentSettlement({ repo: repository, ordersRepo: this.ordersRepo, walletRepo: this.walletRepo })
  }

  /** Constant-time string equality for signatures. */
  _safeEqual(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8')
    const y = Buffer.from(String(b || ''), 'utf8')
    return x.length === y.length && crypto.timingSafeEqual(x, y)
  }

  /**
   * Configurable advance amount (default ₹50 / 5000 paise), read from
   * app_settings so it's admin-adjustable without a code change — same
   * lookup pattern already used elsewhere for store-level settings.
   */
  async _getAdvanceAmountPaise() {
    return getAdvanceAmountPaise()
  }

  /**
   * Create a Razorpay order for an existing app order — or, now, for a
   * fixed advance against a not-yet-placed draft, or the remaining balance
   * against an already-placed order. `purpose` is inferred when omitted:
   * draft-based requests are always ADVANCE; order-based requests are FULL
   * (legacy cart checkout, unchanged) unless an advance has already been
   * paid for that order, in which case they're BALANCE.
   */
  async createPaymentOrder(userId, body) {
    const { orderId, order_draft_id, orderDraftId, purpose: requestedPurpose } = typeof body === 'string' ? { orderId: body } : (body || {})
    const orderDraftIdVal = order_draft_id || orderDraftId

    let amountPaise = 0
    let amountRupees = 0
    let receipt = ''
    let purpose = requestedPurpose

    if (orderDraftIdVal) {
      const draftRes = await query('SELECT id, payable_amount_paise, booking_type FROM order_drafts WHERE id = $1 AND user_id = $2', [orderDraftIdVal, userId])
      const draft = draftRes.rows[0]
      if (!draft) {
        return { success: false, message: 'Order draft not found' }
      }
      purpose = purpose || 'ADVANCE'

      // Already paid (e.g. the confirmation arrived late, after the customer
      // had given up waiting): never charge a second advance.
      const alreadyPaid = await this.repo.findPaidByOrderDraftId(orderDraftIdVal)
      if (alreadyPaid) {
        return { success: false, message: 'Advance payment already completed', code: 'ALREADY_PAID' }
      }

      // Still-open gateway order for this draft: hand back the SAME one so a
      // customer who reopens checkout pays one order, not several parallel ones.
      const open = await query(
        `SELECT id, razorpay_order_id, amount FROM payments
          WHERE order_draft_id = $1 AND status = 'PENDING' AND purpose = $2
            AND razorpay_order_id IS NOT NULL AND razorpay_order_id NOT LIKE 'order_mock_%'
            AND expires_at > NOW() + INTERVAL '2 minutes'
          ORDER BY created_at DESC LIMIT 1`,
        [orderDraftIdVal, purpose]
      )
      const reusableRzp = open.rows[0] ? await getRazorpay() : null
      if (open.rows[0] && reusableRzp) {
        return {
          success: true,
          data: {
            paymentId: open.rows[0].id,
            razorpayOrderId: open.rows[0].razorpay_order_id,
            amount: Number(open.rows[0].amount),
            currency: 'INR',
            keyId: reusableRzp.keyId,
            purpose,
            reused: true,
          },
        }
      }
      const advancePaise = await this._getAdvanceAmountPaise()
      // Never charge more than the order's own estimate, so a tiny order
      // isn't forced to overpay the configured advance. An assisted booking
      // has no service price yet (the laundry sets it after inspecting the
      // garments), so its draft only carries pickup/platform fees — the
      // advance is always the full configured amount.
      amountPaise = draft.booking_type === 'ASSISTED'
        ? advancePaise
        : Math.min(advancePaise, draft.payable_amount_paise)
      amountRupees = amountPaise / 100
      receipt = draft.id
    } else if (orderId) {
      const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
      if (!order) {
        return { success: false, message: 'Order not found' }
      }
      if (order.paymentMethod !== 'ONLINE') {
        return { success: false, message: 'Order is not set for online payment' }
      }

      const alreadyPaidRupees = await this.repo.sumPaidByOrderId(orderId)
      if (!purpose) {
        purpose = alreadyPaidRupees > 0 ? 'BALANCE' : 'FULL'
      }

      if (purpose === 'FULL') {
        if (order.paymentStatus === 'PAID') {
          return { success: false, message: 'Order is already paid' }
        }
        amountPaise = Math.round(order.totalAmount * 100)
      } else {
        const balancePaise = Math.round(order.totalAmount * 100) - Math.round(alreadyPaidRupees * 100)
        amountPaise = Math.max(0, balancePaise)
        if (amountPaise === 0) {
          return { success: false, message: 'No balance due' }
        }
      }
      amountRupees = amountPaise / 100
      receipt = order.orderNumber
    } else {
      return { success: false, message: 'Either orderId or order_draft_id must be provided' }
    }

    // Check if a payment of THIS purpose is already paid — checking only
    // the latest row of any purpose would wrongly block a legitimate
    // BALANCE charge once an ADVANCE row is already PAID.
    if (orderId) {
      const existing = await this.repo.findByOrderIdAndPurpose(orderId, purpose)
      if (existing && existing.status === 'PAID') {
        return { success: false, message: `${purpose === 'FULL' ? 'Payment' : purpose.charAt(0) + purpose.slice(1).toLowerCase() + ' payment'} already completed` }
      }
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    const rzp = await getRazorpay()
    if (!rzp) {
      if (env.NODE_ENV === 'production' || (env.NODE_ENV !== 'test' && !env.ALLOW_MOCK_PAYMENT)) {
        throw { statusCode: 400, message: 'Razorpay integration is not configured', code: 'RAZORPAY_CONFIG_ERROR' }
      }
      // Mock fallback
      const mockRzpOrderId = `order_mock_${Math.random().toString(36).substring(2, 11)}`
      const payment = await this.repo.create({
        orderId: orderId || null,
        orderDraftId: orderDraftIdVal || null,
        userId,
        razorpayOrderId: mockRzpOrderId,
        amount: amountRupees,
        currency: 'INR',
        status: 'PENDING',
        expiresAt,
        metadata: { receipt },
        purpose,
      })

      if (orderId) {
        await this.ordersRepo.updateStatus(orderId, undefined, {
          paymentExpiresAt: expiresAt,
        })
      }

      return {
        success: true,
        data: {
          paymentId: payment.id,
          razorpayOrderId: mockRzpOrderId,
          amount: amountRupees,
          currency: 'INR',
          keyId: 'mock_key_id',
          purpose,
        },
      }
    }

    // Create Razorpay order
    const rzpOrder = await rzp.client.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: receipt.substring(0, 40),
      notes: {
        orderId: orderId || null,
        orderDraftId: orderDraftIdVal || null,
        userId,
        purpose,
      },
    })

    // Save payment record
    const payment = await this.repo.create({
      orderId: orderId || null,
      orderDraftId: orderDraftIdVal || null,
      userId,
      razorpayOrderId: rzpOrder.id,
      amount: amountRupees,
      currency: 'INR',
      status: 'PENDING',
      expiresAt,
      metadata: { receipt },
      purpose,
    })

    if (orderId) {
      await this.ordersRepo.updateStatus(orderId, undefined, {
        paymentExpiresAt: expiresAt,
      })
    }

    logger.info(
      { paymentId: payment.id, razorpayOrderId: rzpOrder.id, orderId },
      'Razorpay payment order created'
    )

    return {
      success: true,
      data: {
        paymentId: payment.id,
        razorpayOrderId: rzpOrder.id,
        amount: amountRupees,
        currency: 'INR',
        keyId: rzp.keyId,
        purpose,
      },
    }
  }

  /**
   * Pay a draft's advance, or an existing order's balance/full amount,
   * directly from the customer's wallet — a same-transaction alternative
   * to Razorpay's create+verify round trip. Debits the wallet and inserts
   * a payments row already PAID in one atomic step, then runs the exact
   * same post-paid side effects verifyPayment runs for that purpose, so
   * placeOrderFromDraft (which only ever checks payments.status='PAID',
   * never how it got there) behaves identically regardless of method.
   */
  async payWithWallet(userId, body) {
    const { orderId, order_draft_id, orderDraftId } = body || {}
    const orderDraftIdVal = order_draft_id || orderDraftId

    let amountPaise = 0
    let purpose
    let order = null

    if (orderDraftIdVal) {
      const draftRes = await query('SELECT id, payable_amount_paise, booking_type FROM order_drafts WHERE id = $1 AND user_id = $2', [orderDraftIdVal, userId])
      const draft = draftRes.rows[0]
      if (!draft) {
        return { success: false, message: 'Order draft not found' }
      }
      purpose = 'ADVANCE'
      const advancePaise = await this._getAdvanceAmountPaise()
      // Assisted booking: no service price yet → always the full advance.
      amountPaise = draft.booking_type === 'ASSISTED'
        ? advancePaise
        : Math.min(advancePaise, draft.payable_amount_paise)
    } else if (orderId) {
      order = await this.ordersRepo.findByIdAndUser(orderId, userId)
      if (!order) {
        return { success: false, message: 'Order not found' }
      }
    } else {
      return { success: false, message: 'Either orderId or order_draft_id must be provided' }
    }

    const client = await getClient()
    let payment
    let amountRupees

    try {
      await client.query('BEGIN')

      // Locking the wallet row serialises every wallet payment of this user.
      // All "has this already been paid?" checks happen AFTER this lock: done
      // before it (as they used to be), two quick taps both passed the check
      // and both debited the wallet.
      const wallet = await this.walletRepo.getForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      if (orderDraftIdVal) {
        const dup = await client.query(
          `SELECT 1 FROM payments WHERE order_draft_id = $1 AND status = 'PAID' AND purpose = 'ADVANCE' LIMIT 1`,
          [orderDraftIdVal]
        )
        if (dup.rows.length > 0) {
          await client.query('ROLLBACK')
          return { success: false, message: 'Advance payment already completed' }
        }
      } else {
        const paidRes = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE order_id = $1 AND status = 'PAID'`,
          [orderId]
        )
        const alreadyPaidRupees = parseFloat(paidRes.rows[0].paid)
        purpose = alreadyPaidRupees > 0 ? 'BALANCE' : 'FULL'
        if (purpose === 'FULL') {
          if (order.paymentStatus === 'PAID') {
            await client.query('ROLLBACK')
            return { success: false, message: 'Order is already paid' }
          }
          amountPaise = Math.round(order.totalAmount * 100)
        } else {
          amountPaise = Math.max(0, Math.round(order.totalAmount * 100) - Math.round(alreadyPaidRupees * 100))
          if (amountPaise === 0) {
            await client.query('ROLLBACK')
            return { success: false, message: 'No balance due' }
          }
        }
      }

      amountRupees = amountPaise / 100

      // What can be spent right now = balance minus any amount reserved for an in-store sale the customer approved.
      const { availablePaise, heldPaise } = await new WalletRedemptionRepository().availablePaise(userId, client)
      if (availablePaise < amountPaise) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: heldPaise > 0
            ? `Insufficient wallet balance. ₹${heldPaise / 100} of your wallet is reserved for an in-store payment you approved (it is released within 15 minutes if the sale is not completed). Available: ₹${Math.max(0, availablePaise) / 100}, needed: ₹${amountRupees}.`
            : `Insufficient wallet balance. Need ₹${amountRupees}, have ₹${wallet.balance}`,
        }
      }

      await this.walletRepo.debit(
        client,
        wallet.id,
        amountRupees,
        orderId ? `Payment for order ${orderId}` : 'Order advance payment',
        orderId || orderDraftIdVal
      )

      payment = await this.repo.create(
        {
          orderId: orderId || null,
          orderDraftId: orderDraftIdVal || null,
          userId,
          amount: amountRupees,
          currency: 'INR',
          status: 'PAID',
          // Distinct from a Razorpay-side "wallet" sub-method (Paytm/
          // PhonePe etc. paid *through* Razorpay's own checkout, which its
          // webhook can independently report as method: 'wallet') — this is
          // LNDRY's own stored-value balance, debited directly above with
          // no gateway involved at all. Keeping the string distinct is what
          // lets the client tell the two apart instead of showing both as
          // an ambiguous "Wallet".
          method: 'LNDRY_WALLET',
          purpose,
        },
        client
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      if (err.code === '23505') {
        // The database's one-paid-advance-per-draft guard fired: a concurrent request won.
        return { success: false, message: 'Advance payment already completed' }
      }
      logger.error({ err, userId, orderId, orderDraftId: orderDraftIdVal }, 'Wallet payment failed')
      return { success: false, message: 'Payment failed. Your wallet was not charged. Please try again.' }
    } finally {
      client.release()
    }

    // Same post-paid side effects as every other confirmation path.
    if (orderId && purpose === 'BALANCE') {
      await this.settlement.applyPaidSideEffects(payment, { source: 'wallet' })
    } else if (orderId && purpose === 'FULL') {
      await this.ordersRepo.updateStatus(orderId, 'WAITING_VENDOR_CONFIRMATION', { paymentStatus: 'PAID' })
      try {
        await orderQueue.add(
          'auto-reject',
          { type: 'auto-reject', orderId },
          { jobId: `auto-reject-${orderId}`, delay: 15 * 60 * 1000, removeOnComplete: true }
        )
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Failed to queue auto-reject on wallet payment')
      }
      // Customer + laundry notifications (idempotent with the status-change path).
      await emitLifecycleEvent('ORDER_PLACED', { orderId })
      await emitLifecycleEvent('VENDOR_NEW_ORDER', { orderId })
    }
    // ADVANCE: the client calls placeOrderFromDraft next (exactly like after a
    // Razorpay verify); if it never does, the reconciliation worker places the
    // order from this PAID row, or refunds the wallet.

    if (purpose !== 'BALANCE') {
      try {
        const { CartRepository } = await import('../../../archived_modules/cart/cart.repository.js')
        const cartRepo = new CartRepository()
        await cartRepo.clearCart(userId)
        await cartRepo.clearExtras(userId)
      } catch (err) {
        logger.warn({ err: err.message, userId }, 'Cart clear after wallet payment failed (non-critical)')
      }
    }

    logger.info({ userId, orderId, orderDraftId: orderDraftIdVal, purpose, amount: amountRupees }, 'Wallet payment successful')

    return { success: true, payment }
  }

  /**
   * Release slot hold on payment failure helper
   */
  async _releaseSlotHold(orderDraftId) {
    if (!orderDraftId) return
    try {
      const draftRes = await query('SELECT snapshot FROM order_drafts WHERE id = $1', [orderDraftId])
      if (draftRes.rows.length > 0) {
        const snapshot = draftRes.rows[0].snapshot
        const snap = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
        const quoteId = snap.quote?.quote_id || snap.quote?.id
        if (quoteId) {
          await query('DELETE FROM slot_holds WHERE quote_id = $1', [quoteId])
          logger.info({ quoteId, orderDraftId }, 'Slot hold released due to payment failure')
        }
      }
    } catch (err) {
      logger.warn({ err: err.message, orderDraftId }, 'Failed to release slot hold on payment failure (non-critical)')
    }
  }

  /**
   * Verify payment signature from Razorpay client-side callback
   */
  async verifyPayment(userId, body) {
    const rzpOrderId = body.razorpayOrderId || body.order_id
    const rzpPaymentId = body.razorpayPaymentId || body.payment_id
    const rzpSignature = body.razorpaySignature || body.signature

    if (!rzpOrderId || !rzpPaymentId) {
      return { success: false, message: 'Missing payment details' }
    }

    const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
    if (!payment) {
      return { success: false, message: 'Payment record not found' }
    }

    if (payment.userId !== userId) {
      return { success: false, message: 'Unauthorized' }
    }

    const rzp = await getRazorpay()
    const isMock = rzpOrderId.startsWith('order_mock_') || !rzp
    if (isMock && (env.NODE_ENV === 'production' || (env.NODE_ENV !== 'test' && !env.ALLOW_MOCK_PAYMENT))) {
      return { success: false, message: 'Mock payment not allowed in this environment' }
    }

    // HMAC-SHA256 verification
    if (!isMock) {
      const expectedSignature = crypto
        .createHmac('sha256', rzp.keySecret)
        .update(`${rzpOrderId}|${rzpPaymentId}`)
        .digest('hex')

      if (!this._safeEqual(expectedSignature, rzpSignature)) {
        // Reject the request only. A bad signature must NOT move a real
        // payment to FAILED: the customer may genuinely have paid, and the
        // webhook / reconciliation will confirm it. (Failing it here used to
        // cancel the order of a customer whose money had in fact been taken.)
        logger.warn({ rzpOrderId, paymentId: payment.id }, 'Payment signature verification failed')
        return { success: false, message: 'Payment verification failed. If money was deducted it will be confirmed automatically within a few minutes.' }
      }
    }

    const result = await this.settlement.settle(payment, {
      razorpayPaymentId: rzpPaymentId,
      signature: rzpSignature,
      source: 'client-verify',
    })

    if (result.payment?.status === 'REFUNDED' || result.outcome === 'REFUNDED' || result.outcome === 'DUPLICATE_REFUNDED') {
      return {
        success: false,
        message: result.outcome === 'DUPLICATE_REFUNDED'
          ? 'You had already paid for this booking. The extra payment is being refunded.'
          : 'Your payment was received but the booking could not be confirmed, so it is being refunded to your original payment method.',
        code: 'PAYMENT_REFUNDED',
      }
    }

    // Clear the cart - only after payment is confirmed. Skipped for a
    // BALANCE payment: the customer may have an unrelated new order's items
    // sitting in their cart right now, and this isn't a fresh checkout.
    if (payment.purpose !== 'BALANCE') {
      try {
        const { CartRepository } = await import('../../../archived_modules/cart/cart.repository.js')
        const cartRepo = new CartRepository()
        await cartRepo.clearCart(userId)
        await cartRepo.clearExtras(userId)
      } catch (err) {
        logger.warn({ err: err.message, userId }, 'Cart clear after payment verify failed (non-critical)')
      }
    }

    logger.info(
      { paymentId: payment.id, razorpayPaymentId: rzpPaymentId, orderId: payment.orderId, outcome: result.outcome },
      'Payment verified successfully'
    )

    return { success: true, payment: result.payment }
  }

  /**
   * Handle Razorpay webhook events.
   *
   * Contract with the HTTP layer:
   *   { success: false, status: 400 }  bad / missing signature
   *   { success: true }                handled (or a duplicate we already handled)
   *   throws                           something transient broke → 500 → Razorpay retries (up to 24h)
   */
  async handleWebhook(rawBody, signature, eventIdHeader) {
    const rzpCfg = await getRazorpay()
    const webhookSecret = rzpCfg?.webhookSecret
    if (!webhookSecret) {
      logger.error('Razorpay webhook received but no webhook secret is configured')
      return { success: false, status: 400 }
    }

    // The HMAC must be computed over the exact bytes Razorpay sent (captured by
    // the `captureRawBody` preParsing hook), not a re-serialisation of parsed JSON.
    const rawBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8')

    const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(rawBuffer).digest('hex')
    if (!this._safeEqual(expectedSignature, signature)) {
      logger.warn('Webhook signature mismatch')
      return { success: false, status: 400 }
    }

    const body = JSON.parse(rawBuffer.toString('utf8'))
    const event = body.event
    const payload = body.payload || {}
    const paymentEntity = payload.payment?.entity
    const eventId = eventIdHeader || crypto.createHash('sha256').update(rawBuffer).digest('hex')

    // Exactly-once processing: Razorpay retries any delivery that did not get a 2xx.
    const seen = await query(
      `INSERT INTO payment_webhook_events (event_id, event_type, razorpay_order_id, razorpay_payment_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO UPDATE SET attempts = payment_webhook_events.attempts + 1
       RETURNING processed_at`,
      [eventId, event, paymentEntity?.order_id || payload.order?.entity?.id || null, paymentEntity?.id || null]
    )
    if (seen.rows[0]?.processed_at) {
      logger.info({ event, eventId }, 'Duplicate Razorpay webhook ignored')
      return { success: true, duplicate: true }
    }

    logger.info({ event, eventId }, 'Razorpay webhook received')

    try {
      await this._processWebhookEvent(event, payload)
      await query(`UPDATE payment_webhook_events SET processed_at = NOW(), last_error = NULL WHERE event_id = $1`, [eventId])
    } catch (err) {
      await query(`UPDATE payment_webhook_events SET last_error = $2 WHERE event_id = $1`, [eventId, String(err?.message || err).slice(0, 500)]).catch(() => {})
      logger.error({ err: err?.message, event, eventId }, 'Webhook processing failed — Razorpay will retry')
      throw err
    }
    return { success: true }
  }

  async _processWebhookEvent(event, payload) {
    switch (event) {
      case 'payment.captured':
      case 'order.paid': {
        const entity = payload.payment?.entity
        const rzpOrderId = entity?.order_id || payload.order?.entity?.id
        if (!rzpOrderId) return

        const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
        if (payment) {
          await this.settlement.settle(payment, {
            razorpayPaymentId: entity?.id,
            method: entity?.method,
            source: `webhook:${event}`,
          })
          return
        }
        // Not an order payment: it may be a wallet top-up whose app was
        // closed before it could call the verify endpoint.
        const { WalletService } = await import('../wallet/wallet.service.js')
        await new WalletService(this.walletRepo).settleTopUp(rzpOrderId, entity?.id)
        return
      }

      case 'payment.authorized': {
        // Accounts on manual capture leave a good payment "authorized"; an
        // un-captured one is eventually auto-refunded by Razorpay. Capture it
        // now (settlement does that and settles) — duplicates are harmless.
        const rzpOrderId = payload.payment?.entity?.order_id
        if (!rzpOrderId) return
        const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
        if (payment && payment.status !== 'PAID') {
          await this.settlement.checkGateway(payment, { source: 'webhook:payment.authorized' })
        }
        return
      }

      case 'payment.failed': {
        const entity = payload.payment?.entity
        const rzpOrderId = entity?.order_id
        if (!rzpOrderId) return
        const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
        if (!payment || payment.status === 'PAID' || payment.status === 'REFUNDED') return

        // Remember WHY (shown to the customer). The payment is not ended here:
        // the customer can retry on the same gateway order and a later success
        // must still settle it.
        const failure = await this.settlement.recordGatewayFailure(payment, entity, { terminal: false })
        logger.info({ paymentId: payment.id, failure: failure.code }, 'Payment attempt failed')

        // Legacy order-first flow only: and only for an order that has not started yet. A failed
        // BALANCE attempt (card declined at the door) must never touch an order that is mid-delivery.
        if (payment.orderId && payment.purpose === 'FULL') {
          const order = await this.ordersRepo.findById(payment.orderId)
          if (order && order.status === 'PENDING') {
            await this.ordersRepo.updateStatus(payment.orderId, 'PAYMENT_FAILED', { paymentStatus: 'FAILED' })
          }
        }
        return
      }

      case 'refund.processed':
      case 'refund.created': {
        const rzpPaymentId = payload.refund?.entity?.payment_id
        logger.info({ razorpayPaymentId: rzpPaymentId, event }, 'Refund event received')
        return
      }

      default:
        logger.debug({ event }, 'Unhandled webhook event')
    }
  }

  /**
   * Where does this checkout stand? Polled by the app after the payment sheet
   * closes (and from the order screen) so a slow gateway is shown honestly as
   * "confirming" rather than as a failure, and a real failure shows its reason.
   *
   * status: PAID | CONFIRMING | FAILED | EXPIRED | REFUNDED | NONE
   */
  async getPaymentStatus(userId, { orderDraftId, orderId, paymentId } = {}) {
    let payment = null
    if (paymentId) payment = await this.repo.findById(paymentId)
    else if (orderDraftId) payment = await this.repo.findLatestByOrderDraftId(orderDraftId)
    else if (orderId) payment = await this.repo.findByOrderId(orderId)
    if (!payment || payment.userId !== userId) return { success: true, data: { status: 'NONE' } }

    // Catch up with the gateway right away instead of waiting for the next
    // reconciliation tick (throttled so a polling app cannot hammer Razorpay).
    if (['PENDING', 'EXPIRED', 'FAILED'].includes(payment.status)) {
      const last = payment.lastGatewayCheckAt ? new Date(payment.lastGatewayCheckAt).getTime() : 0
      if (Date.now() - last > 10_000) {
        const check = await this.settlement.checkGateway(payment, { source: 'status-poll' })
        if (check.payment) payment = (await this.repo.findById(payment.id)) || payment
      }
    }

    const draftId = payment.orderDraftId
    let placedOrderId = payment.orderId
    if (!placedOrderId && draftId && payment.status === 'PAID') {
      const o = await query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [draftId, userId])
      placedOrderId = o.rows[0]?.id || null
    }

    let status
    let message = null
    if (payment.status === 'PAID') {
      status = placedOrderId || payment.purpose === 'BALANCE' ? 'PAID' : 'CONFIRMING'
      if (status === 'CONFIRMING') message = 'Payment received. We are confirming your booking — this usually takes a few seconds.'
    } else if (payment.status === 'REFUNDED') {
      status = 'REFUNDED'
      message = 'This payment was refunded to your original payment method.'
    } else if (payment.failureReason) {
      status = 'FAILED'
      message = payment.failureReason
    } else if (payment.status === 'EXPIRED' || payment.status === 'FAILED') {
      status = payment.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED'
      message = friendlyPaymentFailure({ code: payment.status === 'EXPIRED' ? 'timeout' : '' }).message
    } else {
      status = 'CONFIRMING'
      message = 'Waiting for your bank to confirm the payment. If money was deducted, your booking will be confirmed automatically — you do not need to pay again.'
    }

    return {
      success: true,
      data: {
        status,
        message,
        paymentId: payment.id,
        orderId: placedOrderId || null,
        purpose: payment.purpose,
        amount: payment.amount,
        failureCode: payment.failureCode,
      },
    }
  }

  /**
   * Get payment history for a user
   */
  async getHistory(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { payments, total } = await this.repo.findByUser(userId, { limit, offset })

    return {
      payments,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: initiate refund
   */
  async refund(paymentId, { amount, reason }) {
    const rzp = await getRazorpay()
    if (!rzp) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const payment = await this.repo.findById(paymentId)
    if (!payment) {
      return { success: false, message: 'Payment not found' }
    }

    if (payment.status !== 'PAID') {
      return { success: false, message: 'Only paid payments can be refunded' }
    }

    if (payment.method === 'LNDRY_WALLET' || !payment.razorpayPaymentId) {
      // Paid from the LNDRY wallet (no gateway payment to reverse): credit the wallet back.
      if (amount && Number(amount) < Number(payment.amount)) {
        return { success: false, message: 'Wallet payments can only be refunded in full' }
      }
      const walletRefund = await this.settlement.refundPayment(payment, { reason: reason || 'Admin initiated refund' })
      if (!walletRefund.success) return { success: false, message: walletRefund.message || 'Refund failed' }
      return { success: true, payment: await this.repo.findById(payment.id) }
    }

    const refundAmount = amount || payment.amount
    if (refundAmount > payment.amount) {
      return { success: false, message: 'Refund amount exceeds payment amount' }
    }

    try {
      const rzpRefund = await rzp.client.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { reason: reason || 'Admin initiated refund' },
      })

      const updated = await this.repo.updateRefund(payment.id, {
        refundId: rzpRefund.id,
        refundAmount,
        refundStatus: 'PROCESSED',
      })

      // Update order status to refunded (a payment for a draft has no order yet)
      if (payment.orderId) {
        await this.ordersRepo.updateStatus(payment.orderId, 'REFUNDED', {
          paymentStatus: 'REFUNDED',
        })
      }

      logger.info({ paymentId, refundId: rzpRefund.id, refundAmount }, 'Refund initiated')
      return { success: true, payment: updated }
    } catch (err) {
      logger.error({ err, paymentId }, 'Refund failed')
      return { success: false, message: 'Refund failed: ' + err.message }
    }
  }

  async _queueAutoAssign(orderId, source = 'PAYMENTS_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        {
          type: 'auto-assign',
          orderId,
          source,
        },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }
}
