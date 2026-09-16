import { ReferralsController } from './referrals.controller.js'
import { ReferralsService } from './referrals.service.js'
import { ReferralsRepository } from './referrals.repository.js'
import { getMySummarySchema, getMyHistorySchema } from './referrals.schema.js'

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
