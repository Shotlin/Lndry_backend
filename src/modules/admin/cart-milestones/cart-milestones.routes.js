import { CartMilestonesController } from './cart-milestones.controller.js'
import { CartMilestonesService } from './cart-milestones.service.js'
import { CartMilestonesRepository } from './cart-milestones.repository.js'
import {
  listCartMilestonesSchema,
  createCartMilestoneSchema,
  updateCartMilestoneSchema,
  deleteCartMilestoneSchema,
} from './cart-milestones.schema.js'

/**
 * Cart Milestones admin routes plugin
 * Prefix: /api/v1/admin/cart-milestones
 *
 * No separate customer-facing route for v1 — LNDRY's checkout is a
 * single-vendor quote→draft flow, not a persistent cart to show live
 * pre-checkout progress against (first-time-offers made the same call for
 * its equivalent "customer-facing tiers" endpoint).
 */
export default async function cartMilestonesRoutes(fastify) {
  const repository = new CartMilestonesRepository()
  const service = new CartMilestonesService(repository)
  const controller = new CartMilestonesController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listCartMilestonesSchema }, controller.listAll.bind(controller))
  fastify.post('/', { schema: createCartMilestoneSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateCartMilestoneSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: deleteCartMilestoneSchema }, controller.delete.bind(controller))
}
