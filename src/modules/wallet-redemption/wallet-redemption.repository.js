import { query } from '../../config/database.js'

const COLUMNS = `
  wrr.id, wrr.customer_user_id, wrr.vendor_id, wrr.requested_by_user_id,
  wrr.amount_paise, wrr.attempt_count, wrr.status, wrr.wallet_transaction_id,
  wrr.expires_at, wrr.confirmed_at, wrr.created_at, wrr.updated_at
`

/**
 * Wallet Redemption repository — POS-counter wallet redemption requests.
 * See migration 112_wallet_redemption_requests.sql for the full design
 * rationale (mirrors order_otps' hash-in-DB/plaintext-in-Redis split).
 */
export class WalletRedemptionRepository {
  async findUserByPhone(phone) {
    const { rows } = await query('SELECT id, name FROM users WHERE phone = $1', [phone])
    return rows[0] || null
  }

  /**
   * Lazy-expiry sweep, scoped to one customer — run immediately before an
   * INSERT so a stale un-decided PENDING row never permanently blocks a
   * new request for that customer (the partial unique index can't
   * reference NOW() itself). See migration comment for why this exists
   * instead of a worker.
   */
  async expirePendingForCustomer(customerUserId) {
    await query(
      `UPDATE wallet_redemption_requests SET status = 'EXPIRED', updated_at = NOW()
       WHERE customer_user_id = $1 AND status = 'PENDING' AND expires_at <= NOW()`,
      [customerUserId]
    )
  }

  /**
   * A new request from a vendor replaces that SAME vendor's still-pending one for this customer (a fresh
   * code is issued) instead of failing with "already in progress" — e.g. after the operator reloaded the
   * screen or the vendor's type was switched back and forth. Another vendor's pending request is left alone.
   */
  async cancelPendingForVendor(vendorId, customerUserId) {
    const { rows } = await query(
      `UPDATE wallet_redemption_requests SET status = 'CANCELLED', updated_at = NOW()
       WHERE vendor_id = $1 AND customer_user_id = $2 AND status = 'PENDING'
       RETURNING id`,
      [vendorId, customerUserId]
    )
    return rows.map((row) => row.id)
  }

  async create({ customerUserId, vendorId, requestedByUserId, amountPaise, otpHash, expiresAt }) {
    // AS wrr: the shared COLUMNS constant's RETURNING references are all
    // wrr.-prefixed (matching the SELECT queries below, which do have a
    // real FROM ... wrr to alias) — a bare INSERT has no table alias in
    // scope by default, so this needs the explicit `AS wrr` to resolve.
    const { rows } = await query(
      `INSERT INTO wallet_redemption_requests AS wrr
         (customer_user_id, vendor_id, requested_by_user_id, amount_paise, otp_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [customerUserId, vendorId, requestedByUserId, amountPaise, otpHash, expiresAt]
    )
    return this._format(rows[0])
  }

  /** Ownership + ordering are both checked by the caller (vendor scope for confirm/cancel, customer scope for the pending poll) — this just fetches by id. */
  async findByIdForVendor(id, vendorId) {
    const { rows } = await query(
      `SELECT ${COLUMNS}, wrr.otp_hash FROM wallet_redemption_requests wrr
       WHERE wrr.id = $1 AND wrr.vendor_id = $2`,
      [id, vendorId]
    )
    return rows[0] ? this._format(rows[0], { includeHash: true }) : null
  }

  async findPendingForCustomer(customerUserId) {
    const { rows } = await query(
      `SELECT ${COLUMNS}, v.name AS vendor_name
       FROM wallet_redemption_requests wrr
       JOIN vendors v ON v.id = wrr.vendor_id
       WHERE wrr.customer_user_id = $1 AND wrr.status = 'PENDING'
       ORDER BY wrr.created_at DESC LIMIT 1`,
      [customerUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async incrementAttempt(id, newCount) {
    await query(
      `UPDATE wallet_redemption_requests SET attempt_count = $1, updated_at = NOW() WHERE id = $2`,
      [newCount, id]
    )
  }

  async markRejected(id) {
    await query(
      `UPDATE wallet_redemption_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  async markExpired(id) {
    await query(
      `UPDATE wallet_redemption_requests SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  /** Vendor-initiated abort — only while still genuinely pending. */
  async cancelPending(id, vendorId) {
    const { rows } = await query(
      `UPDATE wallet_redemption_requests SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 AND status = 'PENDING'
       RETURNING id`,
      [id, vendorId]
    )
    return rows.length > 0
  }

  /**
   * Atomic claim: the correct-code path's actual state transition. Race-safe
   * against a concurrent cancel/expire/double-confirm — zero rows back means
   * this request was already decided by the time this ran, not a raw error.
   * Runs inside the caller's transaction (client passed in), same pattern as
   * vendor-rider.service.js#acceptOffer.
   */
  async claimForConfirm(client, id, vendorId) {
    // AS wrr — same reason as create()'s comment above: a bare UPDATE has
    // no table alias in scope by default, and COLUMNS is wrr.-prefixed.
    const { rows } = await client.query(
      `UPDATE wallet_redemption_requests AS wrr SET status = 'CONFIRMED', confirmed_at = NOW(), updated_at = NOW()
       WHERE wrr.id = $1 AND wrr.vendor_id = $2 AND wrr.status = 'PENDING' AND wrr.expires_at > NOW()
       RETURNING ${COLUMNS}`,
      [id, vendorId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async attachWalletTransaction(client, id, walletTransactionId) {
    await client.query(
      `UPDATE wallet_redemption_requests SET wallet_transaction_id = $1, updated_at = NOW() WHERE id = $2`,
      [walletTransactionId, id]
    )
  }

  _format(row, { includeHash = false } = {}) {
    return {
      id: row.id,
      customerUserId: row.customer_user_id,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name ?? undefined,
      requestedByUserId: row.requested_by_user_id,
      amountPaise: row.amount_paise,
      attemptCount: row.attempt_count,
      status: row.status,
      walletTransactionId: row.wallet_transaction_id,
      expiresAt: row.expires_at,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(includeHash ? { otpHash: row.otp_hash } : {}),
    }
  }
}
