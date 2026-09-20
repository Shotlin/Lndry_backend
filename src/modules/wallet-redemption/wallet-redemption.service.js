import bcrypt from 'bcrypt'
import { query, getClient } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { WalletRedemptionRepository } from './wallet-redemption.repository.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { requireWalletAccess } from '../vendors/vendor-tier.js'

const EXPIRY_MS = 5 * 60 * 1000 // 5 minutes — a real in-person handoff needs some time, but a long-lived pending approval is itself a small confusion/abuse surface
const MAX_ATTEMPTS = 5
const OTP_REDIS_PREFIX = 'wallet_redemption_otp:'

function redisKey(requestId) {
  return `${OTP_REDIS_PREFIX}${requestId}`
}

/**
 * Wallet Redemption service — a vendor looks a customer up by phone, proposes
 * redeeming part of their real LNDRY wallet balance against a counter sale,
 * and the customer confirms with a one-time code read off their own
 * already-logged-in app. See migration 112 for the full design rationale.
 */
export class WalletRedemptionService {
  constructor(repository = new WalletRedemptionRepository(), walletRepository = new WalletRepository()) {
    this.repo = repository
    this.walletRepo = walletRepository
  }

  /**
   * Phone lookup is a funded-account-balance oracle — the route layer
   * rate-limits it, and every call is audit-logged here regardless of
   * outcome, same treatment as store-orders' resolve-phone.
   */
  async lookupByPhone(phone, actor) {
    // A Standard vendor's POS has no LNDRY-wallet access (customers still pay with
    // their wallet in the app as usual) — refused before the lookup
    // happens, so a balance (or even the existence of an account) never leaks.
    await requireWalletAccess(actor?.vendorId)
    const user = await this.repo.findUserByPhone(phone)
    let balancePaise
    if (user) {
      const wallet = await this.walletRepo.getOrCreate(user.id)
      balancePaise = Math.round(wallet.balance * 100)
    }
    emitAudit('wallet_redemption_phone_lookup', {
      actor_user_id: actor?.userId ?? null,
      actor_role: actor?.role ?? null,
      target_type: 'user',
      target_id: user?.id ?? null,
      before: null,
      after: { phone, matched: Boolean(user), vendor_id: actor?.vendorId ?? null },
      ip_address: actor?.ip ?? null,
      user_agent: actor?.userAgent ?? null,
    })
    if (!user) return null
    return { userId: user.id, name: user.name, balancePaise }
  }

  async createRequest(vendorId, requestedByUserId, { customerUserId, amountPaise }, actor) {
    await requireWalletAccess(vendorId)
    if (!customerUserId || !Number.isFinite(amountPaise) || amountPaise <= 0) {
      throw { statusCode: 400, message: 'customerUserId and a positive amountPaise are required', code: 'VALIDATION_ERROR' }
    }

    const wallet = await this.walletRepo.getOrCreate(customerUserId)
    const amountRupees = amountPaise / 100
    if (wallet.balance < amountRupees) {
      throw { statusCode: 400, message: `Insufficient wallet balance. Requested ₹${amountRupees}, available ₹${wallet.balance}`, code: 'INSUFFICIENT_BALANCE' }
    }

    // Lazy-expiry sweep for this customer before the insert — see repo comment.
    await this.repo.expirePendingForCustomer(customerUserId)
    for (const staleId of await this.repo.cancelPendingForVendor(vendorId, customerUserId)) await redis.del(redisKey(staleId))

    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpHash = await bcrypt.hash(rawOtp, 12)
    const expiresAt = new Date(Date.now() + EXPIRY_MS)

    let created
    try {
      created = await this.repo.create({ customerUserId, vendorId, requestedByUserId, amountPaise, otpHash, expiresAt })
    } catch (err) {
      if (err.code === '23505') {
        throw { statusCode: 409, message: 'A wallet redemption is already in progress for this customer', code: 'REQUEST_ALREADY_PENDING' }
      }
      throw err
    }

    await redis.set(redisKey(created.id), rawOtp, 'EX', Math.ceil(EXPIRY_MS / 1000))

    emitAudit('wallet_redemption_requested', {
      actor_user_id: actor?.userId ?? null,
      actor_role: actor?.role ?? null,
      target_type: 'wallet_redemption_request',
      target_id: created.id,
      before: null,
      after: { customer_user_id: customerUserId, vendor_id: vendorId, amount_paise: amountPaise },
      ip_address: actor?.ip ?? null,
      user_agent: actor?.userAgent ?? null,
    })

    try {
      const { rows } = await query('SELECT name FROM vendors WHERE id = $1', [vendorId])
      const vendorName = rows[0]?.name || 'a Laundry Store'
      const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
      const { NotificationsService } = await import('../notifications/notifications.service.js')
      const notifService = new NotificationsService(new NotificationsRepository(), null)
      await notifService.sendNotification(customerUserId, {
        title: 'Wallet redemption request',
        body: `${vendorName} wants to redeem ₹${amountRupees} from your wallet. Open Wallet to see your code.`,
        type: 'WALLET_REDEMPTION_REQUESTED',
        data: { requestId: created.id, amountPaise, vendorId },
      })
    } catch (err) {
      logger.warn({ err: err.message, requestId: created.id }, 'Wallet-redemption-requested notification failed (non-critical)')
    }

    return { requestId: created.id, expiresAt: created.expiresAt }
  }

