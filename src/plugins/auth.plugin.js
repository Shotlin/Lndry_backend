import fp from 'fastify-plugin'
import fjwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { env } from '../config/env.js'
import { query } from '../config/database.js'
import { ERROR_CODES } from '../constants/errors.js'

/**
 * Auth plugin — registers JWT + Cookie support
 * Decorates fastify with `authenticate` and `authorize` preHandlers
 */
async function authPlugin(fastify) {
  // Cookie support (for httpOnly refresh token cookie)
  await fastify.register(cookie, {
    secret: env.COOKIE_SECRET || env.JWT_ACCESS_SECRET,
    parseOptions: {},
  })

  // JWT support (only access token verification via this plugin)
  await fastify.register(fjwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: {
      expiresIn: env.JWT_ACCESS_EXPIRY,
    },
    cookie: {
      cookieName: 'accessToken',
      signed: false,
    },
  })

  /**
   * preHandler: Verify JWT from Authorization header or cookie.
   *
   * Pipeline (per multi-vendor design §5.5, R20.8):
   *   1. `request.jwtVerify()` — validates signature + expiry, populates
   *      `request.user` with the token payload.
   *   2. Single parameterized SELECT against `users` to fetch
   *      `is_blocked` and `session_version` in one round-trip (PK
   *      lookup, well under the <50ms p95 DB budget).
   *   3. Reject blocked accounts with 403 ACCOUNT_BLOCKED.
   *   4. Compare the JWT-encoded `session_version` against
   *      `users.session_version`. Mismatch → 401 SESSION_INVALID.
   *      Change-password (auth.service.js#changePassword, task 3.5)
   *      atomically increments the row, so every previously issued JWT
   *      for the user becomes invalid the moment the transaction
   *      commits. Login / select-shop / change-password (tasks 3.2,
   *      3.3, 3.5) mint tokens with the current row value.
   *
   * Backward compatibility (R20.8 migration safety):
   *   Tokens issued before migration 047 carry no `session_version`
   *   claim. When `STRICT_SESSION_VERSION_CHECK=false` (the default
   *   until live tokens have rotated) those tokens are accepted
   *   without comparison. When the env flag is `true` the missing
   *   claim is treated as a violation and rejected with 401
   *   SESSION_INVALID — flip the flag once Phase C is live and all
   *   in-flight tokens carry the claim.
   *
   * @see Requirements: R20.8
   * @see Design: §5.5
   */
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()

      // Single PK lookup fetches both gates in one round-trip.
      const { rows } = await query(
        'SELECT is_blocked, session_version FROM users WHERE id = $1 LIMIT 1',
        [request.user.id]
      )

      // ── 1. Blocked-account gate ─────────────────────────────────
      if (rows.length > 0 && rows[0].is_blocked) {
        return reply.code(403).send({
          success: false,
          message: 'Account is blocked. Contact support.',
          code: 'ACCOUNT_BLOCKED',
        })
      }

      // ── 2. session_version gate (R20.8, design §5.5) ────────────
      // The JWT claim is populated by login / select-shop /
      // change-password. A row miss (deleted user) plus a present
      // claim is treated as an invalidated session for symmetry with
      // the row-vs-claim mismatch path; downstream guards already
      // assume `request.user.id` resolves to a live row.
      const jwtSessionVersion = request.user.session_version
      if (jwtSessionVersion === undefined || jwtSessionVersion === null) {
        if (env.STRICT_SESSION_VERSION_CHECK) {
          return reply.code(401).send({
            success: false,
            message: 'Session is no longer valid',
            code: ERROR_CODES.SESSION_INVALID,
          })
        }
        // Non-strict mode: legacy token without the claim — accept.
      } else {
        const rowSessionVersion = rows[0]?.session_version
        if (rowSessionVersion !== jwtSessionVersion) {
          return reply.code(401).send({
            success: false,
            message: 'Session is no longer valid',
            code: ERROR_CODES.SESSION_INVALID,
          })
        }
      }
    } catch (err) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized — invalid or expired token',
        code: 'UNAUTHORIZED',
      })
    }
  })

  /**
   * preHandler factory: Check if user has one of the allowed roles
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])]
   */
  fastify.decorate('authorize', function (allowedRoles) {
    return async function (request, reply) {
      const { role } = request.user
      if (!allowedRoles.includes(role)) {
        return reply.code(403).send({
          success: false,
          message: 'Forbidden — insufficient permissions',
          code: 'FORBIDDEN',
        })
      }
    }
  })

  /**
   * preHandler: Check if user has ADMIN role
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.requireAdmin]
   */
  fastify.decorate('requireAdmin', async function (request, reply) {
    const { role } = request.user
    if (role !== 'ADMIN') {
      return reply.code(403).send({
        success: false,
        message: 'Forbidden — admin access required',
        code: 'FORBIDDEN',
      })
    }
  })

  /**
   * preHandler factory: Check if user has a specific permission via their role
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.requireAdmin, fastify.requirePermission('garment_rates.manage')]
   */
  fastify.decorate('requirePermission', function (permission) {
    return async function (request, reply) {
      const { id } = request.user
      const { rows } = await query(
        `SELECT COALESCE(r.permissions, '[]'::jsonb) AS permissions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [id]
      )
      const perms = rows[0]?.permissions || []
      if (!perms.includes(permission)) {
        return reply.code(403).send({
          success: false,
          message: `Forbidden — requires '${permission}' permission`,
          code: 'PERMISSION_DENIED',
        })
      }
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
