import { success, error } from '../../utils/apiResponse.js'

/**
 * Vendor Rider controller — thin HTTP layer for the rider job-fulfillment surface.
 */
export class VendorRiderController {
  constructor(service) {
    this.service = service
  }

  async listJobs(request, reply) {
    try {
      const result = await this.service.listJobs(request.user.id)
      return reply.send(success(result, 'Jobs fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async getJobDetail(request, reply) {
    try {
      const result = await this.service.getJobDetail(request.user.id, request.params.orderId)
      return reply.send(success(result, 'Job detail fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async submitPickupPhotos(request, reply) {
    try {
      const result = await this.service.submitPickupPhotos(
        request.user.id,
        request.params.orderId,
        request.body.photos
      )
      return reply.send(success(result, 'Pickup photos saved'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async verifyPickupOtp(request, reply) {
    try {
      const result = await this.service.verifyPickupOtp(
        request.user.id,
        request.params.orderId,
        request.body.otp
      )
      return reply.send(success(result, 'Pickup confirmed'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async verifyDeliveryOtp(request, reply) {
    try {
      const result = await this.service.verifyDeliveryOtp(
        request.user.id,
        request.params.orderId,
        request.body.otp
      )
      return reply.send(success(result, 'Delivery confirmed'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }
}
