import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { CartMilestonesRepository } from './cart-milestones.repository.js'
import { CustomerSegmentsRepository } from '../customer-segments/customer-segments.repository.js'
import { CouponsRepository } from '../../coupons/coupons.repository.js'

/**
 * Cart Milestones service. Ported from bakaloo-backend (see CLAUDE.md's
 * "Bakaloo Feature Port" section) — simplified for LNDRY: no CASHBACK
 * reward (wallet module is unwired, same call as first-time-offers) and no
 * FREE_DELIVERY reward (fee_settings.free_delivery_above already owns that
 * threshold, matching Bakaloo's own exclusion).
 */
export class CartMilestonesService {
  constructor(
    repository = new CartMilestonesRepository(),
    segmentsRepo = new CustomerSegmentsRepository(),
    couponsRepo = new CouponsRepository()
  ) {
    this.repo = repository
    this.segmentsRepo = segmentsRepo
    this.couponsRepo = couponsRepo
  }

  async listAll() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  /** Is this milestone visible/applicable to this user at all (independent of order value)? */
  async _isEligible(milestone, userId) {
    if (milestone.usageLimitPerUser != null) {
      const usage = await this.repo.getUserUsageCount(milestone.id, userId)
      if (usage >= milestone.usageLimitPerUser) return false
    }
    if (milestone.applicableUserType === 'FIRST_TIME') {
      return !(await this.repo.hasPriorOrder(userId))
    }
    if (milestone.applicableUserType === 'SEGMENT') {
      return milestone.applicableSegmentId
        ? this.segmentsRepo.isMember(milestone.applicableSegmentId, userId)
        : false
    }
    return true
  }

  /** All active milestones this user is eligible for, ordered ascending by tier. */
  async getEligibleTiers(userId) {
    const active = await this.repo.findAllActive()
    const eligible = []
    for (const m of active) {
      if (await this._isEligible(m, userId)) eligible.push(m)
    }
    return eligible
  }

  /** Resolve the best-fit (highest currently-satisfied) milestone reward for checkout, or null. */
  async resolveForCheckout(userId, orderTotal) {
    const eligible = await this.getEligibleTiers(userId)
    let best = null
    for (const m of eligible) {
      if (m.minOrderAmount <= orderTotal) {
        if (!best || m.minOrderAmount > best.minOrderAmount) best = m
      }
    }
    return best
  }

  /** Mirrors FirstTimeOffersService.computeReward — same shape convention. */
  computeReward(milestone, orderTotal) {
    switch (milestone.rewardType) {
      case 'FLAT_DISCOUNT':
        return { discount: Math.min(milestone.rewardValue || 0, orderTotal) }
      case 'COUPON_UNLOCK':
        return { unlockCouponId: milestone.unlockCouponId }
      default:
        return {}
    }
  }

  /**
   * Same gap as coupons.service.js's / first-time-offers' targeting: a
   * COUPON_UNLOCK reward only takes effect via coupon_target_users, which
   * coupons.service.js only consults when the coupon's targetType is
   * 'INDIVIDUAL'. Any other targetType makes the "unlock" a silent no-op —
   * catch it at save time instead of a customer discovering it at checkout.
   */
  async _validateCouponUnlock(data) {
    if (data.rewardType !== 'COUPON_UNLOCK') return null
    if (!data.unlockCouponId) {
      return 'unlockCouponId is required when rewardType is COUPON_UNLOCK'
    }
    const coupon = await this.couponsRepo.findById(data.unlockCouponId)
    if (!coupon) return 'Selected coupon was not found'
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `"${coupon.code}" must have its Target Audience set to "Specific customers" to work as a milestone reward — it's currently "${coupon.targetType}", so reaching this milestone would have no effect on who can use it.`
    }
    if (!coupon.isActive) {
      return `"${coupon.code}" is inactive — activate it before linking it as a milestone reward.`
    }
    return null
  }

  async create(data, actor) {
    if (!data.name || !data.rewardType || data.minOrderAmount == null) {
      return { success: false, message: 'name, rewardType and minOrderAmount are required' }
    }
    const couponError = await this._validateCouponUnlock(data)
    if (couponError) return { success: false, message: couponError }
    const milestone = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('cart_milestone_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: milestone.id,
      before: null,
      after: milestone,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ milestoneId: milestone.id, actor: actor.userId }, 'Cart milestone created')
    return { success: true, milestone }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Milestone not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validateCouponUnlock(merged)
    if (couponError) return { success: false, message: couponError }
    const milestone = await this.repo.update(id, data)
    emitAudit('cart_milestone_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: id,
      before: existing,
      after: milestone,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, milestone }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Milestone not found' }
    await this.repo.delete(id)
    emitAudit('cart_milestone_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  /** Record that a user has earned a milestone's reward for a specific order. */
  async recordUsage(milestoneId, userId, orderId) {
    return this.repo.recordUsage(milestoneId, userId, orderId)
  }
}
