import { success, error } from '../../utils/apiResponse.js'

export class VendorExpensesController {
  constructor(service) {
    this.service = service
  }

  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      vendorId: request.vendorId,
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  _fail(reply, result) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400
    return reply.code(status).send(error(result.message, result.code || 'VALIDATION_ERROR'))
  }

  async create(request, reply) {
    const result = await this.service.create(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.expense, 'Expense recorded'))
  }

  async update(request, reply) {
    const { reason, ...input } = request.body || {}
    const result = await this.service.update(request.vendorId, this._actorCtx(request), request.params.id, input, reason)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.expense, 'Expense updated'))
  }

  async cancel(request, reply) {
    const result = await this.service.cancel(request.vendorId, this._actorCtx(request), request.params.id, request.body?.reason)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.expense, 'Expense cancelled'))
  }

  async list(request, reply) {
    const { search, from, to, page, limit } = request.query || {}
    const { expenses, total } = await this.service.list(request.vendorId, { search, from, to, page: Number(page) || 1, limit: Number(limit) || 20 })
    return reply.code(200).send(success(expenses, 'Expenses fetched', { page: Number(page) || 1, total }))
  }
}
