import { success, error } from '../../utils/apiResponse.js'

export class VendorRiderSettlementsController {
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

  async list(request, reply) {
    const { riderEmployeeId, from, to, page, limit } = request.query || {}
    const settlements = await this.service.list(request.vendorId, { riderEmployeeId, from, to, page: Number(page) || 1, limit: Number(limit) || 50 })
    return reply.code(200).send(success(settlements, 'Rider settlements fetched'))
  }

  async create(request, reply) {
    const result = await this.service.create(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.settlement, 'Rider settlement created'))
  }

  async update(request, reply) {
    const result = await this.service.update(request.vendorId, this._actorCtx(request), request.params.id, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.settlement, 'Rider settlement updated'))
  }

  async setStatus(request, reply) {
    const result = await this.service.setStatus(request.vendorId, this._actorCtx(request), request.params.id, request.body.status)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.settlement, 'Rider settlement status updated'))
  }
}
