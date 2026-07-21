import { AdminPaymentsController } from './payments.controller.js'
import { listPaymentsSchema } from './payments.schema.js'

/**
 * Admin payments routes
 * Prefix: /api/v1/admin/payments
 */
export default async function adminPaymentsRoutes(fastify) {
  const ctrl = new AdminPaymentsController()
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listPaymentsSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
}
