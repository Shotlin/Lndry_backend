import { query } from '../../../config/database.js'
import { redis } from '../../../config/redis.js'

export class DashboardRepository {
  /**
   * Enhanced dashboard stats with comparison period + sparklines
   * @param {'today'|'week'|'month'} period
   */
  async getStats(period) {
    const { currentStart, previousStart, previousEnd, days } = this._periodRange(period)

    const [revenue, orders, garment_rates, customers, riders, today] = await Promise.all([
      this._revenueStats(currentStart, previousStart, previousEnd, days),
      this._orderStats(currentStart, previousStart, previousEnd, days),
      this._productStats(currentStart, previousStart, previousEnd),
      this._customerStats(currentStart, previousStart, previousEnd),
      this._riderStats(),
      this._todayStats(),
    ])

    return { revenue, orders, garment_rates, customers, riders, today }
  }

  async getRevenueChart(days = 7) {
    const { rows } = await query(
      `SELECT
         DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
         COUNT(*) AS orders,
         COALESCE(SUM(total_amount), 0) AS revenue,
         COALESCE(AVG(total_amount), 0) AS avg_order_value,
         COALESCE(SUM(CASE WHEN payment_method = 'COD' THEN total_amount ELSE 0 END), 0) AS cod_revenue
       FROM orders
       WHERE created_at >= NOW() - make_interval(days => $1)
         AND payment_status = 'PAID'
         AND status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')
       GROUP BY date
       ORDER BY date ASC`,
      [days]
    )
    return rows.map(r => ({
      date: r.date,
      orders: parseInt(r.orders),
      revenue: parseFloat(r.revenue),
      avgOrderValue: parseFloat(r.avg_order_value),
      codRevenue: parseFloat(r.cod_revenue),
    }))
  }

  async getOrdersByHour() {
    const { rows } = await query(
      `SELECT
         EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
         COUNT(*)::int AS order_count
       FROM orders
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY hour
       ORDER BY hour`
    )
    const avg = rows.length > 0
      ? rows.reduce((s, r) => s + r.order_count, 0) / 24
      : 0
    return { hours: rows, avgOrders: Math.round(avg) }
  }

  async getTopProducts(limit = 10) {
    const { rows } = await query(
      `SELECT
         p.id, p.name,
         COUNT(oi.id)::int AS units_sold,
         COALESCE(SUM(oi.total), 0) AS revenue,
         c.name AS category
       FROM order_lines oi
       JOIN garment_types p ON p.id = oi.garment_type_id
       LEFT JOIN service_categories c ON c.id = p.category_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at >= NOW() - INTERVAL '30 days'
         AND o.status = 'DELIVERED'
       GROUP BY p.id, p.name, c.name
       ORDER BY revenue DESC
       LIMIT $1`,
      [limit]
    )
    return rows.map(r => ({
      ...r,
      revenue: parseFloat(r.revenue),
    }))
  }

  async getLowStockAlerts(threshold = 10) {
    return []
  }

