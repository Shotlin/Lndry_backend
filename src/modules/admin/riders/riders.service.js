import { AdminRidersRepository } from './riders.repository.js'
import { orderQueue } from '../../../config/bullmq.js'
import { logger } from '../../../config/logger.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'

const repo = new AdminRidersRepository()

export class AdminRidersService {
  async list({ page = 1, limit = 20, search, status, sortBy, sortOrder }) {
    const offset = (page - 1) * limit
    return repo.findAll({ offset, limit, search, status, sortBy, sortOrder })
  }

  async getDetail(riderId) {
    return repo.findById(riderId)
  }

  async getEarnings(riderId, { startDate, endDate }) {
    return repo.getEarnings(riderId, { startDate, endDate })
  }

  async getPayouts(riderId) {
    return repo.getPayouts(riderId)
  }

  async createPayout(riderId, { amount, method, reference }, adminId, ip) {
    const payout = await repo.createPayout(riderId, amount, method, reference, adminId)
    logAdminActivity(adminId, 'CREATE_PAYOUT', 'rider', riderId, null, { amount, method }, ip)
    return payout
  }

  async toggleSuspend(riderId, suspended, adminId, ip) {
    const user = await repo.toggleSuspend(riderId, suspended)
    logAdminActivity(adminId, suspended ? 'SUSPEND_RIDER' : 'UNSUSPEND_RIDER', 'rider', riderId, null, null, ip)
    return user
  }

  async updateCommission(riderId, rate, adminId, ip) {
    const profile = await repo.updateCommission(riderId, rate)
    logAdminActivity(adminId, 'UPDATE_COMMISSION', 'rider', riderId, null, { rate }, ip)
    return profile
  }

  async approveRider(riderId, is_approved, adminId, ip) {
    const profile = await repo.approveRider(riderId, is_approved)
    logAdminActivity(adminId, is_approved ? 'APPROVE_RIDER' : 'UNAPPROVE_RIDER', 'rider', riderId, null, { is_approved }, ip)

    // R28.4 — fire-and-forget audit for rider_approved
    emitAudit('rider_approved', {
      actor_user_id: adminId,
      actor_role: 'ADMIN',
      actor_shop_id: null,
      target_type: 'rider',
      target_id: riderId,
      before: null,
      after: { is_approved },
      ip_address: ip || null,
    })

    if (is_approved) {
      await this._queueBacklogAssignScan('RIDER_APPROVED')
    }
    return profile
  }

  /**
   * Task 12.4: Transition is_approved false → true, rejecting a repeat
   * approval with a 409 conflict rather than silently no-op'ing.
   * Returns null if rider not found, { conflict, message } if already approved.
   */
  async transitionApprovalStatus(riderId, adminId, ip) {
    const profile = await repo.getApprovalStatus(riderId)
    if (!profile) return null

    if (profile.is_approved) {
      return {
        conflict: true,
        message: 'Cannot approve rider: already approved',
      }
    }

    const updated = await repo.setApprovalStatus(riderId)
    logAdminActivity(adminId, 'APPROVE_RIDER', 'rider', riderId, null, { is_approved: true }, ip)

    emitAudit('rider_approved', {
      actor_user_id: adminId,
      actor_role: 'ADMIN',
      actor_shop_id: null,
      target_type: 'rider',
      target_id: riderId,
      before: { is_approved: false },
      after: { is_approved: true },
      ip_address: ip || null,
    })

    await this._queueBacklogAssignScan('RIDER_APPROVED')
    return updated
  }

  async getDocuments(riderId) {
    return repo.getDocuments(riderId)
  }

  async verifyDocument(documentId, status, note, adminId, ip) {
    const doc = await repo.verifyDocument(documentId, status, note, adminId)
    logAdminActivity(adminId, 'VERIFY_DOCUMENT', 'rider_document', documentId, null, { status }, ip)
    return doc
  }

  async getLiveLocations() {
    return repo.getLiveLocations()
  }

  async _queueBacklogAssignScan(source) {
    try {
      await orderQueue.add(
        'auto-assign-backlog',
        {
          type: 'auto-assign-backlog',
          source,
          limit: 500,
        },
        {
          jobId: 'auto-assign-backlog-on-rider-approval',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    } catch (err) {
      logger.warn({ err, source }, 'Failed to queue rider approval backlog scan')
    }
  }
}
