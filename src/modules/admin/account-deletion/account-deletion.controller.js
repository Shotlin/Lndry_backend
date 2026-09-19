import { success, error } from '../../../utils/apiResponse.js'

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  ACTIVE_ORDERS_EXIST: 409,
  HAS_STAFF_ROLE: 409,
  DELETION_ALREADY_REQUESTED: 409,
}

export class AccountDeletionController {
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

  _fail(reply, result) {
    return reply.code(STATUS_BY_CODE[result.code] ?? 400).send(error(result.message, result.code))
  }

  // Customer
  async requestDeletion(request, reply) {
    const result = await this.service.requestDeletion(request.user.id, request.body?.reason)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.request, 'Account deletion request sent.'))
  }

  async getMine(request, reply) {
    const current = await this.service.getMyRequest(request.user.id)
    return reply.code(200).send(success(current, 'Account deletion status fetched'))
  }

  // Admin
  async list(request, reply) {
    const { requests, counts, pagination } = await this.service.list(request.query)
    return reply.code(200).send(success(requests, 'Deletion requests fetched', { pagination, counts }))
  }

  async approve(request, reply) {
    const result = await this.service.approve(request.params.id, request.body?.note, this._actorCtx(request))
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.request, 'Deletion approved — the 30-day period has started'))
  }

  async reject(request, reply) {
    const result = await this.service.reject(request.params.id, request.body?.note, this._actorCtx(request))
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.request, 'Deletion request rejected'))
  }
}
