import { success, error } from '../../../utils/apiResponse.js'
import {
  LifecycleNotificationService, LifecycleRequestError, lifecycleNotifications,
} from '../../lifecycle-notifications/lifecycle-notifications.service.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import {
  eventParamSchema, saveEventSchema, previewSchema, testSchema, logSchema,
} from './lifecycle-notifications.schema.js'

/**
 * Admin API for the "Order Lifecycle" tab: view / edit / reset every automatic
 * order notification, preview it, test it, and read the delivery audit trail.
 * Prefix: /api/v1/admin/notification-lifecycle
 */
export default async function adminLifecycleRoutes(fastify) {
  const svc = lifecycleNotifications()

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  const guarded = (fn) => async (request, reply) => {
    try {
      return await fn(request, reply)
    } catch (err) {
      if (err instanceof LifecycleRequestError) {
        return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send(error(err.message, err.code))
      }
      throw err
    }
  }

  fastify.get('/events', guarded(async () => success(await svc.listTemplates(), 'Lifecycle notifications fetched')))

  fastify.put('/events/:eventKey', { schema: saveEventSchema }, guarded(async (request) => {
    const saved = await svc.saveTemplate(request.params.eventKey, request.body, request.user.id)
    logAdminActivity(request.user.id, 'UPDATE_LIFECYCLE_TEMPLATE', 'notification_event', request.params.eventKey, null, null, request.ip)
    return success(saved, 'Saved')
  }))

  fastify.post('/events/:eventKey/reset', { schema: eventParamSchema }, guarded(async (request) => {
    const restored = await svc.resetTemplate(request.params.eventKey)
    logAdminActivity(request.user.id, 'RESET_LIFECYCLE_TEMPLATE', 'notification_event', request.params.eventKey, null, null, request.ip)
    return success(restored, 'Restored the default')
  }))

  fastify.post('/events/:eventKey/preview', { schema: previewSchema }, guarded(async (request) =>
    success(svc.preview(request.params.eventKey, request.body || {}), 'Preview')))

  fastify.post('/events/:eventKey/test', { schema: testSchema }, guarded(async (request) => {
    const push = await svc.sendTest(request.params.eventKey, request.body.userId)
    const status = push.configured === false ? 'NOT_CONFIGURED'
      : !push.devices ? 'NO_DEVICE'
      : push.sent > 0 ? 'SENT'
      : push.invalid === push.devices ? 'INVALID_TOKEN' : 'FAILED'
    return success({ status, devices: push.devices || 0, sent: push.sent || 0 }, 'Test processed')
  }))

  fastify.get('/log', { schema: logSchema }, guarded(async (request) =>
    success(await svc.listLog(request.query), 'Log fetched')))
}

export { LifecycleNotificationService }
