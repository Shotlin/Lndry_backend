import bcrypt from 'bcrypt'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'

/**
 * Service to manage pickup and delivery OTPs using the order_otps table and Redis.
 */
export class OrderOtpService {
  /**
   * Generate a 6-digit numeric OTP and store its hash in the database.
   * Also stores the plaintext in Redis for customer-only retrieval.
   */
  async generateOtp(orderId, purpose) {
    // Generate a random 6-digit numeric string
    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString()
    
    // Hash with bcrypt (cost 12 matches auth.service)
    const otpHash = await bcrypt.hash(rawOtp, 12)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours expiry

    // 1. Insert/Replace in order_otps table
    // Mark any existing active OTP for this order/purpose as used_at/consumed_at
    await query(
      `UPDATE order_otps 
       SET consumed_at = NOW(), used_at = NOW() 
       WHERE order_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [orderId, purpose]
    )

    await query(
      `INSERT INTO order_otps (order_id, otp_hash, purpose, attempt_count, expires_at)
       VALUES ($1, $2, $3, 0, $4)`,
      [orderId, otpHash, purpose, expiresAt]
    )

    // Store plaintext OTP in Redis for secure, ephemeral customer retrieval
    await redis.set(`order_otp:${orderId}:${purpose}`, rawOtp, 'EX', 24 * 60 * 60)

    return rawOtp
  }

  /**
   * Verify the raw OTP code submitted by the employee.
   * Tracks and increments attempt count, locking after 5 failures.
   */
  async verifyOtp(orderId, purpose, rawOtp) {
    // 1. Fetch active OTP mapped to the correct purpose
    const { rows } = await query(
      `SELECT * FROM order_otps 
       WHERE order_id = $1 AND purpose = $2 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [orderId, purpose]
    )

    const activeOtp = rows[0]
    if (!activeOtp) {
      throw { statusCode: 400, message: 'No active OTP found. Please request a new code.', code: 'OTP_NOT_FOUND' }
    }

    if (new Date(activeOtp.expires_at) < new Date()) {
      throw { statusCode: 400, message: 'OTP has expired. Please request a new code.', code: 'OTP_EXPIRED' }
    }

    if (activeOtp.attempt_count >= 5) {
      throw { statusCode: 400, message: 'Verification locked. Too many failed attempts.', code: 'OTP_LOCKED' }
    }

    const isMatch = await bcrypt.compare(rawOtp, activeOtp.otp_hash)

    if (isMatch) {
      // Correct OTP: Mark as consumed and used
      await query(
        `UPDATE order_otps SET consumed_at = NOW(), used_at = NOW() WHERE id = $1`,
        [activeOtp.id]
      )

      // Clear plaintext OTP from orders table (fixed place-holder bug by changing $2 to $1)
      const orderColumn = purpose === 'PICKUP' ? 'pickup_otp' : 'delivery_otp'
      await query(
        `UPDATE orders SET ${orderColumn} = NULL, updated_at = NOW() WHERE id = $1`,
        [orderId]
      )

      // Delete from Redis
      await redis.del(`order_otp:${orderId}:${purpose}`)

      return { success: true }
    } else {
      // Incorrect OTP: Increment attempts
      const newAttempts = activeOtp.attempt_count + 1
      await query(
        `UPDATE order_otps SET attempt_count = $1 WHERE id = $2`,
        [newAttempts, activeOtp.id]
      )

      // Delete from Redis if locked
      if (newAttempts >= 5) {
        await redis.del(`order_otp:${orderId}:${purpose}`)
        throw { statusCode: 400, message: 'Verification locked. Too many failed attempts.', code: 'OTP_LOCKED' }
      }

      const remaining = 5 - newAttempts
      throw {
        statusCode: 400,
        message: `Invalid OTP. ${remaining} attempts remaining.`,
        code: 'INVALID_OTP',
        attemptsRemaining: remaining
      }
    }
  }

  /**
   * Retrieve active OTP for customer order owner with Cache-Control no-store requirements.
   */
  async getActiveOtpForCustomer(userId, orderId, purpose) {
    const { rows: orderRows } = await query('SELECT user_id FROM orders WHERE id = $1', [orderId])
    if (orderRows.length === 0) {
      throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
    }
    if (orderRows[0].user_id !== userId) {
      throw { statusCode: 403, message: 'Forbidden - order ownership check failed', code: 'FORBIDDEN' }
    }

    const plaintextOtp = await redis.get(`order_otp:${orderId}:${purpose}`)
    const { rows } = await query(
      `SELECT expires_at, attempt_count FROM order_otps 
       WHERE order_id = $1 AND purpose = $2 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [orderId, purpose]
    )
    const active = rows[0]
    if (!active || new Date(active.expires_at) < new Date()) {
      return null
    }

    return {
      otp: plaintextOtp || null,
      purpose,
      expires_at: active.expires_at,
      attempts_remaining: Math.max(0, 5 - active.attempt_count)
    }
  }
}
