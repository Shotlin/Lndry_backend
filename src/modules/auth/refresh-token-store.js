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

// After a refresh token is rotated the previous one stays usable for a short
// grace window. Mobile networks drop responses: if the reply carrying the new
// token never reaches the phone, the phone retries with the OLD token — and
// without a grace window that retry is rejected and the user is silently
// logged out. The same applies when the app's start-up refresh and a request
// interceptor refresh race with the same token.
export const ROTATION_GRACE_SECONDS = 120

const legacyKey = (userId) => `refresh:${userId}`
const graceKey = (userId, token) =>
  `refresh_grace:${userId}:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 40)}`
// Written by logout-everywhere so grace-window tokens die with the session.
const revokedAllKey = (userId) => `refresh_revoked_all:${userId}`
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
  // Recently rotated away from — still honoured inside the grace window unless
  // the user has since logged out everywhere.
  if (await redis.exists(graceKey(userId, token))) {
    return !(await redis.exists(revokedAllKey(userId)))
  }
  // Tokens issued before this change live in the old single slot.
  return (await redis.get(legacyKey(userId))) === token
}

/**
 * End only this session. When the token is being rotated (not logged out)
 * pass `graceSeconds` so a retry with the old token still succeeds briefly.
 */
export async function revokeRefreshToken(userId, token, { graceSeconds = 0 } = {}) {
  await redis.del(tokenKey(userId, token))
  await redis.zrem(indexKey(userId), token)
  if ((await redis.get(legacyKey(userId))) === token) await redis.del(legacyKey(userId))
  if (graceSeconds > 0) {
    await redis.set(graceKey(userId, token), '1', 'EX', graceSeconds)
  } else {
    await redis.del(graceKey(userId, token))
  }
}

/** End every session of the user (logout everywhere, account deletion). */
export async function revokeAllRefreshTokens(userId) {
  const tokens = await redis.zrange(indexKey(userId), 0, -1)
  const keys = [legacyKey(userId), indexKey(userId), ...tokens.map((t) => tokenKey(userId, t))]
  await redis.del(...keys)
  // Tokens still inside a rotation grace window are not in the index; this
  // marker (outliving the grace window) makes them invalid as well.
  await redis.set(revokedAllKey(userId), '1', 'EX', ROTATION_GRACE_SECONDS + 60)
}
