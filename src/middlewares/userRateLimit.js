import { redis } from '../config/redis.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Per-USER rate limit preHandler (run AFTER `fastify.authenticate`).
 *
 * The IP-based limiter treats everyone on a mobile carrier's shared address
 * (CGNAT) as one client; money- and abuse-sensitive endpoints need a limit
 * that follows the account instead. Fixed window in Redis; atomic; fails open
 * if Redis is unavailable so a cache outage never blocks payments.
 *
 *   preHandler: [fastify.authenticate, userRateLimit({ name: 'coupon-validate', max: 20, windowSeconds: 60 })]
 */
export function userRateLimit({ name, max, windowSeconds = 60 }) {
  if (!name || !max) throw new Error('userRateLimit needs { name, max }')
  return async function userRateLimitGuard(request, reply) {
    if (!env.RATE_LIMIT_ENABLED) return
    const id = request.user?.id
    if (!id) return
    try {
      const key = `lndry:rl:user:${name}:${id}`
      const [, [, count], [, ttl]] = await redis
        .multi()
        .set(key, 0, 'EX', windowSeconds, 'NX')
        .incr(key)
        .ttl(key)
        .exec()
      if (count > max) {
        reply.header('Retry-After', String(ttl > 0 ? ttl : windowSeconds))
        return reply.code(429).send({
          success: false,
          message: 'Too many attempts. Please wait a moment and try again.',
          code: 'RATE_LIMIT_EXCEEDED',
        })
      }
    } catch (err) {
      logger.warn({ err: err.message, name }, 'User rate limiter unavailable — failing open')
    }
  }
}
