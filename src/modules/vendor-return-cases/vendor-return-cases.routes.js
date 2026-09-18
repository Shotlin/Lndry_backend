import { query } from '../../config/database.js'
import { VendorReturnCasesController } from './vendor-return-cases.controller.js'
import { VendorReturnCasesService } from './vendor-return-cases.service.js'
import { VendorReturnCasesRepository } from './vendor-return-cases.repository.js'
import { requestReturnCaseSchema, decideReturnCaseSchema, listReturnCasesSchema } from './vendor-return-cases.schema.js'

/**
 * Vendor-facing return case routes — mounted at /api/v1/vendor/return-cases.
 */
export default async function vendorReturnCasesRoutes(fastify) {
  const service = new VendorReturnCasesService(new VendorReturnCasesRepository())
  const controller = new VendorReturnCasesController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to return cases', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listReturnCasesSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: requestReturnCaseSchema }, controller.request.bind(controller))
  fastify.post('/:id/decide', { schema: decideReturnCaseSchema }, controller.decide.bind(controller))
}
