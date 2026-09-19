import { query, getClient } from '../../../config/database.js'
import { ACTIVE_ORDER_STATUSES } from '../../../constants/orderStatus.js'

// Requests store their own name/phone snapshot (scrubbed on completion), so the
// admin list never needs to read the live — possibly anonymized — user row.
const LIST_SELECT = `
  r.id, r.user_id, r.status, r.reason, r.requested_at,
  r.reviewed_at, r.review_note, r.scheduled_deletion_at, r.completed_at,
  r.customer_name, r.customer_phone,
  a.name AS reviewed_by_name,
  COALESCE(w.balance, 0) AS wallet_balance,
  (SELECT COUNT(*) FROM orders o
    WHERE o.user_id = r.user_id AND o.status::text = ANY($1::text[])) AS active_order_count
`

/**
 * Account deletion requests repository (migration 134).
 *
 * Every state transition is a single locked transaction so two admins clicking
 * Approve at once, or an approve racing the worker, can't double-process.
 */
export class AccountDeletionRepository {
  /** The customer's live (PENDING/APPROVED) request, else their most recent one. */
  async findCurrentForUser(userId) {
    const { rows } = await query(
      `SELECT id, user_id, status, reason, requested_at, reviewed_at, review_note,
              scheduled_deletion_at, completed_at
         FROM account_deletion_requests
        WHERE user_id = $1
        ORDER BY (status IN ('PENDING','APPROVED')) DESC, requested_at DESC
        LIMIT 1`,
      [userId]
    )
    return rows[0] ? this._formatCustomer(rows[0]) : null
  }

  async create({ userId, reason, customerName, customerPhone }) {
    const { rows } = await query(
      `INSERT INTO account_deletion_requests (user_id, reason, customer_name, customer_phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, status, reason, requested_at, reviewed_at, review_note,
                 scheduled_deletion_at, completed_at`,
      [userId, reason ?? null, customerName ?? null, customerPhone ?? null]
    )
    return this._formatCustomer(rows[0])
  }

  async findUser(userId) {
    const { rows } = await query(
      `SELECT id, name, phone, role, is_active FROM users WHERE id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  async list({ status, search, page, limit }) {
    const where = []
    const params = [ACTIVE_ORDER_STATUSES]
    let idx = 2
    if (status) {
      where.push(`r.status = $${idx++}`)
      params.push(status)
    }
    if (search) {
      where.push(`(r.customer_name ILIKE $${idx} OR r.customer_phone ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const countParams = params.slice(1)
    let cIdx = 1
    const countWhere = []
    if (status) countWhere.push(`status = $${cIdx++}`)
    if (search) countWhere.push(`(customer_name ILIKE $${cIdx} OR customer_phone ILIKE $${cIdx})`)
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM account_deletion_requests
        ${countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : ''}`,
      countParams
    )

    params.push(limit, (page - 1) * limit)
    const { rows } = await query(
      `SELECT ${LIST_SELECT}
         FROM account_deletion_requests r
         LEFT JOIN users a ON a.id = r.reviewed_by
         LEFT JOIN wallets w ON w.user_id = r.user_id
         ${whereSql}
        ORDER BY (r.status = 'PENDING') DESC, r.requested_at DESC
        LIMIT $${idx++} OFFSET $${idx}`,
      params
    )
    return { rows: rows.map((r) => this._formatAdmin(r)), total: countRows[0].total }
  }

  async statusCounts() {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS n FROM account_deletion_requests GROUP BY status`
    )
    const out = { PENDING: 0, APPROVED: 0, REJECTED: 0, COMPLETED: 0 }
    for (const r of rows) out[r.status] = r.n
    return out
  }

  /**
   * Approve: deactivate the account now and start the grace period.
   * Returns { code } on a business-rule refusal, { request } on success.
   */
  async approve(id, { adminId, note, graceDays }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id, user_id, status FROM account_deletion_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const req = rows[0]
      if (!req) {
        await client.query('ROLLBACK')
        return { code: 'NOT_FOUND' }
      }
      if (req.status !== 'PENDING') {
        await client.query('ROLLBACK')
        return { code: 'INVALID_STATE', status: req.status }
      }

      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user_id])

      // Deactivating an account mid-order would strand the pickup/delivery.
      const { rows: orderRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM orders
          WHERE user_id = $1 AND status::text = ANY($2::text[])`,
        [req.user_id, ACTIVE_ORDER_STATUSES]
      )
      if (orderRows[0].n > 0) {
        await client.query('ROLLBACK')
        return { code: 'ACTIVE_ORDERS_EXIST', count: orderRows[0].n }
      }

      // The same phone can also be a vendor employee/captain login; scrubbing
      // the phone would silently lock them out of that role.
      const { rows: staffRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM vendor_employees
          WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL`,
        [req.user_id]
      )
      if (staffRows[0].n > 0) {
        await client.query('ROLLBACK')
        return { code: 'HAS_STAFF_ROLE' }
      }

