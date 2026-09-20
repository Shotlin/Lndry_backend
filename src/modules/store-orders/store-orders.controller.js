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

  // Errors the service throws on purpose (vendor-tier refusals) carry a
  // statusCode; anything without one is unexpected and left to the global handler.
  _handleError(reply, err) {
    if (!err?.statusCode) throw err
    return reply.code(err.statusCode).send(error(err.message, err.code))
  }

  async resolvePhone(request, reply) {
    const phone = String(request.body?.phone || '').trim()
    if (!phone) return reply.code(400).send(error('phone is required', 'VALIDATION_ERROR'))
    try {
      const customer = await this.service.resolvePhone(phone, this._actorCtx(request))
      if (!customer) return reply.code(404).send(error('No LNDRY account found for this phone number', 'NOT_FOUND'))
      return reply.code(200).send(success({ userId: customer.id, name: customer.name }, 'Customer found'))
    } catch (err) {
      return this._handleError(reply, err)
    }
  }

  async pushOrder(request, reply) {
    const actor = this._actorCtx(request)
    try {
      const result = await this.service.pushOrder(request.body, actor)
      if (!result.success) {
        return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
      }
      return reply.code(200).send(success(result.order, 'Store order recorded'))
    } catch (err) {
      return this._handleError(reply, err)
    }
  }

  async listMine(request, reply) {
    const orders = await this.service.listMine(request.user.id)
    return reply.code(200).send(success(orders, 'Store orders fetched'))
  }

  async getMine(request, reply) {
    const order = await this.service.getMine(request.params.id, request.user.id)
    if (!order) return reply.code(404).send(error('Order not found', 'NOT_FOUND'))
    return reply.code(200).send(success(order, 'Store order fetched'))
  }
}
