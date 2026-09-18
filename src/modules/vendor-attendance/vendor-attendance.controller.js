import { success, error } from '../../utils/apiResponse.js'

export class VendorAttendanceController {
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

  async mark(request, reply) {
    const result = await this.service.mark(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return reply.code(400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    return reply.code(result.duplicate ? 200 : 201).send(success(result.mark, result.duplicate ? 'Attendance already recorded' : 'Attendance marked'))
  }

  async roster(request, reply) {
    const date = String(request.query?.date || new Date().toISOString().slice(0, 10))
    const dashboard = await this.service.roster(request.vendorId, date)
    return reply.code(200).send(success(dashboard, 'Attendance roster fetched'))
  }
}
