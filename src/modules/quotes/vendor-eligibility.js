import { query } from '../../config/database.js'

/**
 * Checks if a vendor is eligible for a customer based on visibility rules and proximity radius.
 * Returns { eligible: boolean, message: string }
 */
export async function checkVendorEligibility(customerId, vendorId) {
  // 1. Fetch vendor visibility flags and radius
  const eligibilityRes = await query(
    `SELECT v.id, v.lat, v.lng, v.approved_service_radius_km, v.vendor_approved, v.account_enabled, v.marketplace_published
     FROM vendors v
     WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [vendorId]
  )

  if (eligibilityRes.rows.length === 0) {
    return { eligible: false, message: 'Vendor not found', code: 'VENDOR_NOT_FOUND' }
  }

  const v = eligibilityRes.rows[0]
  if (!v.vendor_approved || !v.account_enabled || !v.marketplace_published) {
    return { eligible: false, message: 'Vendor is not currently active on the marketplace', code: 'VENDOR_NOT_ELIGIBLE' }
  }

  // 2. Check if service is configured (has active services with rate configured)
  const serviceConfiguredRes = await query(
    `SELECT 1 
     FROM vendor_services vs 
     JOIN vendor_service_rates vsr ON vs.id = vsr.vendor_service_id 
     WHERE vs.vendor_id = $1 AND vsr.is_active = true AND vs.deleted_at IS NULL
     LIMIT 1`,
    [vendorId]
  )
  if (serviceConfiguredRes.rows.length === 0) {
    return { eligible: false, message: 'Vendor service rates are not configured yet', code: 'VENDOR_NOT_ELIGIBLE' }
  }

  // 3. Check if capacity is configured (has active slots)
  const capacityConfiguredRes = await query(
    `SELECT 1 
     FROM vendor_slots vs 
     WHERE vs.vendor_id = $1 AND vs.is_active = true
     LIMIT 1`,
    [vendorId]
  )
  if (capacityConfiguredRes.rows.length === 0) {
    return { eligible: false, message: 'Vendor pickup capacity is not configured yet', code: 'VENDOR_NOT_ELIGIBLE' }
  }

  // 4. Proximity check using customer default address
  const addrRes = await query(
    `SELECT lat, lng 
     FROM addresses 
     WHERE user_id = $1 AND is_default = true 
     LIMIT 1`,
    [customerId]
  )
  if (addrRes.rows.length > 0) {
    const addr = addrRes.rows[0]
    if (addr.lat && addr.lng && v.lat && v.lng) {
      const distanceRes = await query(
        `SELECT (6371 * acos(
           LEAST(1.0, GREATEST(-1.0,
             cos(radians($1::float8)) * cos(radians($3::float8))
               * cos(radians($4::float8) - radians($2::float8))
               + sin(radians($1::float8)) * sin(radians($3::float8))
           ))
         ))::numeric(7,2) AS distance_km`,
        [addr.lat, addr.lng, v.lat, v.lng]
      )
      const dist = Number(distanceRes.rows[0]?.distance_km || 0)
      if (dist > Number(v.approved_service_radius_km)) {
        return { eligible: false, message: 'Vendor does not deliver to your location', code: 'VENDOR_OUT_OF_RADIUS' }
      }
    }
  }

  return { eligible: true }
}
