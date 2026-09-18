import { query } from '../../config/database.js'

/**
 * Vendor Counter Sales repository — the pricing side of "ring up a walk-in
 * sale," ported from epic-laundry-desktop's domain.ts#quoteLaundryOrder
 * (the pricing math only — see the service for why booking itself targets
 * `store_orders`, not a new order table).
 */
export class VendorCounterSalesRepository {
  async findServiceRates(vendorId, ids) {
    if (!ids.length) return []
    const { rows } = await query(
      `SELECT r.id, r.rate_paise, r.is_active, gt.name AS garment_name, vs.name AS service_name
       FROM vendor_service_rates r
       JOIN vendor_services vs ON vs.id = r.vendor_service_id
       JOIN garment_types gt ON gt.id = r.garment_type_id
       WHERE vs.vendor_id = $1 AND r.id = ANY($2::uuid[])`,
      [vendorId, ids]
    )
    return rows.map((row) => ({ id: row.id, ratePaise: row.rate_paise, isActive: row.is_active, garmentName: row.garment_name, serviceName: row.service_name }))
  }

  async findCustomer(customerUserId) {
    const { rows } = await query('SELECT id, name, phone FROM users WHERE id = $1', [customerUserId])
    return rows[0] || null
  }
}
