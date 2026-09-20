import { query } from '../../config/database.js'

const COLUMNS = `
  wrr.id, wrr.customer_user_id, wrr.vendor_id, wrr.requested_by_user_id,
  wrr.amount_paise, wrr.attempt_count, wrr.status, wrr.wallet_transaction_id,
  wrr.expires_at, wrr.confirmed_at, wrr.created_at, wrr.updated_at,
  wrr.hold_expires_at, wrr.captured_paise, wrr.refunded_at
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
    // A reservation nobody booked a sale against simply lapses — no money ever left the wallet.
    await query(
      `UPDATE wallet_redemption_requests SET status = 'EXPIRED', updated_at = NOW()
       WHERE customer_user_id = $1 AND status = 'AUTHORIZED' AND hold_expires_at <= NOW()`,
      [customerUserId]
    )
  }

  /**
   * What the customer can actually spend right now: the wallet balance minus every live reservation
   * (an approved redemption whose sale has not been booked yet). Lapsed reservations stop counting on
   * their own — they are compared with NOW(), no clean-up job is needed for that. In paise.
   */
  async availablePaise(customerUserId, client = null, { excludeRequestId = null } = {}) {
    const run = client ? client.query.bind(client) : query
    const { rows } = await run(
      `SELECT ROUND(COALESCE(w.balance, 0) * 100)::bigint AS balance_paise,
              COALESCE((SELECT SUM(r.amount_paise) FROM wallet_redemption_requests r
                        WHERE r.customer_user_id = $1 AND r.status = 'AUTHORIZED' AND r.hold_expires_at > NOW()
                          AND ($2::uuid IS NULL OR r.id <> $2::uuid)), 0)::bigint AS held_paise
       FROM (SELECT $1::uuid AS user_id) u LEFT JOIN wallets w ON w.user_id = u.user_id`,
      [customerUserId, excludeRequestId]
    )
    const balancePaise = Number(rows[0].balance_paise)
    const heldPaise = Number(rows[0].held_paise)
    return { balancePaise, heldPaise, availablePaise: balancePaise - heldPaise }
  }

  /**
   * Turns an approved reservation into a real sale payment. Runs inside the caller's transaction (the one that
   * creates the order), so the request, the order and the wallet debit all commit together or not at all.
   * Zero rows back = the reservation is gone (expired, cancelled, already used) — nothing to capture.
   */
  async capture(client, { id, vendorId, customerUserId, capturedPaise }) {
    const { rows } = await client.query(
      `UPDATE wallet_redemption_requests AS wrr SET status = 'CONFIRMED', captured_paise = $4, updated_at = NOW()
       WHERE wrr.id = $1 AND wrr.vendor_id = $2 AND wrr.customer_user_id = $3 AND wrr.status = 'AUTHORIZED' AND wrr.hold_expires_at > NOW()
       RETURNING ${COLUMNS}`,
      [id, vendorId, customerUserId, capturedPaise]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Redemptions from BEFORE the reservation model: the wallet was debited at approval, but no sale ever used them.
   * (New-model rows are debited only inside the order's own transaction, so they cannot end up here.)
   */
  async listStranded(minutes, limit = 50) {
    const { rows } = await query(
      `SELECT ${COLUMNS}, u.phone AS customer_phone
       FROM wallet_redemption_requests wrr JOIN users u ON u.id = wrr.customer_user_id
       WHERE wrr.status = 'CONFIRMED' AND wrr.wallet_transaction_id IS NOT NULL
         AND wrr.confirmed_at < NOW() - make_interval(mins => $1)
         AND NOT EXISTS (SELECT 1 FROM store_orders so WHERE so.wallet_redemption_request_id = wrr.id)
       ORDER BY wrr.confirmed_at LIMIT $2`,
      [minutes, limit]
    )
    return rows.map((row) => ({ ...this._format(row), customerPhone: row.customer_phone }))
  }

  /** Claims one stranded redemption for refund (once). Runs inside the refunding transaction. */
  async claimRefund(client, id) {
    const { rows } = await client.query(
      `UPDATE wallet_redemption_requests AS wrr SET status = 'REFUNDED', refunded_at = NOW(), updated_at = NOW()
       WHERE wrr.id = $1 AND wrr.status = 'CONFIRMED' AND wrr.wallet_transaction_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM store_orders so WHERE so.wallet_redemption_request_id = wrr.id)
       RETURNING ${COLUMNS}`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * A new request from a vendor replaces that SAME vendor's still-pending one for this customer (a fresh
   * code is issued) instead of failing with "already in progress" — e.g. after the operator reloaded the
   * screen or the vendor's type was switched back and forth. Another vendor's pending request is left alone.
   */
  async cancelPendingForVendor(vendorId, customerUserId) {
    const { rows } = await query(
      `UPDATE wallet_redemption_requests SET status = 'CANCELLED', updated_at = NOW()
       WHERE vendor_id = $1 AND customer_user_id = $2 AND status IN ('PENDING', 'AUTHORIZED')
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

  /** Vendor-initiated abort — while still pending, or while approved but not yet booked (releases the reservation; nothing was debited). */
  async cancelPending(id, vendorId) {
    const { rows } = await query(
      `UPDATE wallet_redemption_requests SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 AND status IN ('PENDING', 'AUTHORIZED')
       RETURNING id`,
      [id, vendorId]
    )
    return rows.length > 0
  }

  /**
   * Atomic claim: the correct-code path's actual state transition — the code was right, so the amount is RESERVED
   * (AUTHORIZED); the wallet is NOT debited here. Race-safe
   * against a concurrent cancel/expire/double-confirm — zero rows back means
   * this request was already decided by the time this ran, not a raw error.
   * Runs inside the caller's transaction (client passed in), same pattern as
   * vendor-rider.service.js#acceptOffer.
   */
  async claimForConfirm(client, id, vendorId, holdExpiresAt) {
    // AS wrr — same reason as create()'s comment above: a bare UPDATE has
    // no table alias in scope by default, and COLUMNS is wrr.-prefixed.
    const { rows } = await client.query(
      `UPDATE wallet_redemption_requests AS wrr SET status = 'AUTHORIZED', confirmed_at = NOW(), hold_expires_at = $3, updated_at = NOW()
       WHERE wrr.id = $1 AND wrr.vendor_id = $2 AND wrr.status = 'PENDING' AND wrr.expires_at > NOW()
       RETURNING ${COLUMNS}`,
      [id, vendorId, holdExpiresAt]
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
      holdExpiresAt: row.hold_expires_at ?? null,
      capturedPaise: row.captured_paise ?? null,
      refundedAt: row.refunded_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(includeHash ? { otpHash: row.otp_hash } : {}),
    }
  }
}
