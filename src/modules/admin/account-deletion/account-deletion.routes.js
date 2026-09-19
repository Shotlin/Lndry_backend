import { AccountDeletionController } from './account-deletion.controller.js'
import { AccountDeletionService } from './account-deletion.service.js'
import { AccountDeletionRepository } from './account-deletion.repository.js'
import { requireStepUp } from '../../../middlewares/requireStepUp.js'
import {
  requestAccountDeletionSchema,
  myAccountDeletionSchema,
  listAccountDeletionSchema,
  approveAccountDeletionSchema,
  rejectAccountDeletionSchema,
} from './account-deletion.schema.js'

const build = () =>
  new AccountDeletionController(new AccountDeletionService(new AccountDeletionRepository()))

/**
 * Customer-facing routes, registered inside customers.routes.js
 * (GET/POST /api/v1/customer/account-deletion).
 */
export async function customerAccountDeletionRoutes(fastify) {
  const controller = build()
  const preHandler = [fastify.authenticate, fastify.authorize(['CUSTOMER'])]

  fastify.post('/', {
    schema: requestAccountDeletionSchema,
    preHandler,
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, controller.requestDeletion.bind(controller))

  fastify.get('/', { schema: myAccountDeletionSchema, preHandler }, controller.getMine.bind(controller))
}

/**
 * Admin routes plugin
 * Prefix: /api/v1/admin/account-deletion-requests
 *
 * Approving is irreversible (personal data is wiped after 30 days), so it uses
 * the same step-up gate as the other high-risk admin actions — a no-op while
 * two-step verification is switched off.
 */
export default async function accountDeletionAdminRoutes(fastify) {
  const controller = build()
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listAccountDeletionSchema, preHandler: adminAuth }, controller.list.bind(controller))
  fastify.post('/:id/approve', {
    schema: approveAccountDeletionSchema,
    preHandler: [...adminAuth, requireStepUp],
  }, controller.approve.bind(controller))
  fastify.post('/:id/reject', {
    schema: rejectAccountDeletionSchema,
    preHandler: adminAuth,
  }, controller.reject.bind(controller))
}
