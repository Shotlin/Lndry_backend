import { query } from '../config/database.js'

/**
 * Remaining amount owed on an order, in paise: total_amount minus the sum
 * of its PAID payments. Shared by every payment-completeness gate (rider
 * delivery-OTP verification, customer delivery-OTP visibility) so they can
 * never disagree on what "paid in full" means.
 */
export async function getOrderBalanceDuePaise(orderId) {
  const { rows } = await query(
    `SELECT o.total_amount,
            (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND status = 'PAID') AS amount_paid
     FROM orders o WHERE o.id = $1`,
    [orderId]
  )
  const row = rows[0]
  if (!row) {
    throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
  }
  const totalPaise = Math.round(Number(row.total_amount) * 100)
  const amountPaidPaise = Math.round(Number(row.amount_paid) * 100)
  return Math.max(0, totalPaise - amountPaidPaise)
}
