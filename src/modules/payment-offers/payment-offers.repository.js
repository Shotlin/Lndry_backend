import { query } from '../../config/database.js'

/**
 * Payment offers repository — CRUD for payment_offers table
 */
export class PaymentOffersRepository {
  async getActive() {
    const { rows } = await query(
      `SELECT *
       FROM payment_offers
       WHERE is_active = true
         AND (valid_until IS NULL OR valid_until > NOW())
       ORDER BY created_at DESC`
    )
    return rows
  }

  async getAll() {
    const { rows } = await query(
      `SELECT *
       FROM payment_offers
       ORDER BY created_at DESC`
    )
    return rows
  }

  async getById(id) {
    const { rows } = await query(
      `SELECT *
       FROM payment_offers
       WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO payment_offers
       (title, description, provider, icon_url, cashback_amount, cashback_percent,
        min_order_amount, max_cashback, lock_threshold, is_active, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, true), COALESCE($11, NOW()), $12)
       RETURNING *`,
      [
        data.title,
        data.description,
        data.provider,
        data.icon_url,
        data.cashback_amount,
        data.cashback_percent,
        data.min_order_amount,
        data.max_cashback,
        data.lock_threshold,
        data.is_active,
        data.valid_from,
        data.valid_until,
      ]
    )
    return rows[0] || null
  }

  async update(id, data) {
    const { rows } = await query(
      `UPDATE payment_offers
       SET title = $1,
           description = $2,
           provider = $3,
           icon_url = $4,
           cashback_amount = $5,
           cashback_percent = $6,
           min_order_amount = $7,
           max_cashback = $8,
           lock_threshold = $9,
           is_active = $10,
           valid_from = $11,
           valid_until = $12,
           updated_at = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        data.title,
        data.description,
        data.provider,
        data.icon_url,
        data.cashback_amount,
        data.cashback_percent,
        data.min_order_amount,
        data.max_cashback,
        data.lock_threshold,
        data.is_active,
        data.valid_from,
        data.valid_until,
        id,
      ]
    )
    return rows[0] || null
  }

  async delete(id) {
    const { rows } = await query(
      `DELETE FROM payment_offers
       WHERE id = $1
       RETURNING id`,
      [id]
    )
    return rows[0] || null
  }
}
