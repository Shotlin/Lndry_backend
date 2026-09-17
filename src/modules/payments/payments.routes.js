import { PaymentsController } from './payments.controller.js'
import { PaymentsService } from './payments.service.js'
import { PaymentsRepository } from './payments.repository.js'
import { captureRawBody } from '../../utils/rawBody.js'
import {
  createPaymentOrderSchema,
  verifyPaymentSchema,
  paymentHistorySchema,
  payWithWalletSchema,
  refundSchema,
} from './payments.schema.js'

/**
 * Payments routes plugin
 * Prefix: /api/v1/payments
 */
export default async function paymentsRoutes(fastify) {
  const repository = new PaymentsRepository()
  const service = new PaymentsService(repository)
  const controller = new PaymentsController(service)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // POST /create-order — Create Razorpay payment order
  fastify.post('/create-order', {
    schema: createPaymentOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.createPaymentOrder.bind(controller))

  // POST /verify — Verify payment signature
  fastify.post('/verify', {
    schema: verifyPaymentSchema,
    preHandler: [fastify.authenticate],
  }, controller.verifyPayment.bind(controller))

  // GET /history — Payment history
  fastify.get('/history', {
    schema: paymentHistorySchema,
    preHandler: [fastify.authenticate],
  }, controller.history.bind(controller))

  // POST /pay-with-wallet — Pay a draft's advance or an order's balance from wallet
  fastify.post('/pay-with-wallet', {
    schema: payWithWalletSchema,
    preHandler: [fastify.authenticate],
  }, controller.payWithWallet.bind(controller))

  // ─── Webhook (NO AUTH — verified by Razorpay signature) ────────────

  // POST /webhook — Razorpay event webhook
  // Raw body must be preserved for signature verification.
  fastify.post('/webhook', {
    preParsing: captureRawBody,
    config: { rawBody: true },
    schema: {
      body: { type: 'object', additionalProperties: true },
    },
  }, controller.webhook.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // POST /:id/refund — Initiate refund [ADMIN]
  fastify.post('/:id/refund', {
    schema: refundSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.refund.bind(controller))
}
