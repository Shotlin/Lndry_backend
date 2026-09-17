import { query } from '../../../config/database.js'

const COLUMNS = `
  id, name, is_active, target_type, target_segment_id, priority, valid_from, valid_until,
  referrer_reward_type, referrer_reward_amount, referrer_reward_count, referrer_unlock_coupon_id, referrer_trigger,
  referee_reward_type, referee_reward_amount, referee_reward_count, referee_unlock_coupon_id, referee_trigger,
  max_referrals_per_referrer, terms_text, created_by, created_at, updated_at
`

/**
 * Referral Programs repository — admin-managed campaign config.
 */
export class ReferralProgramsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM referral_programs ORDER BY priority DESC, created_at DESC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM referral_programs WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Every currently-active, in-date-range program, highest priority first — the raw candidate list resolution scans. */
  async findAllActiveInRange() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM referral_programs
       WHERE is_active = true
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
       ORDER BY priority DESC, created_at DESC`
    )
    return rows.map((row) => this._format(row))
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO referral_programs (
         name, is_active, target_type, target_segment_id, priority, valid_from, valid_until,
         referrer_reward_type, referrer_reward_amount, referrer_reward_count, referrer_unlock_coupon_id, referrer_trigger,
         referee_reward_type, referee_reward_amount, referee_reward_count, referee_unlock_coupon_id, referee_trigger,
         max_referrals_per_referrer, terms_text, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.isActive ?? true,
        data.targetType ?? 'ALL',
        data.targetSegmentId ?? null,
        data.priority ?? 0,
        data.validFrom ?? null,
        data.validUntil ?? null,
        data.referrerRewardType,
        data.referrerRewardAmount ?? null,
        data.referrerRewardCount ?? null,
        data.referrerUnlockCouponId ?? null,
        data.referrerTrigger ?? 'ON_FIRST_ORDER_COMPLETE',
        data.refereeRewardType,
        data.refereeRewardAmount ?? null,
        data.refereeRewardCount ?? null,
        data.refereeUnlockCouponId ?? null,
        data.refereeTrigger ?? 'ON_FIRST_ORDER_COMPLETE',
        data.maxReferralsPerReferrer ?? null,
        data.termsText ?? null,
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
      isActive: 'is_active',
      targetType: 'target_type',
      targetSegmentId: 'target_segment_id',
      priority: 'priority',
      validFrom: 'valid_from',
      validUntil: 'valid_until',
      referrerRewardType: 'referrer_reward_type',
      referrerRewardAmount: 'referrer_reward_amount',
      referrerRewardCount: 'referrer_reward_count',
      referrerUnlockCouponId: 'referrer_unlock_coupon_id',
      referrerTrigger: 'referrer_trigger',
      refereeRewardType: 'referee_reward_type',
      refereeRewardAmount: 'referee_reward_amount',
      refereeRewardCount: 'referee_reward_count',
      refereeUnlockCouponId: 'referee_unlock_coupon_id',
      refereeTrigger: 'referee_trigger',
      maxReferralsPerReferrer: 'max_referrals_per_referrer',
      termsText: 'terms_text',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push('updated_at = NOW()')
    params.push(id)
    const { rows } = await query(
      `UPDATE referral_programs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query('DELETE FROM referral_programs WHERE id = $1', [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      targetType: row.target_type,
      targetSegmentId: row.target_segment_id,
      priority: row.priority,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      referrerRewardType: row.referrer_reward_type,
      referrerRewardAmount: row.referrer_reward_amount != null ? parseFloat(row.referrer_reward_amount) : null,
      referrerRewardCount: row.referrer_reward_count,
      referrerUnlockCouponId: row.referrer_unlock_coupon_id,
      referrerTrigger: row.referrer_trigger,
      refereeRewardType: row.referee_reward_type,
      refereeRewardAmount: row.referee_reward_amount != null ? parseFloat(row.referee_reward_amount) : null,
      refereeRewardCount: row.referee_reward_count,
      refereeUnlockCouponId: row.referee_unlock_coupon_id,
      refereeTrigger: row.referee_trigger,
      maxReferralsPerReferrer: row.max_referrals_per_referrer,
      termsText: row.terms_text,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
