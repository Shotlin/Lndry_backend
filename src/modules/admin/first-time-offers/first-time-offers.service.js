import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { FirstTimeOffersRepository } from './first-time-offers.repository.js'
import { CouponsRepository } from '../../coupons/coupons.repository.js'

/**
 * First-Time Offers service. Ported from bakaloo-backend (see CLAUDE.md's
 * "Bakaloo Feature Port" section) — simplified for LNDRY: no cart-item
 * scoping (a laundry order is priced off a single vendor quote, not a
 * multi-item cart) and no WALLET_CASHBACK reward (wallet module is
 * unwired).
 */
export class FirstTimeOffersService {
  constructor(repository = new FirstTimeOffersRepository(), couponsRepo = new CouponsRepository()) {
    this.repo = repository
    this.couponsRepo = couponsRepo
  }

  async listAll() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  /**
   * Resolve the best-fit first-time offer for an order, or null if the user
   * isn't first-time or no offer currently qualifies. Single source of
   * truth for orders.service.js#prepareOrder — never re-derive first-order
   * status separately.
   */
  async resolveForCheckout(userId, orderTotal) {
    const hasPriorOrder = await this.repo.hasPriorOrder(userId)
    if (hasPriorOrder) return null
    const { best } = await this._evaluateCandidates(orderTotal)
    return best
  }

  /**
   * Evaluates every active/date-valid offer against the order total,
   * returning the best currently-satisfied one (highest min_order_amount
   * that still clears — "bigger order, better reward").
   */
  async _evaluateCandidates(orderTotal) {
    const candidates = await this.repo.findAllActiveCandidates()
    let best = null
    for (const offer of candidates) {
      if (orderTotal >= offer.minOrderAmount) {
        if (!best || offer.minOrderAmount > best.minOrderAmount) {
          best = offer
        }
      }
    }
    return { best }
  }

  /**
   * Translate an offer + order total into a concrete reward effect.
   * `deliveryFee` (rupees) is required for FREE_DELIVERY — LNDRY's fee
   * engine has no "waive delivery" flag, so a FREE_DELIVERY reward is
   * applied as an extra discount equal to the already-computed delivery
   * fee (see orders.service.js#prepareOrder).
   */
  computeReward(offer, orderTotal, deliveryFee = 0) {
    switch (offer.rewardType) {
      case 'FREE_DELIVERY':
        return { freeDelivery: true, deliveryFeeAmount: deliveryFee }
      case 'FLAT_DISCOUNT':
        return { discount: Math.min(offer.rewardValue || 0, orderTotal) }
      case 'PERCENTAGE_DISCOUNT': {
        let discount = (orderTotal * (offer.rewardValue || 0)) / 100
        if (offer.maxDiscount) discount = Math.min(discount, offer.maxDiscount)
        return { discount: Math.min(discount, orderTotal) }
      }
      case 'COUPON_UNLOCK':
        return { unlockCouponId: offer.unlockCouponId }
      default:
        return {}
    }
  }

  /**
   * Same gap as coupons.service.js's targeting: a COUPON_UNLOCK reward only
   * takes effect via coupon_target_users, which coupons.service.js only
   * consults when the coupon's targetType is 'INDIVIDUAL'. Any other
   * targetType makes the "unlock" a silent no-op.
   */
  async _validateCouponUnlock(data) {
    if (data.rewardType !== 'COUPON_UNLOCK') return null
    if (!data.unlockCouponId) {
      return 'unlockCouponId is required when rewardType is COUPON_UNLOCK'
    }
    const coupon = await this.couponsRepo.findById(data.unlockCouponId)
    if (!coupon) return 'Selected coupon was not found'
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `"${coupon.code}" must have its Target Audience set to "Specific customers" to work as a first-time-offer reward — it's currently "${coupon.targetType}", so unlocking it would have no effect on who can use it.`
    }
    if (!coupon.isActive) {
      return `"${coupon.code}" is inactive — activate it before linking it as a first-time-offer reward.`
    }
    return null
  }

  async create(data, actor) {
    if (!data.name || !data.rewardType) {
      return { success: false, message: 'name and rewardType are required' }
    }
    const couponError = await this._validateCouponUnlock(data)
    if (couponError) return { success: false, message: couponError }
    const offer = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('first_time_offer_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'first_time_offer',
      target_id: offer.id,
      before: null,
      after: offer,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ offerId: offer.id, actor: actor.userId }, 'First-time offer created')
    return { success: true, offer }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Offer not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validateCouponUnlock(merged)
    if (couponError) return { success: false, message: couponError }
    const offer = await this.repo.update(id, data)
    emitAudit('first_time_offer_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'first_time_offer',
      target_id: id,
      before: existing,
      after: offer,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, offer }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Offer not found' }
    await this.repo.delete(id)
    emitAudit('first_time_offer_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'first_time_offer',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }
}
