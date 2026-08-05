import { success, error } from '../../../utils/apiResponse.js'
import { getOffsetLimit, buildPagination } from '../../../utils/paginate.js'

/**
 * Order Recovery controller — thin HTTP layer
 */
export class OrderRecoveryController {
  constructor(service) {
    this.service = service
  }

  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  async listAll(request, reply) {
    const { offset, limit } = getOffsetLimit(request.query)
    const result = await this.service.listAll({ offset, limit, search: request.query.search })
    const pagination = buildPagination({
      page: request.query.page || 1,
      limit,
      total: result.pagination.total,
    })
    return reply.code(200).send(success(result.drafts, 'Incomplete orders fetched', { pagination }))
  }

  async summary(request, reply) {
    const stats = await this.service.getSummary()
    return reply.code(200).send(success(stats, 'Incomplete-order summary fetched'))
  }

  async getDetail(request, reply) {
    const draft = await this.service.getDetail(request.params.id)
    if (!draft) {
      return reply.code(404).send(error('Incomplete order not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(draft, 'Incomplete order fetched'))
  }

  async sendReminder(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.sendReminder(request.params.id, request.body, actor.userId, request.server)
    if (!result.success) {
      return reply.code(result.code === 'NOT_FOUND' ? 404 : 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result, 'Reminder sent'))
  }

  async issueCoupon(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.issueCoupon(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(result.code === 'NOT_FOUND' ? 404 : 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result, 'Coupon issued'))
  }
}
