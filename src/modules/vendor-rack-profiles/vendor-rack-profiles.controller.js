import { success, error } from '../../utils/apiResponse.js'

export class VendorRackProfilesController {
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
    const includeInactive = String(request.query?.includeInactive) === 'true'
    const profiles = await this.service.list(request.vendorId, includeInactive)
    return reply.code(200).send(success(profiles, 'Rack profiles fetched'))
  }

  async create(request, reply) {
    try {
      const result = await this.service.create(request.vendorId, this._actorCtx(request), request.body)
      if (!result.success) return this._fail(reply, result)
      return reply.code(201).send(success(result.profile, 'Rack profile created'))
    } catch (err) {
      if (err.code === '23505') return reply.code(400).send(error('A rack profile with that name or code already exists', 'DUPLICATE_RACK'))
      throw err
    }
  }

  async update(request, reply) {
    try {
      const result = await this.service.update(request.vendorId, this._actorCtx(request), request.params.id, request.body)
      if (!result.success) return this._fail(reply, result)
      return reply.code(200).send(success(result.profile, 'Rack profile updated'))
    } catch (err) {
      if (err.code === '23505') return reply.code(400).send(error('A rack profile with that name or code already exists', 'DUPLICATE_RACK'))
      throw err
    }
  }
}
