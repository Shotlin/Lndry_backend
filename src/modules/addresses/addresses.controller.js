import { success, error } from '../../utils/apiResponse.js'

/**
 * Addresses controller — thin HTTP layer
 */
export class AddressesController {
  constructor(service) {
    this.service = service
  }

  /** GET / */
  async list(request, reply) {
    const addresses = await this.service.list(request.user.id)
    return reply.code(200).send(success(addresses, 'Addresses fetched'))
  }

  /** POST / */
  async create(request, reply) {
    const result = await this.service.create(request.user.id, request.body)
    if (!result.success) {
      const code = result.code || 'ADDRESS_ERROR'
      return reply.code(400).send(error(result.message, code))
    }
    return reply.code(201).send(success(result.address, 'Address created'))
  }

  /** PUT /:id */
  async update(request, reply) {
    const result = await this.service.update(request.user.id, request.params.id, request.body)
    if (!result.success) {
      const code = result.code || 'NOT_FOUND'
      const statusCode = code === 'NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, code))
    }
    return reply.code(200).send(success(result.address, 'Address updated'))
  }

  /** DELETE /:id */
  async delete(request, reply) {
    const result = await this.service.delete(request.user.id, request.params.id)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Address deleted'))
  }

  /** PUT /:id/default */
  async setDefault(request, reply) {
    const result = await this.service.setDefault(request.user.id, request.params.id)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.address, 'Default address updated'))
  }

  /** GET /:id */
  async get(request, reply) {
    const address = await this.service.get(request.user.id, request.params.id)
    if (!address) {
      return reply.code(404).send(error('Address not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(address, 'Address fetched'))
  }

  /** POST /validate-location */
  async validateLocation(request, reply) {
    const { lat, lng } = request.body
    const result = await this.service.validateLocation(lat, lng)
    return reply.code(200).send(success(result, 'Location validation completed'))
  }

  /** POST /validate-pincode */
  async validatePincode(request, reply) {
    const result = await this.service.validatePincode(request.body.pincode)
    const msg = result.available ? 'Delivery available' : 'Delivery not available in this area'
    return reply.code(200).send(success(result, msg))
  }
}
