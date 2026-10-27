import { resolveShopAssignments } from './shop-assignment.js'
import crypto from 'node:crypto'
import { generateOTP, storeOTP, verifyOTP } from '../../utils/otp.js'
import { sendSmsOtp, verifySmsOtp } from '../../utils/sms.js'
import { getSmsConfig } from '../../utils/sms-config.js'
import { generateTokenPair, signAccessToken, signRefreshToken, verifyToken } from '../../utils/jwt.js'
import { orderQueue } from '../../config/bullmq.js'
import { redis } from '../../config/redis.js'
import { storeRefreshToken, isRefreshTokenValid, revokeRefreshToken, revokeAllRefreshTokens, ROTATION_GRACE_SECONDS } from './refresh-token-store.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { query } from '../../config/database.js'

const SMS_SESSION_PREFIX = 'sms:session:'
// Short-lived token issued when a staff member logs in but has multiple shop
// assignments and must select one before getting a full session JWT.
// Requirement 13.3
const TEMP_TOKEN_EXPIRY = '10m'
// Wrong-code guesses allowed per OTP challenge, and per phone before a lock.
const MAX_CHALLENGE_ATTEMPTS = 3
const MAX_PHONE_FAILURES = 10

function normalizePhoneForOtp(phone) {
  const digits = `${phone || ''}`.replace(/\D/g, '')
  if (digits.startsWith('91') && digits.length === 12) return digits.slice(2)
  return digits
}

/**
 * Auth service — business logic for authentication
 */
export class AuthService {
  constructor(repository) {
    this.repo = repository
  }

  _isDemoOtpEnabled() {
    // Hard-blocked in production regardless of the flag, matching the mock
    // payments / mock maps pattern — defense-in-depth against a
    // misconfigured ALLOW_DEMO_OTP in prod, not just relying on the
    // template defaulting it to false.
    if (env.NODE_ENV === 'production') return false
    return env.ALLOW_DEMO_OTP && Boolean(env.DEMO_OTP_PHONE)
  }

  _isDemoOtpPhone(phone) {
    if (!this._isDemoOtpEnabled()) return false
    return normalizePhoneForOtp(phone) === normalizePhoneForOtp(env.DEMO_OTP_PHONE)
  }

  /**
   * Narrow, NODE_ENV-independent bypass (see TEST_BYPASS_OTP_PHONES in
   * env.js) — deliberately separate from _isDemoOtpEnabled so it is not
   * affected by the hard `NODE_ENV === 'production'` block there.
   * Everything else about production behavior (Razorpay/Maps guards,
   * error verbosity, etc.) is untouched.
   *
   * TEST_BYPASS_OTP_PHONES accepts either:
   *   - a comma-separated allowlist of specific numbers, or
   *   - the literal value '*' to bypass for ANY phone number.
   * The '*' form only exists to unblock pre-launch development/testing
   * before a real SMS provider is wired up (TWO_FACTOR_API_KEY) — it
   * must be cleared once one is, since it lets anyone log in as any
   * phone number registered on the platform without owning that phone.
   */
  _isTestBypassPhone(phone) {
    if (!env.TEST_BYPASS_OTP_PHONES) return false
    if (env.TEST_BYPASS_OTP_PHONES.trim() === '*') return true
    const allowed = env.TEST_BYPASS_OTP_PHONES.split(',').map((p) => normalizePhoneForOtp(p.trim()));
    return allowed.includes(normalizePhoneForOtp(phone))
  }

  /**
   * Count a failed verification against the phone itself and lock the phone
   * out of verifying for OTP_LOCKOUT_SECONDS once it crosses the threshold.
   */
  async _recordOtpFailure(phone, lockKey) {
    const failKey = `otp:verify_fail:${phone}`
    const [, [, failures]] = await redis
      .multi()
      .set(failKey, 0, 'EX', env.OTP_LOCKOUT_SECONDS, 'NX')
      .incr(failKey)
      .exec()
    if (failures >= MAX_PHONE_FAILURES) {
      await redis.set(lockKey, '1', 'EX', env.OTP_LOCKOUT_SECONDS)
      await redis.del(failKey)
      logger.warn({ phone: phone.slice(-4) }, 'Phone locked out of OTP verification after repeated failures')
    }
  }

