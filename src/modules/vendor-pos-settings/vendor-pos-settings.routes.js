import { success, error } from '../../utils/apiResponse.js'
import { loadVendorActor, requireVendorPermission } from '../../middlewares/vendor-permission.js'
import { VendorPosSettingsService, OPERATIONAL_KEYS } from './vendor-pos-settings.service.js'

/**
 * Counter settings — mounted at /api/v1/vendor/pos-settings.
 * Everyone on the shop's roster except captains can read; shop configuration
 * can be changed by the owner or staff with catalogue permission, day-to-day
 * operating data (route runs) by any counter staff. No body schema on purpose
 * (the app's AJV strips undeclared fields) — the service validates.
 */
export default async function vendorPosSettingsRoutes(fastify) {
  const service = new VendorPosSettingsService()

  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    if (actor.role === 'VENDOR_RIDER') return reply.code(403).send({ success: false, message: 'Captains do not have access to counter settings', code: 'FORBIDDEN' })
    request.vendorId = actor.vendorId
  })

  const canConfigure = requireVendorPermission('vendor_services.update', 'vendor_services.create')
  const actorOf = (request) => ({ userId: request.user?.id ?? null, role: request.user?.role ?? null, vendorId: request.vendorId, ip: request.ip ?? null, userAgent: request.headers?.['user-agent'] ?? null })
  const reply = (res, result, message) => {
    if (!result.success) return res.code(result.status || 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    const { success: _ok, ...data } = result
    return res.send(success(data, message))
  }

  fastify.get('/', async (request, res) => {
    res.header('Cache-Control', 'no-store')
    return res.send(success({ settings: await service.listAll(request.vendorId) }))
  })
  fastify.get('/:key', async (request, res) => {
    res.header('Cache-Control', 'no-store')
    return reply(res, await service.get(request.vendorId, request.params.key))
  })
  fastify.put('/:key', async (request, res) => {
    if (!OPERATIONAL_KEYS.has(request.params.key)) {
      await canConfigure(request, res)
      if (res.sent) return
    }
    return reply(res, await service.put(request.vendorId, actorOf(request), request.params.key, request.body || {}), 'Setting saved')
  })
}
