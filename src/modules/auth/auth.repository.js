import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

/**
 * Auth repository — all user-related database queries for authentication
 */
export class AuthRepository {
  /**
   * Find user by phone number
   * @param {string} phone
   * @returns {Promise<object|null>}
   */
  async findByPhone(phone) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, is_active, created_at,
              deletion_scheduled_at
       FROM users WHERE phone = $1`,
      [phone]
    )
    return rows[0] || null
  }

  /**
   * Find user by ID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, is_active, created_at
       FROM users WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Create a new user with phone number
   * @param {string} phone
   * @returns {Promise<object>}
   */
  async createUser(phone, role = 'CUSTOMER') {
    const referralCode = this._generateReferralCode()
    const { rows } = await query(
      `INSERT INTO users (phone, role, referral_code)
       VALUES ($1, $2, $3)
       RETURNING id, phone, name, role, is_active, created_at`,
      [phone, role, referralCode]
    )
    return rows[0]
  }

  /**
   * Update a user's role
   * @param {string} userId
   * @param {string} role
   */
  async updateRole(userId, role) {
    await query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, userId]
    )
  }

  /**
   * Ensure a rider_profile row exists for this user.
   * Creates one if missing (with is_approved = false for admin review).
   * @param {string} userId
   */
  async ensureRiderProfile(userId) {
    const { rows } = await query(
      `SELECT id FROM rider_profiles WHERE user_id = $1`,
      [userId]
    )
    if (rows.length === 0) {
      await query(
        `INSERT INTO rider_profiles (user_id, is_approved, is_online)
         VALUES ($1, false, false)`,
        [userId]
      )
    }
  }

  /**
   * Get rider profile for a user
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async getRiderProfile(userId) {
    // Explicit projection (R14.7 — no SELECT *): the sole caller
    // (AuthService, checking rider approval during login) only reads
    // `is_approved`.
    const { rows } = await query(
      `SELECT user_id, is_approved FROM rider_profiles WHERE user_id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  /**
   * Update user's FCM push token
   * @param {string} userId
   * @param {string} fcmToken
   */
  async updateFcmToken(userId, fcmToken) {
    await query(
      `UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
      [fcmToken, userId]
    )
  }

  /**
   * Soft-delete user account (set is_active = false, clear PII)
   * @param {string} userId
   */
  async deleteUser(userId) {
    await query(
      `UPDATE users
       SET is_active = false,
           name = NULL,
           email = NULL,
           avatar_url = NULL,
           fcm_token = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    )
  }

  /**
   * Generate a unique 8-char referral code
   */
  _generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let code = ''
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
  }

  /**
   * Find all active vendor_employees records for a user.
   * "Active" means: vendor_employees.is_active = true, vendor_employees.deleted_at IS NULL,
   *                 the parent shop is_active = true and deleted_at IS NULL.
   * Joins vendors in a single query to avoid N+1 lookups.
   *
   * Used by:
   *   - login flow (decide auto-scope vs require selection) — Requirement 13.1, 13.2, 13.3, 13.4
   *   - select-shop endpoint (validate selection)               — Requirement 2.8
   *
   * @param {string} userId
   * @returns {Promise<Array<{shop_staff_id, vendor_id, shop_name, role, permissions}>>}
   */
  async findActiveShopStaffByUserId(userId) {
    const { rows } = await query(
      `SELECT
         ss.id          AS shop_staff_id,
         ss.vendor_id     AS vendor_id,
         s.name         AS shop_name,
         ss.role        AS role,
         ss.permissions AS permissions,
         ss.created_at  AS assigned_at
       FROM vendor_employees ss
       JOIN vendors s ON s.id = ss.vendor_id
      WHERE ss.user_id    = $1
        AND ss.is_active  = true
        AND ss.deleted_at IS NULL
        AND s.is_active   = true
        AND s.deleted_at  IS NULL
      ORDER BY s.created_at ASC`,
      [userId]
    )
    return rows
  }

  /**
   * Find a single active vendor_employees record for a (user_id, vendor_id) pair.
   * Used by select-shop to validate a user's access to the requested shop.
   * Requirement 2.8, 13.2
   *
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<{shop_staff_id, vendor_id, shop_name, role, permissions}|null>}
   */
  async findActiveShopStaffByUserAndShop(userId, shopId) {
    const { rows } = await query(
      `SELECT
         ss.id          AS shop_staff_id,
         ss.vendor_id     AS vendor_id,
         s.name         AS shop_name,
         ss.role        AS role,
         ss.permissions AS permissions
       FROM vendor_employees ss
       JOIN vendors s ON s.id = ss.vendor_id
      WHERE ss.user_id    = $1
        AND ss.vendor_id    = $2
        AND ss.is_active  = true
        AND ss.deleted_at IS NULL
        AND s.is_active   = true
        AND s.deleted_at  IS NULL
      LIMIT 1`,
      [userId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Create an OTP challenge
   */
  async createOtpChallenge({ phone, otpHash, accountType, expiresAt }) {
    const { rows } = await query(
      `INSERT INTO otp_challenges (phone, otp_hash, account_type, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [phone, otpHash, accountType, expiresAt]
    )
    return rows[0]
  }

  /**
   * Get an OTP challenge
   */
  async getOtpChallenge(challengeId, phone) {
    const { rows } = await query(
      `SELECT id, phone, otp_hash, account_type, expires_at, attempts, created_at
       FROM otp_challenges WHERE id = $1 AND phone = $2`,
      [challengeId, phone]
    )
    return rows[0] || null
  }

  /**
   * Increment attempts on an OTP challenge
   */
  async incrementOtpChallengeAttempts(challengeId) {
    const { rows } = await query(
      `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [challengeId]
    )
    return rows[0]?.attempts || 0
  }

  /**
   * Delete an OTP challenge
   */
  async deleteOtpChallenge(challengeId) {
    await query(`DELETE FROM otp_challenges WHERE id = $1`, [challengeId])
  }

  /**
   * Register a user's device
   */
  async registerDevice({ userId, deviceId, platform, fcmToken, appVersion, deviceModel }) {
    const { rows } = await query(
      `INSERT INTO devices (user_id, device_id, platform, fcm_token, app_version, device_model, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET platform = $3, fcm_token = $4, app_version = $5,
                     device_model = COALESCE($6, devices.device_model), updated_at = NOW()
       RETURNING id`,
      [userId, deviceId, platform, fcmToken, appVersion, deviceModel || null]
    )
    return rows[0]
  }

  /**
   * Delete a registered device
   */
  async deleteDevice(userId, deviceId) {
    await query(
      `DELETE FROM devices WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId]
    )
  }
}
