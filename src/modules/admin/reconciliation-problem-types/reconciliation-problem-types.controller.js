import { success, error } from '../../../utils/apiResponse.js'

/**
 * Reconciliation Problem Types controller — thin HTTP layer
 */
export class ReconciliationProblemTypesController {
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
    const problemTypes = await this.service.listAll()
    return reply.code(200).send(success(problemTypes, 'Reconciliation problem types fetched'))
  }

  async listActive(request, reply) {
    const problemTypes = await this.service.listActive()
    return reply.code(200).send(success(problemTypes, 'Active reconciliation problem types fetched'))
  }

  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.problemType, 'Problem type created'))
  }

  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      const code = result.message === 'Problem type not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.problemType, 'Problem type updated'))
  }

  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      const code = result.message === 'Problem type not found' ? 404 : 409
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'CONFLICT'))
    }
    return reply.code(200).send(success(null, 'Problem type deleted'))
  }
}
