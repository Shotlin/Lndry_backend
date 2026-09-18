import { query } from '../../config/database.js'
import { VendorExpensesController } from './vendor-expenses.controller.js'
import { VendorExpensesService } from './vendor-expenses.service.js'
import { VendorExpensesRepository } from './vendor-expenses.repository.js'
import { createExpenseSchema, updateExpenseSchema, cancelExpenseSchema, listExpensesSchema } from './vendor-expenses.schema.js'

/**
 * Vendor-facing expense-tracking routes — mounted at /api/v1/vendor/expenses.
 */
export default async function vendorExpensesRoutes(fastify) {
  const service = new VendorExpensesService(new VendorExpensesRepository())
  const controller = new VendorExpensesController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to expenses', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listExpensesSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createExpenseSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateExpenseSchema }, controller.update.bind(controller))
  fastify.post('/:id/cancel', { schema: cancelExpenseSchema }, controller.cancel.bind(controller))
}
