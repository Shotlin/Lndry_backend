import { success, error } from '../../utils/apiResponse.js'

/**
 * Store Orders controller — thin HTTP layer.
 */
export class StoreOrdersController {
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

  async resolvePhone(request, reply) {
    const phone = String(request.body?.phone || '').trim()
    if (!phone) return reply.code(400).send(error('phone is required', 'VALIDATION_ERROR'))
    const customer = await this.service.resolvePhone(phone)
    if (!customer) return reply.code(404).send(error('No LNDRY account found for this phone number', 'NOT_FOUND'))
    return reply.code(200).send(success({ userId: customer.id, name: customer.name }, 'Customer found'))
  }

  async pushOrder(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.pushOrder(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.order, 'Store order recorded'))
  }

  async listMine(request, reply) {
    const orders = await this.service.listMine(request.user.id)
    return reply.code(200).send(success(orders, 'Store orders fetched'))
  }
}
