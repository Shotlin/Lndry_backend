import { query } from '../../config/database.js'

// Explicit column list (R14.7 — no SELECT *), matches every field _format() reads.
const PAYMENT_COLUMNS = `id, order_id, user_id, razorpay_order_id, razorpay_payment_id,
  razorpay_signature, amount, currency, status, method, refund_id, refund_amount,
  refund_status, metadata, created_at, updated_at, expires_at, order_draft_id`

/**
 * Payments repository — all SQL queries for payments
 */
export class PaymentsRepository {
  /**
   * Create a payment record
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO payments (order_id, user_id, razorpay_order_id, amount, currency, status, method, expires_at, metadata, order_draft_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
