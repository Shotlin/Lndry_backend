import { redis } from '../../../config/redis.js'
import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { AccountDeletionRepository } from './account-deletion.repository.js'

/** Days between admin approval and the permanent anonymization. */
export const ACCOUNT_DELETION_GRACE_DAYS = 30

const REFRESH_TOKEN_PREFIX = 'refresh:'

export class AccountDeletionService {
  constructor(repository = new AccountDeletionRepository()) {
    this.repo = repository
  }

  // ── Customer side ──────────────────────────────────────────────────────────

  async requestDeletion(userId, reason) {
    const user = await this.repo.findUser(userId)
    if (!user || !user.is_active) {
      return { success: false, code: 'NOT_FOUND', message: 'Account not found' }
    }

    const current = await this.repo.findCurrentForUser(userId)
    if (current && (current.status === 'PENDING' || current.status === 'APPROVED')) {
      return {
        success: false,
        code: 'DELETION_ALREADY_REQUESTED',
        message: 'You have already requested account deletion.',
      }
    }

    try {
      const request = await this.repo.create({
        userId,
        reason: reason?.trim() || null,
        customerName: user.name,
        customerPhone: user.phone,
      })
      emitAudit('account_deletion_requested', {
        actor_user_id: userId,
        actor_role: 'CUSTOMER',
        target_type: 'account_deletion_request',
        target_id: request.id,
        before: null,
        after: { id: request.id, status: request.status },
      })
      return { success: true, request }
    } catch (err) {
      // uq_account_deletion_open_per_user: a double-tap raced past the check.
      if (err.code === '23505') {
        return {
          success: false,
          code: 'DELETION_ALREADY_REQUESTED',
          message: 'You have already requested account deletion.',
        }
      }
      throw err
    }
  }

  getMyRequest(userId) {
    return this.repo.findCurrentForUser(userId)
  }

  // ── Admin side ─────────────────────────────────────────────────────────────

  async list({ status, search, page = 1, limit = 20 }) {
    const [{ rows, total }, counts] = await Promise.all([
      this.repo.list({ status, search: search?.trim() || undefined, page, limit }),
      this.repo.statusCounts(),
    ])
    return {
      requests: rows,
      counts,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    }
  }

  async approve(id, note, actor) {
    const result = await this.repo.approve(id, {
      adminId: actor.userId,
      note: note?.trim() || null,
      graceDays: ACCOUNT_DELETION_GRACE_DAYS,
    })
    if (result.code) return { success: false, ...this._refusal(result) }

    // Kill the refresh token so the session can't be silently renewed. Access
    // tokens are already dead: approve() bumped users.session_version.
    try {
      await redis.del(`${REFRESH_TOKEN_PREFIX}${result.userId}`)
    } catch (err) {
      logger.warn({ err: err.message, userId: result.userId }, 'Refresh-token cleanup failed on deletion approval')
    }

    emitAudit('account_deletion_approved', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'account_deletion_request',
      target_id: id,
      before: { status: 'PENDING' },
      after: { status: 'APPROVED', scheduledDeletionAt: result.request.scheduledDeletionAt },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ requestId: id, admin: actor.userId }, 'Account deletion approved')
    return { success: true, request: result.request }
  }

  async reject(id, note, actor) {
    const result = await this.repo.reject(id, { adminId: actor.userId, note: note?.trim() || null })
    if (result.code) return { success: false, ...this._refusal(result) }

    emitAudit('account_deletion_rejected', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'account_deletion_request',
      target_id: id,
      before: { status: 'PENDING' },
      after: { status: 'REJECTED' },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, request: result.request }
  }

  _refusal(result) {
    switch (result.code) {
      case 'NOT_FOUND':
        return { code: 'NOT_FOUND', message: 'Deletion request not found' }
      case 'INVALID_STATE':
        return {
          code: 'INVALID_STATE',
          message: `This request has already been ${String(result.status).toLowerCase()}.`,
        }
      case 'ACTIVE_ORDERS_EXIST':
        return {
          code: 'ACTIVE_ORDERS_EXIST',
          message: `This customer has ${result.count} order(s) still in progress. Approve once they are finished, or reject the request.`,
        }
      case 'HAS_STAFF_ROLE':
        return {
          code: 'HAS_STAFF_ROLE',
          message: 'This phone number is also an active vendor/captain login. Deleting it would lock them out of that role, so it cannot be approved here.',
        }
      default:
        return { code: 'ERROR', message: 'Could not process the request' }
    }
  }
}
