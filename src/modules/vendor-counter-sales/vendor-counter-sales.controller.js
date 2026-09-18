import { success, error } from '../../utils/apiResponse.js'

export class VendorCounterSalesController {
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

  async quote(request, reply) {
    const result = await this.service.quote(request.vendorId, request.body)
    if (!result.success) return reply.code(400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    return reply.code(200).send(success(result.quote, 'Counter sale quote computed'))
  }

  async book(request, reply) {
    const result = await this.service.book(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400
      return reply.code(status).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success({ order: result.order, quote: result.quote }, 'Counter sale booked'))
  }
}
