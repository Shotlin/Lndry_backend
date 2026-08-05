import { success, error } from '../../../utils/apiResponse.js'
import { httpStatusFor } from '../../../constants/errors.js'

/**
 * First-Time Offers controller — thin HTTP layer
 */
export class FirstTimeOffersController {
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
    const offers = await this.service.listAll()
    return reply.code(200).send(success(offers, 'First-time offers fetched'))
  }

  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      const code = result.code || 'VALIDATION_ERROR'
      return reply.code(httpStatusFor(code)).send(error(result.message, code))
    }
    return reply.code(201).send(success(result.offer, 'First-time offer created'))
  }

  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      const code = result.message === 'Offer not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.offer, 'First-time offer updated'))
  }

  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'First-time offer deleted'))
  }
}
