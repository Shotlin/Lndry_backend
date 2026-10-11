import { success, error } from '../../utils/apiResponse.js'
import { loadVendorActor } from '../../middlewares/vendor-permission.js'
import { VendorAppModeService } from './vendor-app-mode.service.js'

/**
 * Vendor App modes + POS onboarding — mounted at /api/v1/vendor.
 *   GET   /app-mode                       which modes this person may use (works before any vendor exists)
 *   POST  /pos-onboarding/start           begin POS setup (creates a POS-only shop for a brand-new user)
 *   GET   /pos-onboarding                 saved answers + next step (resume)
 *   PATCH /pos-onboarding                 { step, data }   save one step
 *   POST  /pos-onboarding/complete        finish; applies the starter price list if chosen
 * No body schemas on purpose (the app's AJV strips undeclared fields) — the service validates.
 */
export default async function vendorAppModeRoutes(fastify) {
  const service = new VendorAppModeService()

  fastify.addHook('preHandler', fastify.authenticate)

  const metaOf = (request) => ({ ip: request.ip ?? null, userAgent: request.headers?.['user-agent'] ?? null })
  const send = (res, result, message, status = 200) => {
    if (!result.success) return res.code(result.status || 400).send({ ...error(result.message, result.code || 'VALIDATION_ERROR'), ...(result.missingSteps ? { missing_steps: result.missingSteps } : {}) })
    const { success: _ok, ...data } = result
    return res.code(status).send(success(data, message))
  }

  // Owner-only guard for everything that edits the shop's POS setup.
  const ownerOnly = async (request, reply) => {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return reply.code(403).send(error('Start POS setup first.', 'POS_NOT_STARTED'))
    if (actor.role !== 'VENDOR_OWNER') return reply.code(403).send(error('Only the shop owner can change POS setup.', 'NOT_OWNER'))
    request.vendorId = actor.vendorId
    request.vendorActor = actor
  }
  const actorOf = (request) => ({ userId: request.user?.id ?? null, role: 'VENDOR_OWNER', vendorId: request.vendorId, ...metaOf(request) })

  fastify.get('/app-mode', async (request, res) => {
    res.header('Cache-Control', 'no-store')
    return send(res, await service.getAppMode(request.user))
  })

  fastify.post('/pos-onboarding/start', async (request, res) => {
    const result = await service.start(request.user, metaOf(request))
    return send(res, result, result.created ? 'POS shop created' : 'POS setup started', result.created ? 201 : 200)
  })

  fastify.get('/pos-onboarding', { preHandler: ownerOnly }, async (request, res) => {
    res.header('Cache-Control', 'no-store')
    return send(res, await service.getOnboarding(request.vendorId))
  })

  fastify.patch('/pos-onboarding', { preHandler: ownerOnly }, async (request, res) =>
    send(res, await service.saveStep(request.vendorId, actorOf(request), request.body?.step, request.body?.data), 'Step saved'))

  fastify.post('/pos-onboarding/complete', { preHandler: ownerOnly }, async (request, res) =>
    send(res, await service.complete(request.vendorId, actorOf(request)), 'POS is ready'))
}
