import { query } from '../../src/config/database.js'

/**
 * Scheduled Orders repository — all SQL for scheduled_orders.
 *
 * Conventions (project-standards.md):
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Mutations that need a transaction client take one as the last arg.
 *
 * Migration reference: src/database/migrations/036_scheduled_orders.sql
 *
 * Supporting indexes:
 *   - idx_scheduled_orders_user_status   (user_id, status)
 *   - idx_scheduled_orders_due           (scheduled_for, status) WHERE status='SCHEDULED'
 *   - idx_scheduled_orders_shop_id       (vendor_id)
 */
export class ScheduledOrdersRepository {
  // ────────────────────────────────────────────────────────
  // Column projection — kept in one place so list/get queries stay aligned
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, user_id, vendor_id,
    items, subtotal,
    delivery_address, payment_method,
    scheduled_for, repeat_type, repeat_until,
    status, placed_order_id, failure_reason,
    created_at, updated_at
  `

  // ────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────

  /**
   * Find a scheduled order by id, scoped to a user.
   * The user scope here is intentional — customers may only fetch their own
   * rows (Req 10.6 implies ownership; the controller never bypasses).
   *
   * @param {string} id
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async findByIdForUser(id, userId) {
    const { rows } = await query(
      `SELECT ${ScheduledOrdersRepository.SELECT_COLUMNS}
         FROM scheduled_orders
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )
    return rows[0] || null
  }

  /**
   * Find a scheduled order by id (no scope). Used by the BullMQ worker and
   * internal services; customer-facing reads must use findByIdForUser.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT ${ScheduledOrdersRepository.SELECT_COLUMNS}
         FROM scheduled_orders
        WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Lock a scheduled_orders row for update inside a transaction.
   * Used by the scheduled-orders BullMQ worker (task 10.3) so that:
   *   - concurrent worker retries cannot double-fire the same row
   *     (Requirement 10.5 — only SCHEDULED can transition)
   *   - a customer cancel from another connection waits for the worker's
   *     transaction to release before the row is re-read
   *
   * @param {import('pg').PoolClient} client - Open transaction client
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findByIdForUpdate(client, id) {
    const { rows } = await client.query(
      `SELECT ${ScheduledOrdersRepository.SELECT_COLUMNS}
         FROM scheduled_orders
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Link a placed order id to a scheduled_orders row inside an open
   * transaction. Used by the worker (task 10.3) immediately after the
   * real per-shop order has been INSERTed by the OrderSplitter
   * (Req 10.2).
   *
   * The status is NOT changed here — the caller follows up with
   * updateStatus(..., 'PLACED', ..., client) inside the same transaction.
   * Splitting the two writes keeps the SQL grammar trivially auditable
   * and lets the caller sequence things ergonomically.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} placedOrderId
   * @returns {Promise<object|null>}
   */
  async linkPlacedOrder(client, id, placedOrderId) {
    const { rows } = await client.query(
      `UPDATE scheduled_orders
          SET placed_order_id = $1,
              updated_at = NOW()
        WHERE id = $2
        RETURNING ${ScheduledOrdersRepository.SELECT_COLUMNS}`,
      [placedOrderId, id]
    )
    return rows[0] || null
  }

  /**
   * List scheduled orders for a user with pagination and an optional status
   * filter. Always paginated (Req 14.5/14.7). Limits enforced by Zod.
   *
   * @param {object} filters
   * @param {string} filters.userId
   * @param {string} [filters.status]
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]
   * @returns {Promise<{items: Array<object>, total: number}>}
   */
  async findManyByUser({ userId, status, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const conditions = ['user_id = $1']
    const params = [userId]
    let idx = 2

    if (status) {
      conditions.push(`status = $${idx++}`)
      params.push(status)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${ScheduledOrdersRepository.SELECT_COLUMNS}
           FROM scheduled_orders
          WHERE ${where}
          ORDER BY scheduled_for ASC, created_at DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM scheduled_orders
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Count active (status='SCHEDULED') rows for a user.
   * Backs the per-customer cap of 20 (Req 10.9). Hits the partial index
   * idx_scheduled_orders_user_status for a cheap lookup.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async countActiveForUser(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total
         FROM scheduled_orders
        WHERE user_id = $1 AND status = 'SCHEDULED'`,
      [userId]
    )
    return rows[0]?.total || 0
  }

  // ────────────────────────────────────────────────────────
  // Writes
  // ────────────────────────────────────────────────────────

  /**
   * Insert a new scheduled order in SCHEDULED status.
   *
   * @param {object} data - Validated fields (already shaped by service)
   * @param {string} data.user_id
   * @param {string} data.vendor_id
   * @param {Array} data.items
   * @param {number} data.subtotal
   * @param {object} data.delivery_address
   * @param {string} data.payment_method
   * @param {string|Date} data.scheduled_for
   * @param {string} data.repeat_type
   * @param {string|Date|null} [data.repeat_until]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async create(data, client) {
    const sql = `
      INSERT INTO scheduled_orders (
        user_id, vendor_id,
        items, subtotal,
        delivery_address, payment_method,
        scheduled_for, repeat_type, repeat_until,
        status
      ) VALUES (
        $1, $2,
        $3::jsonb, $4,
        $5::jsonb, $6,
        $7, $8, $9,
        'SCHEDULED'
      )
      RETURNING ${ScheduledOrdersRepository.SELECT_COLUMNS}
    `
    const params = [
      data.user_id,
      data.vendor_id,
      JSON.stringify(data.items),
      data.subtotal,
      JSON.stringify(data.delivery_address),
      data.payment_method ?? 'COD',
      data.scheduled_for,
      data.repeat_type ?? 'ONCE',
      data.repeat_until ?? null,
    ]
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(sql, params)
    return rows[0]
  }

  /**
   * Update only the status (and updated_at) of a scheduled order.
   * Optional `placed_order_id` and `failure_reason` allow the worker to set
   * lifecycle-related fields in the same statement.
   *
   * @param {string} id
   * @param {string} newStatus
   * @param {object} [extra]
   * @param {string|null} [extra.placed_order_id]
   * @param {string|null} [extra.failure_reason]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, newStatus, extra = {}, client) {
    const sql = `
      UPDATE scheduled_orders
         SET status = $1,
             placed_order_id = COALESCE($2, placed_order_id),
             failure_reason  = COALESCE($3, failure_reason),
             updated_at = NOW()
       WHERE id = $4
       RETURNING ${ScheduledOrdersRepository.SELECT_COLUMNS}
    `
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(sql, [
      newStatus,
      extra.placed_order_id ?? null,
      extra.failure_reason ?? null,
      id,
    ])
    return rows[0] || null
  }

  /**
   * Guarded status transition — UPDATE that only fires when the row is
   * still in `expectedStatus`. Returns the updated row, or `null` when no
   * row matched (i.e. another worker / cancel got there first).
   *
   * Used by the worker (task 10.3) to claim a SCHEDULED row exclusively
   * before doing any side effects (Requirement 10.5). Combine with
   * `findByIdForUpdate` for a SELECT…FOR UPDATE → guarded UPDATE pattern
   * inside the same transaction.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} expectedStatus
   * @param {string} newStatus
   * @param {object} [extra]
   * @param {string|null} [extra.placed_order_id]
   * @param {string|null} [extra.failure_reason]
   * @returns {Promise<object|null>}
   */
  async updateStatusIfCurrent(
    client,
    id,
    expectedStatus,
    newStatus,
    extra = {}
  ) {
    const { rows } = await client.query(
      `UPDATE scheduled_orders
          SET status = $1,
              placed_order_id = COALESCE($2, placed_order_id),
              failure_reason  = COALESCE($3, failure_reason),
              updated_at = NOW()
        WHERE id = $4
          AND status = $5
        RETURNING ${ScheduledOrdersRepository.SELECT_COLUMNS}`,
      [
        newStatus,
        extra.placed_order_id ?? null,
        extra.failure_reason ?? null,
        id,
        expectedStatus,
      ]
    )
    return rows[0] || null
  }

  /**
   * Insert a successor scheduled_orders row for a recurring schedule
   * (Requirement 10.3) inside an open transaction. The successor inherits
   * everything except scheduled_for and starts in SCHEDULED status.
   *
   * Returns the inserted row so the worker can enqueue a delayed job.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} parent - The just-PLACED parent row
   * @param {Date|string} nextScheduledFor
   * @returns {Promise<object>}
   */
  async createSuccessor(client, parent, nextScheduledFor) {
    const { rows } = await client.query(
      `INSERT INTO scheduled_orders (
         user_id, vendor_id,
         items, subtotal,
         delivery_address, payment_method,
         scheduled_for, repeat_type, repeat_until,
         status
       ) VALUES (
         $1, $2,
         $3::jsonb, $4,
         $5::jsonb, $6,
         $7, $8, $9,
         'SCHEDULED'
       )
       RETURNING ${ScheduledOrdersRepository.SELECT_COLUMNS}`,
      [
        parent.user_id,
        parent.vendor_id,
        typeof parent.items === 'string'
          ? parent.items
          : JSON.stringify(parent.items),
        parent.subtotal,
        typeof parent.delivery_address === 'string'
          ? parent.delivery_address
          : JSON.stringify(parent.delivery_address),
        parent.payment_method,
        nextScheduledFor,
        parent.repeat_type,
        parent.repeat_until ?? null,
      ]
    )
    return rows[0]
  }

  // ────────────────────────────────────────────────────────
  // Cross-table helpers (read-only)
  // ────────────────────────────────────────────────────────

  /**
   * Verify the caller's user is allocated to the target shop. Used to gate
   * customer-facing creates — `vendor_id` must be in the user's allocations
   * (Req 10.8, mirroring the cart-add rule in Req 5.2).
   *
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<boolean>}
   */
  async isUserAllocatedToShop(userId, shopId) {
    const { rows } = await query(
      `SELECT 1
         FROM user_shop_allocations a
         JOIN vendors s ON s.id = a.vendor_id
        WHERE a.user_id = $1
          AND a.vendor_id = $2
          AND s.is_active = true
          AND s.deleted_at IS NULL
        LIMIT 1`,
      [userId, shopId]
    )
    return rows.length > 0
  }
}
