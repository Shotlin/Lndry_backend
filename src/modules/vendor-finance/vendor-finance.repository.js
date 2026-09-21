import { query } from '../../config/database.js'

/**
 * Read-only SQL behind the vendor finance reports.
 *
 * Two sales channels, kept apart by the table they live in — never by an order-number pattern or a label:
 *   POS            store_orders (+ store_order_payments)   in-store / counter sales
 *   LNDRY_ONLINE   orders (+ payments)                      customer-app marketplace orders
 *
 * Every query is scoped by `vendor_id = $1`. Dates are Indian calendar dates (a sale rung up at
 * 11:30 pm belongs to that day, not the next UTC day). Amounts come back exactly as persisted; the
 * service turns them into the report and never re-prices anything.
 */

const IST = `'Asia/Kolkata'`
const day = (column) => `(${column} AT TIME ZONE ${IST})::date`
// node-pg turns a DATE into a local-time JS Date (off by a day in some time zones), so dates that are
// returned to the service are always cast to 'YYYY-MM-DD' text.
const dayText = (column) => `${day(column)}::text`

/**
 * A counter sale that is really an online order mirrored into store_orders under the same order
 * number would be counted twice. The two tables are separate today, so this matches nothing — it is
 * a permanent guard so the "All" view can never double-count.
 */
const NOT_A_MIRROR = `NOT EXISTS (SELECT 1 FROM orders mo WHERE mo.vendor_id = so.vendor_id AND mo.order_number = so.order_number)`

const num = (value) => Number(value) || 0

export class VendorFinanceRepository {
  // ── Vendor + marketplace linkage ─────────────────────────────────────────

  async vendorProfile(vendorId) {
    const { rows } = await query(
      `SELECT id, name, gst_number, state, city, commission_rate,
              vendor_approved, account_enabled, is_active, deleted_at, marketplace_published,
              (SELECT COUNT(*)::int FROM orders o WHERE o.vendor_id = v.id) AS online_order_count
         FROM vendors v WHERE v.id = $1`,
      [vendorId]
    )
    return rows[0] || null
  }

  // ── POS (store_orders) ───────────────────────────────────────────────────

  /** One row per (day, GST rate): the sales picture, cancelled orders kept apart. */
  async posSales(vendorId, from, to) {
    const { rows } = await query(
      `SELECT ${dayText('so.placed_at')} AS day, so.tax_rate_bps,
              COUNT(*) FILTER (WHERE so.status <> 'CANCELLED')::int                          AS orders,
              COALESCE(SUM(so.subtotal_paise) FILTER (WHERE so.status <> 'CANCELLED'), 0)    AS subtotal,
              COALESCE(SUM(so.charges_paise)  FILTER (WHERE so.status <> 'CANCELLED'), 0)    AS charges,
              COALESCE(SUM(so.discount_paise) FILTER (WHERE so.status <> 'CANCELLED'), 0)    AS discount,
              COALESCE(SUM(so.tax_paise)      FILTER (WHERE so.status <> 'CANCELLED'), 0)    AS tax,
              COALESCE(SUM(so.tax_paise / 2)  FILTER (WHERE so.status <> 'CANCELLED'), 0)    AS cgst,
              COALESCE(SUM(so.tax_paise - so.tax_paise / 2) FILTER (WHERE so.status <> 'CANCELLED'), 0) AS sgst,
              COALESCE(SUM(so.total_paise)    FILTER (WHERE so.status <> 'CANCELLED'), 0)    AS total,
              COALESCE(SUM(GREATEST(so.total_paise - so.amount_paid_paise, 0)) FILTER (WHERE so.status <> 'CANCELLED'), 0) AS outstanding,
              COUNT(*) FILTER (WHERE so.status = 'CANCELLED')::int                           AS cancelled_orders,
              COALESCE(SUM(so.amount_paid_paise) FILTER (WHERE so.status = 'CANCELLED'), 0)  AS cancelled_paid,
              COUNT(*) FILTER (WHERE so.status <> 'CANCELLED' AND so.tax_paise > 0)::int     AS taxed_orders
         FROM store_orders so
        WHERE so.vendor_id = $1 AND ${day('so.placed_at')} BETWEEN $2::date AND $3::date AND ${NOT_A_MIRROR}
        GROUP BY 1, 2 ORDER BY 1`,
      [vendorId, from, to]
    )
    return rows
  }

