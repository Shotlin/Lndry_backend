import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, owner_id, view_name, report_kind, from_date, to_date, search, shared, active, created_at, updated_at`

/**
 * Vendor Report Saved Views repository — ported from
 * epic-laundry-desktop's report-views.ts.
 */
export class VendorReportViewsRepository {
  async listForOwner(vendorId, ownerId) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_report_saved_views
       WHERE vendor_id = $1 AND active = true AND (shared = true OR owner_id = $2)
       ORDER BY view_name ASC`,
      [vendorId, ownerId]
    )
    return rows.map((row) => this._format(row))
  }

  async create(vendorId, ownerId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_report_saved_views (vendor_id, owner_id, view_name, report_kind, from_date, to_date, search, shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [vendorId, ownerId, input.viewName, input.reportKind, input.fromDate || null, input.toDate || null, input.search || null, input.shared || false]
    )
    return this._format(rows[0])
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_report_saved_views WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async deactivate(id) {
    const { rows } = await query(
      `UPDATE vendor_report_saved_views SET active = false, updated_at = NOW() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, ownerId: row.owner_id, viewName: row.view_name, reportKind: row.report_kind,
      fromDate: row.from_date, toDate: row.to_date, search: row.search, shared: row.shared, active: row.active,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
