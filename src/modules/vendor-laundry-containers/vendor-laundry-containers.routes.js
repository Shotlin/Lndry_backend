import { query } from '../../config/database.js'
import { VendorLaundryContainersController } from './vendor-laundry-containers.controller.js'
import { VendorLaundryContainersService } from './vendor-laundry-containers.service.js'
import { VendorLaundryContainersRepository } from './vendor-laundry-containers.repository.js'
import { generateContainersSchema, listContainersForOrderSchema, getContainerSchema, scanContainerSchema } from './vendor-laundry-containers.schema.js'

/**
 * Vendor-facing bag/container tag routes — mounted at
 * /api/v1/vendor/laundry-containers.
 */
export default async function vendorLaundryContainersRoutes(fastify) {
  const service = new VendorLaundryContainersService(new VendorLaundryContainersRepository())
  const controller = new VendorLaundryContainersController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to laundry containers', code: 'FORBIDDEN' })
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

  fastify.post('/generate', { schema: generateContainersSchema }, controller.generate.bind(controller))
  fastify.get('/order/:orderId', { schema: listContainersForOrderSchema }, controller.listForOrder.bind(controller))
  fastify.get('/:id', { schema: getContainerSchema }, controller.getDetail.bind(controller))
  fastify.post('/scan', { schema: scanContainerSchema }, controller.scan.bind(controller))
}
