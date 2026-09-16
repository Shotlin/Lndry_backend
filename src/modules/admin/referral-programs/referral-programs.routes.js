import { ReferralProgramsController } from './referral-programs.controller.js'
import { ReferralProgramsService } from './referral-programs.service.js'
import { ReferralProgramsRepository } from './referral-programs.repository.js'
import {
  listReferralProgramsSchema,
  createReferralProgramSchema,
  updateReferralProgramSchema,
  deleteReferralProgramSchema,
} from './referral-programs.schema.js'

/**
 * Referral Programs admin routes plugin
 * Prefix: /api/v1/admin/referral-programs
 */
export default async function referralProgramsRoutes(fastify) {
  const repository = new ReferralProgramsRepository()
  const service = new ReferralProgramsService(repository)
  const controller = new ReferralProgramsController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listReferralProgramsSchema }, controller.listAll.bind(controller))
  fastify.post('/', { schema: createReferralProgramSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateReferralProgramSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: deleteReferralProgramSchema }, controller.delete.bind(controller))
}
