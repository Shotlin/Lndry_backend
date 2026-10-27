import { env } from '../../config/env.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { AuthRepository } from './auth.repository.js'
import { validatePhone } from '../../middlewares/validatePhone.js'
import {
  sendOtpSchema,
  verifyOtpSchema,
  selectShopSchema,
  refreshTokenSchema,
  logoutSchema,
  deleteAccountSchema,
  myShopsSchema,
} from './auth.schema.js'

/**
 * Auth routes plugin
 * Prefix: /api/v1/auth (set in app.js)
 */
export default async function authRoutes(fastify) {
  // Wire up the layered architecture
  const repository = new AuthRepository()
  const service = new AuthService(repository)
  const controller = new AuthController(service)

  // POST /send-otp — Send OTP to mobile number
  fastify.post('/send-otp', {
    schema: sendOtpSchema,
    preHandler: [validatePhone],
    config: {
      // Per-IP cap. Adjustable with OTP_RATE_LIMIT_MAX / OTP_RATE_LIMIT_WINDOW (default 5 per 5 minutes).
      rateLimit: {
        max: env.OTP_RATE_LIMIT_MAX,
        timeWindow: env.OTP_RATE_LIMIT_WINDOW,
      },
    },
  }, controller.sendOtp.bind(controller))

  // POST /verify-otp — Verify OTP + return JWT tokens
  fastify.post('/verify-otp', {
    schema: verifyOtpSchema,
    preHandler: [validatePhone],
    config: {
      rateLimit: {
        max: env.OTP_RATE_LIMIT_MAX * 2,
        timeWindow: env.OTP_RATE_LIMIT_WINDOW,
      },
    },
  }, controller.verifyOtp.bind(controller))

  // POST /refresh-token — Get new access token
  fastify.post('/refresh-token', {
    schema: refreshTokenSchema,
    config: {
      // Per IP, and mobile carriers put thousands of real users behind one
      // address (CGNAT) while every signed-in app refreshes every 15 minutes.
      // 20 per 5 minutes starved those users of a valid session. A token is
      // 365-day, rotated and single-use, so brute-forcing this endpoint is
      // not a practical attack; this cap only blunts floods.
      rateLimit: {
        max: 600,
        timeWindow: '5 minutes',
      },
    },
  }, controller.refreshToken.bind(controller))

  // POST /select-shop — Issue shop-scoped JWT after staff selects a shop [AUTH]
  // Requirements: 2.6, 2.7, 2.8, 13.2, 13.3, 13.5
  fastify.post('/select-shop', {
    schema: selectShopSchema,
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '5 minutes',
      },
    },
  }, controller.selectShop.bind(controller))

  // POST /logout — Invalidate refresh token [AUTH]
  fastify.post('/logout', {
    schema: logoutSchema,
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '5 minutes',
      },
    },
  }, controller.logout.bind(controller))

  // GET /my-vendors — paginated active staff assignments for the requester [AUTH]
  // Requirements: R19.5
  // Design: §5.4
  fastify.get('/my-vendors', {
    preHandler: [fastify.authenticate],
    schema: myShopsSchema,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, controller.myShops.bind(controller))

  // DELETE /account — Delete user account [AUTH]
  fastify.delete('/account', {
    schema: deleteAccountSchema,
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
      },
    },
  }, controller.deleteAccount.bind(controller))

  // GET /session — returns profile summary, permissions, onboarding state [AUTH]
  fastify.get('/session', {
    preHandler: [fastify.authenticate],
  }, controller.session.bind(controller))

  // GET /my-roles — lists all roles linked to this phone [AUTH]
  fastify.get('/my-roles', {
    preHandler: [fastify.authenticate],
  }, controller.myRoles.bind(controller))

  // POST /select-role — issue scoped JWT [AUTH]
  fastify.post('/select-role', {
    preHandler: [fastify.authenticate],
  }, controller.selectRole.bind(controller))
}
