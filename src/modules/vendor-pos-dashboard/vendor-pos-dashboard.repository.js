import { query } from '../../config/database.js'

/**
 * Vendor POS Dashboard repository — Tier 4 of the POS-parity initiative
 * (see CLAUDE.md). Deliberately NOT a re-implementation of epic's own
 * laundryDashboard (which is built around epic's local pickup/delivery
 * order model and LNDRY's real business already has its own dashboards for
 * that — admin/reports, shop-reports, vendor-analytics). This is specific
 * to the counter/POS surface this initiative actually added: counter
 * sales, cash shifts, production tasks, quality claims, return cases,
 * rider settlements. Every query here is read-only, over tables already
 * shipped in Tiers 0-3 — no new migration for this whole tier.
 */
export class VendorPosDashboardRepository {
  async counterSalesSummary(vendorId, asOf) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_paise), 0)::int AS revenue_paise
       FROM store_orders WHERE vendor_id = $1 AND placed_at::date = $2`,
      [vendorId, asOf]
    )
    return { count: rows[0].count, revenuePaise: rows[0].revenue_paise }
  }

  async openCashShift(vendorId) {
    const { rows } = await query(
      `SELECT id, register, opening_cash_paise, opened_at FROM vendor_cash_shifts WHERE vendor_id = $1 AND status = 'OPEN' LIMIT 1`,
      [vendorId]
    )
    return rows[0] || null
  }

  async productionTaskCounts(vendorId) {
    const { rows } = await query(
      `SELECT status, priority, COUNT(*)::int AS count FROM vendor_production_tasks WHERE vendor_id = $1 AND status IN ('OPEN', 'IN_PROGRESS') GROUP BY status, priority`,
      [vendorId]
    )
    return rows
  }

  async openQualityClaimsCount(vendorId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM vendor_quality_claims WHERE vendor_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')`, [vendorId])
    return rows[0].count
  }

  async pendingReturnCasesCount(vendorId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM vendor_return_cases WHERE vendor_id = $1 AND status = 'REQUESTED'`, [vendorId])
    return rows[0].count
  }

  async pendingRiderSettlementsCount(vendorId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM vendor_rider_settlements WHERE vendor_id = $1 AND status IN ('PENDING', 'HANDED_OVER')`, [vendorId])
    return rows[0].count
  }

  async activeOrderHoldsCount(vendorId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM vendor_order_holds WHERE vendor_id = $1 AND status = 'HELD'`, [vendorId])
    return rows[0].count
  }

  async topGarmentsSince(vendorId, from) {
    const { rows } = await query(
      `SELECT item->>'name' AS name, COUNT(*)::int AS units, SUM((item->>'amountPaise')::int)::int AS revenue_paise
       FROM store_orders so, jsonb_array_elements(so.items) AS item
       WHERE so.vendor_id = $1 AND so.placed_at >= $2
       GROUP BY item->>'name' ORDER BY units DESC LIMIT 10`,
      [vendorId, from]
    )
    return rows.map((row) => ({ name: row.name, units: row.units, revenuePaise: row.revenue_paise }))
  }

  async exportCounterSales(vendorId, from, to) {
    const { rows } = await query(
      `SELECT so.order_number, so.placed_at, u.name AS customer_name, u.phone AS customer_phone,
              so.subtotal_paise, so.discount_paise, so.tax_paise, so.total_paise, so.payment_method
       FROM store_orders so JOIN users u ON u.id = so.customer_user_id
       WHERE so.vendor_id = $1 AND so.placed_at::date >= $2 AND so.placed_at::date <= $3
       ORDER BY so.placed_at ASC`,
      [vendorId, from, to]
    )
    return rows
  }

  async search(vendorId, q) {
    const like = `%${q}%`
    const [customers, orders, garments] = await Promise.all([
      query(
        `SELECT DISTINCT u.id, u.name, u.phone FROM users u JOIN store_orders so ON so.customer_user_id = u.id
         WHERE so.vendor_id = $1 AND (u.name ILIKE $2 OR u.phone ILIKE $2) LIMIT 10`,
        [vendorId, like]
      ),
      query(
        `SELECT id, order_number, total_paise, placed_at FROM store_orders WHERE vendor_id = $1 AND order_number ILIKE $2 ORDER BY placed_at DESC LIMIT 10`,
        [vendorId, like]
      ),
      query(
        `SELECT id, active_tag_code, state, order_id FROM vendor_garment_units WHERE vendor_id = $1 AND active_tag_code ILIKE $2 LIMIT 10`,
        [vendorId, like]
      ),
    ])
    return {
      customers: customers.rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone })),
      orders: orders.rows.map((r) => ({ id: r.id, orderNumber: r.order_number, totalPaise: r.total_paise, placedAt: r.placed_at })),
      garmentUnits: garments.rows.map((r) => ({ id: r.id, tagCode: r.active_tag_code, state: r.state, orderId: r.order_id })),
    }
  }
}
