import { query } from '../../config/database.js'

const COLUMNS = 'id, vendor_id, name, quantity, min_threshold, unit, created_at, updated_at'

/**
 * Data access for a vendor's operational supplies. Every statement is scoped
 * by vendor_id, so one vendor can never read or change another's rows.
 */
export class VendorInventoryRepository {
  /**
   * The vendor's items, oldest first.
   * @param {string} vendorId
   * @param {{query?: Function}} [runner] a transaction client, or the pool by default
   */
  async list(vendorId, runner = null) {
    const run = runner ? runner.query.bind(runner) : query
    const { rows } = await run(
      `SELECT ${COLUMNS} FROM vendor_inventory_items
        WHERE vendor_id = $1
        ORDER BY created_at ASC, name ASC`,
      [vendorId]
    )
    return rows.map(this._format)
  }

  async findById(vendorId, id) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_inventory_items WHERE id = $1 AND vendor_id = $2`,
      [id, vendorId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(vendorId, { name, quantity, minThreshold, unit }) {
    const { rows } = await query(
      `INSERT INTO vendor_inventory_items (vendor_id, name, quantity, min_threshold, unit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [vendorId, name, quantity, minThreshold, unit]
    )
    return this._format(rows[0])
  }

  /** Changes only the fields that were supplied. Returns null if the item isn't this vendor's. */
  async update(vendorId, id, patch) {
    const sets = []
    const params = [id, vendorId]
    const columns = { name: 'name', quantity: 'quantity', minThreshold: 'min_threshold', unit: 'unit' }
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] !== undefined) {
        params.push(patch[key])
        sets.push(`${column} = $${params.length}`)
      }
    }
    if (!sets.length) return this.findById(vendorId, id)
    const { rows } = await query(
      `UPDATE vendor_inventory_items
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND vendor_id = $2
        RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Adds `delta` (positive or negative) to the stored quantity in ONE statement,
   * so two people pressing + at the same moment both count. Never goes below 0.
   */
  async adjust(vendorId, id, delta) {
    const { rows } = await query(
      `UPDATE vendor_inventory_items
          SET quantity = GREATEST(0, quantity + $3), updated_at = NOW()
        WHERE id = $1 AND vendor_id = $2
        RETURNING ${COLUMNS}`,
      [id, vendorId, delta]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async remove(vendorId, id) {
    const { rowCount } = await query(
      'DELETE FROM vendor_inventory_items WHERE id = $1 AND vendor_id = $2',
      [id, vendorId]
    )
    return rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      quantity: Number(row.quantity),
      minThreshold: Number(row.min_threshold),
      unit: row.unit,
      isLowStock: Number(row.quantity) <= Number(row.min_threshold),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    }
  }
}
