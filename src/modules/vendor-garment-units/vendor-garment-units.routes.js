import { query } from '../../config/database.js'
import { VendorGarmentUnitsController } from './vendor-garment-units.controller.js'
import { VendorGarmentUnitsService } from './vendor-garment-units.service.js'
import { VendorGarmentUnitsRepository } from './vendor-garment-units.repository.js'
import {
  generateGarmentUnitsSchema, listGarmentUnitsForOrderSchema, getGarmentUnitSchema,
  scanGarmentUnitSchema, reprintTagSchema, replaceTagSchema,
} from './vendor-garment-units.schema.js'

/**
 * Vendor-facing garment tag/scanning routes — mounted at
 * /api/v1/vendor/garment-units.
 */
export default async function vendorGarmentUnitsRoutes(fastify) {
  const service = new VendorGarmentUnitsService(new VendorGarmentUnitsRepository())
  const controller = new VendorGarmentUnitsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to garment units', code: 'FORBIDDEN' })
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

  fastify.post('/generate', { schema: generateGarmentUnitsSchema }, controller.generate.bind(controller))
  fastify.get('/order/:orderId', { schema: listGarmentUnitsForOrderSchema }, controller.listForOrder.bind(controller))
  fastify.get('/:id', { schema: getGarmentUnitSchema }, controller.getDetail.bind(controller))
  fastify.post('/scan', { schema: scanGarmentUnitSchema }, controller.scan.bind(controller))
  fastify.post('/:id/reprint-tag', { schema: reprintTagSchema }, controller.reprintTag.bind(controller))
  fastify.post('/:id/replace-tag', { schema: replaceTagSchema }, controller.replaceTag.bind(controller))
}
