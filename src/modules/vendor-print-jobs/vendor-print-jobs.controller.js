import { success, error } from '../../utils/apiResponse.js'

export class VendorPrintJobsController {
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
    const result = await this.service.create(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.job, 'Print job created'))
  }

  async markStatus(request, reply) {
    const result = await this.service.markStatus(request.vendorId, this._actorCtx(request), request.params.id, request.body.status, request.body.failureReason)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.job, 'Print job updated'))
  }

  async listForOrder(request, reply) {
    const jobs = await this.service.listForOrder(request.vendorId, request.params.orderId)
    return reply.code(200).send(success(jobs, 'Print jobs fetched'))
  }
}
