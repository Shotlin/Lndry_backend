import { logger } from '../../config/logger.js'
import { redis } from '../../config/redis.js'
import { query } from '../../config/database.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ReferralsRepository } from './referrals.repository.js'
import { ReferralProgramsRepository } from '../admin/referral-programs/referral-programs.repository.js'
import { ReferralProgramsService } from '../admin/referral-programs/referral-programs.service.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { WalletService } from '../wallet/wallet.service.js'

const REDEEM_RATE_LIMIT_MAX = 5
const REDEEM_RATE_LIMIT_WINDOW_SECONDS = 600

/**
 * Referrals service — the actual Refer & Earn business logic: code
 * redemption at signup, reward-granting for both ON_SIGNUP and
 * ON_FIRST_ORDER_COMPLETE triggers, and the customer-facing "Refer & Earn"
 * dashboard data (GET /referrals/me, /me/history).
 */
export class ReferralsService {
  constructor(
    repository = new ReferralsRepository(),
    programsRepo = new ReferralProgramsRepository(),
    programsService = new ReferralProgramsService(programsRepo),
    couponsRepo = new CouponsRepository(),
    walletService = new WalletService(new WalletRepository())
  ) {
    this.repo = repository
    this.programsRepo = programsRepo
    this.programsService = programsService
    this.couponsRepo = couponsRepo
    this.walletService = walletService
  }

  /**
   * Redeem a referral code at signup. Called from users.service.js's
   * updateProfile — guarded there by `referred_by IS NULL` so this can
   * only ever succeed once per account. A missing/blank code is a silent
   * no-op (optional field); an invalid one is a soft failure the caller
   * surfaces as a friendly inline notice, never a hard signup blocker.
   */
  async redeemCode(newUserId, rawCode) {
    const code = (rawCode || '').trim().toUpperCase()
    if (!code) return { success: true, redeemed: false }

    const rateLimitKey = `referral_redeem:${newUserId}`
    const attempts = await redis.incr(rateLimitKey)
    if (attempts === 1) await redis.expire(rateLimitKey, REDEEM_RATE_LIMIT_WINDOW_SECONDS)
    if (attempts > REDEEM_RATE_LIMIT_MAX) {
      return { success: false, code: 'REFERRAL_CODE_INVALID', message: 'Too many attempts. Try again later.' }
    }

    const referrer = await this.repo.findUserByReferralCode(code)
    if (!referrer) {
      return { success: false, code: 'REFERRAL_CODE_INVALID', message: "That referral code doesn't look right." }
    }
    if (referrer.id === newUserId) {
      return { success: false, code: 'REFERRAL_SELF_NOT_ALLOWED', message: "You can't redeem your own referral code." }
    }

    const existing = await this.repo.findByRefereeId(newUserId)
    if (existing) {
      return { success: false, code: 'REFERRAL_ALREADY_REDEEMED', message: 'A referral code has already been redeemed on this account.' }
    }

    const program = await this.programsService.resolveActiveProgramForReferrer(referrer.id)

    let referrerCapped = false
    if (program?.maxReferralsPerReferrer != null) {
      const count = await this.repo.countByReferrer(referrer.id)
      referrerCapped = count >= program.maxReferralsPerReferrer
    }

    let referral
    try {
      referral = await this.repo.create({
        referrerId: referrer.id,
        refereeId: newUserId,
        referralProgramId: program?.id ?? null,
        referralCodeUsed: code,
      })
    } catch (err) {
      // Race: two concurrent redemption attempts for the same brand-new
      // account both passed the findByRefereeId check above before either
      // committed — the UNIQUE(referee_id) constraint is the real backstop.
      if (err && err.code === '23505') {
        return { success: false, code: 'REFERRAL_ALREADY_REDEEMED', message: 'A referral code has already been redeemed on this account.' }
      }
      throw err
    }

    await this._setReferredBy(newUserId, referrer.id)

    if (referrerCapped) {
      await this.repo.updateRewardStatus(referral.id, 'referrer', 'NOT_APPLICABLE')
    }

    if (program) {
      if (program.refereeTrigger === 'ON_SIGNUP') {
        await this._grantSide(referral, program, 'referee', newUserId)
      }
      if (program.referrerTrigger === 'ON_SIGNUP' && !referrerCapped) {
        await this._grantSide(referral, program, 'referrer', referrer.id)
      }
    }

    logger.info({ referralId: referral.id, referrerId: referrer.id, refereeId: newUserId }, 'Referral code redeemed')
    return { success: true, redeemed: true, referral }
  }

  async _setReferredBy(userId, referrerId) {
    await query('UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL', [referrerId, userId])
  }

