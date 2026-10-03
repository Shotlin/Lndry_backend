import { success, error } from '../../utils/apiResponse.js'
import { loadVendorActor, requireVendorPermission } from '../../middlewares/vendor-permission.js'
import { VendorImportsService } from './vendor-imports.service.js'

/**
 * Spreadsheet imports for the counter — mounted at /api/v1/vendor/imports.
 * Needs the same permission as editing the catalogue. No body schemas on
 * purpose (the app's AJV strips undeclared fields) — the service validates.
 */
export default async function vendorImportsRoutes(fastify) {
  const service = new VendorImportsService()

  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    if (actor.role === 'VENDOR_RIDER') return reply.code(403).send({ success: false, message: 'Captains do not have access to imports', code: 'FORBIDDEN' })
    request.vendorId = actor.vendorId
  })
  fastify.addHook('preHandler', requireVendorPermission('vendor_services.update', 'vendor_services.create'))

  const actorOf = (request) => ({ userId: request.user?.id ?? null, role: request.user?.role ?? null, vendorId: request.vendorId, ip: request.ip ?? null, userAgent: request.headers?.['user-agent'] ?? null })
  const reply = (res, result, message) => {
    if (!result.success) return res.code(result.status || 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    const { success: _ok, ...data } = result
    return res.send(success(data, message))
  }

  fastify.get('/', async (request, res) => res.send(success({ jobs: await service.listJobs(request.vendorId, request.query?.type) })))
  fastify.post('/preview', async (request, res) => reply(res, await service.preview(request.vendorId, request.body || {}), 'Rows checked'))
  fastify.post('/customers', async (request, res) => reply(res, await service.commit(request.vendorId, actorOf(request), 'customers', request.body || {}), 'Customers imported'))
  fastify.post('/prices', async (request, res) => reply(res, await service.commit(request.vendorId, actorOf(request), 'prices', request.body || {}), 'Prices imported'))
}
