import { AdminRidersController } from './riders.controller.js'
import {
  listRidersSchema, riderIdSchema, riderEarningsSchema,
  createPayoutSchema, toggleSuspendSchema, approveRiderSchema, updateCommissionSchema, verifyDocumentSchema,
} from './riders.schema.js'
import { requirePermission } from '../../../middlewares/permission-check.js'

const ctrl = new AdminRidersController()

export default async function adminRiderRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  // Task 12.5: GET /api/v1/admin/riders — requires riders.view AND reports.global_view
  fastify.get('/', {
    schema: listRidersSchema,
    preHandler: [requirePermission('riders.view'), requirePermission('reports.global_view')],
  }, ctrl.list)

  fastify.get('/live-locations', ctrl.getLiveLocations)
  fastify.get('/:id', { schema: riderIdSchema }, ctrl.getDetail)
  fastify.get('/:id/earnings', { schema: riderEarningsSchema }, ctrl.getEarnings)
  fastify.get('/:id/payouts', { schema: riderIdSchema }, ctrl.getPayouts)
  fastify.post('/:id/payouts', { schema: createPayoutSchema }, ctrl.createPayout)
  fastify.put('/:id/suspend', { schema: toggleSuspendSchema }, ctrl.toggleSuspend)
  fastify.put('/:id/approve', { schema: approveRiderSchema }, ctrl.approveRider)
  fastify.put('/:id/commission', { schema: updateCommissionSchema }, ctrl.updateCommission)
  fastify.get('/:id/documents', { schema: riderIdSchema }, ctrl.getDocuments)
  fastify.put('/:id/documents/:documentId/verify', { schema: verifyDocumentSchema }, ctrl.verifyDocument)

  // Task 12.4: POST /api/v1/admin/riders/:riderId/approve — requires riders.approve
  fastify.post('/:id/approve', {
    schema: riderIdSchema,
    preHandler: [requirePermission('riders.approve')],
  }, ctrl.approveRiderStatus)
}