  /**
   * Grant one side's reward for a referral program, switching on reward
   * type. Independently try/caught per side so a wallet-credit hiccup on
   * one side never blocks a coupon-unlock grant on the other.
   */
  async _grantSide(referral, program, side, userId) {
    const type = program[`${side}RewardType`]
    try {
      await this.grantReward(userId, type, {
        amount: program[`${side}RewardAmount`],
        count: program[`${side}RewardCount`],
        unlockCouponId: program[`${side}UnlockCouponId`],
      }, referral.id)
      await this.repo.updateRewardStatus(referral.id, side, 'GRANTED')
    } catch (err) {
      logger.warn({ err: err.message, referralId: referral.id, side, type }, 'Referral reward grant failed')
      await this.repo.updateRewardStatus(referral.id, side, 'FAILED')
    }
  }

  /** Switches on reward type and actually applies it. Throws on failure — callers decide how to handle. */
  async grantReward(userId, type, { amount, count, unlockCouponId }, referenceId) {
    switch (type) {
      case 'WALLET_CREDIT': {
        const result = await this.walletService.addMoney(userId, {
          amount: amount || 0,
          description: 'Referral reward',
          referenceId,
        })
        if (!result.success) throw new Error(result.message || 'Wallet credit failed')
        return
      }
      case 'FREE_EXPRESS_DELIVERY':
        return this.repo.grantCredit(userId, 'FREE_EXPRESS_DELIVERY', count || 1, referenceId)
      case 'FREE_STANDARD_DELIVERY':
        return this.repo.grantCredit(userId, 'FREE_STANDARD_DELIVERY', count || 1, referenceId)
      case 'COUPON_UNLOCK':
        if (!unlockCouponId) throw new Error('Missing unlockCouponId for COUPON_UNLOCK reward')
        return this.couponsRepo.addTargetUser(unlockCouponId, userId)
      default:
        throw new Error(`Unknown referral reward type: ${type}`)
    }
  }

  /**
   * Called from orders.service.js#placeOrderFromDraft's post-commit step —
   * mirrors the first-time-offer/cart-milestone deferred-grant pattern.
   * `orderId` is the buyer's own genuinely-first order (checked by the
   * caller via `isFirstOrder`); grants whichever side(s) are still
   * ON_FIRST_ORDER_COMPLETE-triggered and pending, then marks the referral
   * COMPLETED regardless (its status tracks "the referee's first order
   * happened", independent of when either side's reward was granted).
   */
  async completeReferral(referral, orderId) {
    await this.repo.markCompleted(referral.id, orderId)
    if (!referral.referralProgramId) return

    const program = await this.programsRepo.findById(referral.referralProgramId)
    if (!program) return

    if (program.refereeTrigger === 'ON_FIRST_ORDER_COMPLETE' && referral.refereeRewardStatus === 'PENDING') {
      await this._grantSide(referral, program, 'referee', referral.refereeId)
    }
    if (program.referrerTrigger === 'ON_FIRST_ORDER_COMPLETE' && referral.referrerRewardStatus === 'PENDING') {
      await this._grantSide(referral, program, 'referrer', referral.referrerId)
    }
  }

  /** Entry point for orders.service.js — no-ops cleanly if there's nothing to do. */
  async completeReferralForOrder(userId, orderId) {
    const referral = await this.repo.findPendingByRefereeId(userId)
    if (!referral) return
    const isFirstOrder = await this.repo.isFirstOrder(userId, orderId)
    if (!isFirstOrder) return
    await this.completeReferral(referral, orderId)
  }

  // ── Customer-facing dashboard data ──────────────────────────────────────────

  async getMySummary(userId) {
    const [referralCode, summary, program] = await Promise.all([
      this.repo.getReferralCode(userId),
      this.repo.getSummaryForReferrer(userId),
      this.programsService.resolveActiveProgramForReferrer(userId),
    ])
    return {
      referralCode,
      ...summary,
      activeProgram: program
        ? {
            id: program.id,
            name: program.name,
            referrerRewardType: program.referrerRewardType,
            referrerRewardAmount: program.referrerRewardAmount,
            referrerRewardCount: program.referrerRewardCount,
            referrerTrigger: program.referrerTrigger,
            refereeRewardType: program.refereeRewardType,
            refereeRewardAmount: program.refereeRewardAmount,
            refereeRewardCount: program.refereeRewardCount,
            refereeTrigger: program.refereeTrigger,
            termsText: program.termsText,
          }
        : null,
    }
  }

  async getMyHistory(userId, filters = {}) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))
    const { referrals, total } = await this.repo.findByReferrer(userId, { limit, offset })
    return { referrals, pagination: buildPagination({ page, limit, total }) }
  }

  // ── Admin monitoring (platform-wide, read-only) ─────────────────────────────

  async listAllAdmin(filters = {}) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))
    const { referrals, total } = await this.repo.findAllAdmin({ limit, offset, search: filters.search })
    return { referrals, pagination: buildPagination({ page, limit, total }) }
  }

  async getAdminSummary() {
    return this.repo.getAdminSummary()
  }
}
