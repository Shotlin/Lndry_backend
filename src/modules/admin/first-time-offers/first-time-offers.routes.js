import { FirstTimeOffersController } from './first-time-offers.controller.js'
import { FirstTimeOffersService } from './first-time-offers.service.js'
import { FirstTimeOffersRepository } from './first-time-offers.repository.js'
import {
  listFirstTimeOffersSchema,
  activeFirstTimeOffersSchema,
  createFirstTimeOfferSchema,
  updateFirstTimeOfferSchema,
  deleteFirstTimeOfferSchema,
} from './first-time-offers.schema.js'

/**
 * Customer-facing routes plugin — mounted separately (see app.js) at
 * /api/v1/first-time-offers, NOT under /admin, so it only requires a
 * regular authenticated customer, not admin. Kept in this file (rather
 * than the admin routes below) so both share one Controller/Service
 * instance construction pattern without duplicating it.
 */
export async function customerFirstTimeOffersRoutes(fastify) {
  const repository = new FirstTimeOffersRepository()
  const service = new FirstTimeOffersService(repository)
  const controller = new FirstTimeOffersController(service)

  fastify.get('/active', {
    schema: activeFirstTimeOffersSchema,
    preHandler: [fastify.authenticate],
  }, controller.activeForCustomer.bind(controller))
}

/**
 * First-Time Offers admin routes plugin
 * Prefix: /api/v1/admin/first-time-offers
 */
export default async function firstTimeOffersRoutes(fastify) {
  const repository = new FirstTimeOffersRepository()
  const service = new FirstTimeOffersService(repository)
  const controller = new FirstTimeOffersController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listFirstTimeOffersSchema }, controller.listAll.bind(controller))
  fastify.post('/', { schema: createFirstTimeOfferSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateFirstTimeOfferSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: deleteFirstTimeOfferSchema }, controller.delete.bind(controller))
}
