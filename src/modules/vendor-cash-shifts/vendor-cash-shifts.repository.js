import { query } from '../../config/database.js'

const COLUMNS = `
  id, vendor_id, register, status, business_date, opening_cash_paise, opened_by, opened_at, note,
  counted_cash_paise, expected_cash_paise, variance_paise, variance_approved_by, close_note,
  closed_by, closed_at, created_at
`

/**
 * Vendor Cash Shifts repository — counter cash-drawer sessions, ported from
 * epic-laundry-desktop's cash.ts. Expected cash is computed live from real
 * cash-mode movements (store_orders + vendor_expenses) during the shift
 * window rather than tracked as a running column — see migration 114.
 */
export class VendorCashShiftsRepository {
  async findOpen(vendorId, register) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_cash_shifts WHERE vendor_id = $1 AND status = 'OPEN' AND register = $2`,
      [vendorId, register]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async listOpen(vendorId) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_cash_shifts WHERE vendor_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC`,
      [vendorId]
    )
    return rows.map((row) => this._format(row))
  }

  async findById(vendorId, id) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_cash_shifts WHERE vendor_id = $1 AND id = $2`,
      [vendorId, id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async list(vendorId, { page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_cash_shifts WHERE vendor_id = $1 ORDER BY opened_at DESC LIMIT $2 OFFSET $3`,
      [vendorId, limit, offset]
    )
    const { rows: countRows } = await query('SELECT COUNT(*)::int AS total FROM vendor_cash_shifts WHERE vendor_id = $1', [vendorId])
    return { shifts: rows.map((row) => this._format(row)), total: countRows[0].total }
  }

  async open(vendorId, { register, openingCashPaise, note, openedBy }) {
    const { rows } = await query(
      `INSERT INTO vendor_cash_shifts (vendor_id, register, opening_cash_paise, opened_by, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [vendorId, register, openingCashPaise, openedBy, note ?? null]
    )
    return this._format(rows[0])
  }

  async close(id, { countedCashPaise, expectedCashPaise, variancePaise, varianceApprovedBy, closeNote, closedBy }) {
    const { rows } = await query(
      `UPDATE vendor_cash_shifts
       SET status = 'CLOSED', counted_cash_paise = $2, expected_cash_paise = $3, variance_paise = $4,
           variance_approved_by = $5, close_note = $6, closed_by = $7, closed_at = NOW()
       WHERE id = $1 AND status = 'OPEN'
       RETURNING ${COLUMNS}`,
      [id, countedCashPaise, expectedCashPaise, variancePaise, varianceApprovedBy ?? null, closeNote ?? null, closedBy]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Real cash-mode movements during the shift window — mirrors epic's movements(). */
  async movements(vendorId, register, openedAt, closedAt) {
    const upperBound = closedAt ?? new Date()
    const [collections, expenses] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(amt), 0)::int AS total, COUNT(*)::int AS count FROM (
           SELECT p.amount_paise AS amt FROM store_order_payments p
            WHERE p.vendor_id = $1 AND p.mode = 'CASH' AND p.created_at >= $2 AND p.created_at <= $3
           UNION ALL
           SELECT so.total_paise AS amt FROM store_orders so
            WHERE so.vendor_id = $1 AND so.payment_method = 'CASH' AND so.placed_at >= $2 AND so.placed_at <= $3
              AND NOT EXISTS (SELECT 1 FROM store_order_payments p WHERE p.store_order_id = so.id)
         ) cash`,
        [vendorId, openedAt, upperBound]
      ),
      query(
        `SELECT COALESCE(SUM(amount_paise), 0)::int AS total, COUNT(*)::int AS count
         FROM vendor_expenses
         WHERE vendor_id = $1 AND payment_mode = 'CASH' AND status = 'PAID' AND created_at >= $2 AND created_at <= $3`,
        [vendorId, openedAt, upperBound]
      ),
    ])
    return {
      collectionsPaise: collections.rows[0].total,
      collectionCount: collections.rows[0].count,
      expensesPaise: expenses.rows[0].total,
      expenseCount: expenses.rows[0].count,
    }
  }

  _format(row) {
    return {
      id: row.id,
      vendorId: row.vendor_id,
      register: row.register,
      status: row.status,
      businessDate: row.business_date,
      openingCashPaise: row.opening_cash_paise,
      openedBy: row.opened_by,
      openedAt: row.opened_at,
      note: row.note,
      countedCashPaise: row.counted_cash_paise,
      expectedCashPaise: row.expected_cash_paise,
      variancePaise: row.variance_paise,
      varianceApprovedBy: row.variance_approved_by,
      closeNote: row.close_note,
      closedBy: row.closed_by,
      closedAt: row.closed_at,
      createdAt: row.created_at,
    }
  }
}
