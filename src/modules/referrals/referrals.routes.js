import { ReferralsController } from './referrals.controller.js'
import { ReferralsService } from './referrals.service.js'
import { ReferralsRepository } from './referrals.repository.js'
import {
  getMySummarySchema,
  getMyHistorySchema,
  listAllAdminSchema,
  getAdminSummarySchema,
} from './referrals.schema.js'

/**
 * Referrals customer-facing routes plugin
 * Prefix: /api/v1/referrals
 */
export default async function referralsRoutes(fastify) {
  const repository = new ReferralsRepository()
  const service = new ReferralsService(repository)
  const controller = new ReferralsController(service)

  fastify.get('/me', {
    schema: getMySummarySchema,
    preHandler: [fastify.authenticate],
  }, controller.getMySummary.bind(controller))

  fastify.get('/me/history', {
    schema: getMyHistorySchema,
    preHandler: [fastify.authenticate],
  }, controller.getMyHistory.bind(controller))
}

/**
 * Referrals admin monitoring routes plugin — platform-wide, read-only.
 * Prefix: /api/v1/admin/referrals
 */
export async function adminReferralsRoutes(fastify) {
  const repository = new ReferralsRepository()
  const service = new ReferralsService(repository)
  const controller = new ReferralsController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listAllAdminSchema }, controller.listAllAdmin.bind(controller))
  fastify.get('/summary', { schema: getAdminSummarySchema }, controller.getAdminSummary.bind(controller))
}
