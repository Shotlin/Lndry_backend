import { success, error } from '../../utils/apiResponse.js'

export class VendorCustomerLedgerController {
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

  async append(request, reply) {
    const result = await this.service.append(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    return reply.code(201).send(success(result.entry, 'Ledger entry recorded'))
  }

  async getStatement(request, reply) {
    const { customerUserId, phone } = request.query || {}
    if (!customerUserId && !phone) return reply.code(400).send(error('customerUserId or phone is required', 'VALIDATION_ERROR'))
    const statement = await this.service.getStatement(request.vendorId, { customerUserId, phone })
    return reply.code(200).send(success(statement, 'Customer ledger statement fetched'))
  }
}
