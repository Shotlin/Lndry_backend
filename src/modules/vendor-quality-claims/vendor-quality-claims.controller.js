import { success, error } from '../../utils/apiResponse.js'

export class VendorQualityClaimsController {
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

  async open(request, reply) {
    const result = await this.service.open(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.claim, 'Quality claim opened'))
  }

  async resolve(request, reply) {
    const result = await this.service.resolve(request.vendorId, this._actorCtx(request), request.params.id, request.body.decision, request.body.note)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success({ claim: result.claim, correction: result.correction }, 'Quality claim resolved'))
  }

  async list(request, reply) {
    const { status, garmentUnitId, page, limit } = request.query || {}
    const claims = await this.service.list(request.vendorId, { status, garmentUnitId, page: Number(page) || 1, limit: Number(limit) || 50 })
    return reply.code(200).send(success(claims, 'Quality claims fetched'))
  }

  async getDetail(request, reply) {
    const claim = await this.service.getDetail(request.vendorId, request.params.id)
    if (!claim) return reply.code(404).send(error('Quality claim not found', 'NOT_FOUND'))
    return reply.code(200).send(success(claim, 'Quality claim fetched'))
  }
}
