import crypto from 'node:crypto'
import { redis } from '../../config/redis.js'

// Sessions last a year and renew on every use (JWT_REFRESH_EXPIRY must match).
// One refresh token PER SESSION (device/app login), not one per user. Before
// this, a login anywhere (another phone, the Partner app with the same number,
// a second browser) overwrote the single `refresh:<userId>` slot and silently
// killed every other session's ability to refresh.
export const SESSION_DAYS = 365
const TTL_SECONDS = SESSION_DAYS * 24 * 60 * 60
const MAX_SESSIONS_PER_USER = 10

const legacyKey = (userId) => `refresh:${userId}`
const indexKey = (userId) => `refresh_idx:${userId}`
const tokenKey = (userId, token) =>
  `refresh:${userId}:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 40)}`

export async function storeRefreshToken(userId, token) {
  const now = Date.now()
  await redis.set(tokenKey(userId, token), '1', 'EX', TTL_SECONDS)
  await redis.zadd(indexKey(userId), now, token)
  await redis.expire(indexKey(userId), TTL_SECONDS)
  // Drop expired entries and cap the number of live sessions (oldest go first).
  await redis.zremrangebyscore(indexKey(userId), '-inf', now - TTL_SECONDS * 1000)
  const count = await redis.zcard(indexKey(userId))
  if (count > MAX_SESSIONS_PER_USER) {
    const extra = await redis.zrange(indexKey(userId), 0, count - MAX_SESSIONS_PER_USER - 1)
    if (extra.length) {
      await redis.zrem(indexKey(userId), ...extra)
      await redis.del(...extra.map((t) => tokenKey(userId, t)))
    }
  }
}

export async function isRefreshTokenValid(userId, token) {
  if (await redis.exists(tokenKey(userId, token))) return true
  // Tokens issued before this change live in the old single slot.
  return (await redis.get(legacyKey(userId))) === token
}

/** End only this session (used when a refresh token is rotated). */
export async function revokeRefreshToken(userId, token) {
  await redis.del(tokenKey(userId, token))
  await redis.zrem(indexKey(userId), token)
  if ((await redis.get(legacyKey(userId))) === token) await redis.del(legacyKey(userId))
}

/** End every session of the user (logout everywhere, account deletion). */
export async function revokeAllRefreshTokens(userId) {
  const tokens = await redis.zrange(indexKey(userId), 0, -1)
  const keys = [legacyKey(userId), indexKey(userId), ...tokens.map((t) => tokenKey(userId, t))]
  await redis.del(...keys)
}
