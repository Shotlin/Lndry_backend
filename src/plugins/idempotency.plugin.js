import fp from 'fastify-plugin'
import { redis } from '../config/redis.js'
import { logger } from '../config/logger.js'

const REDIS_PREFIX = 'idempotency:'
const LOCK_TTL = 60 // 1 minute lock to prevent concurrent double-submits
const CACHE_TTL = 24 * 3600 // 24 hours retention for completed responses

async function idempotencyPlugin(fastify) {
  // Add preHandler hook globally, but execute only when route requires it or header is present
  fastify.addHook('preHandler', async (request, reply) => {
    const key = request.headers['idempotency-key']
    const isRequired = reply.context.config?.idempotencyRequired === true

    if (isRequired && !key) {
      return reply.code(400).send({
        success: false,
        message: 'Idempotency-Key header is required for this request',
        code: 'MISSING_IDEMPOTENCY_KEY',
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required for this request',
          request_id: request.id
        }
      })
    }

    if (!key) {
      return // Continue if not present and not required
    }

    // Validate that key is a UUID (standard LNDRY requirement)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(key)) {
      return reply.code(400).send({
        success: false,
        message: 'Idempotency-Key header must be a valid UUID v4',
        code: 'INVALID_IDEMPOTENCY_KEY',
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header must be a valid UUID v4',
          request_id: request.id
        }
      })
    }

    const redisKey = `${REDIS_PREFIX}${key}`
    const stored = await redis.get(redisKey)

    if (stored === 'LOCK') {
      return reply.code(409).send({
        success: false,
        message: 'A concurrent request with the same Idempotency-Key is already processing',
        code: 'CONCURRENT_REQUEST',
        error: {
          code: 'CONCURRENT_REQUEST',
          message: 'A concurrent request with the same Idempotency-Key is already processing',
          request_id: request.id
        }
      })
    }

    if (stored) {
      try {
        const cached = JSON.parse(stored)
        logger.info({ key, path: request.url }, 'Idempotency cache hit — replaying response')

        reply.code(cached.statusCode)
        for (const [k, v] of Object.entries(cached.headers)) {
          reply.header(k, v)
        }
        reply.header('X-Cache-Lookup', 'HIT - Idempotency')
        return reply.send(cached.body)
      } catch (err) {
        logger.error({ err: err.message, key }, 'Failed to parse cached response in idempotency middleware')
        // Continue if parsing fails
      }
    }

    // Set lock
    await redis.set(redisKey, 'LOCK', 'EX', LOCK_TTL)
    request.idempotencyKey = key
  })

  // Add onSend hook to cache success responses
  fastify.addHook('onSend', async (request, reply, payload) => {
    const key = request.idempotencyKey
    if (!key) return payload

    const redisKey = `${REDIS_PREFIX}${key}`

    // If request failed with 5xx error, release the lock so the client can retry
    if (reply.statusCode >= 500) {
      await redis.del(redisKey)
      return payload
    }

    // Cache the response for 24h
    const cachedData = JSON.stringify({
      statusCode: reply.statusCode,
      headers: reply.getHeaders(),
      body: payload
    })

    await redis.set(redisKey, cachedData, 'EX', CACHE_TTL)
    return payload
  })
}

export default fp(idempotencyPlugin, { name: 'idempotency' })
