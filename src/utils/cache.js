import { redis } from '../config/redis.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Redis cache helpers.
 *
 * Fail-open by design: the cache is an optimisation, never a dependency. The
 * shared ioredis client uses `maxRetriesPerRequest: null` (needed by BullMQ),
 * which makes commands QUEUE FOREVER while Redis is unreachable — so without
 * a timeout a Redis outage would hang every cached endpoint instead of
 * falling back to the database. Every call here is therefore time-boxed and
 * swallows errors (logged at most once every 30 s per process).
 */

/** Max time any single cache call may take before we give up and use the DB. */
export const CACHE_OP_TIMEOUT_MS = 250

// Circuit breaker: after any cache failure skip the cache entirely for a few
// seconds, so an outage costs requests nothing instead of 250 ms each.
const BREAKER_OPEN_MS = 5_000
let downUntil = 0
const cacheIsDown = () => Date.now() < downUntil

/** Test helper — closes the breaker. */
export function _resetCacheBreaker() {
  downUntil = 0
}

let lastWarnAt = 0
function warnThrottled(err, op) {
  downUntil = Date.now() + BREAKER_OPEN_MS
  const now = Date.now()
  if (now - lastWarnAt < 30_000) return
  lastWarnAt = now
  logger.warn({ err: err?.message, op }, 'Cache unavailable — falling back to database')
}

function withTimeout(promise, ms = CACHE_OP_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache timeout after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Get a cached value (auto JSON parse). Returns null on a miss OR if Redis is
 * unavailable.
 * @param {string} key
 * @returns {Promise<*|null>}
 */
export async function cacheGet(key) {
  if (cacheIsDown()) return null
  let data
  try {
    data = await withTimeout(redis.get(key))
  } catch (err) {
    warnThrottled(err, 'get')
    return null
  }
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

/**
 * Set a cache value (auto JSON stringify). Silently skipped if Redis is
 * unavailable.
 * @param {string} key
 * @param {*} value
 * @param {number} ttl - Time to live in seconds (default from env)
 */
export async function cacheSet(key, value, ttl = env.REDIS_TTL_DEFAULT) {
  if (cacheIsDown()) return
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  try {
    if (ttl) {
      await withTimeout(redis.set(key, serialized, 'EX', ttl))
    } else {
      await withTimeout(redis.set(key, serialized))
    }
  } catch (err) {
    warnThrottled(err, 'set')
  }
}

/**
 * Delete a single cache key. Silently skipped if Redis is unavailable (the
 * entry then expires by TTL).
 * @param {string} key
 */
export async function cacheDel(key) {
  if (cacheIsDown()) return
  try {
    await withTimeout(redis.del(key))
  } catch (err) {
    warnThrottled(err, 'del')
  }
}

/**
 * Delete all keys matching a pattern using SCAN (non-blocking)
 * @param {string} pattern - e.g. 'garment_rates:list:*'
 */
export async function cacheDeletePattern(pattern) {
  if (cacheIsDown()) return
  try {
    let cursor = '0'
    do {
      const [nextCursor, keys] = await withTimeout(
        redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100),
        1000
      )
      cursor = nextCursor
      if (keys.length > 0) {
        await withTimeout(redis.del(...keys), 1000)
      }
    } while (cursor !== '0')
  } catch (err) {
    warnThrottled(err, 'deletePattern')
  }
}

// In-process single-flight: when a key expires under load, only ONE request
// per process runs the loader; the rest await the same promise. (Across the
// 3 API processes that is at most 3 DB hits per TTL instead of one per request.)
const inflight = new Map()

/**
 * Read-through cache. Returns the cached value, or runs `loader`, stores the
 * result and returns it. Never caches `null`/`undefined`. If Redis is down the
 * loader result is returned directly, so behaviour is identical to no cache.
 *
 * Only use this for data that is the SAME for every caller (public lists).
 * Never key it on something that omits the user for per-user data.
 *
 * @template T
 * @param {string} key
 * @param {number} ttl seconds
 * @param {() => Promise<T>} loader
 * @returns {Promise<T>}
 */
export async function cacheWrap(key, ttl, loader) {
  const cached = await cacheGet(key)
  if (cached !== null && cached !== undefined) return cached

  if (inflight.has(key)) return inflight.get(key)

  const run = (async () => {
    const value = await loader()
    if (value !== null && value !== undefined) {
      await cacheSet(key, value, ttl)
    }
    return value
  })().finally(() => inflight.delete(key))

  inflight.set(key, run)
  return run
}
