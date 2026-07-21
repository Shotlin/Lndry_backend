import { success, error } from '../../utils/apiResponse.js'

/**
 * Delivery controller — handles delivery operations
 */
export class DeliveryController {
  constructor(service) {
    this.service = service
  }

  /**
   * GET /profile — Get rider profile
   */
  async getProfile(request, reply) {
    const profile = await this.service.getRiderProfile(request.user.id)
    return reply.code(200).send(success(profile, 'Rider profile fetched'))
  }

  /**
   * GET /documents — Get uploaded documents
   */
  async getDocuments(request, reply) {
    const docs = await this.service.getDocuments(request.user.id)

    const formattedDocs = docs.documents.map(doc => ({
      ...doc,
      type: doc.doc_type,
      url: doc.doc_url,
      status: doc.verified ? 'APPROVED' : (doc.verified_at != null ? 'REJECTED' : 'PENDING')
    }))

    return reply.code(200).send(success({ documents: formattedDocs }, 'Documents fetched'))
  }

  /**
   * POST /documents & /documents/:type — Upload document
   */
  async uploadDocument(request, reply) {
    const file = await request.file()

    if (!file) {
      return reply.code(400).send(error('No file uploaded', 'NO_FILE'))
    }

    const rawType = request.params.type
      || (file.fields.doc_type ? file.fields.doc_type.value : null)
      || (file.fields.type ? file.fields.type.value : null)
      || 'photo'

    const docType = rawType

    try {
      const doc = await this.service.uploadDocument({
        riderId: request.user.id,
        fileStream: file.file,
        docType,
      })

      const formattedDoc = {
        ...doc,
        type: doc.doc_type,
        url: doc.doc_url,
        status: doc.verified ? 'APPROVED' : (doc.verified_at != null ? 'REJECTED' : 'PENDING')
      }

      return reply.code(200).send(success({ document: formattedDoc, ...formattedDoc }, 'Document uploaded'))
    } catch (err) {
      request.log.error({ err }, 'Document upload failed')
      return reply.code(400).send(error(err.message || 'Failed to upload document', 'UPLOAD_FAILED'))
    }
  }

  /**
   * PATCH /toggle-online — Toggle online status
   */
  async toggleOnline(request, reply) {
    const { isOnline } = request.body
    try {
      const result = await this.service.toggleOnline(request.user.id, isOnline)
      return reply.code(200).send(success(result, `Rider is now ${isOnline ? 'online' : 'offline'}`))
    } catch (err) {
      const statusCode = err.statusCode || 400
      const code = err.code || 'TOGGLE_ONLINE_FAILED'
      return reply.code(statusCode).send(error(err.message || 'Failed to toggle online status', code))
    }
  }

  /**
   * GET /orders — Get assigned delivery orders
   */
  async getAssignedOrders(request, reply) {
    const { status } = request.query
    const orders = await this.service.getAssignedOrders(request.user.id, status)
    return reply.code(200).send(success(orders, 'Assigned orders fetched'))
  }

  /**
   * PATCH /orders/:id/accept — Accept a delivery assignment
   */
  async acceptOrder(request, reply) {
    const { id } = request.params
    const result = await this.service.acceptOrder(request.user.id, id)
    return reply.code(200).send(success(result, 'Order accepted'))
  }

  /**
   * PATCH /orders/:id/reject — Reject a delivery assignment
   */
  async rejectOrder(request, reply) {
    const { id } = request.params
    const { reason } = request.body || {}
    const result = await this.service.rejectOrder(request.user.id, id, reason)
    return reply.code(200).send(success(result, 'Order rejected'))
  }

  /**
   * PATCH /orders/:id/pickup — Mark order as picked up
   */
  async markPickedUp(request, reply) {
    const { id } = request.params
    const result = await this.service.markPickedUp(request.user.id, id)
    return reply.code(200).send(success(result, 'Order picked up'))
  }

