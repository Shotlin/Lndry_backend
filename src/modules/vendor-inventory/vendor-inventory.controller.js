import { success, error } from '../../utils/apiResponse.js'

export class VendorInventoryController {
  constructor(service) {
    this.service = service
  }

  _fail(reply, result) {
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'ITEM_EXISTS' ? 409 : 400
    return reply.code(status).send(error(result.message, result.code || 'VALIDATION_ERROR'))
  }

  async list(request, reply) {
    const items = await this.service.list(request.vendorId)
    return reply.code(200).send(success(items, 'Supplies fetched'))
  }

  async create(request, reply) {
    const result = await this.service.create(request.vendorId, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(201).send(success(result.item, 'Supply added'))
  }

  async update(request, reply) {
    const result = await this.service.update(request.vendorId, request.params.id, request.body)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.item, 'Supply updated'))
  }

  async adjust(request, reply) {
    const result = await this.service.adjust(request.vendorId, request.params.id, request.body.delta)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(result.item, 'Quantity updated'))
  }

  async remove(request, reply) {
    const result = await this.service.remove(request.vendorId, request.params.id)
    if (!result.success) return this._fail(reply, result)
    return reply.code(200).send(success(null, 'Supply removed'))
  }
}
