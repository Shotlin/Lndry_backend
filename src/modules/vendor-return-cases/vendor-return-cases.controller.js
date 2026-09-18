import { success, error } from '../../utils/apiResponse.js'

export class VendorReturnCasesController {
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

  async request(request, reply) {
    const result = await this.service.request(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(result.duplicate ? 200 : 201).send(success(result.returnCase, result.duplicate ? 'Matching return case already requested' : 'Return case requested'))
  }

  async decide(request, reply) {
    const result = await this.service.decide(request.vendorId, this._actorCtx(request), request.params.id, request.body.approve, request.body.decisionNote)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.returnCase, 'Return case decided'))
  }

  async list(request, reply) {
    const { status, page, limit } = request.query || {}
    const cases = await this.service.list(request.vendorId, { status, page: Number(page) || 1, limit: Number(limit) || 50 })
    return reply.code(200).send(success(cases, 'Return cases fetched'))
  }
}
