import { query } from '../../config/database.js'
import { VendorPrintJobsController } from './vendor-print-jobs.controller.js'
import { VendorPrintJobsService } from './vendor-print-jobs.service.js'
import { VendorPrintJobsRepository } from './vendor-print-jobs.repository.js'
import { createPrintJobSchema, updatePrintJobStatusSchema, listPrintJobsForOrderSchema } from './vendor-print-jobs.schema.js'

/**
 * Vendor-facing print job routes — mounted at /api/v1/vendor/print-jobs.
 */
export default async function vendorPrintJobsRoutes(fastify) {
  const service = new VendorPrintJobsService(new VendorPrintJobsRepository())
  const controller = new VendorPrintJobsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to print jobs', code: 'FORBIDDEN' })
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

  fastify.post('/', { schema: createPrintJobSchema }, controller.create.bind(controller))
  fastify.put('/:id/status', { schema: updatePrintJobStatusSchema }, controller.markStatus.bind(controller))
  fastify.get('/order/:orderId', { schema: listPrintJobsForOrderSchema }, controller.listForOrder.bind(controller))
}
