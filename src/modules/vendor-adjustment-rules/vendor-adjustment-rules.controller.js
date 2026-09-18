import { success, error } from '../../utils/apiResponse.js'

export class VendorAdjustmentRulesController {
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
    const kind = String(request.params.kind).toUpperCase()
    const includeInactive = String(request.query?.includeInactive) === 'true'
    const rules = await this.service.list(request.vendorId, kind, includeInactive)
    return reply.code(200).send(success(rules, 'Adjustment rules fetched'))
  }

  async create(request, reply) {
    try {
      const kind = String(request.params.kind).toUpperCase()
      const result = await this.service.create(request.vendorId, this._actorCtx(request), kind, request.body)
      if (!result.success) return this._fail(reply, result)
      return reply.code(201).send(success(result.rule, 'Adjustment rule created'))
    } catch (err) {
      if (err.code === '23505') return reply.code(400).send(error('A rule with that name already exists', 'DUPLICATE_RULE'))
      throw err
    }
  }

  async update(request, reply) {
    try {
      const result = await this.service.update(request.vendorId, this._actorCtx(request), request.params.id, request.body)
      if (!result.success) return this._fail(reply, result)
      return reply.code(200).send(success(result.rule, 'Adjustment rule updated'))
    } catch (err) {
      if (err.code === '23505') return reply.code(400).send(error('A rule with that name already exists', 'DUPLICATE_RULE'))
      throw err
    }
  }
}
