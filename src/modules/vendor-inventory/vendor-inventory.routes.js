import { loadVendorActor, requireVendorPermission } from '../../middlewares/vendor-permission.js'
import { VendorInventoryController } from './vendor-inventory.controller.js'
import { VendorInventoryService } from './vendor-inventory.service.js'
import { VendorInventoryRepository } from './vendor-inventory.repository.js'
import {
  listInventorySchema,
  createInventorySchema,
  updateInventorySchema,
  adjustInventorySchema,
  removeInventorySchema,
} from './vendor-inventory.schema.js'

/**
 * Operational supplies — mounted at /api/v1/vendor/inventory.
 * Viewing needs vendor_inventory.view; every change needs vendor_inventory.manage.
 * The owner has both. Captains are refused by the permission guard.
 */
export default async function vendorInventoryRoutes(fastify) {
  const service = new VendorInventoryService(new VendorInventoryRepository())
  const controller = new VendorInventoryController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  // Which vendor's supplies this is comes from the caller's own roster record,
  // never from anything in the request.
  fastify.addHook('preHandler', async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) {
      return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    }
    request.vendorId = actor.vendorId
  })

  const canView = requireVendorPermission('vendor_inventory.view')
  const canManage = requireVendorPermission('vendor_inventory.manage')

  fastify.get('/', { schema: listInventorySchema, preHandler: [canView] }, controller.list.bind(controller))
  fastify.post('/', { schema: createInventorySchema, preHandler: [canManage] }, controller.create.bind(controller))
  fastify.patch('/:id', { schema: updateInventorySchema, preHandler: [canManage] }, controller.update.bind(controller))
  fastify.post('/:id/adjust', { schema: adjustInventorySchema, preHandler: [canManage] }, controller.adjust.bind(controller))
  fastify.delete('/:id', { schema: removeInventorySchema, preHandler: [canManage] }, controller.remove.bind(controller))
}
