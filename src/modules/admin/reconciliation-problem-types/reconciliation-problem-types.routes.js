import { ReconciliationProblemTypesController } from './reconciliation-problem-types.controller.js'
import { ReconciliationProblemTypesService } from './reconciliation-problem-types.service.js'
import { ReconciliationProblemTypesRepository } from './reconciliation-problem-types.repository.js'
import {
  listReconciliationProblemTypesSchema,
  activeReconciliationProblemTypesSchema,
  createReconciliationProblemTypeSchema,
  updateReconciliationProblemTypeSchema,
  deleteReconciliationProblemTypeSchema,
} from './reconciliation-problem-types.schema.js'

/**
 * Vendor-facing routes plugin — mounted separately (see app.js) at
 * /api/v1/reconciliation-problem-types, NOT under /admin. This is what the
 * vendor app's reconcile ("re-evaluation") sheet fetches to populate its
 * problem picker — any authenticated user works (vendor employees today,
 * nothing stops a future customer-facing use), same pattern as
 * cart-milestones' customer-facing /active route.
 */
export async function vendorReconciliationProblemTypesRoutes(fastify) {
  const repository = new ReconciliationProblemTypesRepository()
  const service = new ReconciliationProblemTypesService(repository)
  const controller = new ReconciliationProblemTypesController(service)

  fastify.get('/active', {
    schema: activeReconciliationProblemTypesSchema,
    preHandler: [fastify.authenticate],
  }, controller.listActive.bind(controller))
}

/**
 * Reconciliation Problem Types admin routes plugin
 * Prefix: /api/v1/admin/reconciliation-problem-types
 */
export default async function reconciliationProblemTypesRoutes(fastify) {
  const repository = new ReconciliationProblemTypesRepository()
  const service = new ReconciliationProblemTypesService(repository)
  const controller = new ReconciliationProblemTypesController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listReconciliationProblemTypesSchema }, controller.listAll.bind(controller))
  fastify.post('/', { schema: createReconciliationProblemTypeSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateReconciliationProblemTypeSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: deleteReconciliationProblemTypeSchema }, controller.delete.bind(controller))
}
