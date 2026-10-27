/**
 * The ONE definition of "this vendor can serve this customer".
 *
 * Four code paths used to decide this independently and disagreed:
 *   • discovery list / home / search   — approved radius + publish flags + services + slots
 *   • /addresses/validate-location     — delivery_radius_km only, no publish flags
 *   • quote eligibility / order placement — approved radius, plus is_active & status
 *
 * So the app could accept an address as "serviceable" and then show no vendors,
 * or list a vendor whose order was then rejected. Everything now builds its
 * SQL / checks from the fragments below.
 *
 * Radius: `approved_service_radius_km` is the radius an admin approved. If it
 * is missing or zero (data created before approval existed, or a partial
 * update) fall back to the vendor's own `delivery_radius_km`, then to 5 km —
 * the default a vendor is created with. Previously a NULL radius made the
 * distance comparison NULL, which silently hid the vendor from every customer
 * (and, in order placement, silently allowed any distance).
 */

/** SQL expression for a vendor's effective service radius (km). Table alias must be `v`. */
export const EFFECTIVE_RADIUS_SQL =
  'COALESCE(NULLIF(v.approved_service_radius_km, 0), NULLIF(v.delivery_radius_km, 0), 5)'

/** Same rule in JS, for code that already has the vendor row. */
export function effectiveRadiusKm(vendor) {
  const approved = Number(vendor?.approved_service_radius_km)
  if (Number.isFinite(approved) && approved > 0) return approved
  const delivery = Number(vendor?.delivery_radius_km)
  if (Number.isFinite(delivery) && delivery > 0) return delivery
  return 5
}

/** Great-circle distance in km between the customer ($lat,$lng) and vendor `v`. */
export function distanceKmSql(latParam, lngParam) {
  return `(6371 * acos(
    LEAST(1.0, GREATEST(-1.0,
      cos(radians(${latParam}::float8)) * cos(radians(v.lat::float8))
        * cos(radians(v.lng::float8) - radians(${lngParam}::float8))
        + sin(radians(${latParam}::float8)) * sin(radians(v.lat::float8))
    ))
  ))`
}

/** Vendor has coordinates and the customer is inside its effective radius. */
export function withinRadiusSql(latParam, lngParam) {
  return `(v.lat IS NOT NULL AND v.lng IS NOT NULL AND ${distanceKmSql(latParam, lngParam)} <= ${EFFECTIVE_RADIUS_SQL})`
}

/**
 * Everything except distance. Mirrors what order placement enforces
 * (orders.service#prepareOrder), so a vendor that is listed can be ordered from.
 */
export function eligibilityConditions() {
  return [
    'v.is_active = true',
    "v.status = 'APPROVED'",
    'v.vendor_approved = true',
    'v.account_enabled = true',
    'v.marketplace_published = true',
    'v.deleted_at IS NULL',
    `EXISTS (
      SELECT 1 FROM vendor_services vs
      JOIN vendor_service_rates vsr ON vs.id = vsr.vendor_service_id
      WHERE vs.vendor_id = v.id AND vsr.is_active = true AND vs.deleted_at IS NULL AND vs.approval_status = 'APPROVED'
    )`,
    `EXISTS (
      SELECT 1 FROM vendor_slots sl
      WHERE sl.vendor_id = v.id AND sl.is_active = true
    )`,
  ]
}

/**
 * Which individual rule(s) exclude a vendor for a customer location? Used by
 * scripts/diagnose-vendor-visibility.mjs so "why can't customers see vendor X
 * from here?" has a precise answer instead of a guess.
 */
export const ELIGIBILITY_CHECKS = [
  ['is_active', 'v.is_active = true'],
  ['status_approved', "v.status = 'APPROVED'"],
  ['vendor_approved', 'v.vendor_approved = true'],
  ['account_enabled', 'v.account_enabled = true'],
  ['marketplace_published', 'v.marketplace_published = true'],
  ['not_deleted', 'v.deleted_at IS NULL'],
  ['has_approved_service_with_active_rate', `EXISTS (
      SELECT 1 FROM vendor_services vs JOIN vendor_service_rates vsr ON vs.id = vsr.vendor_service_id
      WHERE vs.vendor_id = v.id AND vsr.is_active = true AND vs.deleted_at IS NULL AND vs.approval_status = 'APPROVED')`],
  ['has_active_pickup_slot', 'EXISTS (SELECT 1 FROM vendor_slots sl WHERE sl.vendor_id = v.id AND sl.is_active = true)'],
  ['has_coordinates', '(v.lat IS NOT NULL AND v.lng IS NOT NULL)'],
]
