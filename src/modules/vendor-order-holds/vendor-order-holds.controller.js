import { success, error } from '../../utils/apiResponse.js'

export class VendorOrderHoldsController {
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
    const result = await this.service.create(request.vendorId, this._actorCtx(request), request.body?.payload)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.hold, 'Order held'))
  }

  async list(request, reply) {
    const includeClosed = String(request.query?.includeClosed) === 'true'
    const holds = await this.service.list(request.vendorId, request.user.id, includeClosed)
    return reply.code(200).send(success(holds, 'Order holds fetched'))
  }

  async presence(request, reply) {
    const presence = await this.service.presence(request.vendorId, request.user.id)
    return reply.code(200).send(success(presence, 'Counter presence fetched'))
  }

  async claim(request, reply) {
    const result = await this.service.claim(request.vendorId, this._actorCtx(request), request.params.id)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.hold, 'Order hold claimed'))
  }

  async renew(request, reply) {
    const result = await this.service.renew(request.vendorId, this._actorCtx(request), request.params.id)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.hold, 'Order hold renewed'))
  }

  async release(request, reply) {
    const result = await this.service.release(request.vendorId, this._actorCtx(request), request.params.id, Boolean(request.body?.override))
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.hold, 'Order hold released'))
  }

  async resume(request, reply) {
    const result = await this.service.resume(request.vendorId, this._actorCtx(request), request.params.id, Boolean(request.body?.override))
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.hold, 'Order hold resumed'))
  }

  async cancel(request, reply) {
    const result = await this.service.cancel(request.vendorId, this._actorCtx(request), request.params.id, Boolean(request.body?.override))
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.hold, 'Order hold cancelled'))
  }
}
