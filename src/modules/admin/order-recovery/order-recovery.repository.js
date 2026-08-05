import { query } from '../../../config/database.js'

/**
 * Order Recovery repository — admin-facing read model over order_drafts
 * that never completed checkout, plus the two admin actions (notify/
 * issue coupon). Ported from bakaloo-backend's abandoned-carts module,
 * reframed for LNDRY's draft-based single-vendor checkout (see CLAUDE.md's
 * "Bakaloo Feature Port" section).
 *
 * A draft counts as "incomplete" when no `orders` row exists with the same
 * id — placeOrderFromDraft always inserts the final order using the
 * draft's own id (orders.service.js), so this is the exact, race-free
 * "never completed" check; no separate status/tracking column needed.
 */
const INCOMPLETE_WHERE = `NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = od.id)`

export class OrderRecoveryRepository {
  async findAll({ offset, limit, search }) {
    const params = []
    const clauses = [INCOMPLETE_WHERE]
    let idx = 1

    if (search) {
      clauses.push(`(u.name ILIKE $${idx} OR u.phone ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    const where = `WHERE ${clauses.join(' AND ')}`

    const { rows } = await query(
      `SELECT od.id, od.user_id, od.vendor_id, od.payable_amount_paise, od.created_at,
              u.name AS user_name, u.phone AS user_phone,
              v.name AS vendor_name,
              p.id AS payment_id, p.status AS payment_status, p.expires_at AS payment_expires_at,
              COALESCE(rc.reminder_count, 0)::int AS reminder_count, rc.last_reminder_sent_at
       FROM order_drafts od
       JOIN users u ON u.id = od.user_id
       JOIN vendors v ON v.id = od.vendor_id
       LEFT JOIN LATERAL (
         SELECT id, status, expires_at FROM payments
         WHERE order_draft_id = od.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE event_type = 'REMINDER_SENT') AS reminder_count,
                MAX(created_at) FILTER (WHERE event_type = 'REMINDER_SENT') AS last_reminder_sent_at
         FROM order_recovery_events WHERE order_draft_id = od.id
       ) rc ON true
       ${where}
       ORDER BY od.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total
       FROM order_drafts od
       JOIN users u ON u.id = od.user_id
       ${where}`,
      params
    )
    const total = countRows[0].total

    return {
      drafts: rows.map(this._formatListRow),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getSummary() {
    const { rows: [stats] } = await query(
      `SELECT COUNT(*)::int AS incomplete_count,
              COALESCE(SUM(od.payable_amount_paise), 0)::bigint AS incomplete_value_paise
       FROM order_drafts od
       WHERE ${INCOMPLETE_WHERE}`
    )
    const { rows: [recovered] } = await query(
      `SELECT COUNT(*)::int AS recovered_today
       FROM order_drafts od
       WHERE od.created_at::date = CURRENT_DATE
         AND EXISTS (SELECT 1 FROM orders o WHERE o.id = od.id)
         AND EXISTS (SELECT 1 FROM order_recovery_events e WHERE e.order_draft_id = od.id)`
    )
    return {
      incompleteCount: stats.incomplete_count,
      incompleteValuePaise: Number(stats.incomplete_value_paise),
      recoveredToday: recovered.recovered_today,
    }
  }

  async findById(id) {
    const { rows: [draft] } = await query(
      `SELECT od.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
              v.name AS vendor_name,
              p.id AS payment_id, p.status AS payment_status, p.expires_at AS payment_expires_at,
              p.amount AS payment_amount
       FROM order_drafts od
       JOIN users u ON u.id = od.user_id
       JOIN vendors v ON v.id = od.vendor_id
       LEFT JOIN LATERAL (
         SELECT id, status, expires_at, amount FROM payments
         WHERE order_draft_id = od.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
       WHERE od.id = $1`,
      [id]
    )
    if (!draft) return null

    const [{ rows: events }, { rows: coupons }] = await Promise.all([
      query(
        `SELECT event_type, actor_id, metadata, created_at
         FROM order_recovery_events WHERE order_draft_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      query(
        `SELECT e.id, e.metadata, e.actor_id, e.created_at, c.id AS coupon_id, c.code
         FROM order_recovery_events e
         LEFT JOIN coupons c ON c.id = (e.metadata->>'couponId')::uuid
         WHERE e.order_draft_id = $1 AND e.event_type = 'COUPON_ISSUED'
         ORDER BY e.created_at DESC`,
        [id]
      ),
    ])

    return this._formatDetail(draft, events, coupons)
  }

  async recordEvent(orderDraftId, { eventType, actorId = null, metadata = null }) {
    await query(
      `INSERT INTO order_recovery_events (order_draft_id, event_type, actor_id, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [orderDraftId, eventType, actorId, metadata ? JSON.stringify(metadata) : null]
    )
  }

  _formatListRow(row) {
    return {
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      userPhone: row.user_phone,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name,
      payableAmountPaise: row.payable_amount_paise,
      createdAt: row.created_at,
      paymentId: row.payment_id,
      paymentStatus: row.payment_status,
      paymentExpiresAt: row.payment_expires_at,
      reminderCount: row.reminder_count,
      lastReminderSentAt: row.last_reminder_sent_at,
    }
  }

  _formatDetail(draft, events, coupons) {
    return {
      id: draft.id,
      createdAt: draft.created_at,
      payableAmountPaise: draft.payable_amount_paise,
      estimatedWeight: draft.estimated_weight != null ? parseFloat(draft.estimated_weight) : null,
      garmentLines: typeof draft.garment_lines === 'string' ? JSON.parse(draft.garment_lines) : draft.garment_lines,
      user: {
        id: draft.user_id,
        name: draft.user_name,
        phone: draft.user_phone,
        email: draft.user_email,
      },
      vendor: {
        id: draft.vendor_id,
        name: draft.vendor_name,
      },
      payment: draft.payment_id
        ? {
            id: draft.payment_id,
            status: draft.payment_status,
            expiresAt: draft.payment_expires_at,
            amount: draft.payment_amount != null ? parseFloat(draft.payment_amount) : null,
          }
        : null,
      events: events.map((e) => ({
        eventType: e.event_type,
        actorId: e.actor_id,
        metadata: e.metadata,
        createdAt: e.created_at,
      })),
      couponsIssued: coupons.map((c) => ({
        id: c.id,
        couponId: c.coupon_id,
        code: c.code,
        actorId: c.actor_id,
        createdAt: c.created_at,
      })),
    }
  }
}
