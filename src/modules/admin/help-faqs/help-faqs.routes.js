import { HelpFaqsController } from './help-faqs.controller.js'
import { HelpFaqsService } from './help-faqs.service.js'
import { HelpFaqsRepository } from './help-faqs.repository.js'
import {
  listHelpFaqsSchema,
  createHelpFaqSchema,
  updateHelpFaqSchema,
  deleteHelpFaqSchema,
} from './help-faqs.schema.js'

/**
 * Help FAQs admin routes plugin
 * Prefix: /api/v1/admin/help-faqs
 *
 * The customer-facing read (GET /api/v1/customer/faqs) lives in
 * customers.routes.js next to /support-contact.
 */
export default async function helpFaqsRoutes(fastify) {
  const controller = new HelpFaqsController(new HelpFaqsService(new HelpFaqsRepository()))

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listHelpFaqsSchema }, controller.listAll.bind(controller))
  fastify.post('/', { schema: createHelpFaqSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateHelpFaqSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: deleteHelpFaqSchema }, controller.delete.bind(controller))
}
