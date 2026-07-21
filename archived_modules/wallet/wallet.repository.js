import { query } from '../../src/config/database.js'

/**
 * Wallet repository — SQL queries for wallets + wallet_transactions
 * Uses SELECT ... FOR UPDATE row locking for balance operations
 */
export class WalletRepository {
  /**
   * Get or create wallet for a user
   */
  async getOrCreate(userId) {
    // Try to find existing wallet
    let { rows } = await query(
      `SELECT * FROM wallets WHERE user_id = $1`,
      [userId]
    )

    if (rows[0]) return this._formatWallet(rows[0])

    // Create wallet
    const result = await query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [userId]
    )
    return this._formatWallet(result.rows[0])
  }

  /**
   * Get wallet with FOR UPDATE lock (for transaction use)
   */
  async getForUpdate(client, userId) {
    const { rows } = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    return rows[0] ? this._formatWallet(rows[0]) : null
  }

  /**
   * Credit wallet (add money) within a transaction
   * Returns { wallet, transaction }
   */
  async credit(client, walletId, amount, description, referenceId) {
    // Update balance
    const { rows: walletRows } = await client.query(
      `UPDATE wallets SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [amount, walletId]
    )
    const wallet = this._formatWallet(walletRows[0])

    // Record transaction
    const { rows: txRows } = await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount, description, reference_id, balance_after)
       VALUES ($1, 'CREDIT', $2, $3, $4, $5)
       RETURNING *`,
      [walletId, amount, description || 'Credit', referenceId || null, wallet.balance]
    )
    const transaction = this._formatTransaction(txRows[0])

    return { wallet, transaction }
  }

  /**
   * Debit wallet (deduct money) within a transaction
   * Returns { wallet, transaction }
   */
  async debit(client, walletId, amount, description, referenceId) {
    // Update balance (CHECK constraint enforces >= 0)
    const { rows: walletRows } = await client.query(
      `UPDATE wallets SET balance = balance - $1, updated_at = NOW()
       WHERE id = $2 AND balance >= $1 RETURNING *`,
      [amount, walletId]
    )

    if (walletRows.length === 0) {
      throw new Error('Insufficient wallet balance')
    }

    const wallet = this._formatWallet(walletRows[0])

    // Record transaction
    const { rows: txRows } = await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount, description, reference_id, balance_after)
       VALUES ($1, 'DEBIT', $2, $3, $4, $5)
       RETURNING *`,
      [walletId, amount, description || 'Debit', referenceId || null, wallet.balance]
    )
    const transaction = this._formatTransaction(txRows[0])

    return { wallet, transaction }
  }

  /**
   * Get wallet transactions (paginated)
   */
  async getTransactions(walletId, { limit, offset, type }) {
    const conditions = ["wallet_id = $1", "COALESCE(status, 'COMPLETED') = 'COMPLETED'"]
    const params = [walletId]
    let idx = 2

    if (type) {
      conditions.push(`type = $${idx++}`)
      params.push(type)
    }

    const where = conditions.join(' AND ')

    const countResult = await query(
      `SELECT COUNT(*) FROM wallet_transactions WHERE ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT * FROM wallet_transactions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      transactions: rows.map(this._formatTransaction),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Create a pending wallet top-up transaction before Razorpay payment succeeds
   */
  async createPendingTopUp(walletId, { amount, razorpayOrderId, description }) {
    const { rows } = await query(
      `INSERT INTO wallet_transactions
         (wallet_id, type, amount, description, reference_id, status)
       VALUES ($1, 'CREDIT', $2, $3, $4, 'PENDING')
       RETURNING *`,
      [walletId, amount, description || 'Wallet top-up', razorpayOrderId]
    )

    return this._formatTransaction(rows[0])
  }

  /**
   * Find a wallet top-up transaction by Razorpay order ID and lock it for update
   */
  async findTopUpByOrderIdForUpdate(client, razorpayOrderId) {
    const { rows } = await client.query(
      `SELECT wt.*, w.user_id
       FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
       WHERE wt.reference_id = $1
         AND wt.type = 'CREDIT'
       ORDER BY wt.created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [razorpayOrderId]
    )

    return rows[0] ? this._formatTransaction(rows[0]) : null
  }

  /**
   * Apply a verified pending top-up to the wallet and complete the ledger entry
   */
  async applyPendingTopUp(client, walletId, topupId, amount) {
    const { rows: walletRows } = await client.query(
      `UPDATE wallets
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [amount, walletId]
    )
    const wallet = this._formatWallet(walletRows[0])

    const { rows: txRows } = await client.query(
      `UPDATE wallet_transactions
       SET status = 'COMPLETED', balance_after = $2
       WHERE id = $1
       RETURNING *`,
      [topupId, wallet.balance]
    )
    const transaction = this._formatTransaction(txRows[0])

    return { wallet, transaction }
  }

  /**
   * Mark a pending top-up as failed after signature verification fails
   */
  async markTopUpFailed(client, topupId) {
    const { rows } = await client.query(
      `UPDATE wallet_transactions
       SET status = 'FAILED'
       WHERE id = $1
       RETURNING *`,
      [topupId]
    )

    return rows[0] ? this._formatTransaction(rows[0]) : null
  }

  /**
   * Find user by phone number (for transfers)
   */
  async findUserByPhone(phone) {
    const { rows } = await query(
      `SELECT id, name, phone FROM users WHERE phone = $1 AND is_active = true`,
      [phone]
    )
    return rows[0] || null
  }

  /**
   * Get ALL wallet transactions across all users (admin view)
   * Joins users table to show customer info
   */
  async getAdminTransactions({ limit, offset, type, userId }) {
    const conditions = []
    const params = []
    let idx = 1

    if (userId) {
      conditions.push(`w.user_id = $${idx++}`)
      params.push(userId)
    }
    if (type) {
      conditions.push(`wt.type = $${idx++}`)
      params.push(type)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(*) FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
       ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT wt.*, w.user_id, u.name AS user_name, u.phone AS user_phone
       FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
       LEFT JOIN users u ON u.id = w.user_id
       ${where}
       ORDER BY wt.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      transactions: rows.map(r => ({
        ...this._formatTransaction(r),
        userId: r.user_id,
        userName: r.user_name,
        userPhone: r.user_phone,
      })),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Format wallet row
   */
  _formatWallet(row) {
    return {
      id: row.id,
      userId: row.user_id,
      balance: parseFloat(row.balance),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Format transaction row
   */
  _formatTransaction(row) {
    return {
      id: row.id,
      walletId: row.wallet_id,
      userId: row.user_id ?? null,
      type: row.type,
      amount: parseFloat(row.amount),
      description: row.description,
      referenceId: row.reference_id,
      balanceAfter: row.balance_after != null ? parseFloat(row.balance_after) : null,
      status: row.status || 'COMPLETED',
      createdAt: row.created_at,
    }
  }
}
