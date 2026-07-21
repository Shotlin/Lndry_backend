import { AdminRidersService } from './riders.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminRidersService()

export class AdminRidersController {
  async list(request, reply) {
    const { page, limit, search, status, sortBy, sortOrder } = request.query
    const data = await svc.list({ page, limit, search, status, sortBy, sortOrder })
    return success(data, 'Riders fetched')
  }

  async getDetail(request, reply) {
    try {
      const rider = await svc.getDetail(request.params.id)
      if (!rider) return error('Rider not found', 404)
      return success(rider, 'Rider detail fetched')
    } catch (err) {
      request.log.error({ err, riderId: request.params.id }, 'Failed to fetch rider detail')
      throw err
    }
  }

  async getEarnings(request, reply) {
    try {
      const { startDate, endDate } = request.query
      const data = await svc.getEarnings(request.params.id, { startDate, endDate })
      return success(data, 'Rider earnings fetched')
    } catch (err) {
      request.log.error(
        { err, riderId: request.params.id, query: request.query },
        'Failed to fetch rider earnings'
      )
      throw err
    }
  }

  async getPayouts(request, reply) {
    try {
      const data = await svc.getPayouts(request.params.id)
      return success(data, 'Rider payouts fetched')
    } catch (err) {
      request.log.error({ err, riderId: request.params.id }, 'Failed to fetch rider payouts')
      throw err
    }
  }

  async createPayout(request, reply) {
    const payout = await svc.createPayout(request.params.id, request.body, request.user.id, request.ip)
    return success(payout, 'Payout created')
  }

  async toggleSuspend(request, reply) {
    const { suspended } = request.body
    const user = await svc.toggleSuspend(request.params.id, suspended, request.user.id, request.ip)
    if (!user) return error('Rider not found', 404)
    return success(user, suspended ? 'Rider suspended' : 'Rider unsuspended')
  }

  async updateCommission(request, reply) {
    const { rate } = request.body
    const profile = await svc.updateCommission(request.params.id, rate, request.user.id, request.ip)
    if (!profile) return error('Rider profile not found', 404)
    return success(profile, 'Commission updated')
  }

  async approveRider(request, reply) {
    const { is_approved } = request.body
    const profile = await svc.approveRider(request.params.id, is_approved, request.user.id, request.ip)
    if (!profile) return error('Rider profile not found', 404)
    return success(profile, is_approved ? 'Rider approved' : 'Rider unapproved')
  }

  /**
   * Task 12.4: POST /api/v1/admin/riders/:riderId/approve
   * Transitions approval_status from PENDING → APPROVED
   */
  async approveRiderStatus(request, reply) {
    try {
      const result = await svc.transitionApprovalStatus(request.params.id, request.user.id, request.ip)
      if (!result) {
        return reply.code(404).send(error('Rider profile not found', 'PRODUCT_NOT_FOUND'))
      }
      if (result.conflict) {
        return reply.code(409).send(error(result.message, 'ORDER_STATE_INVALID'))
      }
      return success(result, 'Rider approved')
    } catch (err) {
      request.log.error({ err, riderId: request.params.id }, 'Failed to approve rider')
      throw err
    }
  }

  async getDocuments(request, reply) {
    try {
      const data = await svc.getDocuments(request.params.id)
      const formatted = data.map(doc => ({
        ...doc,
        type: doc.doc_type,
        url: doc.doc_url,
        status: doc.verified ? 'APPROVED' : (doc.verified_at != null ? 'REJECTED' : 'PENDING')
      }))
      return success(formatted, 'Documents fetched')
    } catch (err) {
      request.log.error({ err, riderId: request.params.id }, 'Failed to fetch rider documents')
      throw err
    }
  }

  async verifyDocument(request, reply) {
    const { status: docStatus, note } = request.body
    const doc = await svc.verifyDocument(request.params.documentId, docStatus, note, request.user.id, request.ip)
    if (!doc) return error('Document not found', 404)

    const formattedDoc = {
      ...doc,
      type: doc.doc_type,
      url: doc.doc_url,
      status: doc.verified ? 'APPROVED' : (doc.verified_at != null ? 'REJECTED' : 'PENDING')
    }

    return success(formattedDoc, 'Document verified')
  }

  async getLiveLocations(request, reply) {
    const data = await svc.getLiveLocations()
    return success(data, 'Live locations fetched')
  }
}
