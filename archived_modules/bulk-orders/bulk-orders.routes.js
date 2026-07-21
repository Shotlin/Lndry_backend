import { BulkOrdersController } from './bulk-orders.controller.js'
import { BulkOrdersService } from './bulk-orders.service.js'
import { BulkOrdersRepository } from './bulk-orders.repository.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'

/**
 * Bulk Orders routes plugin.
 * Prefix: /api/v1/bulk-orders
 *
 * Authorization model:
 *   - Every route requires a valid JWT (fastify.authenticate).
 *   - POST / and PATCH /:id/submit and PATCH /:id/cancel are CUSTOMER-side —
 *     no shop scope is required; the service verifies the caller owns the
 *     bulk_order and (for create) is allocated to the target shop.
 *   - GET / and GET /:id and PATCH /:id/status are scoped via
 *     `requireShopScope` so platform Super Admins (X-Shop-Id) and shop staff
 *     are routed into the correct shop view (Req 9.9, RBAC).
 *
 * Rate limiting (design.md Security Model):
 *   - POST /                 : 3/min (bulk order creation)
 *   - PATCH /:id/submit      : 3/min (submission)
 */
export default async function bulkOrdersRoutes(fastify) {
  const repository = new BulkOrdersRepository()
  const service = new BulkOrdersService(repository)
  const controller = new BulkOrdersController(service)

  // ── RBAC for status transitions ──────────────────────────
  // Customer transitions (DRAFT->SUBMITTED, *->CANCELLED) and shop-side
  // transitions are dispatched by the service via `transitionStatus`. The
  // service enforces the actor checks (customer ownership / shop staff
  // role) — no extra route-level role guard is required. The shop-scope
  // middleware is applied softly so customers can hit it too.

  // shop-scope is "soft" for list/get and the unified status PATCH
  // (customers without a shop hit their own bulk orders / their own
  // SUBMIT/CANCEL transitions). Shop-staff transitions resolve under the
  // same middleware via the JWT vendor_id.
  const softShopScope = requireShopScope({ requireShop: false })

  // ─────────────────────────────────────────────────────────
  // Customer routes
  // ─────────────────────────────────────────────────────────

  // POST / — Create a bulk order (DRAFT)
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary: 'Create a bulk order (DRAFT) [Customer]',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
        },
      },
    },
    controller.create.bind(controller)
  )

  // PATCH /:id/submit — Customer submit (DRAFT -> SUBMITTED, validate stock)
  fastify.patch(
    '/:id/submit',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary: 'Submit a bulk order [Customer]',
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
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
        },
      },
    },
    controller.submit.bind(controller)
  )

  // PATCH /:id/cancel — Customer cancels own DRAFT/SUBMITTED order
  fastify.patch(
    '/:id/cancel',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary: 'Cancel a bulk order [Customer]',
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

  // ─────────────────────────────────────────────────────────
  // List / get (any caller, scoped by service based on actor)
  // ─────────────────────────────────────────────────────────

  fastify.get(
    '/',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary: 'List bulk orders (scoped to caller)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: {
              type: 'string',
              enum: [
                'DRAFT',
                'SUBMITTED',
                'CONFIRMED',
                'PROCESSING',
                'READY',
                'DELIVERED',
                'CANCELLED',
              ],
            },
            vendor_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate, softShopScope],
    },
    controller.list.bind(controller)
  )

  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary: 'Get bulk order by ID (scoped to caller)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate, softShopScope],
    },
    controller.getOne.bind(controller)
  )

  // ─────────────────────────────────────────────────────────
  // Shop-side state transitions
  // ─────────────────────────────────────────────────────────

  fastify.patch(
    '/:id/status',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary:
          'Advance bulk order lifecycle [Customer for SUBMIT/CANCEL; Shop Admin/Manager or Super Admin for shop-side states]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate, softShopScope],
    },
    controller.updateStatus.bind(controller)
  )

  // DELETE /:id — Soft cancel for the owning customer
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['Bulk Orders'],
        summary: 'Soft-cancel a bulk order (status=CANCELLED) [Customer]',
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
    controller.softDelete.bind(controller)
  )
}
