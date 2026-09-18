import { query } from '../../config/database.js'
import { VendorServicePackagesController } from './vendor-service-packages.controller.js'
import { VendorServicePackagesService } from './vendor-service-packages.service.js'
import { VendorServicePackagesRepository } from './vendor-service-packages.repository.js'
import {
  listServicePackagesSchema, createServicePackageSchema, purchasePackageSchema,
  addPackagePaymentSchema, redeemPackageSchema, listCustomerPackagesSchema,
} from './vendor-service-packages.schema.js'

/**
 * Vendor-facing service package routes — mounted at
 * /api/v1/vendor/service-packages.
 */
export default async function vendorServicePackagesRoutes(fastify) {
  const service = new VendorServicePackagesService(new VendorServicePackagesRepository())
  const controller = new VendorServicePackagesController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to service packages', code: 'FORBIDDEN' })
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

  fastify.get('/', { schema: listServicePackagesSchema }, controller.listDefinitions.bind(controller))
  fastify.post('/', { schema: createServicePackageSchema }, controller.createDefinition.bind(controller))
  fastify.post('/purchase', { schema: purchasePackageSchema }, controller.purchase.bind(controller))
  fastify.post('/:id/payments', { schema: addPackagePaymentSchema }, controller.addPayment.bind(controller))
  fastify.post('/:id/redeem', { schema: redeemPackageSchema }, controller.redeem.bind(controller))
  fastify.get('/customers/:customerUserId', { schema: listCustomerPackagesSchema }, controller.listForCustomer.bind(controller))
}
