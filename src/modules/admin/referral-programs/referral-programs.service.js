import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { ReferralProgramsRepository } from './referral-programs.repository.js'
import { CustomerSegmentsRepository } from '../customer-segments/customer-segments.repository.js'
import { CouponsRepository } from '../../coupons/coupons.repository.js'

const REWARD_TYPES = ['WALLET_CREDIT', 'FREE_EXPRESS_DELIVERY', 'FREE_STANDARD_DELIVERY', 'COUPON_UNLOCK']

/**
 * Referral Programs service — admin-configured Refer & Earn campaigns.
 * Multiple programs can be simultaneously active; resolveActiveProgramForReferrer
 * picks the one that actually applies to a given referrer at redemption time,
 * reusing the same segment-targeting infra as Coupons/Cart-Milestones.
 */
export class ReferralProgramsService {
  constructor(
    repository = new ReferralProgramsRepository(),
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

  /** Is this active/in-range program eligible for this specific referrer? */
  async _isEligibleForReferrer(program, referrerId) {
    if (program.targetType === 'SEGMENT') {
      return program.targetSegmentId
        ? this.segmentsRepo.isMember(program.targetSegmentId, referrerId)
        : false
    }
    return true
  }

  /**
   * Resolve which active program applies to a referral where `referrerId`
   * is the person whose code is being redeemed — highest priority among
   * every active, in-date-range, eligible program wins; ties break by most
   * recently created. Used both at redemption time (to snapshot onto the
   * new referrals row) and by GET /referrals/me (so what a referrer is
   * shown always matches what they'd actually get).
   */
  async resolveActiveProgramForReferrer(referrerId) {
    const candidates = await this.repo.findAllActiveInRange()
    for (const program of candidates) {
      if (await this._isEligibleForReferrer(program, referrerId)) {
        return program
      }
    }
    return null
  }

  /**
   * A COUPON_UNLOCK reward only has effect via coupon_target_users, which
   * coupons.service.js only consults for an INDIVIDUAL-targeted coupon —
   * same validation cart-milestones/first-time-offers already apply.
   */
  async _validateCouponUnlock(rewardType, unlockCouponId, sideLabel) {
    if (rewardType !== 'COUPON_UNLOCK') return null
    if (!unlockCouponId) {
      return `${sideLabel} unlockCouponId is required when rewardType is COUPON_UNLOCK`
    }
    const coupon = await this.couponsRepo.findById(unlockCouponId)
    if (!coupon) return `${sideLabel}: selected coupon was not found`
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `${sideLabel}: "${coupon.code}" must have its Target Audience set to "Specific customers" to work as a referral reward — it's currently "${coupon.targetType}".`
    }
    if (!coupon.isActive) {
      return `${sideLabel}: "${coupon.code}" is inactive — activate it before linking it as a referral reward.`
    }
    return null
  }

  async _validate(data) {
    if (!data.name) return 'name is required'
    if (!REWARD_TYPES.includes(data.referrerRewardType)) return 'referrerRewardType is invalid'
    if (!REWARD_TYPES.includes(data.refereeRewardType)) return 'refereeRewardType is invalid'
    if (data.targetType === 'SEGMENT' && !data.targetSegmentId) {
      return 'targetSegmentId is required when targetType is SEGMENT'
    }
    const referrerCouponError = await this._validateCouponUnlock(
      data.referrerRewardType, data.referrerUnlockCouponId, 'Referrer reward'
    )
    if (referrerCouponError) return referrerCouponError
    const refereeCouponError = await this._validateCouponUnlock(
      data.refereeRewardType, data.refereeUnlockCouponId, 'Referee reward'
    )
    if (refereeCouponError) return refereeCouponError
    return null
  }

  async create(data, actor) {
    const validationError = await this._validate(data)
    if (validationError) return { success: false, message: validationError }
    const program = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('referral_program_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'referral_program',
      target_id: program.id,
      before: null,
      after: program,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ programId: program.id, actor: actor.userId }, 'Referral program created')
    return { success: true, program }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Referral program not found' }
    const merged = { ...existing, ...data }
    const validationError = await this._validate(merged)
    if (validationError) return { success: false, message: validationError }
    const program = await this.repo.update(id, data)
    emitAudit('referral_program_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'referral_program',
      target_id: id,
      before: existing,
      after: program,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, program }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Referral program not found' }
    await this.repo.delete(id)
    emitAudit('referral_program_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'referral_program',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }
}
