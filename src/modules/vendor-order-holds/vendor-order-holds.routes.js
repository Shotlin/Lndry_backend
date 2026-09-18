import { query } from '../../config/database.js'
import { VendorOrderHoldsController } from './vendor-order-holds.controller.js'
import { VendorOrderHoldsService } from './vendor-order-holds.service.js'
import { VendorOrderHoldsRepository } from './vendor-order-holds.repository.js'
import {
  createOrderHoldSchema, listOrderHoldsSchema, orderHoldPresenceSchema,
  claimOrderHoldSchema, renewOrderHoldSchema, releaseOrderHoldSchema, resumeOrderHoldSchema, cancelOrderHoldSchema,
} from './vendor-order-holds.schema.js'

/**
 * Vendor-facing order hold routes — mounted at /api/v1/vendor/order-holds.
 */
export default async function vendorOrderHoldsRoutes(fastify) {
  const service = new VendorOrderHoldsService(new VendorOrderHoldsRepository())
  const controller = new VendorOrderHoldsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to order holds', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listOrderHoldsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createOrderHoldSchema }, controller.create.bind(controller))
  fastify.get('/presence', { schema: orderHoldPresenceSchema }, controller.presence.bind(controller))
  fastify.post('/:id/claim', { schema: claimOrderHoldSchema }, controller.claim.bind(controller))
  fastify.post('/:id/renew', { schema: renewOrderHoldSchema }, controller.renew.bind(controller))
  fastify.post('/:id/release', { schema: releaseOrderHoldSchema }, controller.release.bind(controller))
  fastify.post('/:id/resume', { schema: resumeOrderHoldSchema }, controller.resume.bind(controller))
  fastify.post('/:id/cancel', { schema: cancelOrderHoldSchema }, controller.cancel.bind(controller))
}
