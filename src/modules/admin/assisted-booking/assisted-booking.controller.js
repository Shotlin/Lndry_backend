import { success, error } from '../../../utils/apiResponse.js'

export class AssistedBookingController {
  constructor(service) {
    this.service = service
  }

  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  async get(request, reply) {
    return reply.code(200).send(success(await this.service.getAdminView(), 'Assisted booking settings fetched'))
  }

  async update(request, reply) {
    const result = await this.service.update(request.body || {}, this._actorCtx(request))
    if (!result.success) return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    return reply.code(200).send(success(result.settings, 'Assisted booking settings saved'))
  }
}
