import { success, error } from '../../../utils/apiResponse.js'

export class HelpFaqsController {
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
    return reply.code(200).send(success(await this.service.listAll(), 'FAQs fetched'))
  }

  async create(request, reply) {
    const result = await this.service.create(request.body, this._actorCtx(request))
    if (!result.success) return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    return reply.code(201).send(success(result.faq, 'FAQ created'))
  }

  async update(request, reply) {
    const result = await this.service.update(request.params.id, request.body, this._actorCtx(request))
    if (!result.success) {
      const notFound = result.message === 'FAQ not found'
      return reply
        .code(notFound ? 404 : 400)
        .send(error(result.message, notFound ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.faq, 'FAQ updated'))
  }

  async delete(request, reply) {
    const result = await this.service.delete(request.params.id, this._actorCtx(request))
    if (!result.success) return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    return reply.code(200).send(success(null, 'FAQ deleted'))
  }
}
