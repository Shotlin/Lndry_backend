import { query } from '../../config/database.js'

const CLAIM_COLUMNS = `id, vendor_id, garment_unit_id, order_id, category, severity, status, description, opened_at, opened_by, decision, resolution_note, resolved_at, resolved_by, created_at, updated_at`
const CORRECTION_COLUMNS = `id, claim_id, customer_user_id, order_id, garment_unit_id, decision, summary, customer_message, issued_at, issued_by`

const CUSTOMER_MESSAGES = {
  REWASH: 'Our quality team identified an issue and has sent this garment back for rewash before release.',
  DAMAGED: 'Our quality team recorded a damage exception for this garment and will contact you with the next resolution step.',
  MISSING: 'Our quality team recorded that this garment could not be located and will contact you with the next resolution step.',
  RELEASE: 'Our quality team completed its review and released this garment for the next fulfilment step.',
  REJECT: 'Our quality team reviewed this claim and closed it without changing the garment lifecycle.',
}

/**
 * Vendor Quality Claims repository — ported from epic-laundry-desktop's
 * quality.ts. See migration 126.
 */
export class VendorQualityClaimsRepository {
  static customerMessageFor(decision) {
    return CUSTOMER_MESSAGES[decision]
  }

  async findOpenForUnit(garmentUnitId) {
    const { rows } = await query(
      `SELECT ${CLAIM_COLUMNS} FROM vendor_quality_claims WHERE garment_unit_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW') LIMIT 1`,
      [garmentUnitId]
    )
    return rows[0] ? this._formatClaim(rows[0]) : null
  }

  async create(vendorId, actorUserId, { garmentUnitId, orderId, category, severity, description }) {
    const { rows } = await query(
      `INSERT INTO vendor_quality_claims (vendor_id, garment_unit_id, order_id, category, severity, description, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${CLAIM_COLUMNS}`,
      [vendorId, garmentUnitId, orderId, category, severity, description, actorUserId]
    )
    return this._formatClaim(rows[0])
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${CLAIM_COLUMNS} FROM vendor_quality_claims WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._formatClaim(rows[0]) : null
  }

  async resolve(id, actorUserId, decision, note) {
    const status = decision === 'REJECT' ? 'REJECTED' : 'RESOLVED'
    const { rows } = await query(
      `UPDATE vendor_quality_claims SET status = $2, decision = $3, resolution_note = $4, resolved_at = NOW(), resolved_by = $5, updated_at = NOW()
       WHERE id = $1 RETURNING ${CLAIM_COLUMNS}`,
      [id, status, decision, note, actorUserId]
    )
    return this._formatClaim(rows[0])
  }

  async list(vendorId, { status, garmentUnitId, page = 1, limit = 50 } = {}) {
    const conditions = ['vendor_id = $1']
    const params = [vendorId]
    if (status) { params.push(status); conditions.push(`status = $${params.length}`) }
    if (garmentUnitId) { params.push(garmentUnitId); conditions.push(`garment_unit_id = $${params.length}`) }
    const offset = (page - 1) * limit
    params.push(limit, offset)
    const { rows } = await query(
      `SELECT ${CLAIM_COLUMNS} FROM vendor_quality_claims WHERE ${conditions.join(' AND ')}
       ORDER BY (status IN ('OPEN', 'UNDER_REVIEW')) DESC, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return rows.map((row) => this._formatClaim(row))
  }

  async issueCorrection(claimId, actorUserId, { customerUserId, orderId, garmentUnitId, decision }) {
    const summary = `Quality exception resolved as ${decision}`
    const { rows } = await query(
      `INSERT INTO vendor_customer_corrections (claim_id, customer_user_id, order_id, garment_unit_id, decision, summary, customer_message, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_id) DO NOTHING RETURNING ${CORRECTION_COLUMNS}`,
      [claimId, customerUserId, orderId, garmentUnitId, decision, summary, CUSTOMER_MESSAGES[decision], actorUserId]
    )
    return rows[0] ? this._formatCorrection(rows[0]) : null
  }

  async correctionForClaim(claimId) {
    const { rows } = await query(`SELECT ${CORRECTION_COLUMNS} FROM vendor_customer_corrections WHERE claim_id = $1`, [claimId])
    return rows[0] ? this._formatCorrection(rows[0]) : null
  }

  async correctionsForOrder(orderId) {
    const { rows } = await query(`SELECT ${CORRECTION_COLUMNS} FROM vendor_customer_corrections WHERE order_id = $1 ORDER BY issued_at DESC`, [orderId])
    return rows.map((row) => this._formatCorrection(row))
  }

  _formatClaim(row) {
    return {
      id: row.id, vendorId: row.vendor_id, garmentUnitId: row.garment_unit_id, orderId: row.order_id,
      category: row.category, severity: row.severity, status: row.status, description: row.description,
      openedAt: row.opened_at, openedBy: row.opened_by, decision: row.decision, resolutionNote: row.resolution_note,
      resolvedAt: row.resolved_at, resolvedBy: row.resolved_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  _formatCorrection(row) {
    return {
      id: row.id, claimId: row.claim_id, customerUserId: row.customer_user_id, orderId: row.order_id,
      garmentUnitId: row.garment_unit_id, decision: row.decision, summary: row.summary,
      customerMessage: row.customer_message, issuedAt: row.issued_at, issuedBy: row.issued_by,
    }
  }
}
