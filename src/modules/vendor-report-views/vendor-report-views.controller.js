import { success, error } from '../../utils/apiResponse.js'

export class VendorReportViewsController {
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
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 400
    return reply.code(status).send(error(result.message, result.code || 'VALIDATION_ERROR'))
  }

  async list(request, reply) {
    const views = await this.service.list(request.vendorId, request.user.id)
    return reply.code(200).send(success(views, 'Saved report views fetched'))
  }

  async create(request, reply) {
    try {
      const shopRole = request.user?.shopRole || request.user?.shop_role
      const canShare = shopRole === 'VENDOR_OWNER'
      const result = await this.service.create(request.vendorId, this._actorCtx(request), request.body, canShare)
      if (!result.success) return this._fail(reply, result)
      return reply.code(201).send(success(result.view, 'Saved report view created'))
    } catch (err) {
      if (err.code === '23505') return reply.code(400).send(error('A saved view with that name already exists for this report', 'DUPLICATE_VIEW'))
      throw err
    }
  }

  async remove(request, reply) {
    const result = await this.service.delete(this._actorCtx(request), request.params.id)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.view, 'Saved report view deleted'))
  }
}
