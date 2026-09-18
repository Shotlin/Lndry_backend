import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, order_id, document_type, garment_unit_ids, container_ids, printer_profile, requested_copies, status, failure_reason, created_by, created_at, updated_at`

/**
 * Vendor Print Jobs repository — a log of tag/label print requests, ported
 * from epic-laundry-desktop's domain.ts#createLaundryPrintJob. See migration 124.
 */
export class VendorPrintJobsRepository {
  async create(vendorId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_print_jobs (vendor_id, order_id, document_type, garment_unit_ids, container_ids, printer_profile, requested_copies, status, failure_reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
      [
        vendorId, input.orderId, input.documentType || 'GARMENT_TAG', input.garmentUnitIds || [], input.containerIds || [],
        input.printerProfile ?? null, input.requestedCopies || 1, input.status || 'PENDING', input.failureReason ?? null, actorUserId,
      ]
    )
    return this._format(rows[0])
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_print_jobs WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async updateStatus(id, status, failureReason) {
    const { rows } = await query(
      `UPDATE vendor_print_jobs SET status = $2, failure_reason = $3, updated_at = NOW() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status, failureReason ?? null]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async listForOrder(vendorId, orderId) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_print_jobs WHERE vendor_id = $1 AND order_id = $2 ORDER BY created_at DESC`, [vendorId, orderId])
    return rows.map((row) => this._format(row))
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, orderId: row.order_id, documentType: row.document_type,
      garmentUnitIds: row.garment_unit_ids, containerIds: row.container_ids, printerProfile: row.printer_profile,
      requestedCopies: row.requested_copies, status: row.status, failureReason: row.failure_reason,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
