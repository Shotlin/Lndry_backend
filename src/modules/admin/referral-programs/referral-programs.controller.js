import { success, error } from '../../../utils/apiResponse.js'
import { httpStatusFor } from '../../../constants/errors.js'

/**
 * Referral Programs controller — thin HTTP layer.
 */
export class ReferralProgramsController {
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

  async listAll(request, reply) {
    const programs = await this.service.listAll()
    return reply.code(200).send(success(programs, 'Referral programs fetched'))
  }

  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      const code = result.code || 'VALIDATION_ERROR'
      return reply.code(httpStatusFor(code)).send(error(result.message, code))
    }
    return reply.code(201).send(success(result.program, 'Referral program created'))
  }

  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      const code = result.message === 'Referral program not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.program, 'Referral program updated'))
  }

  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Referral program deleted'))
  }
}
