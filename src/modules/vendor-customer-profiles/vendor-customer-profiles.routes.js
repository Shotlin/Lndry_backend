import { success, error } from '../../utils/apiResponse.js'
import { loadVendorActor } from '../../middlewares/vendor-permission.js'
import { VendorCustomerProfilesService } from './vendor-customer-profiles.service.js'

const idParams = { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string', format: 'uuid' } } }
const addressParams = { type: 'object', required: ['customerId', 'addressId'], properties: { customerId: { type: 'string', format: 'uuid' }, addressId: { type: 'string', format: 'uuid' } } }

/**
 * Vendor-private customer details — mounted at /api/v1/vendor/customer-profiles.
 * Any counter staff (not captains) may keep customer details; every row is
 * scoped to the caller's own vendor. No body schemas on purpose (the app's AJV
 * strips undeclared fields) — the service validates.
 */
export default async function vendorCustomerProfilesRoutes(fastify) {
  const service = new VendorCustomerProfilesService()

  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    if (actor.role === 'VENDOR_RIDER') return reply.code(403).send({ success: false, message: 'Captains do not have access to customer details', code: 'FORBIDDEN' })
    request.vendorId = actor.vendorId
  })

  const actorOf = (request) => ({ userId: request.user?.id ?? null, role: request.user?.role ?? null, vendorId: request.vendorId, ip: request.ip ?? null, userAgent: request.headers?.['user-agent'] ?? null })
  const reply = (res, result, message, status = 200) => {
    if (!result.success) return res.code(result.status || 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    const { success: _ok, ...data } = result
    return res.code(status).send(success(data, message))
  }

  fastify.get('/:customerId', { schema: { params: idParams } }, async (req, res) => reply(res, await service.get(req.vendorId, req.params.customerId)))
  fastify.patch('/:customerId', { schema: { params: idParams } }, async (req, res) => reply(res, await service.update(req.vendorId, actorOf(req), req.params.customerId, req.body || {}), 'Customer updated'))
  fastify.get('/:customerId/addresses', { schema: { params: idParams } }, async (req, res) => reply(res, await service.listAddresses(req.vendorId, req.params.customerId)))
  fastify.post('/:customerId/addresses', { schema: { params: idParams } }, async (req, res) => reply(res, await service.createAddress(req.vendorId, actorOf(req), req.params.customerId, req.body || {}), 'Address saved', 201))
  fastify.patch('/:customerId/addresses/:addressId', { schema: { params: addressParams } }, async (req, res) => reply(res, await service.updateAddress(req.vendorId, actorOf(req), req.params.customerId, req.params.addressId, req.body || {}), 'Address updated'))
  fastify.post('/:customerId/addresses/:addressId/archive', { schema: { params: addressParams } }, async (req, res) => reply(res, await service.archiveAddress(req.vendorId, actorOf(req), req.params.customerId, req.params.addressId), 'Address removed'))
}
