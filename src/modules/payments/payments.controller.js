import { success, error } from '../../utils/apiResponse.js'

/**
 * Payments controller — thin HTTP layer
 */
export class PaymentsController {
  constructor(service) {
    this.service = service
  }

  /**
   * Create a Razorpay payment order
   */
  async createPaymentOrder(request, reply) {
    const result = await this.service.createPaymentOrder(
      request.user.id,
      request.body
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'PAYMENT_FAILED'))
    }
    return reply.code(201).send(success(result.data, 'Payment order created'))
  }

  /**
   * Verify Razorpay payment
   */
  async verifyPayment(request, reply) {
    const result = await this.service.verifyPayment(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'VERIFY_FAILED'))
    }
    return reply.send(success(result.payment, 'Payment verified'))
  }

  /**
   * Pay from wallet balance
   */
  async payWithWallet(request, reply) {
    const result = await this.service.payWithWallet(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'WALLET_PAY_FAILED'))
    }
    return reply.send(success(result.payment, 'Payment successful'))
  }

  /**
   * Razorpay webhook — no auth, verified via signature
   */
  async webhook(request, reply) {
    const signature = request.headers['x-razorpay-signature']
    const eventId = request.headers['x-razorpay-event-id']
    // A thrown error becomes a 500, which makes Razorpay retry the delivery —
    // exactly what we want for a transient failure (database blip, etc.).
    const result = await this.service.handleWebhook(request.rawBody, signature, eventId)
    if (!result.success) {
      // Bad signature / unconfigured secret: say so, so it shows up as a failing
      // webhook in the Razorpay dashboard instead of silently "succeeding".
      return reply.code(result.status || 400).send({ status: 'error' })
    }
    return reply.send({ status: 'ok' })
  }

  /**
   * Checkout / payment status for the app to poll
   */
  async status(request, reply) {
    const { order_draft_id, order_id, payment_id } = request.query
    const result = await this.service.getPaymentStatus(request.user.id, {
      orderDraftId: order_draft_id,
      orderId: order_id,
      paymentId: payment_id,
    })
    reply.header('Cache-Control', 'no-store')
    return reply.send(success(result.data, 'Payment status'))
  }

  /**
   * Payment history for current user
   */
  async history(request, reply) {
    const { payments, pagination } = await this.service.getHistory(
      request.user.id,
      request.query
    )
    return reply.send(success(payments, 'Payment history fetched', { pagination }))
  }

  /**
   * Admin: initiate refund
   */
  async refund(request, reply) {
    const result = await this.service.refund(request.params.id, request.body || {})
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'REFUND_FAILED'))
    }
    return reply.send(success(result.payment, 'Refund initiated'))
  }
}
