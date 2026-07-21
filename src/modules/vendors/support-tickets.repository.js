import { query } from '../../config/database.js'

const LIST_COLUMNS = `id, vendor_id, ticket_ref, title, description, category, status, priority,
              admin_reply, replied_at, vendor_reply, vendor_replied_at, rating, rated_at,
              created_at, updated_at`

/**
 * Repository for vendor_support_tickets.
 */
export class SupportTicketsRepository {
  /**
   * Create a new ticket.
   * @param {{ vendorId, userId, title, description, category }} data
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO vendor_support_tickets
         (id, vendor_id, user_id, ticket_ref, title, description, category)
       VALUES
         (gen_random_uuid(),
          $1, $2,
          'TKT-' || nextval('vendor_ticket_ref_seq'),
          $3, $4, $5)
       RETURNING id, ticket_ref, title, description, category, status, priority,
                 created_at, updated_at`,
      [data.vendorId, data.userId, data.title, data.description, data.category]
    )
    return rows[0]
  }

  /**
   * List tickets for a vendor, newest first.
   * @param {string} vendorId
   * @param {{ limit?: number, offset?: number }} opts
   */
  async listByVendor(vendorId, { limit = 20, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS}
       FROM vendor_support_tickets
       WHERE vendor_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [vendorId, limit, offset]
    )
    return rows
  }

  /**
   * Count tickets for a vendor.
   */
  async countByVendor(vendorId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total FROM vendor_support_tickets WHERE vendor_id = $1`,
      [vendorId]
    )
    return rows[0].total
  }

  /** Single ticket, optionally scoped to a vendor (vendor-side reads). */
  async findById(id, vendorId = null) {
    const conditions = ['id = $1']
    const params = [id]
    if (vendorId) {
      conditions.push('vendor_id = $2')
      params.push(vendorId)
    }
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS} FROM vendor_support_tickets WHERE ${conditions.join(' AND ')}`,
      params
    )
    return rows[0] || null
  }

  /** Admin-side: every vendor's tickets, single round trip with vendor name joined in. */
  async listAll({ status, limit = 20, offset = 0 } = {}) {
    const conditions = []
    const params = []
    let idx = 1
    if (status) {
      conditions.push(`t.status = $${idx++}`)
      params.push(status)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT t.id, t.vendor_id, v.name AS vendor_name, t.ticket_ref, t.title, t.description,
              t.category, t.status, t.priority, t.admin_reply, t.replied_at,
              t.vendor_reply, t.vendor_replied_at, t.rating, t.rated_at,
              t.created_at, t.updated_at
       FROM vendor_support_tickets t
       JOIN vendors v ON v.id = t.vendor_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM vendor_support_tickets t ${where}`,
      params
    )
    return { tickets: rows, total: countRes.rows[0].total }
  }

  /** Admin replies — moves the ticket to REPLIED. */
  async reply(id, { adminReply, repliedBy }) {
    const { rows } = await query(
      `UPDATE vendor_support_tickets
       SET admin_reply = $2, replied_at = NOW(), replied_by = $3, status = 'REPLIED', updated_at = NOW()
       WHERE id = $1
       RETURNING ${LIST_COLUMNS}`,
      [id, adminReply, repliedBy]
    )
    return rows[0] || null
  }

  /** Admin closes the ticket directly (no rating involved). */
  async close(id) {
    const { rows } = await query(
      `UPDATE vendor_support_tickets
       SET status = 'CLOSED', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING ${LIST_COLUMNS}`,
      [id]
    )
    return rows[0] || null
  }

  /** Vendor says "not satisfied" — reopens with a follow-up message. */
  async vendorFollowUp(id, vendorId, message) {
    const { rows } = await query(
      `UPDATE vendor_support_tickets
       SET vendor_reply = $3, vendor_replied_at = NOW(), status = 'OPEN', updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2
       RETURNING ${LIST_COLUMNS}`,
      [id, vendorId, message]
    )
    return rows[0] || null
  }

  /** Vendor says "satisfied" — rates and closes in one step. */
  async rate(id, vendorId, rating) {
    const { rows } = await query(
      `UPDATE vendor_support_tickets
       SET rating = $3, rated_at = NOW(), status = 'CLOSED', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2
       RETURNING ${LIST_COLUMNS}`,
      [id, vendorId, rating]
    )
    return rows[0] || null
  }
}
