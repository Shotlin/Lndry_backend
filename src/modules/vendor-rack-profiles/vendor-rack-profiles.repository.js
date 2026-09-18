import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, name, code, capacity, active, notes, created_at, updated_at`

/**
 * Vendor Rack Profiles repository — ported from epic-laundry-desktop's
 * rack.ts (profile CRUD only; occupancy is deferred, see migration 117).
 */
export class VendorRackProfilesRepository {
  async list(vendorId, includeInactive = false) {
    const clause = includeInactive ? '' : 'AND active = true'
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_rack_profiles WHERE vendor_id = $1 ${clause} ORDER BY name ASC`,
      [vendorId]
    )
    return rows.map((row) => this._format(row))
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_rack_profiles WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(vendorId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_rack_profiles (vendor_id, name, code, capacity, active, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [vendorId, input.name, input.code || null, input.capacity, input.active !== false, input.notes || null]
    )
    return this._format(rows[0])
  }

  async update(id, input) {
    const { rows } = await query(
      `UPDATE vendor_rack_profiles SET name = $2, code = $3, capacity = $4, active = $5, notes = $6, updated_at = NOW()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, input.name, input.code || null, input.capacity, input.active !== false, input.notes || null]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, name: row.name, code: row.code, capacity: row.capacity,
      active: row.active, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
