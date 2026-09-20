import { success, error } from '../../utils/apiResponse.js'
import { loadVendorActor, requireVendorPermission } from '../../middlewares/vendor-permission.js'
import { VendorPosCatalogueService } from './vendor-pos-catalogue.service.js'

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

/**
 * POS (in-store) catalogue — mounted at /api/v1/vendor/pos-catalogue.
 * Every request is scoped to the caller's own vendor; nothing here reads or
 * writes another vendor's rows or the marketplace catalogue. No body schemas
 * on purpose (the app's AJV strips undeclared fields) — the service validates.
 */
export default async function vendorPosCatalogueRoutes(fastify) {
  const service = new VendorPosCatalogueService()

  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    if (actor.role === 'VENDOR_RIDER') return reply.code(403).send({ success: false, message: 'Captains do not have access to the POS catalogue', code: 'FORBIDDEN' })
    request.vendorId = actor.vendorId
  })

  // Anyone on the shop's roster can read (the counter needs it to book); changes need catalogue permission.
  const canEdit = requireVendorPermission('vendor_services.update', 'vendor_services.create')
  const withImage = { preHandler: canEdit }

  const actorOf = (request) => ({ userId: request.user?.id ?? null, role: request.user?.role ?? null, vendorId: request.vendorId, ip: request.ip ?? null, userAgent: request.headers?.['user-agent'] ?? null })
  const reply = (res, result, message, status = 200) => {
    if (!result.success) return res.code(result.status || 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    const { success: _ok, ...data } = result
    return res.code(status).send(success(data, message))
  }

  fastify.get('/', async (request, res) => res.send(success(await service.getCatalogue(request.vendorId))))
  fastify.post('/sync', { preHandler: canEdit }, async (request, res) => res.send(success(await service.sync(request.vendorId), 'Catalogue synced from LNDRY')))
  fastify.get('/marketplace-rates', async (request, res) => res.send(success(await service.listMarketplaceLinkedRates(request.vendorId))))

  fastify.post('/categories', withImage, async (request, res) => reply(res, await service.createCategory(request.vendorId, actorOf(request), request.body || {}), 'Category created', 201))
  fastify.put('/categories/:id', { ...withImage, schema: { params: idParams } }, async (request, res) => reply(res, await service.updateCategory(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Category updated'))
  fastify.post('/services', withImage, async (request, res) => reply(res, await service.createService(request.vendorId, actorOf(request), request.body || {}), 'Service created', 201))
  fastify.put('/services/:id', { ...withImage, schema: { params: idParams } }, async (request, res) => reply(res, await service.updateService(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Service updated'))
  fastify.post('/garments', withImage, async (request, res) => reply(res, await service.createGarment(request.vendorId, actorOf(request), request.body || {}), 'Garment created', 201))
  fastify.put('/garments/:id', { ...withImage, schema: { params: idParams } }, async (request, res) => reply(res, await service.updateGarment(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Garment updated'))
  fastify.post('/prices', { preHandler: canEdit }, async (request, res) => reply(res, await service.createPrice(request.vendorId, actorOf(request), request.body || {}), 'Price created', 201))
  fastify.put('/prices/:id', { preHandler: canEdit, schema: { params: idParams } }, async (request, res) => reply(res, await service.updatePrice(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Price updated'))
  fastify.post('/taxes', { preHandler: canEdit }, async (request, res) => reply(res, await service.saveTaxRule(request.vendorId, actorOf(request), null, request.body || {}), 'Tax rule created', 201))
  fastify.put('/taxes/:id', { preHandler: canEdit, schema: { params: idParams } }, async (request, res) => reply(res, await service.saveTaxRule(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Tax rule updated'))
}