  /** Outstanding on every open POS sale, whatever day it was rung up. */
  async posOutstandingNow(vendorId) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(GREATEST(so.total_paise - so.amount_paid_paise, 0)), 0) AS outstanding, COUNT(*)::int AS orders
         FROM store_orders so
        WHERE so.vendor_id = $1 AND so.status <> 'CANCELLED' AND so.total_paise > so.amount_paid_paise AND ${NOT_A_MIRROR}`,
      [vendorId]
    )
    return { outstanding: num(rows[0]?.outstanding), orders: num(rows[0]?.orders) }
  }

  async posMirroredCount(vendorId, from, to) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM store_orders so
        WHERE so.vendor_id = $1 AND ${day('so.placed_at')} BETWEEN $2::date AND $3::date AND NOT (${NOT_A_MIRROR})`,
      [vendorId, from, to]
    )
    return num(rows[0]?.n)
  }

  /** Money taken at the counter, by day and payment mode. Older desktop-pushed sales carry only a paid amount + method. */
  async posPayments(vendorId, from, to) {
    const { rows } = await query(
      `SELECT d AS day, mode, SUM(amount)::bigint AS amount, COUNT(*)::int AS count FROM (
          SELECT ${dayText('p.created_at')} AS d, p.mode::text AS mode, p.amount_paise AS amount
            FROM store_order_payments p JOIN store_orders so ON so.id = p.store_order_id
           WHERE p.vendor_id = $1 AND ${day('p.created_at')} BETWEEN $2::date AND $3::date AND ${NOT_A_MIRROR}
          UNION ALL
          SELECT ${dayText('so.placed_at')}, COALESCE(NULLIF(so.payment_method, ''), 'OTHER'), so.amount_paid_paise
            FROM store_orders so
           WHERE so.vendor_id = $1 AND so.amount_paid_paise > 0 AND ${day('so.placed_at')} BETWEEN $2::date AND $3::date
             AND NOT EXISTS (SELECT 1 FROM store_order_payments p WHERE p.store_order_id = so.id) AND ${NOT_A_MIRROR}
        ) x GROUP BY 1, 2 ORDER BY 1`,
      [vendorId, from, to]
    )
    return rows
  }

  /** Approved return cases against counter sales — the recorded refund approvals (a case tracks the refund; it does not move money). */
  async posRefunds(vendorId, from, to) {
    const { rows } = await query(
      `SELECT ${dayText('COALESCE(rc.decided_at, rc.created_at)')} AS day, rc.amount_paise,
              ROUND(rc.amount_paise::numeric * so.tax_paise / NULLIF(so.total_paise, 0))::int AS tax_portion,
              (so.status <> 'CANCELLED') AS on_sale, so.tax_rate_bps
         FROM vendor_return_cases rc JOIN store_orders so ON so.id = rc.order_id AND so.vendor_id = rc.vendor_id
        WHERE rc.vendor_id = $1 AND rc.status = 'APPROVED'
          AND ${day('COALESCE(rc.decided_at, rc.created_at)')} BETWEEN $2::date AND $3::date`,
      [vendorId, from, to]
    )
    return rows
  }

  async posTopItems(vendorId, from, to) {
    const { rows } = await query(
      `SELECT COALESCE(NULLIF(it->>'name', ''), 'Item') AS name,
              COALESCE(SUM(CASE WHEN (it->>'amountPaise') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ROUND((it->>'amountPaise')::numeric) ELSE 0 END), 0) AS amount,
              COUNT(DISTINCT so.id)::int AS orders
         FROM store_orders so,
              jsonb_array_elements(CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END) it
        WHERE so.vendor_id = $1 AND so.status <> 'CANCELLED' AND ${day('so.placed_at')} BETWEEN $2::date AND $3::date AND ${NOT_A_MIRROR}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [vendorId, from, to]
    )
    return rows
  }

  async expenses(vendorId, from, to) {
    const { rows } = await query(
      `SELECT expense_date::date::text AS day, payment_mode, category, SUM(amount_paise)::bigint AS amount, COUNT(*)::int AS count
         FROM vendor_expenses
        WHERE vendor_id = $1 AND status = 'PAID' AND expense_date BETWEEN $2::date AND $3::date
        GROUP BY 1, 2, 3 ORDER BY 1`,
      [vendorId, from, to]
    )
    return rows
  }

  async cashClosing(vendorId, from, to) {
    const [closed, open] = await Promise.all([
      query(
        `SELECT id, register, business_date::text AS business_date, opening_cash_paise, expected_cash_paise, counted_cash_paise, variance_paise, closed_at
           FROM vendor_cash_shifts
          WHERE vendor_id = $1 AND status = 'CLOSED' AND business_date BETWEEN $2::date AND $3::date
          ORDER BY closed_at DESC NULLS LAST LIMIT 200`,
        [vendorId, from, to]
      ),
      query(
        `SELECT id, register, business_date::text AS business_date, opening_cash_paise, opened_at FROM vendor_cash_shifts
          WHERE vendor_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC`,
        [vendorId]
      ),
    ])
    return { closed: closed.rows, open: open.rows }
  }

  async captainSettlements(vendorId, from, to) {
    const { rows } = await query(
      `SELECT status, SUM(amount_paise)::bigint AS amount, COUNT(*)::int AS count
         FROM vendor_rider_settlements
        WHERE vendor_id = $1 AND settlement_date BETWEEN $2::date AND $3::date
        GROUP BY 1`,
      [vendorId, from, to]
    )
    return rows
  }

  // ── LNDRY online (orders) ────────────────────────────────────────────────

  /**
   * One row per online order booked in the range, with the persisted money columns — the same ones
   * the invoice reads. Lines / paid / refunded are summed per order so the service can classify it.
   */
  async onlineOrders(vendorId, from, to) {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.status::text AS status, ${dayText('o.created_at')} AS day,
              o.payment_status, o.payment_method, o.fee_breakdown,
              o.payable_amount_paise, o.total_amount, o.subtotal, o.discount_amount, o.delivery_fee,
              o.platform_fee, o.handling_fee, o.tax_amount,
              lt.lines_paise, lt.line_count,
              COALESCE(pd.paid_paise, 0) AS paid_paise,
              (SELECT NULLIF(TRIM(o.delivery_address->>'state'), '')) AS ship_state
         FROM orders o
         LEFT JOIN LATERAL (
              SELECT SUM(COALESCE(l.total_paise, ROUND(l.total * 100)::int))::bigint AS lines_paise, COUNT(*)::int AS line_count
                FROM order_lines l WHERE l.order_id = o.id) lt ON true
         LEFT JOIN LATERAL (
              SELECT SUM(ROUND(p.amount * 100))::bigint AS paid_paise
                FROM payments p WHERE p.order_id = o.id AND p.status = 'PAID') pd ON true
        WHERE o.vendor_id = $1 AND ${day('o.created_at')} BETWEEN $2::date AND $3::date
        ORDER BY o.created_at`,
      [vendorId, from, to]
    )
    return rows
  }

  /** Outstanding on every open online order, whatever day it was booked — the caller classifies with the same rule as the period rows. */
  async onlineOpenOrders(vendorId) {
    const { rows } = await query(
      `SELECT o.id, o.status::text AS status, o.payment_status, o.fee_breakdown,
              o.payable_amount_paise, o.total_amount, o.subtotal, o.discount_amount, o.delivery_fee,
              o.platform_fee, o.handling_fee, o.tax_amount, lt.lines_paise,
              COALESCE(pd.paid_paise, 0) AS paid_paise
         FROM orders o
         LEFT JOIN LATERAL (
              SELECT SUM(COALESCE(l.total_paise, ROUND(l.total * 100)::int))::bigint AS lines_paise
                FROM order_lines l WHERE l.order_id = o.id) lt ON true
         LEFT JOIN LATERAL (
              SELECT SUM(ROUND(p.amount * 100))::bigint AS paid_paise
                FROM payments p WHERE p.order_id = o.id AND p.status = 'PAID') pd ON true
        WHERE o.vendor_id = $1 AND COALESCE(o.payment_status, '') <> 'PAID'
          AND o.status::text NOT IN ('PENDING', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'WAITING_VENDOR_CONFIRMATION', 'WAITING_FOR_VENDOR_CONFIRMATION', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'CANCELLED', 'REFUNDED')`,
      [vendorId]
    )
    return rows
  }

  async onlinePayments(vendorId, from, to) {
    const { rows } = await query(
      `SELECT ${dayText('p.created_at')} AS day, UPPER(COALESCE(NULLIF(p.method, ''), 'ONLINE')) AS method,
              SUM(ROUND(p.amount * 100))::bigint AS amount, COUNT(*)::int AS count
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.vendor_id = $1 AND p.status = 'PAID' AND ${day('p.created_at')} BETWEEN $2::date AND $3::date
        GROUP BY 1, 2 ORDER BY 1`,
      [vendorId, from, to]
    )
    return rows
  }

  /** Refunds actually recorded on payments (a payment carries its own refund_amount). Dated by when the refund was recorded. */
  async onlineRefunds(vendorId, from, to) {
    const { rows } = await query(
      `SELECT ${dayText('p.updated_at')} AS day, ROUND(p.refund_amount * 100)::bigint AS refund_paise,
              o.status::text AS status, o.fee_breakdown, o.payable_amount_paise, o.total_amount, o.subtotal,
              o.discount_amount, o.delivery_fee, o.platform_fee, o.handling_fee, o.tax_amount, lt.lines_paise
         FROM payments p JOIN orders o ON o.id = p.order_id
         LEFT JOIN LATERAL (
              SELECT SUM(COALESCE(l.total_paise, ROUND(l.total * 100)::int))::bigint AS lines_paise
                FROM order_lines l WHERE l.order_id = o.id) lt ON true
        WHERE o.vendor_id = $1 AND p.refund_amount > 0 AND COALESCE(UPPER(p.refund_status), '') NOT IN ('FAILED', 'REJECTED')
          AND ${day('p.updated_at')} BETWEEN $2::date AND $3::date`,
      [vendorId, from, to]
    )
    return rows
  }

  async onlineTopItems(vendorId, from, to, saleStatuses) {
    const { rows } = await query(
      `SELECT l.name AS name, SUM(COALESCE(l.total_paise, ROUND(l.total * 100)::int))::bigint AS amount, COUNT(DISTINCT o.id)::int AS orders
         FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE o.vendor_id = $1 AND o.status::text = ANY($4::text[]) AND ${day('o.created_at')} BETWEEN $2::date AND $3::date
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [vendorId, from, to, saleStatuses]
    )
    return rows
  }

  /** The platform's own settlement records for this vendor (daily rows, written by the settlement worker). */
  async settlements(vendorId, from, to) {
    const { rows } = await query(
      `SELECT period_start::text AS period_start, gross_revenue, platform_commission, delivery_costs, refund_amount, net_revenue,
              payout_amount, payout_status, paid_at, total_orders
         FROM shop_financials
        WHERE vendor_id = $1 AND period_type = 'DAILY' AND period_start BETWEEN $2::date AND $3::date
        ORDER BY period_start DESC`,
      [vendorId, from, to]
    )
    return rows
  }

  // ── Invoices ─────────────────────────────────────────────────────────────

  async invoices(vendorId, from, to) {
    const { rows } = await query(
      `SELECT invoice_number, order_type, order_id, order_number, status, ${dayText('invoice_date')} AS invoice_day,
              subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise, tax_paise, total_paise, payment_status
         FROM invoices
        WHERE vendor_id = $1 AND ${day('invoice_date')} BETWEEN $2::date AND $3::date
        ORDER BY invoice_date DESC, invoice_number DESC`,
      [vendorId, from, to]
    )
    return rows
  }

  /** Finished sales in the range that have no invoice yet (invoices are issued on first request after delivery). */
  async deliveredWithoutInvoice(vendorId, from, to) {
    const [pos, online] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS n FROM store_orders so
          WHERE so.vendor_id = $1 AND so.status = 'DELIVERED' AND ${day('so.placed_at')} BETWEEN $2::date AND $3::date AND ${NOT_A_MIRROR}
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_type = 'STORE_ORDER' AND i.order_id = so.id)`,
        [vendorId, from, to]
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM orders o
          WHERE o.vendor_id = $1 AND o.status::text = 'DELIVERED' AND ${day('o.created_at')} BETWEEN $2::date AND $3::date
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_type = 'ORDER' AND i.order_id = o.id)`,
        [vendorId, from, to]
      ),
    ])
    return { pos: num(pos.rows[0]?.n), online: num(online.rows[0]?.n) }
  }
}