  /**
   * Customer-side poll — Cache-Control: no-store is set by the controller.
   * Ownership is implicit: this only ever looks up by the authenticated
   * customer's own id, never by an id the caller supplies.
   */
  async getPendingForCustomer(customerUserId) {
    await this.repo.expirePendingForCustomer(customerUserId)
    const request = await this.repo.findPendingForCustomer(customerUserId)
    if (!request) return null
    const otp = await redis.get(redisKey(request.id))
    return {
      requestId: request.id,
      amountPaise: request.amountPaise,
      vendorName: request.vendorName,
      otp: otp || null,
      expiresAt: request.expiresAt,
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - request.attemptCount),
    }
  }

  async confirmRequest(requestId, vendorId, rawOtp, actor) {
    // Re-checked at confirm time: a vendor moved to Standard while a request was
    // pending must not be able to finish the debit.
    await requireWalletAccess(vendorId)
    if (!rawOtp || typeof rawOtp !== 'string') {
      throw { statusCode: 400, message: 'otp is required', code: 'VALIDATION_ERROR' }
    }

    const request = await this.repo.findByIdForVendor(requestId, vendorId)
    if (!request) {
      throw { statusCode: 404, message: 'Wallet redemption request not found', code: 'REQUEST_NOT_FOUND' }
    }
    if (request.status !== 'PENDING') {
      throw { statusCode: 409, message: 'This request is no longer pending', code: 'REQUEST_ALREADY_DECIDED_OR_EXPIRED' }
    }
    if (new Date(request.expiresAt) <= new Date()) {
      await this.repo.markExpired(requestId)
      throw { statusCode: 409, message: 'This request has expired', code: 'REQUEST_ALREADY_DECIDED_OR_EXPIRED' }
    }
    if (request.attemptCount >= MAX_ATTEMPTS) {
      await this.repo.markRejected(requestId)
      throw { statusCode: 400, message: 'Verification locked. Too many failed attempts.', code: 'OTP_LOCKED' }
    }

    const isMatch = await bcrypt.compare(rawOtp, request.otpHash)
    if (!isMatch) {
      const newAttempts = request.attemptCount + 1
      if (newAttempts >= MAX_ATTEMPTS) {
        await this.repo.markRejected(requestId)
        await redis.del(redisKey(requestId))
        throw { statusCode: 400, message: 'Verification locked. Too many failed attempts.', code: 'OTP_LOCKED' }
      }
      await this.repo.incrementAttempt(requestId, newAttempts)
      const remaining = MAX_ATTEMPTS - newAttempts
      throw { statusCode: 400, message: `Invalid code. ${remaining} attempt(s) remaining.`, code: 'INVALID_OTP', attemptsRemaining: remaining }
    }

    // Correct code — atomic claim + debit, all in one transaction.
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const claimed = await this.repo.claimForConfirm(client, requestId, vendorId)
      if (!claimed) {
        await client.query('ROLLBACK')
        throw { statusCode: 409, message: 'This request is no longer pending', code: 'REQUEST_ALREADY_DECIDED_OR_EXPIRED' }
      }

      const wallet = await this.walletRepo.getForUpdate(client, claimed.customerUserId)
      if (!wallet) {
        await client.query('ROLLBACK')
        throw { statusCode: 404, message: 'Wallet not found', code: 'WALLET_NOT_FOUND' }
      }

      const amountRupees = claimed.amountPaise / 100
      let debitResult
      try {
        debitResult = await this.walletRepo.debit(client, wallet.id, amountRupees, `Wallet redemption at Laundry Store`, requestId)
      } catch (err) {
        await client.query('ROLLBACK')
        throw { statusCode: 409, message: 'Insufficient wallet balance', code: 'INSUFFICIENT_BALANCE' }
      }

      await this.repo.attachWalletTransaction(client, requestId, debitResult.transaction.id)
      await client.query('COMMIT')

      await redis.del(redisKey(requestId))

      emitAudit('wallet_redemption_confirmed', {
        actor_user_id: actor?.userId ?? null,
        actor_role: actor?.role ?? null,
        target_type: 'wallet_redemption_request',
        target_id: requestId,
        before: null,
        after: { customer_user_id: claimed.customerUserId, vendor_id: vendorId, amount_paise: claimed.amountPaise, wallet_transaction_id: debitResult.transaction.id },
        ip_address: actor?.ip ?? null,
        user_agent: actor?.userAgent ?? null,
      })

      return {
        requestId,
        amountPaise: claimed.amountPaise,
        walletTransactionId: debitResult.transaction.id,
        newBalance: debitResult.wallet.balance,
      }
    } finally {
      client.release()
    }
  }

  async cancelRequest(requestId, vendorId) {
    const cancelled = await this.repo.cancelPending(requestId, vendorId)
    if (!cancelled) {
      throw { statusCode: 409, message: 'This request is no longer pending', code: 'REQUEST_ALREADY_DECIDED_OR_EXPIRED' }
    }
    await redis.del(redisKey(requestId))
    return { cancelled: true }
  }
}
