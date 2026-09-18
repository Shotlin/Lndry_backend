import { query } from '../../config/database.js'
import { randomBytes } from 'node:crypto'

const COLUMNS = `id, vendor_id, hold_code, status, payload, owner_user_id, ownership_updated_at, resumed_by, resumed_at, cancelled_by, cancelled_at, created_by, created_at, updated_at`

/**
 * Vendor Order Holds repository — "park this counter-sale cart for later"
 * with a claim/lease, ported from epic-laundry-desktop's holds.ts. See
 * migration 129.
 */
export class VendorOrderHoldsRepository {
  async create(vendorId, actorUserId, payload) {
    const holdCode = `H-${randomBytes(3).toString('hex').toUpperCase()}`
    const { rows } = await query(
      `INSERT INTO vendor_order_holds (vendor_id, hold_code, payload, created_by) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [vendorId, holdCode, JSON.stringify(payload), actorUserId]
    )
    return this._format(rows[0])
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_order_holds WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async list(vendorId, includeClosed) {
    const clause = includeClosed ? '' : `AND status = 'HELD'`
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_order_holds WHERE vendor_id = $1 ${clause} ORDER BY created_at DESC`, [vendorId])
    return rows.map((row) => this._format(row))
  }

  async claim(id, actorUserId) {
    const { rows } = await query(
      `UPDATE vendor_order_holds SET owner_user_id = $2, ownership_updated_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'HELD' RETURNING ${COLUMNS}`,
      [id, actorUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async renew(id, actorUserId) {
    const { rows } = await query(
      `UPDATE vendor_order_holds SET ownership_updated_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'HELD' AND owner_user_id = $2 RETURNING ${COLUMNS}`,
      [id, actorUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async release(id) {
    const { rows } = await query(
      `UPDATE vendor_order_holds SET owner_user_id = NULL, ownership_updated_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'HELD' RETURNING ${COLUMNS}`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async resume(id, actorUserId) {
    const { rows } = await query(
      `UPDATE vendor_order_holds SET status = 'RESUMED', resumed_by = $2, resumed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'HELD' RETURNING ${COLUMNS}`,
      [id, actorUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async cancel(id, actorUserId) {
    const { rows } = await query(
      `UPDATE vendor_order_holds SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'HELD' RETURNING ${COLUMNS}`,
      [id, actorUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, holdCode: row.hold_code, status: row.status, payload: row.payload,
      ownerUserId: row.owner_user_id, ownershipUpdatedAt: row.ownership_updated_at,
      resumedBy: row.resumed_by, resumedAt: row.resumed_at, cancelledBy: row.cancelled_by, cancelledAt: row.cancelled_at,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
