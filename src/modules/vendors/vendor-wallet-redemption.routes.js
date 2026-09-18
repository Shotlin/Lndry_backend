import { query } from '../../config/database.js'
import { WalletRedemptionController } from '../wallet-redemption/wallet-redemption.controller.js'
import { WalletRedemptionService } from '../wallet-redemption/wallet-redemption.service.js'
import {
  lookupPhoneSchema,
  createRequestSchema,
  confirmRequestSchema,
  cancelRequestSchema,
} from '../wallet-redemption/wallet-redemption.schema.js'

/**
 * Vendor-facing wallet redemption routes — mounted at /api/v1/vendor
 * (shares the prefix with vendor-applications.routes.js, store-orders'
 * vendorStoreOrdersRoutes, and others already registered there). Called by
 * a vendor's own POS desktop app (epic-laundry-desktop) when a customer
 * wants to pay with their real LNDRY wallet balance at the counter.
 */
export default async function vendorWalletRedemptionRoutes(fastify) {
  const service = new WalletRedemptionService()
  const controller = new WalletRedemptionController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  // Riders have no reason to look up a customer's wallet or redeem
  // against it — same guard store-orders/vendor-orders already use.
  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({
        success: false,
        message: 'Riders do not have access to wallet redemption',
        code: 'FORBIDDEN',
      })
    }
  })

  fastify.addHook('preHandler', async (request, reply) => {
    const { rows } = await query(
      `SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [request.user.id]
    )
    if (!rows.length) {
      return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    }
    request.vendorId = rows[0].vendor_id
  })

  fastify.post('/wallet/lookup', {
    schema: lookupPhoneSchema,
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
  }, controller.lookupPhone.bind(controller))

  fastify.post('/wallet/redemption-requests', {
    schema: createRequestSchema,
  }, controller.createRequest.bind(controller))

  fastify.post('/wallet/redemption-requests/:id/confirm', {
    schema: confirmRequestSchema,
  }, controller.confirmRequest.bind(controller))

  fastify.post('/wallet/redemption-requests/:id/cancel', {
    schema: cancelRequestSchema,
  }, controller.cancelRequest.bind(controller))
}
