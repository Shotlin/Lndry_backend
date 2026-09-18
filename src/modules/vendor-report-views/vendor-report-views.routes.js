import { query } from '../../config/database.js'
import { VendorReportViewsController } from './vendor-report-views.controller.js'
import { VendorReportViewsService } from './vendor-report-views.service.js'
import { VendorReportViewsRepository } from './vendor-report-views.repository.js'
import { listReportViewsSchema, createReportViewSchema, deleteReportViewSchema } from './vendor-report-views.schema.js'

/**
 * Vendor-facing saved report view routes — mounted at /api/v1/vendor/report-views.
 */
export default async function vendorReportViewsRoutes(fastify) {
  const service = new VendorReportViewsService(new VendorReportViewsRepository())
  const controller = new VendorReportViewsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to report views', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listReportViewsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createReportViewSchema }, controller.create.bind(controller))
  fastify.delete('/:id', { schema: deleteReportViewSchema }, controller.remove.bind(controller))
}
