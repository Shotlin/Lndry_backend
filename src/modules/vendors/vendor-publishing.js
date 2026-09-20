import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

/**
 * Publishes a vendor to the customer marketplace the first time it is
 * service-ready, so approval + setup is all a vendor ever needs to be found.
 *
 * "Service-ready" is exactly what customer discovery and quoting require
 * (discovery.routes.js `getEligibilityConditions`, quotes/vendor-eligibility.js)
 * plus a usable location:
 *   • approved, active, account enabled, not deleted
 *   • at least one APPROVED service with an active rate
 *   • at least one active pickup slot
 *   • a latitude/longitude and a service radius
 *
 * It only ever flips a vendor from unpublished → published ONCE
 * (`marketplace_auto_published_at`), so an admin who unpublishes a vendor on
 * purpose is not overruled. Idempotent and safe to call from anywhere, any
 * number of times; a single statement, so two callers can't race.
 *
 * @param {{ vendorId?: string }} [options] limit to one vendor (after a change
 *   that could make it ready) or omit to sweep everyone.
 * @returns {Promise<string[]>} ids that were just published
 */
export async function autoPublishReadyVendors({ vendorId = null } = {}) {
  const { rows } = await query(
    `UPDATE vendors v
        SET marketplace_published = true,
            is_active = true,
            marketplace_auto_published_at = NOW(),
            updated_at = NOW()
      WHERE v.marketplace_published = false
        AND v.marketplace_auto_published_at IS NULL
        AND v.status = 'APPROVED'
        AND v.vendor_approved = true
        AND v.account_enabled = true
        AND v.is_active = true
        AND v.deleted_at IS NULL
        AND v.lat IS NOT NULL AND v.lng IS NOT NULL
        AND COALESCE(v.approved_service_radius_km, 0) > 0
        AND EXISTS (
          SELECT 1 FROM vendor_services vs
            JOIN vendor_service_rates vsr ON vsr.vendor_service_id = vs.id
           WHERE vs.vendor_id = v.id
             AND vsr.is_active = true
             AND vs.deleted_at IS NULL
             AND vs.approval_status = 'APPROVED')
        AND EXISTS (
          SELECT 1 FROM vendor_slots sl
           WHERE sl.vendor_id = v.id AND sl.is_active = true)
        AND ($1::uuid IS NULL OR v.id = $1::uuid)
      RETURNING v.id, v.name`,
    [vendorId]
  )
  for (const vendor of rows) {
    logger.info({ vendorId: vendor.id, name: vendor.name }, 'Vendor is service-ready — published to the marketplace automatically')
  }
  return rows.map((r) => r.id)
}

/**
 * Fire-and-forget version for request handlers: call it right after a change
 * that can make a vendor ready (approval, service approved, rates or slots
 * saved). Never throws — the periodic sweep is the safety net.
 */
export function autoPublishAfterChange(vendorId) {
  if (!vendorId) return
  autoPublishReadyVendors({ vendorId }).catch((err) =>
    logger.warn({ err: err.message, vendorId }, 'Auto-publish after change failed (the periodic sweep will retry)')
  )
}
