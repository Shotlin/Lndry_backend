import { query } from '../../config/database.js'
import { VendorQualityClaimsController } from './vendor-quality-claims.controller.js'
import { VendorQualityClaimsService } from './vendor-quality-claims.service.js'
import { VendorQualityClaimsRepository } from './vendor-quality-claims.repository.js'
import { openQualityClaimSchema, resolveQualityClaimSchema, listQualityClaimsSchema, getQualityClaimSchema } from './vendor-quality-claims.schema.js'

/**
 * Vendor-facing quality claim routes — mounted at
 * /api/v1/vendor/quality-claims.
 */
export default async function vendorQualityClaimsRoutes(fastify) {
  const service = new VendorQualityClaimsService(new VendorQualityClaimsRepository())
  const controller = new VendorQualityClaimsController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to quality claims', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listQualityClaimsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: openQualityClaimSchema }, controller.open.bind(controller))
  fastify.get('/:id', { schema: getQualityClaimSchema }, controller.getDetail.bind(controller))
  fastify.post('/:id/resolve', { schema: resolveQualityClaimSchema }, controller.resolve.bind(controller))
}