      const { rows: updated } = await client.query(
        `UPDATE account_deletion_requests
            SET status = 'APPROVED',
                reviewed_at = NOW(),
                reviewed_by = $2,
                review_note = $3,
                scheduled_deletion_at = NOW() + ($4 || ' days')::interval,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, user_id, status, reason, requested_at, reviewed_at, review_note,
                    scheduled_deletion_at, completed_at`,
        [id, adminId, note ?? null, String(graceDays)]
      )

      // Deactivate now: is_active=false blocks login/OTP; bumping
      // session_version makes every existing access token fail the auth gate.
      await client.query(
        `UPDATE users
            SET is_active = false,
                deletion_scheduled_at = $2,
                session_version = COALESCE(session_version, 1) + 1,
                fcm_token = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [req.user_id, updated[0].scheduled_deletion_at]
      )
      await client.query('DELETE FROM fcm_tokens WHERE user_id = $1', [req.user_id])
      await client.query('DELETE FROM devices WHERE user_id = $1', [req.user_id])

      await client.query('COMMIT')
      return { request: this._formatCustomer(updated[0]), userId: req.user_id }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async reject(id, { adminId, note }) {
    const { rows } = await query(
      `UPDATE account_deletion_requests
          SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $2,
              review_note = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'PENDING'
        RETURNING id, user_id, status, reason, requested_at, reviewed_at, review_note,
                  scheduled_deletion_at, completed_at`,
      [id, adminId, note ?? null]
    )
    if (rows[0]) return { request: this._formatCustomer(rows[0]) }

    const { rows: existing } = await query(
      'SELECT status FROM account_deletion_requests WHERE id = $1',
      [id]
    )
    if (!existing[0]) return { code: 'NOT_FOUND' }
    return { code: 'INVALID_STATE', status: existing[0].status }
  }

  /**
   * Worker step: anonymize one approved request whose grace period is over.
   * Locks with SKIP LOCKED so several worker instances never collide.
   * Returns the anonymized user id, or null if nothing was due.
   */
  async anonymizeNextDue() {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id, user_id FROM account_deletion_requests
          WHERE status = 'APPROVED' AND scheduled_deletion_at <= NOW()
          ORDER BY scheduled_deletion_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`
      )
      const req = rows[0]
      if (!req) {
        await client.query('ROLLBACK')
        return null
      }

      // Keeps the row (orders/payments/invoices point at it) but removes every
      // personal identifier. The tombstone phone keeps the UNIQUE column
      // satisfied and can never match a real number, so the person can sign up
      // fresh with the same phone later.
      await client.query(
        `UPDATE users
            SET phone = 'del_' || substr(replace(id::text, '-', ''), 1, 11),
                email = NULL,
                name = 'Deleted User',
                avatar_url = NULL,
                birthday = NULL,
                fcm_token = NULL,
                referral_code = NULL,
                last_location = NULL,
                location_updated_at = NULL,
                is_active = false,
                anonymized_at = NOW(),
                session_version = COALESCE(session_version, 1) + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [req.user_id]
      )
      await client.query('DELETE FROM addresses WHERE user_id = $1', [req.user_id])
      await client.query('DELETE FROM fcm_tokens WHERE user_id = $1', [req.user_id])
      await client.query('DELETE FROM devices WHERE user_id = $1', [req.user_id])
      await client.query('DELETE FROM notifications WHERE user_id = $1', [req.user_id])
      await client.query('DELETE FROM wishlist WHERE user_id = $1', [req.user_id])

      await client.query(
        `UPDATE account_deletion_requests
            SET status = 'COMPLETED',
                completed_at = NOW(),
                customer_name = NULL,
                customer_phone = CASE WHEN customer_phone IS NULL THEN NULL
                                      ELSE '••••••' || right(customer_phone, 4) END,
                updated_at = NOW()
          WHERE id = $1`,
        [req.id]
      )
      await client.query('COMMIT')
      return { requestId: req.id, userId: req.user_id }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  _formatCustomer(row) {
    return {
      id: row.id,
      status: row.status,
      reason: row.reason,
      requestedAt: row.requested_at,
      reviewedAt: row.reviewed_at,
      reviewNote: row.review_note,
      scheduledDeletionAt: row.scheduled_deletion_at,
      completedAt: row.completed_at,
    }
  }

  _formatAdmin(row) {
    return {
      ...this._formatCustomer(row),
      userId: row.user_id,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      reviewedByName: row.reviewed_by_name,
      walletBalance: Number(row.wallet_balance),
      activeOrderCount: Number(row.active_order_count),
    }
  }
}
