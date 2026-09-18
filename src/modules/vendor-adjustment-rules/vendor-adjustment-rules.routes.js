import { query } from '../../config/database.js'
import { VendorAdjustmentRulesController } from './vendor-adjustment-rules.controller.js'
import { VendorAdjustmentRulesService } from './vendor-adjustment-rules.service.js'
import { VendorAdjustmentRulesRepository } from './vendor-adjustment-rules.repository.js'
import { listAdjustmentRulesSchema, createAdjustmentRuleSchema, updateAdjustmentRuleSchema } from './vendor-adjustment-rules.schema.js'

/**
 * Vendor-facing charge/discount rule routes — mounted at
 * /api/v1/vendor/adjustment-rules/:kind (kind is 'charge' or 'discount').
 */
export default async function vendorAdjustmentRulesRoutes(fastify) {
  const service = new VendorAdjustmentRulesService(new VendorAdjustmentRulesRepository())
  const controller = new VendorAdjustmentRulesController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to adjustment rules', code: 'FORBIDDEN' })
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

  fastify.get('/:kind', { schema: listAdjustmentRulesSchema }, controller.list.bind(controller))
  fastify.post('/:kind', { schema: createAdjustmentRuleSchema }, controller.create.bind(controller))
  fastify.put('/:kind/:id', { schema: updateAdjustmentRuleSchema }, controller.update.bind(controller))
}
