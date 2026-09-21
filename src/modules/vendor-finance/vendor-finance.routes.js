import { loadVendorActor } from '../../middlewares/vendor-permission.js'
import { VendorFinanceController } from './vendor-finance.controller.js'
import { VendorFinanceService } from './vendor-finance.service.js'
import { VendorFinanceRepository } from './vendor-finance.repository.js'
import { financeOverviewSchema, financeStatutorySchema } from './vendor-finance.schema.js'

/**
 * Vendor finance reports — mounted at /api/v1/vendor/finance.
 *
 * Money reports (sales, GST, collections) are an owner area, like payouts and store settings: staff and
 * captains are refused. Which business the report is about comes from the caller's own roster record,
 * never from anything in the request, so one vendor can never read another's figures.
 */
export default async function vendorFinanceRoutes(fastify) {
  const service = new VendorFinanceService(new VendorFinanceRepository())
  const controller = new VendorFinanceController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    if (actor.role !== 'VENDOR_OWNER') {
      return reply.code(403).send({ success: false, message: 'Finance reports are available to the shop owner.', code: 'OWNER_ONLY' })
    }
    request.vendorId = actor.vendorId
  })

  fastify.get('/overview', { schema: financeOverviewSchema }, controller.overview.bind(controller))
  fastify.get('/statutory', { schema: financeStatutorySchema }, controller.statutory.bind(controller))
}
