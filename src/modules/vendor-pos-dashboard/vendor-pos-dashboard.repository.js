import { query } from '../../config/database.js'
import { HOME_TILE_CONDITIONS as T } from './home-tile-filters.js'

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
    // Money actually received today (payments), kept separate from what was billed.
    const paid = await query(
      `SELECT COALESCE(SUM(amount_paise), 0)::int AS collected_paise
       FROM store_order_payments WHERE vendor_id = $1 AND created_at::date = $2`,
      [vendorId, asOf]
    )
    return { count: rows[0].count, revenuePaise: rows[0].revenue_paise, collectedPaise: paid.rows[0].collected_paise }
  }

  /**
   * POS Home tiles. Every figure is a plain count/sum over this vendor's rows. The order set is the same one the
   * Orders list shows (counter orders, i.e. NOT the 'DESKTOP_PUSH' mirror rows), so tapping a tile and seeing a
   * different number is impossible. "Active" = not DELIVERED / CANCELLED. Definitions follow Epic's queues.
   */
  async homeOrderTiles(vendorId, asOf) {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(total_paise) FILTER (WHERE ${T.bookingsToday('store_orders', '$2::date')}), 0)::bigint AS revenue_today_paise,
         COUNT(*) FILTER (WHERE ${T.bookingsToday('store_orders', '$2::date')})::int AS bookings_today,
         COUNT(*) FILTER (WHERE ${T.deliveriesToday('store_orders', '$2::date')})::int AS deliveries_today,
         COUNT(*) FILTER (WHERE ${T.upcomingDeliveries('store_orders', '$2::date')})::int AS upcoming_deliveries,
         COUNT(*) FILTER (WHERE ${T.deliveredToday('store_orders', '$2::date')})::int AS delivered_today,
         COUNT(*) FILTER (WHERE ${T.pendingOrders('store_orders')})::int AS pending_orders,
         COUNT(*) FILTER (WHERE ${T.unassignedPickups('store_orders')})::int AS unassigned_pickups,
         COUNT(*) FILTER (WHERE ${T.unassignedDeliveries('store_orders')})::int AS unassigned_deliveries,
         COUNT(*) FILTER (WHERE ${T.expressOrders('store_orders')})::int AS express_orders,
         COALESCE(SUM(total_paise - amount_paid_paise) FILTER (WHERE ${T.collectionDue('store_orders')}), 0)::bigint AS collection_due_paise
       FROM store_orders
       WHERE vendor_id = $1 AND source <> 'DESKTOP_PUSH'`,
      [vendorId, asOf]
    )
    return rows[0]
  }

  // Money actually received today on this list's orders (cash/UPI/card/bank/wallet payments rows).
  async homeCollectionToday(vendorId, asOf) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(p.amount_paise), 0)::bigint AS collected_paise
       FROM store_order_payments p JOIN store_orders so ON so.id = p.store_order_id
       WHERE p.vendor_id = $1 AND so.source <> 'DESKTOP_PUSH' AND p.created_at::date = $2`,
      [vendorId, asOf]
    )
    return rows[0].collected_paise
  }

  // Marketplace orders waiting for this vendor to accept (always 0 for a POS-only shop: it has none).
  async onlineOrderRequestsCount(vendorId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM orders WHERE vendor_id = $1 AND status = 'WAITING_VENDOR_CONFIRMATION'`, [vendorId])
    return rows[0].count
  }

  // Garments whose washing is finished and that wait at assembly to be racked in the store.
  async washingToStoreCount(vendorId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM vendor_garment_units WHERE vendor_id = $1 AND state = 'ASSEMBLY'`, [vendorId])
    return rows[0].count
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
