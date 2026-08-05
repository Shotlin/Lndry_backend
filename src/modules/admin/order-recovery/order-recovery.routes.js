import { OrderRecoveryController } from './order-recovery.controller.js'
import { OrderRecoveryService } from './order-recovery.service.js'
import { OrderRecoveryRepository } from './order-recovery.repository.js'
import {
  listIncompleteOrdersSchema,
  incompleteOrdersSummarySchema,
  getIncompleteOrderSchema,
  sendRecoveryReminderSchema,
  issueRecoveryCouponSchema,
} from './order-recovery.schema.js'

/**
 * Order Recovery admin routes plugin
 * Prefix: /api/v1/admin/incomplete-orders
 */
export default async function orderRecoveryRoutes(fastify) {
  const repository = new OrderRecoveryRepository()
  const service = new OrderRecoveryService(repository)
  const controller = new OrderRecoveryController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listIncompleteOrdersSchema }, controller.listAll.bind(controller))
  fastify.get('/summary', { schema: incompleteOrdersSummarySchema }, controller.summary.bind(controller))
  fastify.get('/:id', { schema: getIncompleteOrderSchema }, controller.getDetail.bind(controller))
  fastify.post('/:id/notify', { schema: sendRecoveryReminderSchema }, controller.sendReminder.bind(controller))
  fastify.post('/:id/coupon', { schema: issueRecoveryCouponSchema }, controller.issueCoupon.bind(controller))
}
