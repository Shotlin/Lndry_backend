import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, order_id, customer_user_id, amount_paise, reason, note, status, decision_note, decided_at, decided_by, created_by, created_at`

/**
 * Vendor Return Cases repository — ported from epic-laundry-desktop's
 * returns.ts (request + list; a decide action was added here since epic's
 * own presenter already anticipates a decisionNote nothing upstream ever
 * sets — see migration 127).
 */
export class VendorReturnCasesRepository {
  async findOrder(vendorId, orderId) {
    const { rows } = await query(`SELECT id, user_id AS customer_user_id, total_amount FROM orders WHERE id = $1 AND vendor_id = $2`, [orderId, vendorId])
    return rows[0] || null
  }

  async findDuplicate(orderId, amountPaise, reason) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_return_cases WHERE order_id = $1 AND amount_paise = $2 AND reason = $3 AND status = 'REQUESTED' LIMIT 1`,
      [orderId, amountPaise, reason]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(vendorId, actorUserId, { orderId, customerUserId, amountPaise, reason, note }) {
    const { rows } = await query(
      `INSERT INTO vendor_return_cases (vendor_id, order_id, customer_user_id, amount_paise, reason, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [vendorId, orderId, customerUserId, amountPaise, reason, note ?? null, actorUserId]
    )
    return this._format(rows[0])
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_return_cases WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async decide(id, actorUserId, status, decisionNote) {
    const { rows } = await query(
      `UPDATE vendor_return_cases SET status = $2, decision_note = $3, decided_at = NOW(), decided_by = $4 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status, decisionNote, actorUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async list(vendorId, { status, page = 1, limit = 50 } = {}) {
    const conditions = ['vendor_id = $1']
    const params = [vendorId]
    if (status) { params.push(status); conditions.push(`status = $${params.length}`) }
    const offset = (page - 1) * limit
    params.push(limit, offset)
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_return_cases WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return rows.map((row) => this._format(row))
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, orderId: row.order_id, customerUserId: row.customer_user_id,
      amountPaise: row.amount_paise, reason: row.reason, note: row.note, status: row.status,
      decisionNote: row.decision_note, decidedAt: row.decided_at, decidedBy: row.decided_by,
      createdBy: row.created_by, createdAt: row.created_at,
    }
  }
}
