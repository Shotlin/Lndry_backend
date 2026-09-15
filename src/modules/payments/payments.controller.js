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
      return reply.code(400).send(error(result.message, 'PAYMENT_FAILED'))
    }
    return reply.code(201).send(success(result.data, 'Payment order created'))
  }

  /**
   * Verify Razorpay payment
   */
  async verifyPayment(request, reply) {
    const result = await this.service.verifyPayment(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VERIFY_FAILED'))
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
    const result = await this.service.handleWebhook(request.rawBody, signature)
    // Always return 200 to Razorpay
    return reply.send({ status: result.success ? 'ok' : 'error' })
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
