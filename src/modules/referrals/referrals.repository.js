import { query } from '../../config/database.js'

const COLUMNS = `
  id, referrer_id, referee_id, referral_program_id, referral_code_used, status,
  referee_signed_up_at, referee_first_order_id, referee_first_order_completed_at,
  referrer_reward_status, referrer_reward_granted_at,
  referee_reward_status, referee_reward_granted_at,
  created_at, updated_at
`

/**
 * Referrals repository — the tracked referrer/referee relationships, plus
 * the redeemable free-delivery credit ledger (referral_reward_credits),
 * kept in the same file since both are referral-domain data with no
 * admin CRUD of their own (unlike referral_programs).
 */
export class ReferralsRepository {
  /** Look up a referrer by the code someone else is trying to redeem. */
  async findUserByReferralCode(code) {
    const { rows } = await query(
      `SELECT id, referral_code, referred_by FROM users WHERE referral_code = $1`,
      [code]
    )
    return rows[0] || null
  }

  /** The current user's own shareable code, for the Refer & Earn dashboard. */
  async getReferralCode(userId) {
    const { rows } = await query('SELECT referral_code FROM users WHERE id = $1', [userId])
    return rows[0]?.referral_code ?? null
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM referrals WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /** A referee can only ever have one referral row (enforced by a UNIQUE constraint too). */
  async findByRefereeId(refereeId) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM referrals WHERE referee_id = $1`, [refereeId])
    return rows[0] ? this._format(rows[0]) : null
  }

  async findPendingByRefereeId(refereeId) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM referrals WHERE referee_id = $1 AND status = 'PENDING_FIRST_ORDER'`,
      [refereeId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async countByReferrer(referrerId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id = $1`,
      [referrerId]
    )
    return rows[0].count
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO referrals (referrer_id, referee_id, referral_program_id, referral_code_used)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [data.referrerId, data.refereeId, data.referralProgramId ?? null, data.referralCodeUsed ?? null]
    )
    return this._format(rows[0])
  }

  /**
   * A referee's account can only ever be created once — the caller is
   * responsible for the `users.referred_by IS NULL` guard; the UNIQUE
   * constraint on referee_id is the last-line-of-defense backstop.
   */
  async isFirstOrder(userId, orderId) {
    const { rows } = await query(
      `SELECT NOT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND status != 'CANCELLED' AND id != $2
       ) AS is_first`,
      [userId, orderId]
    )
    return rows[0].is_first
  }

  async markCompleted(id, orderId) {
    await query(
      `UPDATE referrals
       SET status = 'COMPLETED', referee_first_order_id = $2, referee_first_order_completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, orderId]
    )
  }

  async updateRewardStatus(id, side, status) {
    const column = side === 'referrer' ? 'referrer_reward_status' : 'referee_reward_status'
    const grantedAtColumn = side === 'referrer' ? 'referrer_reward_granted_at' : 'referee_reward_granted_at'
    const grantedAtClause = status === 'GRANTED' ? `${grantedAtColumn} = NOW(),` : ''
    await query(
      `UPDATE referrals SET ${column} = $2, ${grantedAtClause} updated_at = NOW() WHERE id = $1`,
      [id, status]
    )
  }

  /** Paginated referral history for a referrer's "Refer & Earn" timeline. */
  async findByReferrer(referrerId, { limit, offset }) {
    const countResult = await query(
      `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`,
      [referrerId]
    )
    const { rows } = await query(
      `SELECT r.id, r.referrer_id, r.referee_id, r.referral_program_id, r.referral_code_used, r.status,
              r.referee_signed_up_at, r.referee_first_order_id, r.referee_first_order_completed_at,
              r.referrer_reward_status, r.referrer_reward_granted_at,
              r.referee_reward_status, r.referee_reward_granted_at,
              r.created_at, r.updated_at,
              u.name AS referee_name, u.phone AS referee_phone
       FROM referrals r
       JOIN users u ON u.id = r.referee_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [referrerId, limit, offset]
    )
    return {
      referrals: rows.map((row) => ({
        ...this._format(row),
        refereeName: row.referee_name,
        refereePhoneMasked: this._maskPhone(row.referee_phone),
      })),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /** Summary stats for the customer-facing dashboard. */
  async getSummaryForReferrer(referrerId) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE r.status = 'PENDING_FIRST_ORDER')::int AS pending,
         COUNT(*) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
         COALESCE(SUM(p.referrer_reward_amount) FILTER (
           WHERE r.referrer_reward_status = 'GRANTED' AND p.referrer_reward_type = 'WALLET_CREDIT'
         ), 0) AS total_wallet_earned
       FROM referrals r
       LEFT JOIN referral_programs p ON p.id = r.referral_program_id
       WHERE r.referrer_id = $1`,
      [referrerId]
    )
    const row = rows[0] || {}
    return {
      totalReferred: row.total || 0,
      pending: row.pending || 0,
      completed: row.completed || 0,
      totalWalletEarned: row.total_wallet_earned != null ? parseFloat(row.total_wallet_earned) : 0,
    }
  }

  /** Platform-wide, paginated referral list for the admin monitoring page. */
  async findAllAdmin({ limit, offset, search }) {
    const params = []
    let idx = 1
    let searchClause = ''
    if (search) {
      searchClause = `AND (referrer.name ILIKE $${idx} OR referrer.phone ILIKE $${idx} OR referee.name ILIKE $${idx} OR referee.phone ILIKE $${idx})`
      params.push(`%${search}%`)
      idx += 1
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM referrals r
       JOIN users referrer ON referrer.id = r.referrer_id
       JOIN users referee ON referee.id = r.referee_id
       WHERE 1=1 ${searchClause}`,
      params
    )

    const listParams = [...params, limit, offset]
    const { rows } = await query(
      `SELECT r.id, r.status, r.created_at, r.referee_signed_up_at, r.referee_first_order_completed_at,
              r.referrer_reward_status, r.referrer_reward_granted_at,
              r.referee_reward_status, r.referee_reward_granted_at,
              referrer.name AS referrer_name, referrer.phone AS referrer_phone,
              referee.name AS referee_name, referee.phone AS referee_phone,
              p.name AS program_name
       FROM referrals r
       JOIN users referrer ON referrer.id = r.referrer_id
       JOIN users referee ON referee.id = r.referee_id
       LEFT JOIN referral_programs p ON p.id = r.referral_program_id
       WHERE 1=1 ${searchClause}
       ORDER BY r.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      listParams
    )

    return {
      referrals: rows.map((row) => ({
        id: row.id,
        status: row.status,
        referrerName: row.referrer_name,
        referrerPhone: row.referrer_phone,
        refereeName: row.referee_name,
        refereePhone: row.referee_phone,
        programName: row.program_name,
        referrerRewardStatus: row.referrer_reward_status,
        referrerRewardGrantedAt: row.referrer_reward_granted_at,
        refereeRewardStatus: row.referee_reward_status,
        refereeRewardGrantedAt: row.referee_reward_granted_at,
        createdAt: row.created_at,
        refereeSignedUpAt: row.referee_signed_up_at,
        refereeFirstOrderCompletedAt: row.referee_first_order_completed_at,
      })),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /** Platform-wide summary stats for the admin monitoring page's stat strip. */
  async getAdminSummary() {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'PENDING_FIRST_ORDER')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
         (COUNT(*) FILTER (WHERE referrer_reward_status = 'GRANTED')
          + COUNT(*) FILTER (WHERE referee_reward_status = 'GRANTED'))::int AS rewards_granted
       FROM referrals`
    )
    const row = rows[0] || {}
    return {
      total: row.total || 0,
      pending: row.pending || 0,
      completed: row.completed || 0,
      rewardsGranted: row.rewards_granted || 0,
    }
  }

  // ── Reward credits ledger (referral_reward_credits) ────────────────────────

  async grantCredit(userId, creditType, count, sourceReferralId) {
    await query(
      `INSERT INTO referral_reward_credits (user_id, credit_type, remaining_count, source_referral_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, credit_type)
       DO UPDATE SET remaining_count = referral_reward_credits.remaining_count + $3, updated_at = NOW()`,
      [userId, creditType, count, sourceReferralId ?? null]
    )
  }

  async getCredit(userId, creditType) {
    const { rows } = await query(
      `SELECT remaining_count FROM referral_reward_credits WHERE user_id = $1 AND credit_type = $2`,
      [userId, creditType]
    )
    return rows[0]?.remaining_count ?? 0
  }

  async consumeCredit(userId, creditType) {
    const { rows } = await query(
      `UPDATE referral_reward_credits SET remaining_count = remaining_count - 1, updated_at = NOW()
       WHERE user_id = $1 AND credit_type = $2 AND remaining_count > 0
       RETURNING remaining_count`,
      [userId, creditType]
    )
    return rows.length > 0
  }

  _maskPhone(phone) {
    if (!phone || phone.length < 4) return phone
    return `${phone.slice(0, -4).replace(/\d/g, '•')}${phone.slice(-4)}`
  }

  _format(row) {
    return {
      id: row.id,
      referrerId: row.referrer_id,
      refereeId: row.referee_id,
      referralProgramId: row.referral_program_id,
      referralCodeUsed: row.referral_code_used,
      status: row.status,
      refereeSignedUpAt: row.referee_signed_up_at,
      refereeFirstOrderId: row.referee_first_order_id,
      refereeFirstOrderCompletedAt: row.referee_first_order_completed_at,
      referrerRewardStatus: row.referrer_reward_status,
      referrerRewardGrantedAt: row.referrer_reward_granted_at,
      refereeRewardStatus: row.referee_reward_status,
      refereeRewardGrantedAt: row.referee_reward_granted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
