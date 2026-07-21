import { redis } from '../config/redis.js'
import { env } from '../config/env.js'

/**
 * Get a cached value (auto JSON parse)
 * @param {string} key
 * @returns {Promise<*|null>}
 */
export async function cacheGet(key) {
  const data = await redis.get(key)
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

/**
 * Set a cache value (auto JSON stringify)
 * @param {string} key
 * @param {*} value
 * @param {number} ttl - Time to live in seconds (default from env)
 */
export async function cacheSet(key, value, ttl = env.REDIS_TTL_DEFAULT) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (ttl) {
    await redis.set(key, serialized, 'EX', ttl)
  } else {
    await redis.set(key, serialized)
  }
}

/**
 * Delete a single cache key
 * @param {string} key
 */
export async function cacheDel(key) {
  await redis.del(key)
}

/**
 * Delete all keys matching a pattern using SCAN (non-blocking)
 * @param {string} pattern - e.g. 'garment_rates:list:*'
 */
export async function cacheDeletePattern(pattern) {
  let cursor = '0'
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = nextCursor
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } while (cursor !== '0')
}
