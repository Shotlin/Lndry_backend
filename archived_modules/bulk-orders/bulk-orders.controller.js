import { success, error } from '../../src/utils/apiResponse.js'
import {
  createBulkOrderSchema,
  updateStatusSchema,
  listBulkOrdersQuerySchema,
  bulkOrderIdParamSchema,
} from './bulk-orders.schema.js'

/**
 * Bulk Orders controller — thin HTTP layer.
 * Handles request/response shape only and delegates to the service.
 *
 * Shop scope (request.shopId) is set by the `requireShopScope` preHandler on
 * the routes that mount this controller (list/get/updateStatus). Customer
 * routes (create, submit, cancel) do not require a shop scope; the service
 * verifies the user is allocated to the target shop.
 */
export class BulkOrdersController {
  constructor(service) {
    this.service = service
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  /** @private */
  _actor(request) {
    return {
      id: request.user?.id,
      role: request.user?.role,
      shopId:
        request.shopId ?? request.user?.shopId ?? request.user?.vendor_id ?? null,
      shopRole: request.user?.shopRole || request.user?.shop_role || null,
    }
  }

  /** @private */
  _statusForCode(code) {
    switch (code) {
      case 'BULK_ORDER_NOT_FOUND':
        return 404
      case 'UNAUTHORIZED':
        return 401
      case 'FORBIDDEN':
      case 'SHOP_SCOPE_MISMATCH':
        return 403
      case 'INVALID_STATE_TRANSITION':
      case 'INSUFFICIENT_STOCK':
      case 'BULK_DATE_INVALID':
      case 'NO_ALLOCATION':
      case 'VALIDATION_ERROR':
        return 400
      case 'BULK_ORDER_DUPLICATE':
        return 409
      default:
        return 400
    }
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')
  }

  /** @private */
  _replyError(reply, result) {
    const status = this._statusForCode(result.code)
    const payload = error(result.message, result.code)
    if (Array.isArray(result.failed) && result.failed.length > 0) {
      payload.failed = result.failed
    }
    return reply.code(status).send(payload)
  }

  /** @private */
  _requireUser(request, reply) {
    if (!request.user || !request.user.id) {
      reply.code(401).send(error('Unauthorized', 'UNAUTHORIZED'))
      return false
    }
    return true
  }

  // ────────────────────────────────────────────────────────
  // POST / — Create a bulk order (DRAFT)
  // ────────────────────────────────────────────────────────
  async create(request, reply) {
    if (!this._requireUser(request, reply)) return

    const parsed = createBulkOrderSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.create(request.user.id, parsed.data)
    if (!result.success) return this._replyError(reply, result)

    return reply.code(201).send(success(result.data, 'Bulk order created'))
  }

  // ────────────────────────────────────────────────────────
  // GET / — List bulk orders (scoped to caller)
  // ────────────────────────────────────────────────────────
  async list(request, reply) {
    if (!this._requireUser(request, reply)) return

    const parsed = listBulkOrdersQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.list(this._actor(request), parsed.data)
    return reply.code(200).send(success(result, 'Bulk orders fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /:id — Get a single bulk order
  // ────────────────────────────────────────────────────────
  async getOne(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = bulkOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid bulk order ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.getById(
      paramsParsed.data.id,
      this._actor(request)
    )
    if (!result.success) return this._replyError(reply, result)

    return reply.code(200).send(success(result.data, 'Bulk order fetched'))
  }

  // ────────────────────────────────────────────────────────
  // PATCH /:id/submit — Customer submit (DRAFT -> SUBMITTED)
  // ────────────────────────────────────────────────────────
  async submit(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = bulkOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid bulk order ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.submit(
      request.user.id,
      paramsParsed.data.id
    )
    if (!result.success) return this._replyError(reply, result)

    return reply.code(200).send(success(result.data, 'Bulk order submitted'))
  }

  // ────────────────────────────────────────────────────────
  // PATCH /:id/status — Unified status transition
  //   - Customer: DRAFT->SUBMITTED, DRAFT->CANCELLED, SUBMITTED->CANCELLED
  //   - Shop Admin/Manager: SUBMITTED->CONFIRMED, CONFIRMED->PROCESSING,
  //                          CONFIRMED->CANCELLED, PROCESSING->READY,
  //                          READY->DELIVERED
  // The service dispatches to the correct flow based on the requested
  // status and the caller's actor profile.
  // ────────────────────────────────────────────────────────
  async updateStatus(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = bulkOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid bulk order ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = updateStatusSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.transitionStatus(
      this._actor(request),
      paramsParsed.data.id,
      bodyParsed.data.status
    )
    if (!result.success) return this._replyError(reply, result)

    return reply
      .code(200)
      .send(success(result.data, 'Bulk order status updated'))
  }

  // ────────────────────────────────────────────────────────
  // DELETE /:id — Soft cancel (sets status=CANCELLED).
  // No row deletion; auditable. Customer-only entry point — equivalent to
  // `PATCH /:id/status { status: 'CANCELLED' }` for owning customers.
  // ────────────────────────────────────────────────────────
  async softDelete(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = bulkOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid bulk order ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.cancel(
      request.user.id,
      paramsParsed.data.id
    )
    if (!result.success) return this._replyError(reply, result)

    return reply.code(200).send(success(result.data, 'Bulk order cancelled'))
  }

  // ────────────────────────────────────────────────────────
  // PATCH /:id/cancel — Customer cancels their own DRAFT/SUBMITTED order
  // ────────────────────────────────────────────────────────
  async cancel(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = bulkOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid bulk order ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.cancel(
      request.user.id,
      paramsParsed.data.id
    )
    if (!result.success) return this._replyError(reply, result)

    return reply.code(200).send(success(result.data, 'Bulk order cancelled'))
  }
}
