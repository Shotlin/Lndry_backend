import { query } from '../../config/database.js'
import { VendorProductionTasksController } from './vendor-production-tasks.controller.js'
import { VendorProductionTasksService } from './vendor-production-tasks.service.js'
import { VendorProductionTasksRepository } from './vendor-production-tasks.repository.js'
import { listProductionTasksSchema, assignProductionTaskSchema, startProductionTaskSchema } from './vendor-production-tasks.schema.js'

/**
 * Vendor-facing production task routes — mounted at
 * /api/v1/vendor/production-tasks. Tasks themselves are created/completed
 * automatically by vendor-garment-units' scan(), not created directly here.
 */
export default async function vendorProductionTasksRoutes(fastify) {
  const service = new VendorProductionTasksService(new VendorProductionTasksRepository())
  const controller = new VendorProductionTasksController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to production tasks', code: 'FORBIDDEN' })
    }
  })

  fastify.addHook('preHandler', async (request, reply) => {
    const { rows } = await query(
      `SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [request.user.id]
    )
    if (!rows.length) {
      return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    }
    request.vendorId = rows[0].vendor_id
  })

  fastify.get('/', { schema: listProductionTasksSchema }, controller.list.bind(controller))
  fastify.put('/:id/assign', { schema: assignProductionTaskSchema }, controller.assign.bind(controller))
  fastify.post('/:id/start', { schema: startProductionTaskSchema }, controller.start.bind(controller))
}
