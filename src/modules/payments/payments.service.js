import crypto from 'node:crypto'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { razorpay } from '../../config/razorpay.js'
import { orderQueue } from '../../config/bullmq.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { query } from '../../config/database.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Payments service — Razorpay integration + payment management
 */
export class PaymentsService {
  constructor(repository) {
    this.repo = repository
    this.ordersRepo = new OrdersRepository()
  }

  /**
   * Create a Razorpay order for an existing app order
   */
  async createPaymentOrder(userId, body) {
    const { orderId, order_draft_id, orderDraftId } = typeof body === 'string' ? { orderId: body } : (body || {})
    const orderDraftIdVal = order_draft_id || orderDraftId

    let amountPaise = 0
    let amountRupees = 0
    let receipt = ''

    if (orderDraftIdVal) {
      const draftRes = await query('SELECT id, payable_amount_paise FROM order_drafts WHERE id = $1 AND user_id = $2', [orderDraftIdVal, userId])
      const draft = draftRes.rows[0]
      if (!draft) {
        return { success: false, message: 'Order draft not found' }
      }
      amountPaise = draft.payable_amount_paise
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
      if (order.paymentStatus === 'PAID') {
        return { success: false, message: 'Order is already paid' }
      }
      amountPaise = Math.round(order.totalAmount * 100)
      amountRupees = order.totalAmount
      receipt = order.orderNumber
    } else {
      return { success: false, message: 'Either orderId or order_draft_id must be provided' }
    }

    // Check if payment record already exists
    if (orderId) {
      const existing = await this.repo.findByOrderId(orderId)
      if (existing && existing.status === 'PAID') {
        return { success: false, message: 'Payment already completed' }
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
      },
    }
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

    if (payment.orderId) {
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
      try {
        const order = await this.ordersRepo.findByIdAndUser(payment.orderId, userId)
        if (order) {
          const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
          const { NotificationsService } = await import('../notifications/notifications.service.js')
          const { buildCustomerOrderEventNotification } = await import('../notifications/customer-order-event.helper.js')
          const notifService = new NotificationsService(new NotificationsRepository(), null)
          await notifService.sendNotification(userId, buildCustomerOrderEventNotification({
            orderId: order.id,
            orderNumber: order.orderNumber || order.order_number,
            timelineType: 'ORDER_PLACED',
            status: 'CONFIRMED',
          }))
        }
      } catch (err) {
        logger.warn({ err: err.message, orderId: payment.orderId }, 'Order notification after payment verify failed (non-critical)')
      }
    }

    // Clear the cart - only after payment is confirmed.
    try {
      const { CartRepository } = await import('../../../archived_modules/cart/cart.repository.js')
      const cartRepo = new CartRepository()
      await cartRepo.clearCart(userId)
      await cartRepo.clearExtras(userId)
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Cart clear after payment verify failed (non-critical)')
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
