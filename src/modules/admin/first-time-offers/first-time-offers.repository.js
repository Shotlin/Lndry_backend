import { query } from '../../../config/database.js'

const COLUMNS = `
  id, name, min_order_amount, reward_type, reward_value, max_discount,
  unlock_coupon_id, start_at, end_at, is_active, auto_apply,
  created_by, created_at, updated_at
`

/**
 * First-Time Offers repository — admin-defined rewards for a customer's
 * first order. Ported from bakaloo-backend (see CLAUDE.md's "Bakaloo
 * Feature Port" section).
 */
export class FirstTimeOffersRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM first_time_offers ORDER BY min_order_amount ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM first_time_offers WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Every currently-active, date-valid offer, regardless of order total —
   * the service scans this set to find the best-fit (highest
   * min_order_amount the order still satisfies) and the closest
   * not-yet-satisfied one. Ordered by min_order_amount ASC purely as a
   * convenience for that scan.
   */
  async findAllActiveCandidates() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM first_time_offers
       WHERE is_active = true
         AND (start_at IS NULL OR start_at <= NOW())
         AND (end_at IS NULL OR end_at >= NOW())
       ORDER BY min_order_amount ASC`
    )
    return rows.map((row) => this._format(row))
  }

  /**
   * True once userId has placed a real order — same first-order check used
   * by FIRST_TIME coupon targeting (coupons.repository.js#hasPriorOrder).
   * Counts every status except CANCELLED, including PENDING, so a second
   * order placed while the first is still unpaid doesn't look "first-time"
   * again.
   */
  async hasPriorOrder(userId) {
    const { rows } = await query(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND status != 'CANCELLED'
       ) AS has_prior`,
      [userId]
    )
    return rows[0].has_prior
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO first_time_offers (
         name, min_order_amount, reward_type, reward_value, max_discount,
         unlock_coupon_id, start_at, end_at, auto_apply, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.minOrderAmount ?? 0,
        data.rewardType,
        data.rewardValue ?? null,
        data.maxDiscount ?? null,
        data.unlockCouponId ?? null,
        data.startAt ?? null,
        data.endAt ?? null,
        data.autoApply ?? true,
        data.createdBy ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      name: 'name',
      minOrderAmount: 'min_order_amount',
      rewardType: 'reward_type',
      rewardValue: 'reward_value',
      maxDiscount: 'max_discount',
      unlockCouponId: 'unlock_coupon_id',
      startAt: 'start_at',
      endAt: 'end_at',
      isActive: 'is_active',
      autoApply: 'auto_apply',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push(`updated_at = NOW()`)
    params.push(id)
    const { rows } = await query(
      `UPDATE first_time_offers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM first_time_offers WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      minOrderAmount: parseFloat(row.min_order_amount),
      rewardType: row.reward_type,
      rewardValue: row.reward_value != null ? parseFloat(row.reward_value) : null,
      maxDiscount: row.max_discount != null ? parseFloat(row.max_discount) : null,
      unlockCouponId: row.unlock_coupon_id,
      startAt: row.start_at,
      endAt: row.end_at,
      isActive: row.is_active,
      autoApply: row.auto_apply,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
