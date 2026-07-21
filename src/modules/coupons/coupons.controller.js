import { success, error } from '../../utils/apiResponse.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ERROR_CODES, httpStatusFor } from '../../constants/errors.js'

/**
 * Coupons controller — thin HTTP layer
 */
export class CouponsController {
  constructor(service) {
    this.service = service
  }

  /**
   * Extract actor context from request for audit and scope enforcement.
   */
  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      shopRole: request.user?.shopRole ?? request.user?.shop_role ?? null,
      shopId: request.shopId ?? request.user?.shopId ?? request.user?.vendor_id ?? null,
      permissions: request.user?.permissions ?? [],
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  /** POST /validate */
  async validate(request, reply) {
    const result = await this.service.validate(
      request.user.id,
      request.body.code,
      request.body.cartTotal
    )
    if (!result.valid) {
      return reply.code(400).send(error(result.message, result.code || 'INVALID_COUPON'))
    }
    return reply.code(200).send(success(result, 'Coupon is valid'))
  }

  /** GET /available */
  async available(request, reply) {
    const coupons = await this.service.getAvailable(request.user.id)
    return reply.code(200).send(success(coupons, 'Available coupons'))
  }

  /** GET / — Admin */
  async listAll(request, reply) {
    const { offset, limit } = getOffsetLimit(request.query)
    const result = await this.service.listAll({ offset, limit })
    const pagination = buildPagination({
      page: request.query.page || 1,
      limit,
      total: result.total,
    })
    return reply.code(200).send(success(result.data, 'Coupons fetched', { pagination }))
  }

  /** POST / — Admin (task 9.2: scope enforcement) */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)

    if (!result.success) {
      const httpCode = httpStatusFor(result.code) || 400
      return reply.code(httpCode).send(error(result.message, result.code || 'DUPLICATE'))
    }
    return reply.code(201).send(success(result.coupon, 'Coupon created'))
  }

  /** PUT /:id — Admin */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)

    if (!result.success) {
      const code = result.message === 'Coupon not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'DUPLICATE'))
    }
    return reply.code(200).send(success(result.coupon, 'Coupon updated'))
  }

  /** DELETE /:id — Admin */
  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)

    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Coupon deleted'))
  }
}
