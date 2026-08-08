import { query } from '../../../config/database.js'

const COLUMNS = `
  id, name, min_order_amount, reward_type, reward_value, max_discount,
  unlock_coupon_id, message_before, message_after, is_active,
  applicable_user_type, applicable_segment_id, stackable_with_coupon,
  usage_limit_per_user, priority, created_by, created_at, updated_at
`

/**
 * Cart Milestones repository — admin-defined spend-ladder rewards that
 * apply to every qualifying order (not just a customer's first). Ported
 * from bakaloo-backend (see CLAUDE.md's "Bakaloo Feature Port" section).
 */
export class CartMilestonesRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM cart_milestones ORDER BY min_order_amount ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM cart_milestones WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Every active tier, ascending by value — the raw ladder the service scans. */
  async findAllActive() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM cart_milestones WHERE is_active = true ORDER BY min_order_amount ASC`
    )
    return rows.map((row) => this._format(row))
  }

  /** Same first-order check used by FIRST_TIME coupon/first-time-offer targeting. */
  async hasPriorOrder(userId) {
    const { rows } = await query(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND status != 'CANCELLED'
       ) AS has_prior`,
      [userId]
    )
    return rows[0].has_prior
  }

  async getUserUsageCount(milestoneId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM cart_milestone_usages WHERE milestone_id = $1 AND user_id = $2`,
      [milestoneId, userId]
    )
    return rows[0].count
  }

  async recordUsage(milestoneId, userId, orderId) {
    await query(
      `INSERT INTO cart_milestone_usages (milestone_id, user_id, order_id) VALUES ($1, $2, $3)`,
      [milestoneId, userId, orderId]
    )
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO cart_milestones (
         name, min_order_amount, reward_type, reward_value, max_discount,
         unlock_coupon_id, message_before, message_after,
         applicable_user_type, applicable_segment_id, stackable_with_coupon,
         usage_limit_per_user, priority, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.minOrderAmount,
        data.rewardType,
        data.rewardValue ?? null,
        data.maxDiscount ?? null,
        data.unlockCouponId ?? null,
        data.messageBefore ?? null,
        data.messageAfter ?? null,
        data.applicableUserType ?? 'ALL',
        data.applicableSegmentId ?? null,
        data.stackableWithCoupon ?? true,
        data.usageLimitPerUser ?? null,
        data.priority ?? 0,
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
      messageBefore: 'message_before',
      messageAfter: 'message_after',
      isActive: 'is_active',
      applicableUserType: 'applicable_user_type',
      applicableSegmentId: 'applicable_segment_id',
      stackableWithCoupon: 'stackable_with_coupon',
      usageLimitPerUser: 'usage_limit_per_user',
      priority: 'priority',
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
      `UPDATE cart_milestones SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM cart_milestones WHERE id = $1`, [id])
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
      messageBefore: row.message_before,
      messageAfter: row.message_after,
      isActive: row.is_active,
      applicableUserType: row.applicable_user_type,
      applicableSegmentId: row.applicable_segment_id,
      stackableWithCoupon: row.stackable_with_coupon,
      usageLimitPerUser: row.usage_limit_per_user,
      priority: row.priority,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
