import { query } from '../../../config/database.js'

export class AdminPaymentsRepository {
  async findAll({ offset, limit, status, search, startDate, endDate }) {
    let sql = `
      SELECT p.id, p.order_id, p.user_id, p.order_draft_id,
             p.razorpay_order_id, p.razorpay_payment_id,
             p.amount, p.currency, p.status, p.method,
             p.refund_id, p.refund_amount, p.refund_status,
             p.created_at, p.updated_at,
             u.name AS customer_name, u.phone AS customer_phone,
             o.order_number
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE 1=1
    `
    const params = []
    let idx = 1

    if (status) { params.push(status); sql += ` AND p.status = $${idx++}` }
    if (startDate) { params.push(startDate); sql += ` AND p.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); sql += ` AND p.created_at <= $${idx++}` }
    if (search) {
      params.push(`%${search}%`)
      sql += ` AND (o.order_number ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.name ILIKE $${idx} OR p.razorpay_payment_id ILIKE $${idx})`
      idx++
    }

    const countSql = `
      SELECT COUNT(*) FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE 1=1
    ` + sql.split('WHERE 1=1')[1].replace(/ORDER BY.*$/, '').replace(/LIMIT.*$/, '')
    const countRes = await query(countSql, params)
    const total = parseInt(countRes.rows[0].count, 10)

    params.push(limit, offset)
    sql += ` ORDER BY p.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`

    const { rows } = await query(sql, params)
    return { payments: rows, total }
  }
}
