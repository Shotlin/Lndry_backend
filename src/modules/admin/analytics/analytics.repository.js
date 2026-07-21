import { query } from '../../../config/database.js'

export class AdminAnalyticsRepository {
  async getSalesAnalytics({ startDate, endDate, groupBy = 'day' }) {
    const trunc = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day'
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }

    const { rows: timeSeries } = await query(
      `SELECT DATE_TRUNC('${trunc}', o.created_at) AS period,
              SUM(o.total_amount) AS revenue, COUNT(*)::int AS orders,
              AVG(o.total_amount) AS avg_order_value,
              SUM(COALESCE(o.discount_amount, 0)) AS total_discount
       FROM orders o ${dateFilter}
       GROUP BY period ORDER BY period`,
      params
    )

    const { rows: [summary] } = await query(
      `SELECT SUM(o.total_amount) AS total_revenue, COUNT(*)::int AS total_orders,
              AVG(o.total_amount) AS avg_order_value,
              COUNT(DISTINCT o.user_id)::int AS unique_customers,
              SUM(COALESCE(o.discount_amount, 0)) AS total_discounts
       FROM orders o ${dateFilter}`,
      params
    )

    return {
      summary: {
        total_revenue: parseFloat(summary.total_revenue || 0),
        total_orders: summary.total_orders,
        avg_order_value: parseFloat(summary.avg_order_value || 0),
        unique_customers: summary.unique_customers,
        total_discounts: parseFloat(summary.total_discounts || 0),
      },
      timeSeries: timeSeries.map(r => ({
        period: r.period,
        revenue: parseFloat(r.revenue),
        orders: r.orders,
        avg_order_value: parseFloat(r.avg_order_value),
        total_discount: parseFloat(r.total_discount),
      })),
    }
  }

  async getProductPerformance({ startDate, endDate, limit = 20 }) {
    const params = [limit]
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }

    const { rows } = await query(
      `SELECT p.id, p.name, c.name AS category,
              SUM(oi.quantity)::int AS units_sold,
              SUM(oi.total) AS revenue,
              COUNT(DISTINCT o.user_id)::int AS unique_buyers,
              0::int AS views,
              0::numeric AS conversion_rate
       FROM order_lines oi
       JOIN orders o ON o.id = oi.order_id
       JOIN garment_types p ON p.id = oi.garment_type_id
       LEFT JOIN service_categories c ON c.id = p.category_id
       ${dateFilter}
       GROUP BY p.id, p.name, c.name
       ORDER BY revenue DESC
       LIMIT $1`,
      params
    )
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      thumbnail_url: null,
      category: r.category,
      units_sold: r.units_sold,
      revenue: parseFloat(r.revenue),
      unique_buyers: r.unique_buyers,
      views: 0,
      conversion_rate: 0
    }))
  }

  async getCustomerCohorts() {
    const { rows } = await query(
      `WITH cohorts AS (
         SELECT DATE_TRUNC('month', u.created_at) AS cohort_month,
                u.id AS user_id
         FROM users u WHERE u.role = 'CUSTOMER'
       ),
       orders_by_month AS (
         SELECT c.cohort_month, DATE_TRUNC('month', o.created_at) AS order_month,
                COUNT(DISTINCT c.user_id)::int AS active_users
         FROM cohorts c
         JOIN orders o ON o.user_id = c.user_id AND o.status = 'DELIVERED'
         GROUP BY c.cohort_month, DATE_TRUNC('month', o.created_at)
       ),
       cohort_sizes AS (
         SELECT cohort_month, COUNT(*)::int AS size FROM cohorts GROUP BY cohort_month
       )
       SELECT obm.cohort_month, cs.size AS cohort_size, obm.order_month,
              obm.active_users,
              ROUND(obm.active_users::numeric / cs.size * 100, 2) AS retention_pct
       FROM orders_by_month obm
       JOIN cohort_sizes cs ON cs.cohort_month = obm.cohort_month
       ORDER BY obm.cohort_month, obm.order_month`
    )
    return rows.map(r => ({ ...r, retention_pct: parseFloat(r.retention_pct) }))
  }

  async getDeliveryAnalytics({ startDate, endDate }) {
    const params = []
    let dateFilter = "WHERE da.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND da.delivered_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND da.delivered_at <= $${params.length}` }

    const { rows: [summary] } = await query(
      `SELECT COUNT(*)::int AS total_deliveries,
              AVG(da.delivery_time_minutes) AS avg_delivery_time,
              AVG(da.distance_km) AS avg_distance,
              AVG(da.rating) AS avg_rating,
              COUNT(CASE WHEN da.delivery_time_minutes <= 30 THEN 1 END)::int AS on_time_count,
              SUM(da.tip_amount) AS total_tips
       FROM order_assignments da ${dateFilter}`,
      params
    )

    const { rows: byHour } = await query(
      `SELECT EXTRACT(HOUR FROM da.delivered_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
              COUNT(*)::int AS deliveries,
              AVG(da.delivery_time_minutes) AS avg_time
       FROM order_assignments da ${dateFilter}
       GROUP BY hour ORDER BY hour`,
      params
    )

    const onTimePct = summary.total_deliveries > 0
      ? Math.round(summary.on_time_count / summary.total_deliveries * 100)
      : 0

    return {
      summary: {
        total_deliveries: summary.total_deliveries,
        avg_delivery_time: parseFloat(summary.avg_delivery_time || 0).toFixed(1),
        avg_distance: parseFloat(summary.avg_distance || 0).toFixed(2),
        avg_rating: parseFloat(summary.avg_rating || 0).toFixed(2),
        on_time_percentage: onTimePct,
        total_tips: parseFloat(summary.total_tips || 0),
      },
      byHour: byHour.map(r => ({ hour: r.hour, deliveries: r.deliveries, avg_time: parseFloat(r.avg_time).toFixed(1) })),
    }
  }

  async getFinancialReport({ startDate, endDate }) {
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }

    const { rows: [rev] } = await query(
      `SELECT SUM(o.total_amount) AS gross_revenue,
              SUM(COALESCE(o.discount_amount, 0)) AS total_discounts,
              SUM(COALESCE(o.delivery_fee, 0)) AS delivery_fees,
              SUM(o.total_amount - COALESCE(o.discount_amount, 0)) AS net_revenue,
              COUNT(*)::int AS order_count
       FROM orders o ${dateFilter}`,
      params
    )

    const { rows: byPayment } = await query(
      `SELECT o.payment_method, SUM(o.total_amount) AS revenue, COUNT(*)::int AS count
       FROM orders o ${dateFilter}
       GROUP BY o.payment_method ORDER BY revenue DESC`,
      params
    )

    const { rows: gstRows } = await query(
      `SELECT 0 AS gst_rate,
              SUM(oi.total) AS taxable_amount,
              0 AS gst_amount
       FROM order_lines oi
       JOIN orders o ON o.id = oi.order_id
       ${dateFilter}`,
      params
    )

    return {
      revenue: {
        gross: parseFloat(rev.gross_revenue || 0),
        discounts: parseFloat(rev.total_discounts || 0),
        delivery_fees: parseFloat(rev.delivery_fees || 0),
        net: parseFloat(rev.net_revenue || 0),
        order_count: rev.order_count,
      },
      byPaymentMethod: byPayment.map(r => ({ ...r, revenue: parseFloat(r.revenue) })),
      gstBreakdown: gstRows.map(r => ({
        gst_rate: parseFloat(r.gst_rate),
        taxable_amount: parseFloat(r.taxable_amount),
        gst_amount: parseFloat(r.gst_amount),
      })),
    }
  }

  async getCartEnhancementAnalytics({ startDate, endDate }) {
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }

    const { rows: [summary] } = await query(
      `SELECT COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0) AS total_tips,
              COALESCE(AVG(NULLIF(o.tip_amount, 0)), 0) AS average_tip,
              COUNT(CASE WHEN COALESCE(o.tip_amount, 0) > 0 THEN 1 END)::int AS tipped_orders,
              COALESCE(SUM(COALESCE(o.delivery_fee, 0)), 0) AS total_delivery_fees,
              COALESCE(SUM(COALESCE(o.handling_fee, 0)), 0) AS total_handling_fees,
              COALESCE(SUM(COALESCE(o.late_night_fee, 0)), 0) AS total_late_night_fees
       FROM orders o ${dateFilter}`,
      params
    )

    const { rows: [popularTip] } = await query(
      `SELECT o.tip_amount AS amount, COUNT(*)::int AS frequency
       FROM orders o
       ${dateFilter} AND COALESCE(o.tip_amount, 0) > 0
       GROUP BY o.tip_amount
       ORDER BY frequency DESC, o.tip_amount DESC
       LIMIT 1`,
      params
    )

    return {
      tipAnalytics: {
        totalTips: parseFloat(summary.total_tips || 0),
        averageTip: parseFloat(summary.average_tip || 0),
        mostPopularAmount: popularTip ? parseFloat(popularTip.amount) : null,
        tippedOrders: summary.tipped_orders || 0,
      },
      feeRevenue: {
        totalDeliveryFees: parseFloat(summary.total_delivery_fees || 0),
        totalHandlingFees: parseFloat(summary.total_handling_fees || 0),
        totalLateNightFees: parseFloat(summary.total_late_night_fees || 0),
      },
    }
  }

  async getComparisonStats(period1Start, period1End, period2Start, period2End) {
    const getStats = async (start, end) => {
      const { rows: [s] } = await query(
        `SELECT SUM(total_amount) AS revenue, COUNT(*)::int AS orders,
                COUNT(DISTINCT user_id)::int AS customers, AVG(total_amount) AS aov
         FROM orders WHERE status = 'DELIVERED' AND created_at >= $1 AND created_at <= $2`,
        [start, end]
      )
      return {
        revenue: parseFloat(s.revenue || 0),
        orders: s.orders,
        customers: s.customers,
        aov: parseFloat(s.aov || 0),
      }
    }

    const [current, previous] = await Promise.all([
      getStats(period1Start, period1End),
      getStats(period2Start, period2End),
    ])

    const pctChange = (cur, prev) => prev > 0 ? Math.round((cur - prev) / prev * 100) : cur > 0 ? 100 : 0

    return {
      current,
      previous,
      changes: {
        revenue: pctChange(current.revenue, previous.revenue),
        orders: pctChange(current.orders, previous.orders),
        customers: pctChange(current.customers, previous.customers),
        aov: pctChange(current.aov, previous.aov),
      },
    }
  }
}
