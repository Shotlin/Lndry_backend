import { success, error } from '../../utils/apiResponse.js'

export class VendorProductionTasksController {
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
    const { status, station, page, limit } = request.query || {}
    const tasks = await this.service.list(request.vendorId, { status, station, page: Number(page) || 1, limit: Number(limit) || 50 })
    return reply.code(200).send(success(tasks, 'Production tasks fetched'))
  }

  async assign(request, reply) {
    const result = await this.service.assign(request.vendorId, this._actorCtx(request), request.params.id, request.body.employeeId)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.task, 'Task assigned'))
  }

  async start(request, reply) {
    const result = await this.service.start(request.vendorId, this._actorCtx(request), request.params.id)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.task, 'Task started'))
  }
}