  /**
   * Send OTP to a phone number
   * Production: sends via 2Factor.in SMS
   * Development: returns OTP in response for testing
   *
   * SECURITY: the locally stored challenge hash must NEVER be derived from a
   * guessable value for a real phone. When the SMS provider delivers the code
   * (2Factor generates it), the local hash is built from random bytes nobody
   * knows, so the local-compare fallback in verifyOtp can't be satisfied by
   * typing a well-known code like 123456.
   */
  async sendOtp(phone, accountType = 'CUSTOMER') {
    // Rate limit: max 5 OTP requests per phone per 10 minutes. Numbers on the
    // TEST_BYPASS_OTP_PHONES list (fixed OTP, no SMS sent, so nothing to abuse) are exempt
    // so testers can request codes as often as they like.
    const isTestBypass = this._isTestBypassPhone(phone)
    if (!isTestBypass) {
      const rateLimitKey = `otp_limit:${phone}`
      // INCR + EXPIRE as one atomic unit so a crash between them can never
      // leave a counter with no TTL (a permanent lock-out for that phone).
      const [, [, rateCount]] = await redis
        .multi()
        .set(rateLimitKey, 0, 'EX', 600, 'NX')
        .incr(rateLimitKey)
        .exec()
      if (rateCount > 5) {
        throw { statusCode: 429, message: 'Too many OTP requests. Please wait 10 minutes.', code: 'RATE_LIMIT_EXCEEDED' }
      }
    }

    const isProduction = env.NODE_ENV === 'production'
    let otpCode = null
    let isDemo = false
    const smsConfig = await getSmsConfig()

    if (this._isDemoOtpPhone(phone)) {
      otpCode = env.DEMO_OTP_CODE || '123456'
      isDemo = true
      await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      logger.info({ phone: phone.slice(-4) }, 'Demo OTP bypass used')
    } else if (isTestBypass) {
      otpCode = '123456'
      await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      logger.info({ phone: phone.slice(-4) }, 'Test-bypass OTP phone used')
    } else if (smsConfig || (isProduction && env.SMS_PROVIDER === '2factor')) {
      const smsResult = await sendSmsOtp(phone)
      if (smsResult.success) {
        await redis.set(
          `${SMS_SESSION_PREFIX}${phone}`,
          smsResult.sessionId,
          'EX',
          env.OTP_EXPIRY_SECONDS
        )
        // Unknown-to-everyone secret: only the SMS provider's own verify call
        // can approve this login.
        otpCode = crypto.randomBytes(16).toString('hex')
        logger.info({ phone: phone.slice(-4) }, 'OTP sent via 2Factor SMS')
      } else if (isProduction) {
        // Never pretend an OTP was sent when it wasn't — the user would wait
        // for an SMS that is never coming.
        logger.error({ phone: phone.slice(-4) }, '2Factor SMS failed — OTP not delivered')
        throw { statusCode: 503, message: 'We could not send the OTP right now. Please try again in a minute.', code: 'OTP_DELIVERY_FAILED' }
      }
    } else if (isProduction) {
      logger.error('OTP requested in production but no SMS provider is configured')
      throw { statusCode: 503, message: 'OTP service is temporarily unavailable. Please try again later.', code: 'OTP_UNAVAILABLE' }
    }

    // Development only: no SMS provider → locally generated code, echoed back.
    if (otpCode === null) {
      otpCode = generateOTP()
    }

    const otpHash = crypto.createHash('sha256').update(otpCode).digest('hex')
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    const challenge = await this.repo.createOtpChallenge({
      phone,
      otpHash,
      accountType: accountType || 'CUSTOMER',
      expiresAt
    })

    // Store in Redis for legacy helper verifyOTP compatibility
    await storeOTP(phone, otpCode)

    logger.info({ phone: phone.slice(-4) }, 'OTP challenge created')

    const data = {
      challenge_id: challenge.id,
      expires_in: 300,
    }

    // The code is only ever echoed back outside production. (A fixed test /
    // review code is known to the tester already; echoing it from a public
    // endpoint would let anyone who knows the number log in.)
    if (!isProduction && (env.NODE_ENV === 'development' || isDemo || isTestBypass)) {
      data.otp = otpCode
    }

    return data
  }

