import { success, error } from '../../src/utils/apiResponse.js'
import {
  createScheduledOrderSchema,
  listScheduledOrdersQuerySchema,
  scheduledOrderIdParamSchema,
} from './scheduled-orders.schema.js'

/**
 * Scheduled Orders controller — thin HTTP layer.
 *
 * Customer-facing only:
 *   - POST   /api/v1/scheduled-orders
 *   - GET    /api/v1/scheduled-orders
 *   - GET    /api/v1/scheduled-orders/:id
 *   - DELETE /api/v1/scheduled-orders/:id
 *
 * The controller validates input with Zod, then delegates to the service
 * which returns `{ success, message, code }` envelopes. Status codes are
 * mapped centrally in `_statusForCode`.
 */
export class ScheduledOrdersController {
  constructor(service) {
    this.service = service
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  /** @private */
  _statusForCode(code) {
    switch (code) {
      case 'SCHEDULED_ORDER_NOT_FOUND':
        return 404
      case 'UNAUTHORIZED':
        return 401
      case 'FORBIDDEN':
      case 'NO_ALLOCATION':
        return 403
      case 'SCHEDULE_LIMIT':
      case 'INVALID_STATE_TRANSITION':
      case 'VALIDATION_ERROR':
        return 400
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
    return reply.code(status).send(error(result.message, result.code))
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
  // POST / — Create a scheduled order
  // ────────────────────────────────────────────────────────
  async create(request, reply) {
    if (!this._requireUser(request, reply)) return

    const parsed = createScheduledOrderSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.create(request.user.id, parsed.data)
    if (!result.success) return this._replyError(reply, result)

    return reply
      .code(201)
      .send(success(result.data, 'Scheduled order created'))
  }

  // ────────────────────────────────────────────────────────
  // GET / — List the caller's scheduled orders
  // ────────────────────────────────────────────────────────
  async list(request, reply) {
    if (!this._requireUser(request, reply)) return

    const parsed = listScheduledOrdersQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.list(request.user.id, parsed.data)
    return reply.code(200).send(success(result, 'Scheduled orders fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /:id — Fetch one (scoped to user_id)
  // ────────────────────────────────────────────────────────
  async getOne(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = scheduledOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid scheduled order ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.getById(
      request.user.id,
      paramsParsed.data.id
    )
    if (!result.success) return this._replyError(reply, result)

    return reply.code(200).send(success(result.data, 'Scheduled order fetched'))
  }

  // ────────────────────────────────────────────────────────
  // DELETE /:id — Customer cancel (Req 10.6)
  // ────────────────────────────────────────────────────────
  async cancel(request, reply) {
    if (!this._requireUser(request, reply)) return

    const paramsParsed = scheduledOrderIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid scheduled order ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.cancel(
      request.user.id,
      paramsParsed.data.id
    )
    if (!result.success) return this._replyError(reply, result)

    return reply
      .code(200)
      .send(success(result.data, 'Scheduled order cancelled'))
  }
}
