import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, kind, name, type, flat_amount_paise, percentage_bps, description, active, created_at, updated_at`

/**
 * Vendor Adjustment Rules repository — named charge/discount line items for
 * counter sales, ported from epic-laundry-desktop's
 * domain.ts#saveAdjustmentRule.
 */
export class VendorAdjustmentRulesRepository {
  async list(vendorId, kind, includeInactive = false) {
    const clause = includeInactive ? '' : 'AND active = true'
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_adjustment_rules WHERE vendor_id = $1 AND kind = $2 ${clause} ORDER BY name ASC`,
      [vendorId, kind]
    )
    return rows.map((row) => this._format(row))
  }

  async findByIds(vendorId, ids) {
    if (!ids.length) return []
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_adjustment_rules WHERE vendor_id = $1 AND id = ANY($2::uuid[])`,
      [vendorId, ids]
    )
    return rows.map((row) => this._format(row))
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_adjustment_rules WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(vendorId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_adjustment_rules (vendor_id, kind, name, type, flat_amount_paise, percentage_bps, description, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [vendorId, input.kind, input.name, input.type, input.flatAmountPaise ?? null, input.percentageBps ?? null, input.description ?? null, input.active !== false]
    )
    return this._format(rows[0])
  }

  async update(id, input) {
    const { rows } = await query(
      `UPDATE vendor_adjustment_rules SET
         name = $2, type = $3, flat_amount_paise = $4, percentage_bps = $5, description = $6, active = $7, updated_at = NOW()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, input.name, input.type, input.flatAmountPaise ?? null, input.percentageBps ?? null, input.description ?? null, input.active !== false]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, kind: row.kind, name: row.name, type: row.type,
      flatAmountPaise: row.flat_amount_paise, percentageBps: row.percentage_bps, description: row.description,
      active: row.active, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
