/**
 * requireStepUp — Admin 2FA Step-Up Middleware
 *
 * High-risk admin operations (settings changes, refunds, status overrides)
 * require a step-up token issued via POST /api/v1/admin/auth/step-up.
 *
 * The step-up token is a short-lived JWT (5 minutes) containing:
 *   { sub: userId, purpose: 'step-up', totp_verified: true }
 *
 * Usage:
 *   preHandler: [fastify.authenticate, fastify.requireAdmin, requireStepUp]
 *
 * Client flow:
 *   1. Admin calls POST /api/v1/admin/auth/step-up with TOTP code
 *   2. Backend verifies TOTP, issues step-up JWT
 *   3. Admin sends step-up JWT in x-step-up-token header on the high-risk request
 *   4. This middleware validates the token
 */
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'

const STEP_UP_MAX_AGE_SECONDS = 300 // 5 minutes

/**
 * Whether step-up verification is currently enforced. Controlled by the
 * `admin_step_up_enabled` app setting (Dashboard → Settings → Security →
 * Two-Step Verification). Only an explicit `false` turns enforcement off —
 * a missing row, garbage value or DB error all fail CLOSED (enforced).
 */
export async function isStepUpEnforced() {
  try {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key = 'admin_step_up_enabled'`
    )
    if (!rows.length) return true
    const v = rows[0].value
    return !(v === false || v === 'false')
  } catch (err) {
    logger.error({ err: err.message }, 'Could not read admin_step_up_enabled — enforcing step-up')
    return true
  }
}

/**
 * Fastify preHandler that validates the x-step-up-token header.
 * Must be used AFTER authenticate (request.user must be set).
 */
export async function requireStepUp(request, reply) {
  // Two-Step Verification switched OFF (development mode): no token needed.
  if (!(await isStepUpEnforced())) {
    request.stepUpBypassed = true
    return
  }

  const stepUpToken = request.headers['x-step-up-token']

  if (!stepUpToken) {
    return reply.code(403).send({
      success: false,
      message: 'Step-up authentication required. Verify TOTP via POST /api/v1/admin/auth/step-up first.',
      code: 'STEP_UP_REQUIRED',
    })
  }

  try {
    const payload = jwt.verify(stepUpToken, env.JWT_ACCESS_SECRET, {
      maxAge: `${STEP_UP_MAX_AGE_SECONDS}s`,
    })

    // Verify it's a step-up token, not a reused access token
    if (payload.purpose !== 'step-up') {
      return reply.code(403).send({
        success: false,
        message: 'Invalid step-up token — wrong purpose',
        code: 'STEP_UP_INVALID',
      })
    }

    // Verify it belongs to the current user
    if (payload.sub !== request.user.id) {
      return reply.code(403).send({
        success: false,
        message: 'Step-up token does not match authenticated user',
        code: 'STEP_UP_INVALID',
      })
    }

    // Verify TOTP was actually verified
    if (!payload.totp_verified) {
      return reply.code(403).send({
        success: false,
        message: 'Step-up token was not TOTP-verified',
        code: 'STEP_UP_INVALID',
      })
    }

    // Check freshness (belt-and-suspenders alongside jwt maxAge)
    const iat = payload.iat
    const now = Math.floor(Date.now() / 1000)
    if (now - iat > STEP_UP_MAX_AGE_SECONDS) {
      return reply.code(403).send({
        success: false,
        message: 'Step-up token has expired. Re-verify TOTP.',
        code: 'STEP_UP_EXPIRED',
      })
    }

    // Valid step-up — attach to request for audit logging
    request.stepUpClaims = payload
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return reply.code(403).send({
        success: false,
        message: 'Step-up token has expired. Re-verify TOTP.',
        code: 'STEP_UP_EXPIRED',
      })
    }
    return reply.code(403).send({
      success: false,
      message: 'Invalid step-up token',
      code: 'STEP_UP_INVALID',
    })
  }
}

/**
 * Issue a step-up JWT after TOTP verification.
 * Called by the step-up route handler.
 *
 * @param {string} userId - Authenticated admin user ID
 * @returns {string} Signed JWT with 5-minute expiry
 */
export function issueStepUpToken(userId) {
  return jwt.sign(
    {
      sub: userId,
      purpose: 'step-up',
      totp_verified: true,
    },
    env.JWT_ACCESS_SECRET,
    { expiresIn: `${STEP_UP_MAX_AGE_SECONDS}s` }
  )
}
