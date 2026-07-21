import { OrdersController } from './orders.controller.js'
import { OrdersService } from './orders.service.js'
import { OrdersRepository } from './orders.repository.js'
import {
  placeOrderSchema,
  listOrdersSchema,
  getOrderSchema,
  activeOrderSchema,
  cancelOrderSchema,
  reorderSchema,
  adminListOrdersSchema,
  adminUpdateStatusSchema,
  adminAssignRiderSchema,
  prepareOrderSchema,
} from './orders.schema.js'

/**
 * Orders routes plugin
 * Prefix: /api/v1/orders
 * All routes require authentication
 */
export default async function ordersRoutes(fastify) {
  const repository = new OrdersRepository()
  const service = new OrdersService(repository, fastify)
  const controller = new OrdersController(service)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // POST /prepare — Prepare a new order draft before payment
  fastify.post('/prepare', {
    schema: prepareOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.prepare.bind(controller))

  // POST / — Place a new order (supports legacy cart or new LNDRY draft checkout)
  fastify.post('/', {
    schema: placeOrderSchema,
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (request.body?.order_draft_id || request.body?.orderDraftId) {
      return controller.placeOrderFromDraft(request, reply)
    }
    return controller.placeOrder(request, reply)
  })

  // GET / — List user orders
  fastify.get('/', {
    schema: listOrdersSchema,
    preHandler: [fastify.authenticate],
  }, controller.list.bind(controller))

  // GET /active — Get current active order
  fastify.get('/active', {
    schema: activeOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.getActive.bind(controller))

  // GET /:id — Get order details
  fastify.get('/:id', {
    schema: getOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.getById.bind(controller))

  // POST /:id/cancel — Cancel an order
  fastify.post('/:id/cancel', {
    schema: cancelOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.cancel.bind(controller))

  // POST /:id/reorder — Re-order items
  fastify.post('/:id/reorder', {
    schema: reorderSchema,
    preHandler: [fastify.authenticate],
  }, controller.reorder.bind(controller))

  // GET /:id/invoice — Download PDF invoice
  fastify.get('/:id/invoice', {
    schema: {
      tags: ['Orders'],
      summary: 'Download order invoice as PDF',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.getInvoice.bind(controller))

  // GET /:id/otp — Retrieve active OTP for customer
  fastify.get('/:id/otp', {
    schema: {
      tags: ['Orders'],
      summary: 'Get active OTP for customer order',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      querystring: {
        type: 'object',
        required: ['purpose'],
        properties: { purpose: { type: 'string', enum: ['PICKUP', 'DELIVERY'] } },
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.getOtp.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // GET /admin/all — List all orders [ADMIN]
  fastify.get('/admin/all', {
    schema: adminListOrdersSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.adminList.bind(controller))

  // PUT /admin/:id/status — Update order status [ADMIN]
  fastify.put('/admin/:id/status', {
    schema: adminUpdateStatusSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.adminUpdateStatus.bind(controller))

  // PUT /admin/:id/rider — Assign rider [ADMIN]
  fastify.put('/admin/:id/rider', {
    schema: adminAssignRiderSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.adminAssignRider.bind(controller))
}
