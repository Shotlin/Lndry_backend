import { query } from '../../../config/database.js'

/**
 * Admin Finance repository — HQ-scoped finance SQL (task 8.9).
 * All queries parameterized, no SELECT *, pagination enforced.
 */
export class AdminFinanceRepository {
  static SHOP_COLUMNS = `
    s.id, s.name, s.commission_rate, s.is_active,
    s.bank_account_number, s.bank_ifsc, s.bank_name, s.bank_holder_name
  `

  static TX_COLUMNS = `
    id, vendor_id, type, amount, balance_after,
    reference_type, reference_id, description,
    direction, status, metadata, rider_id, order_id,
    created_by, created_at
  `

  static FIN_COLUMNS = `
    sf.id, sf.vendor_id, sf.period_type, sf.period_start, sf.period_end,
    sf.gross_revenue, sf.net_revenue, sf.total_orders, sf.avg_order_value,
    sf.platform_commission, sf.delivery_costs, sf.refund_amount,
    sf.payout_amount, sf.payout_status, sf.payout_ref,
    sf.paid_at, sf.failure_reason, sf.attempt_count,
    sf.created_at, sf.updated_at
  `

  /**
   * List vendors with finance summary (paginated).
   */
  async findShops({ page = 1, limit = 20, search, has_pending_payout }) {
    const offset = (page - 1) * limit
    const conditions = ['s.deleted_at IS NULL']
    const params = []
    let idx = 1

    if (search) {
      conditions.push(`s.name ILIKE $${idx++}`)
      params.push(`%${search}%`)
    }

    if (has_pending_payout === true) {
      conditions.push(`EXISTS (
        SELECT 1 FROM shop_financials sf2
        WHERE sf2.vendor_id = s.id AND sf2.payout_status = 'PENDING'
      )`)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${AdminFinanceRepository.SHOP_COLUMNS}
           FROM vendors s
          WHERE ${where}
          ORDER BY s.name ASC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM vendors s
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Transactions for a specific shop (HQ view, paginated).
   */
  async findShopTransactions({ shopId, page = 1, limit = 20, type, direction, from, to }) {
    const offset = (page - 1) * limit
    const conditions = ['vendor_id = $1']
    const params = [shopId]
    let idx = 2

    if (type) {
      conditions.push(`type = $${idx++}`)
      params.push(type)
    }
    if (direction) {
      conditions.push(`direction = $${idx++}`)
      params.push(direction)
    }
    if (from instanceof Date) {
      conditions.push(`created_at >= $${idx++}`)
      params.push(from)
    }
    if (to instanceof Date) {
      conditions.push(`created_at < $${idx++}`)
      params.push(to)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${AdminFinanceRepository.TX_COLUMNS}
           FROM shop_transactions
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_transactions
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Financials for a specific shop (HQ view, paginated).
   */
  async findShopFinancials({ shopId, page = 1, limit = 20, period_type, from, to, payout_status }) {
    const offset = (page - 1) * limit
    const conditions = ['sf.vendor_id = $1']
    const params = [shopId]
    let idx = 2

    if (period_type) {
      conditions.push(`sf.period_type = $${idx++}`)
      params.push(period_type)
    }
    if (from) {
      conditions.push(`sf.period_start >= $${idx++}::date`)
      params.push(from)
    }
    if (to) {
      conditions.push(`sf.period_start <= $${idx++}::date`)
      params.push(to)
    }
    if (payout_status) {
      conditions.push(`sf.payout_status = $${idx++}`)
      params.push(payout_status)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${AdminFinanceRepository.FIN_COLUMNS}
           FROM shop_financials sf
          WHERE ${where}
          ORDER BY sf.period_start DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_financials sf
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Find a single shop_financials row by id and shopId (for mark-paid).
   */
  async findFinancialByIdAndShop(periodId, shopId) {
    const { rows } = await query(
      `SELECT id, vendor_id, payout_status, payout_amount, period_start, period_end
         FROM shop_financials
        WHERE id = $1 AND vendor_id = $2`,
      [periodId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Payout report for CSV export (max 10000 rows).
   */
  async findPayoutReport({ from, to, payout_status, limit = 10000 }) {
    const conditions = []
    const params = []
    let idx = 1

    if (from) {
      conditions.push(`sf.period_start >= $${idx++}::date`)
      params.push(from)
    }
    if (to) {
      conditions.push(`sf.period_start <= $${idx++}::date`)
      params.push(to)
    }
    if (payout_status) {
      conditions.push(`sf.payout_status = $${idx++}`)
      params.push(payout_status)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const cappedLimit = Math.min(limit, 10000)

    const { rows } = await query(
      `SELECT sf.id, sf.vendor_id, s.name AS shop_name,
              sf.period_type, sf.period_start, sf.period_end,
              sf.gross_revenue, sf.net_revenue, sf.payout_amount,
              sf.payout_status, sf.payout_ref, sf.paid_at
         FROM shop_financials sf
         JOIN vendors s ON s.id = sf.vendor_id
        ${where}
        ORDER BY sf.period_start DESC, s.name ASC
        LIMIT $${idx}`,
      [...params, cappedLimit]
    )

    return rows
  }

  /**
   * Comparison view — aggregate financials per shop for a period range.
   */
  async findComparison({ period_type, from, to, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT sf.vendor_id, s.name AS shop_name,
                SUM(sf.gross_revenue)::numeric(12,2) AS total_gross,
                SUM(sf.net_revenue)::numeric(12,2) AS total_net,
                SUM(sf.total_orders)::int AS total_orders,
                SUM(sf.platform_commission)::numeric(12,2) AS total_commission,
                SUM(sf.payout_amount)::numeric(12,2) AS total_payout
           FROM shop_financials sf
           JOIN vendors s ON s.id = sf.vendor_id
          WHERE sf.period_type = $1
            AND sf.period_start >= $2::date
            AND sf.period_start <= $3::date
          GROUP BY sf.vendor_id, s.name
          ORDER BY total_gross DESC
          LIMIT $4 OFFSET $5`,
        [period_type, from, to, limit, offset]
      ),
      query(
        `SELECT COUNT(DISTINCT sf.vendor_id)::int AS total
           FROM shop_financials sf
          WHERE sf.period_type = $1
            AND sf.period_start >= $2::date
            AND sf.period_start <= $3::date`,
        [period_type, from, to]
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }
}