  /**
   * Verify OTP and return JWT tokens
   */
  async verifyOtp(phone, challengeIdOrOtp, otpOrRole, deviceOrRole) {
    let challengeId = null
    let otp = null
    let role = null
    let device = null

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

    // Detect if we are in new challengeId flow or legacy flow
    if (typeof challengeIdOrOtp === 'string' && uuidRegex.test(challengeIdOrOtp)) {
      challengeId = challengeIdOrOtp
      otp = otpOrRole
      device = deviceOrRole
    } else {
      otp = challengeIdOrOtp
      role = otpOrRole
      // Fallback: look up latest challenge for the phone from DB
      const result = await query(
        `SELECT id, account_type FROM otp_challenges WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
        [phone]
      )
      const rows = result?.rows || []
      if (rows[0]) {
        challengeId = rows[0].id
        if (!role) role = rows[0].account_type
      }
    }

    // Phone-level lock that outlives any single challenge: without it an
    // attacker could burn a challenge (3 guesses), request a fresh one and
    // keep guessing indefinitely.
    const isTestBypass = this._isTestBypassPhone(phone)
    const verifyLockKey = `otp:verify_lock:${phone}`
    if (!isTestBypass && (await redis.get(verifyLockKey))) {
      return { success: false, message: 'Too many failed attempts. Please try again after some time.' }
    }

    const challenge = challengeId ? await this.repo.getOtpChallenge(challengeId, phone) : null
    if (!challenge) {
      // If challenge not found in DB, try direct Redis verification for fallback compatibility
      const result = await verifyOTP(phone, otp)
      if (!result.valid) {
        return { success: false, message: result.message || 'OTP challenge not found or invalid' }
      }
    } else {
      if (new Date(challenge.expires_at) <= new Date()) {
        await this.repo.deleteOtpChallenge(challenge.id)
        return { success: false, message: 'OTP expired. Request a new one.' }
      }

      // Reserve an attempt ATOMICALLY before looking at the code. Counting
      // after the comparison let a burst of parallel requests each read
      // attempts=0 and all get evaluated, so the "3 attempts" cap did not
      // hold against concurrent guessing.
      const reserved = await this.repo.reserveOtpAttempt(challenge.id, phone, MAX_CHALLENGE_ATTEMPTS)
      if (!reserved) {
        await this.repo.deleteOtpChallenge(challenge.id)
        await redis.del(`otp:${phone}`)
        return { success: false, message: 'Too many failed attempts. Locked out.' }
      }

      let otpValid = false
      if (this._isDemoOtpPhone(phone)) {
        if (`${otp || ''}`.trim() === (env.DEMO_OTP_CODE || '123456')) {
          otpValid = true
          await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
        }
      }

      const sessionId = otpValid ? null : await redis.get(`${SMS_SESSION_PREFIX}${phone}`)
      if (sessionId && !otpValid) {
        const smsResult = await verifySmsOtp(sessionId, otp)
        if (smsResult.success) {
          otpValid = true
          await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
        }
      }

      if (!otpValid) {
        // Constant-time compare of the stored hash (the hash is never a
        // guessable value for SMS-delivered codes — see sendOtp).
        const hashedInput = crypto.createHash('sha256').update(`${otp || ''}`).digest()
        const stored = Buffer.from(challenge.otp_hash || '', 'hex')
        if (stored.length === hashedInput.length && crypto.timingSafeEqual(stored, hashedInput)) {
          otpValid = true
        }
      }

      if (!otpValid) {
        if (!isTestBypass) await this._recordOtpFailure(phone, verifyLockKey)
        if (reserved.attempts >= MAX_CHALLENGE_ATTEMPTS) {
          await this.repo.deleteOtpChallenge(challenge.id)
          await redis.del(`otp:${phone}`)
          return { success: false, message: 'Too many failed attempts. Locked out.' }
        }
        return { success: false, message: `Invalid OTP. ${MAX_CHALLENGE_ATTEMPTS - reserved.attempts} attempts remaining.` }
      }

      await this.repo.deleteOtpChallenge(challenge.id)
      await redis.del(`otp:${phone}`, `otp:verify_fail:${phone}`)
    }

    // Normalize role: RIDER, DELIVERY → 'RIDER' (canonical value)
    const requestedRole = (role === 'RIDER' || role === 'DELIVERY' || challenge?.account_type === 'RIDER') ? 'RIDER' : 'CUSTOMER'

    // Find or create user
    let user = await this.repo.findByPhone(phone)
    let isNewUser = false

    if (!user) {
      user = await this.repo.createUser(phone, requestedRole)
      isNewUser = true
      logger.info({ userId: user.id, role: user.role }, 'New user registered')

      if (user.role === 'RIDER') {
        await this.repo.ensureRiderProfile(user.id)
        logger.info({ userId: user.id }, 'Auto-created rider_profile for new rider')
      }
    } else if (requestedRole === 'RIDER' && user.role === 'CUSTOMER') {
      await this.repo.updateRole(user.id, 'RIDER')
      user.role = 'RIDER'
      await this.repo.ensureRiderProfile(user.id)
      logger.info({ userId: user.id }, 'Upgraded CUSTOMER to RIDER with rider_profile')
    }

    if (!user.is_active) {
      // Approved for deletion: deactivated during the 30-day grace period.
      if (user.deletion_scheduled_at) {
        return {
          success: false,
          message: 'This account has been closed and is scheduled for deletion. Contact support if this is a mistake.',
        }
      }
      return { success: false, message: 'Your account has been blocked. Contact support.' }
    }

    // Register device if details are provided
    if (device && device.device_id) {
      await this.repo.registerDevice({
        userId: user.id,
        deviceId: device.device_id,
        platform: device.platform || 'UNKNOWN',
        fcmToken: device.fcm_token || '',
        appVersion: device.app_version || '',
        deviceModel: device.device_model || null
      })
    }

    // Determine roles linked to this phone
    const roles = [user.role]
    let staffAssignments = []
    if (user.role !== 'RIDER') {
      try {
        staffAssignments = resolveShopAssignments(
          await this.repo.findActiveShopStaffByUserId(user.id)
        )
        for (const assign of staffAssignments) {
          if (!roles.includes(assign.role)) {
            roles.push(assign.role)
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, userId: user.id }, 'Shop staff lookup failed')
      }
    }

    if (staffAssignments.length === 1 && !role) {
      // Single shop and no role specified → issue shop-scoped JWT directly
      const assignment = staffAssignments[0]
      const accessToken = signAccessToken(
        {
          id: user.id,
          phone: user.phone,
          role: user.role,
          shopId: assignment.vendor_id,
          shopRole: assignment.role,
          permissions: assignment.permissions || [],
        },
        { expiresIn: '24h' }
      )
      const refreshToken = signRefreshToken({
        id: user.id,
        phone: user.phone,
        role: user.role,
      })
      await storeRefreshToken(user.id, refreshToken)

      logger.info(
        {
          userId: user.id,
          shopId: assignment.vendor_id,
          shopRole: assignment.role,
          action: 'staff_login_auto_scope',
        },
        'Shop staff auto-scoped to single shop'
      )

      return {
        success: true,
        accessToken,
        refreshToken,
        roles,
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
          isVerified: false,
          vendor_id: assignment.vendor_id,
          shop_role: assignment.role,
          permissions: assignment.permissions || [],
        },
      }
    }

    if (staffAssignments.length > 1 && !role) {
      // Multiple vendors and no role specified → require selection
      const tempToken = signAccessToken(
        {
          id: user.id,
          phone: user.phone,
          role: user.role,
          requires_shop_selection: true,
        },
        { expiresIn: TEMP_TOKEN_EXPIRY }
      )

      logger.info(
        {
          userId: user.id,
          shopCount: staffAssignments.length,
          action: 'staff_login_requires_selection',
        },
        'Shop staff has multiple vendors — selection required'
      )

      return {
        success: true,
        requires_shop_selection: true,
        temp_token: tempToken,
        roles,
        vendors: staffAssignments.map((a) => ({
          vendor_id: a.vendor_id,
          shop_name: a.shop_name,
          shop_role: a.role,
        })),
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
        },
      }
    }

    // Sign the token with the role being logged into (requestedRole), not the
    // account's stored user.role — a phone number that was ever upgraded to
    // RIDER (see the updateRole call above) stays RIDER in the DB forever,
    // but should still get a CUSTOMER-scoped token when authenticating
    // through the customer app, otherwise every authorize(['CUSTOMER'])
    // route (e.g. quote/checkout) 403s for anyone who has ever also used
    // the rider app with the same number.
    const payload = { id: user.id, phone: user.phone, role: requestedRole }
    const tokens = generateTokenPair(payload)

    await storeRefreshToken(user.id, tokens.refreshToken)

    let isVerified = false
    if (requestedRole === 'RIDER') {
      const riderProfile = await this.repo.getRiderProfile(user.id)
      isVerified = riderProfile?.is_approved === true
      if (isVerified) {
        await this._queueBacklogAssignScan('RIDER_LOGIN')
      }
    }

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      roles,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        isNewUser,
        isVerified,
      },
    }
  }

  /**
   * Refresh access token using a valid refresh token
   *
   * If the user is a vendor employee with exactly one shop assignment, the
   * refreshed access token will include shopId / shopRole / permissions so
   * that shop-scoped authorization middleware keeps working across refreshes.
   */
  async refreshToken(refreshToken) {
    try {
      const decoded = verifyToken(refreshToken, env.JWT_REFRESH_SECRET)

      // Check if refresh token is still valid in Redis
      if (!(await isRefreshTokenValid(decoded.id, refreshToken))) {
        return { success: false, message: 'Invalid or expired refresh token' }
      }

      // Check user still exists and is active
      const user = await this.repo.findById(decoded.id)
      if (!user || !user.is_active) {
        return { success: false, message: 'User account is not active' }
      }

      // Re-attach shop scope when the user has exactly one active vendor assignment.
      // This preserves shopId / shopRole / permissions that the initial verifyOtp
      // injected but that a plain payload = { id, phone, role } rotation would lose.
      let accessToken
      let staffAssignments = []
      try {
        staffAssignments = resolveShopAssignments(
          await this.repo.findActiveShopStaffByUserId(user.id)
        )
      } catch (err) {
        logger.warn({ err: err.message, userId: user.id }, 'Shop staff lookup failed during refresh')
      }

      // Preserve the role this refresh-token lineage was actually issued
      // with (decoded.role), not the account's current user.role — the
      // latter can silently diverge (e.g. a CUSTOMER session for a phone
      // number that's since been upgraded to RIDER via the vendor/rider
      // app), and re-deriving from user.role here would flip a live
      // customer session to RIDER on its next silent refresh even after
      // verifyOtp's login-time fix.
      if (staffAssignments.length === 1) {
        const assignment = staffAssignments[0]
        accessToken = signAccessToken(
          {
            id: user.id,
            phone: user.phone,
            role: decoded.role,
            shopId: assignment.vendor_id,
            shopRole: assignment.role,
            permissions: assignment.permissions || [],
          },
          { expiresIn: '24h' }
        )
        logger.info(
          { userId: user.id, shopId: assignment.vendor_id, shopRole: assignment.role },
          'Token refreshed with shop scope preserved'
        )
      } else {
        // No shop assignment or multiple — issue a plain token
        const payload = { id: user.id, phone: user.phone, role: decoded.role }
        accessToken = signAccessToken(payload, { expiresIn: '24h' })
      }

      // Rotate the refresh token, carrying the same role forward so the
      // *next* refresh preserves it too.
      const newRefreshToken = signRefreshToken({
        id: user.id,
        phone: user.phone,
        role: decoded.role,
      })
      await storeRefreshToken(user.id, newRefreshToken)
      await revokeRefreshToken(user.id, refreshToken, { graceSeconds: ROTATION_GRACE_SECONDS })

      return {
        success: true,
        accessToken,
        refreshToken: newRefreshToken,
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Refresh token verification failed')
      return { success: false, message: 'Invalid or expired refresh token' }
    }
  }

  /**
   * Logout — invalidate refresh token
   */
  async logout(userId, { refreshToken = null } = {}) {
    if (refreshToken) {
      await revokeRefreshToken(userId, refreshToken, { graceSeconds: 0 })
      logger.info({ userId }, 'User logged out of one session')
      return
    }
    await revokeAllRefreshTokens(userId)
    logger.info({ userId }, 'User logged out of all sessions')
  }

  /**
   * Delete user account (GDPR compliance)
   */
  async deleteAccount(userId) {
    await this.repo.deleteUser(userId)
    await revokeAllRefreshTokens(userId)
    logger.info({ userId }, 'User account deleted')
  }

  /**
   * Select a shop after authentication and issue a shop-scoped JWT.
   * Validates that the user has an active Shop_Staff_Record for the requested
   * shop (and the parent shop is itself active).
   *
   * Requirements: 2.6, 2.7, 2.8, 13.2, 13.5
   * Error codes: STAFF_NOT_FOUND (404), STAFF_INACTIVE (403)
   *
   * @param {string} userId - From the authenticated request (could be a temp
   *   token issued during a multi-shop login or any token without shopId).
   * @param {string} shopId - From the request body, validated as UUID.
   * @returns {Promise<{success, token?, vendor_id?, shop_role?, permissions?, message?, code?}>}
   */
  async selectShop(userId, shopId) {
    // Verify the user is still active before issuing a long-lived token.
    const user = await this.repo.findById(userId)
    if (!user || !user.is_active) {
      return {
        success: false,
        message: 'User account is not active',
        code: 'STAFF_INACTIVE',
      }
    }

    const assignment = await this.repo.findActiveShopStaffByUserAndShop(
      userId,
      shopId
    )

    if (!assignment) {
      logger.info(
        { userId, shopId, action: 'select_shop_rejected' },
        'Shop selection rejected — no active assignment'
      )
      return {
        success: false,
        message: 'No active shop assignment found for this user and shop',
        code: 'STAFF_NOT_FOUND',
      }
    }

    const token = signAccessToken(
      {
        id: user.id,
        phone: user.phone,
        role: user.role,
        shopId: assignment.vendor_id,
        shopRole: assignment.role,
        permissions: assignment.permissions || [],
      },
      { expiresIn: '24h' }
    )

    logger.info(
      {
        userId: user.id,
        shopId: assignment.vendor_id,
        shopRole: assignment.role,
        action: 'shop_scope_selected',
      },
      'Shop scope selected and JWT issued'
    )

    return {
      success: true,
      token,
      vendor_id: assignment.vendor_id,
      shop_role: assignment.role,
      permissions: assignment.permissions || [],
    }
  }

  /**
   * Get paginated active shop assignments for the authenticated user
   * (used by `GET /api/v1/auth/my-vendors`).
   *
   * No permission check beyond `fastify.authenticate` — the route returns
   * the requester's own assignments only. Bounds (`page >= 1`,
   * `1 <= limit <= 100`) are enforced by the JSON-Schema querystring
   * validator on the route; the service re-clamps defensively so any
   * direct in-process caller stays within bounds.
   *
   * Requirements: R19.5
   * Design: §5.4
   *
   * @param {string} userId
   * @param {{ page?: number, limit?: number }} pagination
   * @returns {Promise<{ items: Array<object>, page: number, limit: number, total: number }>}
   */
  async getMyShops(userId, { page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, Math.floor(Number(page) || 1))
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)))

    const { items, total } = await this.repo.loadActiveShopAssignmentsPaginated(
      userId,
      { page: safePage, limit: safeLimit }
    )

    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
    }
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
          jobId: 'auto-assign-backlog-on-rider-login',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    } catch (err) {
      logger.warn({ err, source }, 'Failed to queue rider backlog assignment scan')
    }
  }
}
