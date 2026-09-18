import { query } from '../../config/database.js'
import { VendorRackProfilesController } from './vendor-rack-profiles.controller.js'
import { VendorRackProfilesService } from './vendor-rack-profiles.service.js'
import { VendorRackProfilesRepository } from './vendor-rack-profiles.repository.js'
import { listRackProfilesSchema, createRackProfileSchema, updateRackProfileSchema } from './vendor-rack-profiles.schema.js'

/**
 * Vendor-facing storage rack profile routes — mounted at
 * /api/v1/vendor/rack-profiles. Occupancy (which rack holds what right now)
 * is a later phase — depends on per-garment-unit tracking that doesn't
 * exist yet.
 */
export default async function vendorRackProfilesRoutes(fastify) {
  const service = new VendorRackProfilesService(new VendorRackProfilesRepository())
  const controller = new VendorRackProfilesController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to rack profiles', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listRackProfilesSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createRackProfileSchema }, controller.create.bind(controller))
  fastify.put('/:id', { schema: updateRackProfileSchema }, controller.update.bind(controller))
}