  async getPendingActions() {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE status = 'WAITING_VENDOR_CONFIRMATION')::int AS pending_orders,
         (SELECT COUNT(*) FROM orders WHERE status = 'VENDOR_ACCEPTED')::int AS confirmed_orders,
         (SELECT COUNT(*) FROM rider_profiles WHERE is_approved = false)::int AS pending_riders,
         0::int AS low_stock_products,
         (SELECT COUNT(*) FROM rider_payouts WHERE status = 'PENDING')::int AS pending_payouts`
    )
    return rows[0]
  }

  async getLiveStats() {
    const [stats, onlineRiders] = await Promise.all([
      this._todayStats(),
      this._riderStats(),
    ])
    return { today: stats, riders: onlineRiders }
  }

  async getCategoryRevenue() {
    const { rows } = await query(
      `SELECT
         c.name AS category,
         COALESCE(SUM(oi.total), 0) AS revenue
       FROM order_lines oi
       JOIN garment_types p ON p.id = oi.garment_type_id
       JOIN service_categories c ON c.id = p.category_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')
         AND o.payment_status = 'PAID'
         AND o.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY c.name
       ORDER BY revenue DESC`
    )
    return rows.map(r => ({
      category: r.category,
      revenue: parseFloat(r.revenue),
    }))
  }

  // ─── PRIVATE HELPERS ────────────────────────────────

  _periodRange(period) {
    const now = new Date()
    let days
    switch (period) {
      case 'today':
        days = 1; break
      case 'month':
        days = 30; break
      case 'week':
      default:
        days = 7; break
    }
    const currentStart = new Date(now - days * 86400000).toISOString()
    const previousEnd = currentStart
    const previousStart = new Date(now - days * 2 * 86400000).toISOString()
    return { currentStart, previousStart, previousEnd, days }
  }

  async _revenueStats(currentStart, previousStart, previousEnd, days) {
    const [current, previous, sparkline] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM orders WHERE payment_status = 'PAID' AND status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')
           AND created_at >= $1`, [currentStart]
      ),
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM orders WHERE payment_status = 'PAID' AND status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')
           AND created_at >= $1 AND created_at < $2`, [previousStart, previousEnd]
      ),
      query(
        `SELECT COALESCE(SUM(total_amount), 0)::numeric AS rev
         FROM orders
         WHERE payment_status = 'PAID' AND status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')
           AND created_at >= $1
         GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
         ORDER BY DATE(created_at AT TIME ZONE 'Asia/Kolkata') ASC`, [currentStart]
      ),
    ])
    const cur = parseFloat(current.rows[0].total)
    const prev = parseFloat(previous.rows[0].total)
    return {
      current: cur,
      previous: prev,
      change_pct: prev > 0 ? parseFloat(((cur - prev) / prev * 100).toFixed(1)) : 0,
      sparkline: sparkline.rows.map(r => parseFloat(r.rev)),
    }
  }

  async _orderStats(currentStart, previousStart, previousEnd, days) {
    const [current, previous, sparkline] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM orders WHERE created_at >= $1`, [currentStart]),
      query(`SELECT COUNT(*)::int AS total FROM orders WHERE created_at >= $1 AND created_at < $2`, [previousStart, previousEnd]),
      query(
        `SELECT COUNT(*)::int AS cnt
         FROM orders WHERE created_at >= $1
         GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
         ORDER BY DATE(created_at AT TIME ZONE 'Asia/Kolkata') ASC`, [currentStart]
      ),
    ])
    const cur = current.rows[0].total
    const prev = previous.rows[0].total
    return {
      current: cur,
      previous: prev,
      change_pct: prev > 0 ? parseFloat(((cur - prev) / prev * 100).toFixed(1)) : 0,
      sparkline: sparkline.rows.map(r => r.cnt),
    }
  }

  async _productStats(currentStart, previousStart, previousEnd) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_active = true)::int AS active,
         0::int AS out_of_stock,
         0::int AS low_stock
       FROM garment_types`
    )
    return rows[0]
  }

  async _customerStats(currentStart, previousStart, previousEnd) {
    const [total, newCustomers, repeat] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'CUSTOMER'`),
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'CUSTOMER' AND created_at >= $1`, [currentStart]),
      query(
        `SELECT COUNT(*)::int AS total FROM (
           SELECT user_id FROM orders
           WHERE status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')
           GROUP BY user_id HAVING COUNT(*) > 1
         ) sub`
      ),
    ])
    const totalCount = total.rows[0].total
    const repeatCount = repeat.rows[0].total
    return {
      current: totalCount,
      new_this_period: newCustomers.rows[0].total,
      change_pct: 0, // computed from comparison period in sparkline
      repeat_rate: totalCount > 0 ? parseFloat((repeatCount / totalCount * 100).toFixed(1)) : 0,
    }
  }

  async _riderStats() {
    const [totals, onlineKeys] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_online = true)::int AS online,
           COUNT(*) FILTER (WHERE is_approved = false)::int AS pending
         FROM rider_profiles`
      ),
      // Count riders with active delivery assignments
      query(
        `SELECT COUNT(DISTINCT rider_id)::int AS on_delivery
         FROM order_assignments
         WHERE status IN ('ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`
      ),
    ])
    const t = totals.rows[0]
    return {
      total: t.total,
      online: t.online,
      on_delivery: onlineKeys.rows[0].on_delivery,
      offline: t.total - t.online,
    }
  }

  async _todayStats() {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(total_amount), 0) AS revenue,
         COUNT(*)::int AS orders,
         COALESCE(SUM(CASE WHEN payment_method = 'COD' AND status != 'DELIVERED' THEN total_amount ELSE 0 END), 0) AS cod_to_collect,
         COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered
       FROM orders
       WHERE created_at::date = CURRENT_DATE`
    )
    const r = rows[0]
    return {
      revenue: parseFloat(r.revenue),
      orders: r.orders,
      cod_to_collect: parseFloat(r.cod_to_collect),
      delivered: r.delivered,
    }
  }
}
