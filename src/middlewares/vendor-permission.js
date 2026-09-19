import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { cacheGet, cacheSet, cacheDel } from '../utils/cache.js'
import { CANONICAL_PERMISSIONS } from '../utils/permissions.js'

/**
 * Per-request permission guard for the vendor (Partner) app's routes.
 *
 * Who is who, on a vendor's roster (`vendor_employees.role`):
 *   VENDOR_OWNER — full access, always.
 *   VENDOR_STAFF — only the modules the owner has granted (permissions[]).
 *   VENDOR_RIDER — a captain: never allowed on the vendor-app modules; they
 *                  have their own restricted surface at /vendor/rider.
 *
 * The staff record is read from the DATABASE (cached briefly, invalidated the
 * moment an owner edits or removes that staff member), not from the JWT. A
 * JWT's permissions are frozen at login, so trusting them would leave a staff
 * member with their old access until they signed out and back in — the very
 * thing "changes must reach the staff app session" rules out.
 */

const CACHE_PREFIX = 'lndry:staff-perms:v1:'
const CACHE_TTL_SECONDS = 300

export const vendorActorCacheKey = (userId, shopId) => `${CACHE_PREFIX}${userId}:${shopId ?? '_'}`

/** Drops the cached record. Called whenever a roster record changes. */
export async function invalidateVendorActorCache(userId, shopId) {
  if (!userId) return
  try {
    await Promise.all([cacheDel(vendorActorCacheKey(userId, shopId)), cacheDel(vendorActorCacheKey(userId, null))])
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Vendor actor cache invalidation failed')
  }
}

/**
 * The requester's active roster record: { vendorId, role, permissions:string[] },
 * or null if they aren't on any vendor's roster. Only canonical permission
 * strings are ever returned.
 */
export async function loadVendorActor(userId, shopId = null) {
  const key = vendorActorCacheKey(userId, shopId)
  try {
    const cached = await cacheGet(key)
    if (cached && typeof cached === 'object' && cached.role) return cached
  } catch (err) {
    logger.warn({ err: err.message }, 'Vendor actor cache read failed — using the database')
  }

  const params = [userId]
  let shopClause = ''
  if (shopId) {
    params.push(shopId)
    shopClause = 'AND vendor_id = $2'
  }
  const { rows } = await query(
    `SELECT vendor_id, role, permissions
       FROM vendor_employees
      WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL ${shopClause}
      ORDER BY (role = 'VENDOR_OWNER') DESC, created_at ASC
      LIMIT 1`,
    params
  )
  const row = rows[0]
  const actor = row
    ? {
        vendorId: row.vendor_id,
        role: row.role,
        permissions: (Array.isArray(row.permissions) ? row.permissions : []).filter(
          (p) => typeof p === 'string' && CANONICAL_PERMISSIONS.has(p)
        ),
      }
    : null

  // Only a found record is cached. A "not on any roster" answer must never
  // stick, or someone added to a roster a moment later would be treated as
  // an outsider until the entry expired.
  if (actor) {
    try {
      await cacheSet(key, actor, CACHE_TTL_SECONDS)
    } catch (err) {
      logger.warn({ err: err.message }, 'Vendor actor cache write failed')
    }
  }
  return actor
}

/**
 * preHandler factory. The request passes if the requester is the owner, or a
 * staff member holding AT LEAST ONE of `anyOf`. Captains are always refused.
 * A user who isn't on any roster is passed through untouched — the handler's
 * own vendor resolution (or an HQ admin path) decides what happens to them.
 *
 * Unknown permission names throw at route-registration time, so a typo fails
 * the boot instead of silently leaving a route open or locked.
 */
export function requireVendorPermission(...anyOf) {
  if (anyOf.length === 0) throw new Error('requireVendorPermission needs at least one permission')
  for (const perm of anyOf) {
    if (!CANONICAL_PERMISSIONS.has(perm)) {
      throw new Error(`requireVendorPermission: "${perm}" is not a canonical permission string`)
    }
  }

  const handler = async function vendorPermissionGuard(request, reply) {
    const user = request.user
    if (!user?.id) return // authenticate() runs first and rejects anonymous requests

    const actor = await loadVendorActor(user.id, user.shopId || user.vendor_id || null)
    if (!actor) return

    if (actor.role === 'VENDOR_OWNER') return

    if (actor.role === 'VENDOR_RIDER') {
      return reply.code(403).send({
        success: false,
        message: 'Captain accounts use the captain jobs screen, not this section.',
        code: 'FORBIDDEN',
      })
    }

    if (anyOf.some((perm) => actor.permissions.includes(perm))) return

    return reply.code(403).send({
      success: false,
      message: 'You do not have access to this section. Ask the shop owner to enable it for you.',
      code: 'PERMISSION_DENIED',
    })
  }
  handler.requiredPermission = anyOf.length === 1 ? anyOf[0] : anyOf
  return handler
}
