import fp from 'fastify-plugin'
import crypto from 'node:crypto'
import rateLimit from '@fastify/rate-limit'
import { env } from '../config/env.js'
import { redis } from '../config/redis.js'
import { logger } from '../config/logger.js'

// Paths that must never be throttled by the blanket limiter: load-balancer
// health probes and the payment gateway's webhook (it retries on failure and
// is authenticated by its own signature).
const EXEMPT_PREFIXES = ['/health', '/api/webhook/', '/api/v1/payments/webhook']
const EXEMPT_EXACT = new Set(['/', '/favicon.ico'])

function isExempt(url) {
  const path = url.split('?')[0]
  if (EXEMPT_EXACT.has(path)) return true
  return EXEMPT_PREFIXES.some((p) => path.startsWith(p))
}

/**
 * The client address used as the rate-limit identity.
 *
 * Deliberately `request.ip` and nothing else. Fastify derives it from
 * X-Forwarded-For using the configured TRUST_PROXY allow-list, so a client
 * cannot choose its own identity by sending X-Forwarded-For / X-Real-IP /
 * CF-Connecting-IP headers. (The previous key generator read those headers
 * directly, which made every IP-based limit — OTP, login, refresh — trivially
 * bypassable by rotating a header value.)
 */
function clientKey(request) {
  return request.ip
}

function tokenKey(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  if (!token) return null
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)
}

/**
 * Fixed-window counters over Redis for every bucket this request counts
 * against, in ONE round trip. Each bucket is atomic (SET NX EX + INCR in the
 * same MULTI) so a crash between the two can never leave an immortal counter.
 */
async function hitAll(keys, windowMs) {
  const ttl = Math.ceil(windowMs / 1000)
  const pipeline = redis.multi()
  for (const key of keys) pipeline.set(key, 0, 'EX', ttl, 'NX').incr(key).ttl(key)
  const res = await pipeline.exec()
  return keys.map((_, i) => {
    const count = res[i * 3 + 1][1]
    const remaining = res[i * 3 + 2][1]
    return { count, retryAfter: remaining > 0 ? remaining : ttl }
  })
}

/**
 * Redis-backed rate limiting.
 *   1. Per-route limits (config.rateLimit on a route) via @fastify/rate-limit.
 *   2. A blanket limit on every other request, per IP and per bearer token.
 *      Fails OPEN if Redis errors: an outage of the limiter must not take the
 *      API down with it.
 */
async function rateLimitPlugin(fastify) {
  if (!env.RATE_LIMIT_ENABLED) {
    fastify.log.warn('Rate limiting is disabled by configuration')
    return
  }

  await fastify.register(rateLimit, {
    global: false,
    redis,
    hook: 'onRequest',
    nameSpace: 'lndry:ratelimit:',
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    skipOnError: true,
    keyGenerator: clientKey,
  })

  const windowMs = env.RATE_LIMIT_GLOBAL_WINDOW ?? 60000
  const ipMax = env.RATE_LIMIT_GLOBAL_IP_MAX ?? 1800
  const tokenMax = env.RATE_LIMIT_GLOBAL_TOKEN_MAX ?? 900
  const ns = 'lndry:rl:global:'

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || isExempt(request.raw.url || request.url)) return

    try {
      const tk = tokenKey(request)
      const keys = [`${ns}ip:${clientKey(request)}`]
      if (tk) keys.push(`${ns}tok:${tk}`)
      const [ip, token] = await hitAll(keys, windowMs)

      let worst = null
      if (ip.count > ipMax) worst = ip
      else if (token && token.count > tokenMax) worst = token

      if (worst) {
        reply.header('Retry-After', String(worst.retryAfter))
        return reply.code(429).send({
          success: false,
          message: 'Too many requests. Please slow down and try again shortly.',
          code: 'RATE_LIMIT_EXCEEDED',
        })
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Global rate limiter unavailable — failing open')
    }
  })
}

export default fp(rateLimitPlugin, { name: 'rate-limit' })
