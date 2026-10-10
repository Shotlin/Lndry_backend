import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { query } from '../config/database.js'
import { cacheGet, cacheSet } from '../utils/cache.js'
import { loadVendorActor } from './vendor-permission.js'
import { offeringAllows, productForPath } from '../modules/vendor-app-mode/offering.js'
import { offeringCacheKey } from '../modules/vendor-app-mode/vendor-app-mode.service.js'

const CACHE_TTL_SECONDS = 60

async function offeringOf(vendorId) {
  const key = offeringCacheKey(vendorId)
  try {
    const cached = await cacheGet(key)
    if (cached && typeof cached === 'string') return cached
  } catch { /* fall through to the database */ }
  const { rows } = await query('SELECT offering FROM vendors WHERE id = $1', [vendorId])
  const offering = rows[0]?.offering || null
  if (offering) await cacheSet(key, offering, CACHE_TTL_SECONDS).catch(() => {})
  return offering
}

/**
 * Root-level preHandler: a vendor may only call the routes of a product it is entitled to
 * (vendors.offering). Runs for every request but only does work for the two prefix lists in
 * offering.js. It verifies the JWT signature itself because it runs before each route's own
 * `authenticate`; if that fails it steps aside and lets the route reject the request.
 *
 * ENFORCE_OFFERING=false (default): it only LOGS what it would have blocked — existing Epic POS
 * clients are never affected. Turn it on only after reviewing those logs.
 */
export function offeringGuard() {
  return async function offeringGuardHook(request, reply) {
    const product = productForPath(request.url)
    if (!product) return

    try {
      if (!request.user) await request.jwtVerify()
    } catch {
      return
    }
    const userId = request.user?.id
    if (!userId) return

    const actor = await loadVendorActor(userId, request.user.shopId || request.user.vendor_id || null)
    if (!actor) return // not a vendor: the route's own checks decide

    const offering = await offeringOf(actor.vendorId)
    if (!offering || offeringAllows(offering, product)) return

    const code = product === 'POS' ? 'POS_NOT_ENABLED' : 'MARKETPLACE_NOT_ENABLED'
    if (!env.ENFORCE_OFFERING) {
      logger.warn({ vendorId: actor.vendorId, offering, product, path: request.url.split('?')[0], method: request.method }, 'ENFORCE_OFFERING=false: request would be blocked')
      return
    }
    return reply.code(403).send({
      success: false,
      code,
      message: product === 'POS'
        ? 'POS is not enabled for this shop. Ask LNDRY to add it, or start POS setup from Settings.'
        : 'This shop is set up for POS only, so marketplace features are not available.',
    })
  }
}
