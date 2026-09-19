import { query } from '../../config/database.js'
import { checkVendorEligibility } from '../quotes/vendor-eligibility.js'

/**
 * Prepares a reorder from a past order.
 *
 * The old order is only a REFERENCE for "what did this customer buy, from
 * whom": nothing stale is copied. The vendor is re-checked with the same
 * eligibility rules a new quote uses (approved, enabled, published, has
 * rates and pickup capacity, delivers to the customer's default address),
 * and every garment is re-priced against the vendor's CURRENT approved
 * rates. What comes back is what the app can safely put in the cart right
 * now, plus a plain list of anything that is no longer available — so a
 * reorder that succeeds here is guaranteed to get through the quote step.
 *
 * Nothing is written: the customer reviews the cart and checks out as usual.
 */
export async function prepareReorder(userId, orderId) {
  const orderRes = await query(
    `SELECT id, vendor_id FROM orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  )
  const order = orderRes.rows[0]
  if (!order) {
    return { success: false, code: 'ORDER_NOT_FOUND', message: 'We could not find that order.' }
  }
  if (!order.vendor_id) {
    return { success: false, code: 'REORDER_UNAVAILABLE', message: "This order can't be repeated." }
  }

  const eligibility = await checkVendorEligibility(userId, order.vendor_id)
  if (!eligibility.eligible) {
    return {
      success: false,
      code: 'REORDER_VENDOR_UNAVAILABLE',
      message:
        eligibility.code === 'VENDOR_OUT_OF_RADIUS'
          ? "This laundry doesn't deliver to your current location."
          : "This laundry isn't accepting orders right now.",
    }
  }

  const vendorRes = await query(`SELECT name FROM vendors WHERE id = $1`, [order.vendor_id])
  const lineRes = await query(
    `SELECT garment_type_id, name, COALESCE(estimated_quantity, quantity) AS qty
       FROM order_lines
      WHERE order_id = $1 AND garment_type_id IS NOT NULL
      ORDER BY name`,
    [orderId]
  )

  // One entry per garment type — the cart holds a garment once, with a quantity.
  const wanted = new Map()
  for (const line of lineRes.rows) {
    const quantity = Math.max(1, Math.round(Number(line.qty) || 1))
    const existing = wanted.get(line.garment_type_id)
    if (existing) existing.quantity += quantity
    else wanted.set(line.garment_type_id, { garmentTypeId: line.garment_type_id, name: line.name, quantity })
  }

  const items = []
  const unavailable = []
  for (const line of wanted.values()) {
    // Same lookup the quote uses, so "available" here means "quotable".
    const rateRes = await query(
      `SELECT vsr.rate_paise, gt.name, gt.unit
         FROM vendor_service_rates vsr
         JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
         JOIN garment_types gt ON vsr.garment_type_id = gt.id
        WHERE vs.vendor_id = $1
          AND vsr.garment_type_id = $2
          AND vsr.is_active = true
          AND vs.deleted_at IS NULL
          AND vs.approval_status = 'APPROVED'
        LIMIT 1`,
      [order.vendor_id, line.garmentTypeId]
    )
    const rate = rateRes.rows[0]
    if (!rate) {
      unavailable.push({ name: line.name, reason: 'No longer offered by this laundry' })
      continue
    }
    items.push({
      serviceId: line.garmentTypeId,
      name: rate.name,
      unit: rate.unit,
      quantity: line.quantity,
      ratePaise: Number(rate.rate_paise),
    })
  }

  if (items.length === 0) {
    return {
      success: false,
      code: 'REORDER_NOTHING_AVAILABLE',
      message: 'None of the items from this order are available right now.',
    }
  }

  return {
    success: true,
    data: {
      vendorId: order.vendor_id,
      vendorName: vendorRes.rows[0]?.name || '',
      items,
      itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
      unavailable,
    },
  }
}
