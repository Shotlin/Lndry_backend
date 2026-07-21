import { query, getClient } from '../../../config/database.js'

export class AdminCustomersRepository {
  async findAll({ offset, limit, search, status, sortBy = 'created_at', sortOrder = 'DESC' }) {
    const params = []
    const clauses = ["u.role = 'CUSTOMER'"]
    let idx = 1

    if (search) {
      clauses.push(`(u.name ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.email ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    if (status === 'active') { clauses.push('u.is_active = true AND u.is_blocked IS NOT TRUE') }
    else if (status === 'blocked') { clauses.push('u.is_blocked = true') }
    else if (status === 'inactive') { clauses.push('u.is_active = false') }

    const allowedSort = { created_at: 'u.created_at', name: 'u.name', orders: 'order_count', spent: 'total_spent' }
    const orderCol = allowedSort[sortBy] || 'u.created_at'
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC'
    const where = clauses.join(' AND ')

    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.avatar_url, u.is_active, u.is_blocked, u.created_at,
              u.loyalty_points, COALESCE(w.balance, 0) AS wallet_balance,
              COALESCE(o_stats.order_count, 0)::int AS order_count,
              COALESCE(o_stats.total_spent, 0) AS total_spent,
              o_stats.last_order_at
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent, MAX(created_at) AS last_order_at
         FROM orders WHERE status != 'CANCELLED' GROUP BY user_id
       ) o_stats ON o_stats.user_id = u.id
       WHERE ${where}
       ORDER BY ${orderCol} ${dir} NULLS LAST
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM users u WHERE ${where}`,
      params
    )

    const total = countRes.rows[0].total
    const page = Math.floor(offset / limit) + 1

    return {
      customers: rows.map(r => ({
        ...r,
        wallet_balance: parseFloat(r.wallet_balance || 0),
        total_spent: parseFloat(r.total_spent || 0),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async findById(id) {
    const { rows: [customer] } = await query(
      `SELECT u.*, COALESCE(w.balance, 0) AS wallet_balance,
              COALESCE(o_stats.order_count, 0)::int AS order_count,
              COALESCE(o_stats.total_spent, 0) AS total_spent,
              COALESCE(o_stats.avg_order, 0) AS avg_order_value,
              o_stats.last_order_at
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent,
                AVG(total_amount) AS avg_order, MAX(created_at) AS last_order_at
         FROM orders WHERE status != 'CANCELLED' GROUP BY user_id
       ) o_stats ON o_stats.user_id = u.id
       WHERE u.id = $1 AND u.role = 'CUSTOMER'`,
      [id]
    )
    if (!customer) return null
    return {
      ...customer,
      wallet_balance: parseFloat(customer.wallet_balance || 0),
      total_spent: parseFloat(customer.total_spent || 0),
      avg_order_value: parseFloat(customer.avg_order_value || 0),
    }
  }

  async getCustomerOrders(customerId, { offset, limit }) {
    const { rows } = await query(
      `SELECT id, order_number, status, total_amount, payment_method, created_at
       FROM orders WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [customerId, limit, offset]
    )
    const countRes = await query('SELECT COUNT(*)::int AS total FROM orders WHERE user_id = $1', [customerId])
    const total = countRes.rows[0].total
    const page = Math.floor(offset / limit) + 1
    return {
      orders: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getCustomerAddresses(customerId) {
    const { rows } = await query(
      'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [customerId]
    )
    return rows
  }

  async getLTV() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.created_at,
              COALESCE(o.total_spent, 0) AS ltv,
              COALESCE(o.order_count, 0)::int AS order_count,
              COALESCE(o.avg_order, 0) AS avg_order_value,
              EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400 AS days_since_signup
       FROM users u
       LEFT JOIN (
         SELECT user_id, SUM(total_amount) AS total_spent, COUNT(*)::int AS order_count, AVG(total_amount) AS avg_order
         FROM orders WHERE status = 'DELIVERED' GROUP BY user_id
       ) o ON o.user_id = u.id
       WHERE u.role = 'CUSTOMER'
       ORDER BY ltv DESC NULLS LAST
       LIMIT 100`
    )
    return rows.map(r => ({
      ...r,
      ltv: parseFloat(r.ltv),
      avg_order_value: parseFloat(r.avg_order_value),
      days_since_signup: Math.floor(parseFloat(r.days_since_signup)),
    }))
  }

  async getChurned(days = 30) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email,
              o.last_order_at, o.order_count::int, COALESCE(o.total_spent, 0) AS total_spent
       FROM users u
       JOIN (
         SELECT user_id, MAX(created_at) AS last_order_at, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent
         FROM orders WHERE status = 'DELIVERED' GROUP BY user_id HAVING COUNT(*) >= 2
       ) o ON o.user_id = u.id
       WHERE u.role = 'CUSTOMER' AND u.is_active = true
         AND o.last_order_at < NOW() - make_interval(days => $1)
       ORDER BY o.total_spent DESC`,
      [days]
    )
    return rows.map(r => ({ ...r, total_spent: parseFloat(r.total_spent) }))
  }

  async getVIP(minOrders = 10) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.loyalty_points,
              COALESCE(w.balance, 0) AS wallet_balance,
              o.order_count::int, COALESCE(o.total_spent, 0) AS total_spent,
              COALESCE(o.avg_order, 0) AS avg_order_value, o.last_order_at
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent,
                AVG(total_amount) AS avg_order, MAX(created_at) AS last_order_at
         FROM orders WHERE status = 'DELIVERED' GROUP BY user_id HAVING COUNT(*) >= $1
       ) o ON o.user_id = u.id
       WHERE u.role = 'CUSTOMER' AND u.is_active = true
       ORDER BY o.total_spent DESC`,
      [minOrders]
    )
    return rows.map(r => ({ ...r, total_spent: parseFloat(r.total_spent), avg_order_value: parseFloat(r.avg_order_value) }))
  }

  async creditWallet(userId, amount, description) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: [wallet] } = await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()
         RETURNING *`,
        [userId, amount]
      )
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount, description, balance_after)
         VALUES ($1, 'CREDIT', $2, $3, $4)`,
        [wallet.id, amount, description || 'Admin credit', wallet.balance]
      )
      await client.query('COMMIT')
      return { balance: parseFloat(wallet.balance) }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async toggleBlock(userId, blocked) {
    const { rows: [user] } = await query(
      'UPDATE users SET is_blocked = $1, blocked_at = $3, is_active = $4, updated_at = NOW() WHERE id = $2 RETURNING id, name, is_active, is_blocked',
      [blocked, userId, blocked ? new Date() : null, !blocked]
    )
    return user
  }

  async getAllForExport() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.is_active, u.loyalty_points,
              COALESCE(w.balance, 0) AS wallet_balance, u.created_at,
              COALESCE(o.order_count, 0)::int AS order_count, COALESCE(o.total_spent, 0) AS total_spent
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent
         FROM orders WHERE status != 'CANCELLED' GROUP BY user_id
       ) o ON o.user_id = u.id
       WHERE u.role = 'CUSTOMER'
       ORDER BY u.created_at DESC`
    )
    return rows
  }
}

