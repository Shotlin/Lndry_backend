import { CartMilestonesController } from './cart-milestones.controller.js'
import { CartMilestonesService } from './cart-milestones.service.js'
import { CartMilestonesRepository } from './cart-milestones.repository.js'
import {
  listCartMilestonesSchema,
  activeCartMilestonesSchema,
  createCartMilestoneSchema,
  updateCartMilestoneSchema,
  deleteCartMilestoneSchema,
} from './cart-milestones.schema.js'

/**
 * Customer-facing routes plugin — mounted separately (see app.js) at
 * /api/v1/cart-milestones, NOT under /admin. Added for the mobile app's
 * "milestone perks" widget floating above the cart/nav (real cart
 * subtotal vs. the tier ladder, live progress bar). The "no customer route
 * needed" note this file used to carry assumed LNDRY's checkout had no use
 * for live pre-checkout progress — it does, via the mobile cart screen.
 */
export async function customerCartMilestonesRoutes(fastify) {
  const repository = new CartMilestonesRepository()
  const service = new CartMilestonesService(repository)
  const controller = new CartMilestonesController(service)

  fastify.get('/active', {
    schema: activeCartMilestonesSchema,
    preHandler: [fastify.authenticate],
  }, controller.activeForCustomer.bind(controller))
}

/**
 * Cart Milestones admin routes plugin
 * Prefix: /api/v1/admin/cart-milestones
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
