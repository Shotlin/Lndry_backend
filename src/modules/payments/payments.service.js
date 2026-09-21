import crypto from 'node:crypto'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { razorpay } from '../../config/razorpay.js'
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

    if (!razorpay) {
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
    const rzpOrder = await razorpay.orders.create({
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
        keyId: env.RAZORPAY_KEY_ID,
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

    if (orderDraftIdVal) {
      const draftRes = await query('SELECT id, payable_amount_paise, booking_type FROM order_drafts WHERE id = $1 AND user_id = $2', [orderDraftIdVal, userId])
      const draft = draftRes.rows[0]
      if (!draft) {
        return { success: false, message: 'Order draft not found' }
      }
      const existingPaid = await this.repo.findPaidByOrderDraftId(orderDraftIdVal)
      if (existingPaid) {
        return { success: false, message: 'Advance payment already completed' }
      }
      purpose = 'ADVANCE'
      const advancePaise = await this._getAdvanceAmountPaise()
      // Assisted booking: no service price yet → always the full advance.
      amountPaise = draft.booking_type === 'ASSISTED'
        ? advancePaise
        : Math.min(advancePaise, draft.payable_amount_paise)
    } else if (orderId) {
      const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
      if (!order) {
        return { success: false, message: 'Order not found' }
      }

      const alreadyPaidRupees = await this.repo.sumPaidByOrderId(orderId)
      purpose = alreadyPaidRupees > 0 ? 'BALANCE' : 'FULL'

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
    } else {
      return { success: false, message: 'Either orderId or order_draft_id must be provided' }
    }

    const amountRupees = amountPaise / 100
    const client = await getClient()
    let payment

    try {
      await client.query('BEGIN')

      const wallet = await this.walletRepo.getForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }
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
      logger.error({ err, userId, orderId, orderDraftId: orderDraftIdVal }, 'Wallet payment failed')
      return { success: false, message: 'Payment failed: ' + err.message }
    } finally {
      client.release()
    }

    // Run the same post-paid side effects verifyPayment runs, keyed by
    // purpose — ADVANCE needs none here: placeOrderFromDraft (called next
    // by the client, exactly like after a Razorpay verify) does the rest.
    if (orderId && purpose === 'BALANCE') {
      await this.ordersRepo.updateStatus(orderId, undefined, { paymentStatus: 'PAID' })
      await this._announceBalancePaid(orderId, Math.round(Number(amountRupees) * 100), `wallet:${amountRupees}`)
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

    const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
    if (!payment) {
      return { success: false, message: 'Payment record not found' }
    }

    if (payment.userId !== userId) {
      return { success: false, message: 'Unauthorized' }
    }

    const isMock = rzpOrderId.startsWith('order_mock_') || !razorpay
    if (isMock && (env.NODE_ENV === 'production' || (env.NODE_ENV !== 'test' && !env.ALLOW_MOCK_PAYMENT))) {
      return { success: false, message: 'Mock payment not allowed in this environment' }
    }

    // HMAC-SHA256 verification
    if (!isMock) {
      const expectedSignature = crypto
        .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(`${rzpOrderId}|${rzpPaymentId}`)
        .digest('hex')

      if (expectedSignature !== rzpSignature) {
        logger.warn({ rzpOrderId }, 'Payment signature verification failed')

        await this.repo.updatePayment(payment.id, { status: 'FAILED' })
        if (payment.orderId) {
          await this.ordersRepo.updateStatus(payment.orderId, 'PAYMENT_FAILED', {
            paymentStatus: 'FAILED',
          })
        }
        if (payment.orderDraftId) {
          await this._releaseSlotHold(payment.orderDraftId)
        }

        return { success: false, message: 'Payment verification failed' }
      }
    }

    // Update payment record
    const updated = await this.repo.updatePayment(payment.id, {
      razorpayPaymentId: rzpPaymentId,
      razorpaySignature: rzpSignature,
      status: 'PAID',
    })

    if (payment.orderId && payment.purpose === 'BALANCE') {
      // Balance-at-delivery leg: just mark paid and tell the customer.
      // Must NOT run any of the FULL-path side effects below — this order
      // is already well past PAYMENT_PENDING (e.g. out for delivery), so
      // forcing it back to WAITING_VENDOR_CONFIRMATION or re-queuing an
      // auto-reject job would corrupt its real lifecycle state.
      await this.ordersRepo.updateStatus(payment.orderId, undefined, {
        paymentStatus: 'PAID',
      })
      await this._announceBalancePaid(payment.orderId, Math.round(Number(updated.amount) * 100), `payment:${payment.id}`)
    } else if (payment.orderId && payment.purpose === 'FULL') {
      // Update order payment status (legacy path)
      await this.ordersRepo.updateStatus(payment.orderId, 'WAITING_VENDOR_CONFIRMATION', {
        paymentStatus: 'PAID',
      })
      try {
        await orderQueue.add(
          'auto-reject',
          {
            type: 'auto-reject',
            orderId: payment.orderId,
          },
          {
            jobId: `auto-reject-${payment.orderId}`,
            delay: 15 * 60 * 1000,
            removeOnComplete: true,
          }
        )
      } catch (err) {
        logger.warn({ err: err.message, orderId: payment.orderId }, 'Failed to queue auto-reject on verified payment')
      }

      // Send order placed notification after confirmed payment
      // Customer + laundry notifications (idempotent with the status-change path).
      await emitLifecycleEvent('ORDER_PLACED', { orderId: payment.orderId })
      await emitLifecycleEvent('VENDOR_NEW_ORDER', { orderId: payment.orderId })
    }
    // payment.purpose === 'ADVANCE' never reaches here with payment.orderId
    // set — at this point only order_draft_id is set, the order doesn't
    // exist yet (it's created by placeOrderFromDraft once this verify
    // succeeds), exactly as before this change.

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
      { paymentId: payment.id, razorpayPaymentId: rzpPaymentId, orderId: payment.orderId },
      'Payment verified successfully'
    )

    return { success: true, payment: updated }
  }

  /**
   * Handle Razorpay webhook events
   */
  async handleWebhook(rawBody, signature) {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      logger.warn('Razorpay webhook secret not configured')
      return { success: false }
    }

    // The real HTTP path passes the exact pristine bytes captured by the
    // `captureRawBody` preParsing hook (see payments.routes.js / app.js).
    // The HMAC must be computed over those exact bytes — not a
    // re-serialization of the already-JSON-parsed body — or a legitimate
    // Razorpay signature will never match. The string/object fallbacks
    // below exist only for direct unit-test callers.
    const rawBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8')

    const expectedSignature = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBuffer)
      .digest('hex')

    const expectedBuf = Buffer.from(expectedSignature, 'utf8')
    const providedBuf = Buffer.from(String(signature || ''), 'utf8')
    const signatureValid =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf)

    if (!signatureValid) {
      logger.warn('Webhook signature mismatch')
      return { success: false }
    }

    const body = JSON.parse(rawBuffer.toString('utf8'))
    const event = body.event
    const payload = body.payload

    logger.info({ event }, 'Razorpay webhook received')

    switch (event) {
      case 'payment.captured': {
        const rzpPaymentId = payload.payment?.entity?.id
        const rzpOrderId = payload.payment?.entity?.order_id

        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          if (payment && payment.status !== 'PAID') {
            await this.repo.updatePayment(payment.id, {
              razorpayPaymentId: rzpPaymentId,
              status: 'PAID',
              method: payload.payment?.entity?.method,
            })
            
            // Finalize the order from draft
            const { OrdersService } = await import('../orders/orders.service.js')
            const { OrdersRepository } = await import('../orders/orders.repository.js')
            const ordersService = new OrdersService(new OrdersRepository())
            
            try {
              const checkRes = await ordersService.placeOrderFromDraft(payment.userId, { orderDraftId: payment.orderDraftId })
              if (checkRes.success) {
                logger.info({ orderId: checkRes.order.id }, 'Order finalized successfully on webhook capture')
              }
            } catch (err) {
              logger.error({ err: err.message, draftId: payment.orderDraftId }, 'Failed to finalize order on webhook capture')
            }

            logger.info({ paymentId: payment.id }, 'Payment captured via webhook')
          }
        }
        break
      }

      case 'payment.failed': {
        const rzpOrderId = payload.payment?.entity?.order_id
        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          if (payment) {
            await this.repo.updatePayment(payment.id, { status: 'FAILED' })
            if (payment.orderId) {
              await this.ordersRepo.updateStatus(payment.orderId, 'PAYMENT_FAILED', {
                paymentStatus: 'FAILED',
              })
            }
            if (payment.orderDraftId) {
              await this._releaseSlotHold(payment.orderDraftId)
            }
            logger.info({ paymentId: payment.id }, 'Payment failed via webhook')
          }
        }
        break
      }

      case 'refund.processed': {
        const rzpPaymentId = payload.refund?.entity?.payment_id
        // Handle refund event if needed
        logger.info({ razorpayPaymentId: rzpPaymentId }, 'Refund processed via webhook')
        break
      }

      default:
        logger.debug({ event }, 'Unhandled webhook event')
    }

    return { success: true }
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
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const payment = await this.repo.findById(paymentId)
    if (!payment) {
      return { success: false, message: 'Payment not found' }
    }

    if (payment.status !== 'PAID') {
      return { success: false, message: 'Only paid payments can be refunded' }
    }

    if (!payment.razorpayPaymentId) {
      return { success: false, message: 'No Razorpay payment ID — cannot refund' }
    }

    const refundAmount = amount || payment.amount
    if (refundAmount > payment.amount) {
      return { success: false, message: 'Refund amount exceeds payment amount' }
    }

    try {
      const rzpRefund = await razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { reason: reason || 'Admin initiated refund' },
      })

      const updated = await this.repo.updateRefund(payment.id, {
        refundId: rzpRefund.id,
        refundAmount,
        refundStatus: 'PROCESSED',
      })

      // Update order status to refunded
      await this.ordersRepo.updateStatus(payment.orderId, 'REFUNDED', {
        paymentStatus: 'REFUNDED',
      })

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
