import { FirstTimeOffersController } from './first-time-offers.controller.js'
import { FirstTimeOffersService } from './first-time-offers.service.js'
import { FirstTimeOffersRepository } from './first-time-offers.repository.js'
import {
  listFirstTimeOffersSchema,
  createFirstTimeOfferSchema,
  updateFirstTimeOfferSchema,
  deleteFirstTimeOfferSchema,
} from './first-time-offers.schema.js'

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
