import { success, error } from '../../utils/apiResponse.js'

export class VendorCashShiftsController {
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

  async getCurrent(request, reply) {
    const register = String(request.query?.register || 'Main counter')
    const shift = await this.service.getCurrent(request.vendorId, register)
    return reply.code(200).send(success(shift, shift ? 'Open cash shift fetched' : 'No cash shift is open'))
  }

  async list(request, reply) {
    const { page, limit } = request.query || {}
    const { shifts, total } = await this.service.list(request.vendorId, { page: Number(page) || 1, limit: Number(limit) || 20 })
    return reply.code(200).send(success(shifts, 'Cash shifts fetched', { page: Number(page) || 1, total }))
  }

  async open(request, reply) {
    const result = await this.service.open(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return reply.code(400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    return reply.code(201).send(success(result.shift, 'Cash shift opened'))
  }

  async close(request, reply) {
    const result = await this.service.close(request.vendorId, this._actorCtx(request), request.params.id, request.body)
    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400
      return reply.code(status).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.shift, 'Cash shift closed'))
  }
}