  /**
   * PATCH /orders/:id/deliver — Mark order as delivered
   */
  async markDelivered(request, reply) {
    const { id } = request.params
    const { otp, proofPhotoUrl, demoMode } = request.body || {}
    const result = await this.service.markDelivered(
      request.user.id,
      id,
      otp,
      proofPhotoUrl,
      demoMode
    )
    return reply.code(200).send(success(result, 'Order delivered'))
  }

  /**
   * POST /orders/:id/proof — Upload delivery proof photo
   */
  async uploadProof(request, reply) {
    const { id } = request.params

    let proofPhotoUrl = request.body?.proofPhotoUrl || request.body?.proof_url || null

    if (!proofPhotoUrl) {
      const file = await request.file()
      if (!file) {
        return reply.code(400).send(error('No proof file uploaded', 'NO_FILE'))
      }

      const uploaded = await this.service.uploadDeliveryProof({
        riderId: request.user.id,
        orderId: id,
        fileStream: file.file,
      })
      proofPhotoUrl = uploaded.proofUrl
    } else {
      await this.service.saveProofUrl({
        riderId: request.user.id,
        orderId: id,
        proofPhotoUrl,
      })
    }

    return reply.code(200).send(success({ proofUrl: proofPhotoUrl }, 'Proof uploaded'))
  }

  /**
   * GET /stats — Get delivery partner stats
   */
  async getStats(request, reply) {
    const stats = await this.service.getDeliveryStats(request.user.id)
    return reply.code(200).send(success(stats, 'Stats fetched'))
  }

  /**
   * GET /earnings — Get rider earnings summary
   */
  async getEarnings(request, reply) {
    const period = `${request.query?.period || 'month'}`
    const earnings = await this.service.getDeliveryEarnings(request.user.id, period)
    return reply.code(200).send(success(earnings, 'Earnings fetched'))
  }

  /**
   * GET /payouts — Get rider payout history
   */
  async getPayouts(request, reply) {
    const page = Number(request.query?.page || 1)
    const limit = Number(request.query?.limit || 20)
    const payouts = await this.service.getDeliveryPayouts(request.user.id, page, limit)
    return reply.code(200).send(success(payouts, 'Payout history fetched'))
  }

  /**
   * PATCH /location — Update current location
   */
  async updateLocation(request, reply) {
    const { latitude, longitude } = request.body
    await this.service.updateLocation(request.user.id, latitude, longitude)
    return reply.code(200).send(success(null, 'Location updated'))
  }

  /**
   * GET /history — Get delivery history
   */
  async getHistory(request, reply) {
    const { page, limit } = request.query
    const result = await this.service.getDeliveryHistory(request.user.id, page, limit)
    return reply.code(200).send(success(result, 'Delivery history fetched'))
  }

  /**
   * GET /store-info — Get store location for delivery maps
   */
  async getStoreInfo(request, reply) {
    const info = await this.service.getStoreInfo()
    return reply.code(200).send(success(info, 'Store info fetched'))
  }

  /**
   * POST /orders/:id/verify-pickup-otp — Verify pickup OTP
   */
  async verifyPickupOtp(request, reply) {
    const { id } = request.params
    const { otp } = request.body
    try {
      const result = await this.service.verifyPickupOtp(request.user.id, id, otp)
      return reply.code(200).send(success(result, 'Pickup OTP verified successfully'))
    } catch (err) {
      const statusCode = err.statusCode || 400
      const code = err.code || 'VERIFY_PICKUP_OTP_FAILED'
      return reply.code(statusCode).send(error(err.message || 'Failed to verify pickup OTP', code))
    }
  }

  /**
   * POST /orders/:id/verify-delivery-otp — Verify delivery OTP
   */
  async verifyDeliveryOtp(request, reply) {
    const { id } = request.params
    const { otp } = request.body
    try {
      const result = await this.service.verifyDeliveryOtp(request.user.id, id, otp)
      return reply.code(200).send(success(result, 'Delivery OTP verified successfully'))
    } catch (err) {
      const statusCode = err.statusCode || 400
      const code = err.code || 'VERIFY_DELIVERY_OTP_FAILED'
      return reply.code(statusCode).send(error(err.message || 'Failed to verify delivery OTP', code))
    }
  }
}
