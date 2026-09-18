import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, rider_employee_id, settlement_date, amount_paise, method, status, order_ids, reference, notes, created_by, created_at, updated_at`

/**
 * Vendor Rider Settlements repository — ported from
 * epic-laundry-desktop's domain.ts#saveLaundryRiderSettlement. See
 * migration 128.
 */
export class VendorRiderSettlementsRepository {
  async findRider(vendorId, riderEmployeeId) {
    const { rows } = await query(
      `SELECT ve.id, ve.user_id FROM vendor_employees ve WHERE ve.vendor_id = $1 AND ve.id = $2 AND ve.is_active = true`,
      [vendorId, riderEmployeeId]
    )
    return rows[0] || null
  }

  /** Confirms every orderId was actually assigned (pickup or delivery) to this rider's user_id. */
  async ordersAssignedToRider(orderIds, riderUserId) {
    if (!orderIds.length) return []
    const { rows } = await query(
      `SELECT DISTINCT order_id FROM order_assignments WHERE order_id = ANY($1::uuid[]) AND (rider_id = $2 OR employee_id = $2)`,
      [orderIds, riderUserId]
    )
    return rows.map((row) => row.order_id)
  }

  async create(vendorId, actorUserId, data) {
    const { rows } = await query(
      `INSERT INTO vendor_rider_settlements (vendor_id, rider_employee_id, settlement_date, amount_paise, method, order_ids, reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [vendorId, data.riderEmployeeId, data.settlementDate, data.amountPaise, data.method, data.orderIds, data.reference ?? null, data.notes ?? null, actorUserId]
    )
    return this._format(rows[0])
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_rider_settlements WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async update(id, data) {
    const { rows } = await query(
      `UPDATE vendor_rider_settlements SET
         settlement_date = $2, amount_paise = $3, method = $4, order_ids = $5, reference = $6, notes = $7, updated_at = NOW()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, data.settlementDate, data.amountPaise, data.method, data.orderIds, data.reference ?? null, data.notes ?? null]
    )
    return this._format(rows[0])
  }

  async updateStatus(id, status) {
    const { rows } = await query(`UPDATE vendor_rider_settlements SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING ${COLUMNS}`, [id, status])
    return this._format(rows[0])
  }

  async list(vendorId, { riderEmployeeId, from, to, page = 1, limit = 50 } = {}) {
    const conditions = ['vendor_id = $1']
    const params = [vendorId]
    if (riderEmployeeId) { params.push(riderEmployeeId); conditions.push(`rider_employee_id = $${params.length}`) }
    if (from) { params.push(from); conditions.push(`settlement_date >= $${params.length}`) }
    if (to) { params.push(to); conditions.push(`settlement_date <= $${params.length}`) }
    const offset = (page - 1) * limit
    params.push(limit, offset)
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_rider_settlements WHERE ${conditions.join(' AND ')}
       ORDER BY settlement_date DESC, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return rows.map((row) => this._format(row))
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, riderEmployeeId: row.rider_employee_id, settlementDate: row.settlement_date,
      amountPaise: row.amount_paise, method: row.method, status: row.status, orderIds: row.order_ids,
      reference: row.reference, notes: row.notes, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
