import { success, error } from '../../utils/apiResponse.js'

export class VendorLaundryContainersController {
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
    const status = result.code === 'NOT_FOUND' || result.code === 'TAG_NOT_FOUND' ? 404 : 400
    return reply.code(status).send(error(result.message, result.code || 'VALIDATION_ERROR'))
  }

  async generate(request, reply) {
    const result = await this.service.generate(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.containers, 'Bag/container tags generated'))
  }

  async listForOrder(request, reply) {
    const containers = await this.service.listForOrder(request.vendorId, request.params.orderId)
    return reply.code(200).send(success(containers, 'Containers fetched'))
  }

  async getDetail(request, reply) {
    const container = await this.service.getDetail(request.vendorId, request.params.id)
    if (!container) return reply.code(404).send(error('Container not found', 'NOT_FOUND'))
    return reply.code(200).send(success(container, 'Container fetched'))
  }

  async scan(request, reply) {
    const result = await this.service.scan(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success({ container: result.container, scanResult: result.scanResult }, 'Container scanned'))
  }
}
