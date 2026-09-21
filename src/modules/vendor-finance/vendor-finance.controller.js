import { success, error } from '../../utils/apiResponse.js'

export class VendorFinanceController {
  constructor(service) {
    this.service = service
  }

  async _reply(reply, result, message) {
    if (result?.success === false) return reply.code(result.statusCode || 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    return reply.code(200).send(success(result, message))
  }

  async overview(request, reply) {
    const { from, to, channel } = request.query
    return this._reply(reply, await this.service.overview(request.vendorId, { from, to, channel }), 'Finance overview fetched')
  }

  async statutory(request, reply) {
    const { from, to, channel } = request.query
    return this._reply(reply, await this.service.statutory(request.vendorId, { from, to, channel }), 'Statutory report fetched')
  }
}
