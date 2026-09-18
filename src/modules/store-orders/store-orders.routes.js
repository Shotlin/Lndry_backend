import { query } from '../../config/database.js'
import { StoreOrdersController } from './store-orders.controller.js'
import { StoreOrdersService } from './store-orders.service.js'
import { StoreOrdersRepository } from './store-orders.repository.js'
import { resolvePhoneSchema, pushStoreOrderSchema, listMyStoreOrdersSchema } from './store-orders.schema.js'

/**
 * Customer-facing routes — mounted at /api/v1/store-orders. A signed-in
 * customer's own "Laundry Store" (walk-in) order history.
 */
export default async function storeOrdersRoutes(fastify) {
  const service = new StoreOrdersService(new StoreOrdersRepository())
  const controller = new StoreOrdersController(service)

  fastify.get('/mine', {
    schema: listMyStoreOrdersSchema,
    preHandler: [fastify.authenticate],
  }, controller.listMine.bind(controller))
}

/**
 * Vendor-facing routes — mounted at /api/v1/vendor (shares the prefix with
 * vendor-applications.routes.js and others already registered there).
 * Called by a vendor's own POS desktop app (epic-laundry-desktop) when a
 * walk-in customer's phone matches a real LNDRY account.
 */
export async function vendorStoreOrdersRoutes(fastify) {
  const service = new StoreOrdersService(new StoreOrdersRepository())
  const controller = new StoreOrdersController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  // Only a vendor owner/staff runs the counter — riders have no reason to
  // look up a customer's account or push a sale, same guard vendor-orders
  // uses to keep a rider's shop-scoped JWT off the full vendor surface.
  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({
        success: false,
        message: 'Riders do not have access to store orders',
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

  fastify.post('/customers/resolve-phone', {
    schema: resolvePhoneSchema,
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
  }, controller.resolvePhone.bind(controller))

  fastify.post('/store-orders', {
    schema: pushStoreOrderSchema,
  }, controller.pushOrder.bind(controller))
}
