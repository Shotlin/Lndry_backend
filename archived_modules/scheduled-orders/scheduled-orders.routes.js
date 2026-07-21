import { ScheduledOrdersController } from './scheduled-orders.controller.js'
import { ScheduledOrdersService } from './scheduled-orders.service.js'
import { ScheduledOrdersRepository } from './scheduled-orders.repository.js'

/**
 * Scheduled Orders routes plugin.
 * Prefix: /api/v1/scheduled-orders
 *
 * Customer-facing module — every route requires authentication; the service
 * scopes all operations to the JWT's user_id (Req 10.6, 10.8, 10.9). No
 * shop-scope middleware is needed because customers never present an
 * X-Shop-Id header and shop staff don't manage their customers' schedules.
 *
 * Rate limiting (per design.md Security Model):
 *   - POST / : 5/min — bounds spammy creates without hindering normal use
 */
export default async function scheduledOrdersRoutes(fastify) {
  const repository = new ScheduledOrdersRepository()
  const service = new ScheduledOrdersService(repository)
  const controller = new ScheduledOrdersController(service)

  // ── POST / — Create a scheduled order ────────────────────
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Scheduled Orders'],
        summary: 'Create a scheduled order [Customer]',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    controller.create.bind(controller)
  )

  // ── GET / — List my scheduled orders ─────────────────────
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Scheduled Orders'],
        summary: 'List my scheduled orders [Customer]',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: {
              type: 'string',
              enum: [
                'SCHEDULED',
                'PROCESSING',
                'PLACED',
                'FAILED',
                'CANCELLED',
              ],
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.list.bind(controller)
  )

  // ── GET /:id — Fetch one (scoped to user_id) ─────────────
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Scheduled Orders'],
        summary: 'Get scheduled order by ID [Customer]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.getOne.bind(controller)
  )

  // ── DELETE /:id — Cancel (Req 10.6) ──────────────────────
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['Scheduled Orders'],
        summary: 'Cancel a scheduled order [Customer]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.cancel.bind(controller)
  )
}
