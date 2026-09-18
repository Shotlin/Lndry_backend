import { success, error } from '../../utils/apiResponse.js'

export class VendorServicePackagesController {
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

  async listDefinitions(request, reply) {
    const includeInactive = String(request.query?.includeInactive) === 'true'
    const definitions = await this.service.listDefinitions(request.vendorId, includeInactive)
    return reply.code(200).send(success(definitions, 'Service packages fetched'))
  }

  async createDefinition(request, reply) {
    try {
      const result = await this.service.createDefinition(request.vendorId, this._actorCtx(request), request.body)
      if (!result.success) return this._fail(reply, result)
      return reply.code(201).send(success(result.definition, 'Service package created'))
    } catch (err) {
      if (err.code === '23505') return reply.code(400).send(error('A package with that name already exists', 'DUPLICATE_PACKAGE'))
      throw err
    }
  }

  async purchase(request, reply) {
    const result = await this.service.purchase(request.vendorId, this._actorCtx(request), request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.customerPackage, 'Package purchased'))
  }

  async addPayment(request, reply) {
    const result = await this.service.addPayment(request.vendorId, this._actorCtx(request), request.params.id, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success({ payment: result.payment, customerPackage: result.customerPackage, outstandingPaise: result.outstandingPaise }, 'Payment collected'))
  }

  async redeem(request, reply) {
    const result = await this.service.redeem(request.vendorId, this._actorCtx(request), request.params.id, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.customerPackage, 'Package redeemed'))
  }

  async listForCustomer(request, reply) {
    const packages = await this.service.listForCustomer(request.vendorId, request.params.customerUserId)
    return reply.code(200).send(success(packages, 'Customer packages fetched'))
  }
}
