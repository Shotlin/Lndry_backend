import { query } from '../../config/database.js'
import { VendorCashShiftsController } from './vendor-cash-shifts.controller.js'
import { VendorCashShiftsService } from './vendor-cash-shifts.service.js'
import { VendorCashShiftsRepository } from './vendor-cash-shifts.repository.js'
import { getCurrentCashShiftSchema, listCashShiftsSchema, openCashShiftSchema, closeCashShiftSchema } from './vendor-cash-shifts.schema.js'

/**
 * Vendor-facing counter cash-drawer routes — mounted at
 * /api/v1/vendor/cash-shifts (shares the /vendor prefix with
 * store-orders.routes.js and others already registered there).
 */
export default async function vendorCashShiftsRoutes(fastify) {
  const service = new VendorCashShiftsService(new VendorCashShiftsRepository())
  const controller = new VendorCashShiftsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to cash shifts', code: 'FORBIDDEN' })
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

  fastify.get('/current', { schema: getCurrentCashShiftSchema }, controller.getCurrent.bind(controller))
  fastify.get('/', { schema: listCashShiftsSchema }, controller.list.bind(controller))
  fastify.post('/open', { schema: openCashShiftSchema }, controller.open.bind(controller))
  fastify.post('/:id/close', { schema: closeCashShiftSchema }, controller.close.bind(controller))
}
