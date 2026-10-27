import { query } from '../../config/database.js'

// Explicit column list (R14.7 — no SELECT *), matches every field _format() reads.
const PAYMENT_COLUMNS = `id, order_id, user_id, razorpay_order_id, razorpay_payment_id,
  razorpay_signature, amount, currency, status, method, refund_id, refund_amount,
  refund_status, metadata, created_at, updated_at, expires_at, order_draft_id, purpose,
  failure_code, failure_reason, failure_source, paid_at, recovery_attempts,
  recovery_next_at, recovery_last_error, last_gateway_check_at`

/**
 * Payments repository — all SQL queries for payments
 */
export class PaymentsRepository {
  /**
   * Create a payment record
   */
  async create(data, client = null) {
    const exec = client ? (text, params) => client.query(text, params) : query
    const { rows } = await exec(
      `INSERT INTO payments (order_id, user_id, razorpay_order_id, amount, currency, status, method, expires_at, metadata, order_draft_id, purpose, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6::varchar, $7, $8, $9, $10, $11, CASE WHEN $6::varchar = 'PAID' THEN NOW() END)
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        data.orderId || null,
        data.userId,
        data.razorpayOrderId || null,
        data.amount,
        data.currency || 'INR',
        data.status || 'PENDING',
        data.method || null,
        data.expiresAt || null,
        JSON.stringify(data.metadata || {}),
        data.orderDraftId || null,
        data.purpose || 'FULL',
      ]
    )
    return this._format(rows[0])
  }

  /**
   * Find payment by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find payment by Razorpay order ID
   */
  async findByRazorpayOrderId(razorpayOrderId) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE razorpay_order_id = $1`,
      [razorpayOrderId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find payment by order ID
   */
  async findByOrderId(orderId) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Every payment attempt for an order (ADVANCE, BALANCE, and any FAILED/
   * PENDING retries), oldest first — the full history, unlike findByOrderId
   * (latest row only) or findByOrderIdAndPurpose (latest row of one
   * purpose). Customer-facing "how was this order actually paid" needs the
   * whole list: an order's advance and balance legs can genuinely have been
   * paid by two different methods (e.g. advance via Razorpay, balance via
   * the LNDRY wallet), which orders.payment_method alone can't represent —
   * that column only ever encodes the checkout-time COD-vs-online choice.
   */
  async listByOrderId(orderId) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    )
    return rows.map((row) => this._format(row))
  }

  /**
   * Find the latest payment of a specific purpose (ADVANCE/BALANCE/FULL)
   * for an order — distinct from findByOrderId, which only ever sees the
   * single latest row regardless of purpose and would otherwise wrongly
   * treat a PAID advance as blocking a legitimate later balance charge.
   */
  async findByOrderIdAndPurpose(orderId, purpose) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
      [orderId, purpose]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find a PAID payment for a given order draft — the advance leg, before
   * the real order exists (order_id is still null at that point). Distinct
   * from findByOrderId, which only ever matches once order_id is set.
   */
  async findPaidByOrderDraftId(orderDraftId) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_draft_id = $1 AND status = 'PAID' ORDER BY created_at DESC LIMIT 1`,
      [orderDraftId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Sum of all successfully collected (PAID) payments for an order, in
   * rupees — the authoritative "amount collected so far" figure, computed
   * on demand rather than tracked in a denormalized column.
   */
  async sumPaidByOrderId(orderId) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(amount), 0) AS amount_paid FROM payments WHERE order_id = $1 AND status = 'PAID'`,
      [orderId]
    )
    return parseFloat(rows[0].amount_paid)
  }

  /**
   * Update payment after verification
   */
  async updatePayment(id, data) {
    const sets = ['updated_at = NOW()']
    const params = []
    let idx = 1

    if (data.razorpayPaymentId) {
      sets.push(`razorpay_payment_id = $${idx++}`)
      params.push(data.razorpayPaymentId)
    }
    if (data.razorpaySignature) {
      sets.push(`razorpay_signature = $${idx++}`)
      params.push(data.razorpaySignature)
    }
    if (data.status) {
      sets.push(`status = $${idx++}`)
      params.push(data.status)
    }
    if (data.method) {
      sets.push(`method = $${idx++}`)
      params.push(data.method)
    }
    if (data.metadata) {
      sets.push(`metadata = $${idx++}`)
      params.push(JSON.stringify(data.metadata))
    }

    params.push(id)

    const { rows } = await query(
      `UPDATE payments SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${PAYMENT_COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Atomically move a payment to PAID. Returns `{ transitioned, payment }`;
   * `transitioned` is false when it was already PAID/REFUNDED (a concurrent
   * verify / webhook / poll got there first), and `{ duplicate: true }` when
   * the database refuses a second PAID advance for the same draft (the
   * customer paid twice) or a Razorpay payment id that is already recorded.
   */
  async markPaid(id, { razorpayPaymentId = null, signature = null, method = null } = {}) {
    try {
      const { rows } = await query(
        `UPDATE payments
            SET status = 'PAID',
                razorpay_payment_id = COALESCE($2, razorpay_payment_id),
                razorpay_signature  = COALESCE($3, razorpay_signature),
                method              = COALESCE($4, method),
                paid_at             = COALESCE(paid_at, NOW()),
                failure_code = NULL, failure_reason = NULL, failure_source = NULL,
                updated_at = NOW()
          WHERE id = $1 AND status NOT IN ('PAID', 'REFUNDED')
          RETURNING ${PAYMENT_COLUMNS}`,
        [id, razorpayPaymentId, signature, method]
      )
      if (rows.length === 0) return { transitioned: false, payment: await this.findById(id) }
      return { transitioned: true, payment: this._format(rows[0]) }
    } catch (err) {
      if (err.code === '23505') return { transitioned: false, duplicate: true, constraint: err.constraint, payment: null }
      throw err
    }
  }

  /**
   * Remember why an attempt failed without ending the payment's life: a
   * customer can retry inside the same gateway order, and a later success
   * must still be able to settle it. `terminal` additionally marks it FAILED.
   */
  async recordFailure(id, { code, message, source }, { terminal = false } = {}) {
    const { rows } = await query(
      `UPDATE payments
          SET failure_code = $2, failure_reason = $3, failure_source = $4,
              status = CASE WHEN $5::boolean AND status IN ('PENDING','EXPIRED') THEN 'FAILED' ELSE status END,
              updated_at = NOW()
        WHERE id = $1 AND status <> 'PAID' AND status <> 'REFUNDED'
        RETURNING ${PAYMENT_COLUMNS}`,
      [id, code || null, message || null, source || null, terminal]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async findByRazorpayPaymentId(razorpayPaymentId) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE razorpay_payment_id = $1`,
      [razorpayPaymentId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Latest payment for a draft (any status) — for the app's status polling. */
  async findLatestByOrderDraftId(orderDraftId) {
    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_draft_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderDraftId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Update refund fields
   */
  async updateRefund(id, refundData) {
    const { rows } = await query(
      `UPDATE payments SET
        refund_id = $1,
        refund_amount = $2,
        refund_status = $3,
        status = 'REFUNDED',
        updated_at = NOW()
       WHERE id = $4 RETURNING ${PAYMENT_COLUMNS}`,
      [refundData.refundId, refundData.refundAmount, refundData.refundStatus || 'PROCESSED', id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Get payment history for a user (paginated)
   */
  async findByUser(userId, { limit, offset }) {
    const countResult = await query(
      `SELECT COUNT(*) FROM payments WHERE user_id = $1`,
      [userId]
    )

    const { rows } = await query(
      `SELECT ${PAYMENT_COLUMNS} FROM payments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )

    return {
      payments: rows.map(this._format),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Format snake_case row to camelCase
   */
  _format(row) {
    return {
      id: row.id,
      orderId: row.order_id,
      userId: row.user_id,
      razorpayOrderId: row.razorpay_order_id,
      razorpayPaymentId: row.razorpay_payment_id,
      razorpaySignature: row.razorpay_signature,
      amount: parseFloat(row.amount),
      currency: row.currency,
      status: row.status,
      method: row.method,
      expiresAt: row.expires_at || null,
      refundId: row.refund_id,
      refundAmount: row.refund_amount ? parseFloat(row.refund_amount) : null,
      refundStatus: row.refund_status,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      orderDraftId: row.order_draft_id,
      purpose: row.purpose,
      failureCode: row.failure_code ?? null,
      failureReason: row.failure_reason ?? null,
      failureSource: row.failure_source ?? null,
      paidAt: row.paid_at ?? null,
      recoveryAttempts: row.recovery_attempts ?? 0,
      recoveryNextAt: row.recovery_next_at ?? null,
      recoveryLastError: row.recovery_last_error ?? null,
      lastGatewayCheckAt: row.last_gateway_check_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
