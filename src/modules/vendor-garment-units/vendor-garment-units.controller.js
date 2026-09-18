import { success, error } from '../../utils/apiResponse.js'

export class VendorGarmentUnitsController {
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
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'TAG_RETIRED' ? 409 : 400
    const body = error(result.message, result.code || 'VALIDATION_ERROR')
    if (result.details) body.details = result.details
    return reply.code(status).send(body)
  }

  async generate(request, reply) {
    const result = await this.service.generate(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.units, 'Garment tags generated'))
  }

  async listForOrder(request, reply) {
    const units = await this.service.listForOrder(request.vendorId, request.params.orderId)
    return reply.code(200).send(success(units, 'Garment units fetched'))
  }

  async getDetail(request, reply) {
    const unit = await this.service.getDetail(request.vendorId, request.params.id)
    if (!unit) return reply.code(404).send(error('Garment unit not found', 'NOT_FOUND'))
    return reply.code(200).send(success(unit, 'Garment unit fetched'))
  }

  async scan(request, reply) {
    const result = await this.service.scan(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success({ unit: result.unit, scanResult: result.scanResult }, 'Garment scanned'))
  }

  async reprintTag(request, reply) {
    const result = await this.service.reprintTag(request.vendorId, this._actorCtx(request), request.params.id, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.unit, 'Tag reprint logged'))
  }

  async replaceTag(request, reply) {
    const result = await this.service.replaceTag(request.vendorId, this._actorCtx(request), request.params.id, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.unit, 'Tag replaced'))
  }
}
