import { query, getClient } from '../../../config/database.js'

export class AdminRidersRepository {
  async findAll({ offset, limit, search, status, sortBy = 'created_at', sortOrder = 'DESC' }) {
    const params = []
    const clauses = ["u.role = 'RIDER'"]
    let idx = 1

    if (search) {
      clauses.push(`(u.name ILIKE $${idx} OR u.phone ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    if (status === 'online') { clauses.push('rp.is_online = true') }
    else if (status === 'offline') { clauses.push('rp.is_online = false') }
    else if (status === 'pending') { clauses.push('rp.is_approved = false') }
    else if (status === 'suspended') { clauses.push('u.is_active = false') }

    const allowedSort = { created_at: 'u.created_at', name: 'u.name', deliveries: 'rp.total_deliveries', rating: 'rp.rating' }
    const orderCol = allowedSort[sortBy] || 'u.created_at'
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC'
    const where = clauses.join(' AND ')

    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.avatar_url, u.is_active,
              rp.vehicle_type, rp.vehicle_number, rp.is_approved, rp.is_online,
              rp.rating, rp.total_deliveries, rp.commission_rate,
              rp.current_lat, rp.current_lng, u.created_at
       FROM users u
       LEFT JOIN rider_profiles rp ON rp.user_id = u.id
       WHERE ${where}
       ORDER BY ${orderCol} ${dir} NULLS LAST
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )
    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM users u LEFT JOIN rider_profiles rp ON rp.user_id = u.id WHERE ${where}`,
      params
    )
    return { riders: rows, total: countRes.rows[0].total }
  }

  async findById(riderId) {
    const { rows: [rider] } = await query(
      `SELECT u.*, rp.vehicle_type, rp.vehicle_number, rp.license_url, rp.aadhar_url,
              rp.is_approved, rp.is_online, rp.rating, rp.total_deliveries,
              rp.commission_rate, rp.bank_account_number, rp.bank_ifsc, rp.bank_name,
              rp.current_lat, rp.current_lng
       FROM users u
       LEFT JOIN rider_profiles rp ON rp.user_id = u.id
       WHERE u.id = $1 AND u.role = 'RIDER'`,
      [riderId]
    )
    return rider || null
  }

  async getEarnings(riderId, { startDate, endDate }) {
    const params = [riderId]
    let dateFilter = ''
    if (startDate) {
      params.push(startDate)
      dateFilter += ` AND re.created_at >= $${params.length}`
    }
    if (endDate) {
      params.push(endDate)
      dateFilter += ` AND re.created_at <= $${params.length}`
    }

    const { rows: summary } = await query(
      `SELECT COALESCE(SUM(re.amount), 0) AS total,
              COUNT(*)::int AS delivery_count,
              COALESCE(AVG(re.amount), 0) AS avg_per_delivery
       FROM rider_earnings re
       WHERE re.rider_id = $1 ${dateFilter}`,
      params
    )

    const { rows: daily } = await query(
      `SELECT DATE(re.created_at) AS date, SUM(re.amount) AS total, COUNT(*)::int AS deliveries
       FROM rider_earnings re
       WHERE re.rider_id = $1 ${dateFilter}
       GROUP BY DATE(re.created_at)
       ORDER BY date DESC LIMIT 30`,
      params
    )

    return {
      summary: {
        total: parseFloat(summary[0].total),
        delivery_count: summary[0].delivery_count,
        avg_per_delivery: parseFloat(summary[0].avg_per_delivery),
      },
      daily: daily.map(d => ({ ...d, total: parseFloat(d.total) })),
    }
  }

  async getPayouts(riderId) {
    const { rows } = await query(
      `SELECT * FROM rider_payouts WHERE rider_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [riderId]
    )
    return rows
  }

  async createPayout(riderId, amount, method, reference, adminId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: [payout] } = await client.query(
        `INSERT INTO rider_payouts (rider_id, amount, payment_ref, status, initiated_by, period_start, period_end)
         VALUES ($1, $2, $3, 'PAID', $4, CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE) RETURNING *`,
        [riderId, amount, reference || method, adminId]
      )
      await client.query('COMMIT')
      return payout
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async toggleSuspend(riderId, suspended) {
    const { rows: [user] } = await query(
      'UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, is_active',
      [!suspended, riderId]
    )
    return user
  }

  async updateCommission(riderId, rate) {
    const { rows: [profile] } = await query(
      `UPDATE rider_profiles SET commission_rate = $1, updated_at = NOW()
       WHERE user_id = $2 RETURNING user_id, commission_rate`,
      [rate, riderId]
    )
    return profile
  }

  async approveRider(riderId, is_approved) {
    const { rows: [profile] } = await query(
      `UPDATE rider_profiles SET is_approved = $1, updated_at = NOW()
       WHERE user_id = $2 RETURNING user_id, is_approved`,
      [is_approved, riderId]
    )
    return profile
  }

  async getApprovalStatus(riderId) {
    const { rows: [profile] } = await query(
      `SELECT user_id, is_approved FROM rider_profiles WHERE user_id = $1`,
      [riderId]
    )
    return profile || null
  }

  async setApprovalStatus(riderId) {
    const { rows: [profile] } = await query(
      `UPDATE rider_profiles
       SET is_approved = true, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, is_approved`,
      [riderId]
    )
    return profile || null
  }

  async getDocuments(riderId) {
    const { rows } = await query(
      'SELECT * FROM rider_documents WHERE rider_id = $1 ORDER BY uploaded_at DESC',
      [riderId]
    )
    return rows
  }

  async verifyDocument(documentId, status, note, adminId) {
    const isApproved = status === 'APPROVED'
    const { rows: [doc] } = await query(
      `UPDATE rider_documents SET verified = $1, verified_by = $2, verified_at = NOW()
       WHERE id = $3 RETURNING *`,
      [isApproved, adminId, documentId]
    )
    return doc
  }

  async getLiveLocations() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, rp.current_lat, rp.current_lng,
              rp.vehicle_type, rp.is_online,
              da.order_id, da.status AS delivery_status
       FROM users u
       JOIN rider_profiles rp ON rp.user_id = u.id
       LEFT JOIN order_assignments da ON da.rider_id = u.id
         AND da.status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')
       WHERE rp.is_online = true AND u.is_active = true
       ORDER BY u.name`
    )
    return rows
  }
}
