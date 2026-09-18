import { query } from '../../config/database.js'
import { VendorPosDashboardController } from './vendor-pos-dashboard.controller.js'
import { VendorPosDashboardService } from './vendor-pos-dashboard.service.js'
import { VendorPosDashboardRepository } from './vendor-pos-dashboard.repository.js'
import { posDashboardSchema, exportCounterSalesCsvSchema, posSearchSchema } from './vendor-pos-dashboard.schema.js'

/**
 * Vendor-facing POS dashboard/export/search routes — Tier 4 of the
 * POS-parity initiative, mounted at /api/v1/vendor/pos.
 */
export default async function vendorPosDashboardRoutes(fastify) {
  const service = new VendorPosDashboardService(new VendorPosDashboardRepository())
  const controller = new VendorPosDashboardController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to the POS dashboard', code: 'FORBIDDEN' })
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

  fastify.get('/dashboard', { schema: posDashboardSchema }, controller.dashboard.bind(controller))
  fastify.get('/counter-sales/export', { schema: exportCounterSalesCsvSchema }, controller.exportCsv.bind(controller))
  fastify.get('/search', { schema: posSearchSchema }, controller.search.bind(controller))
}
