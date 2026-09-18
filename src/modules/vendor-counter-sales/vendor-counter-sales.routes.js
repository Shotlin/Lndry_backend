import { query } from '../../config/database.js'
import { VendorCounterSalesController } from './vendor-counter-sales.controller.js'
import { VendorCounterSalesService } from './vendor-counter-sales.service.js'
import { VendorCounterSalesRepository } from './vendor-counter-sales.repository.js'
import { quoteCounterSaleSchema, bookCounterSaleSchema } from './vendor-counter-sales.schema.js'

/**
 * Vendor-facing counter-sale (walk-in checkout) routes — mounted at
 * /api/v1/vendor/counter-sales.
 */
export default async function vendorCounterSalesRoutes(fastify) {
  const service = new VendorCounterSalesService(new VendorCounterSalesRepository())
  const controller = new VendorCounterSalesController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to counter sales', code: 'FORBIDDEN' })
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

  fastify.post('/quote', { schema: quoteCounterSaleSchema }, controller.quote.bind(controller))
  fastify.post('/', { schema: bookCounterSaleSchema }, controller.book.bind(controller))
}
