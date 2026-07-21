import { query } from '../../src/config/database.js'

/**
 * Bulk Orders repository — all SQL queries for bulk_orders.
 *
 * Conventions (project-standards.md):
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Mutations that need row-level locks (status updates that deduct or
 *     restore stock) accept a transaction client passed in by the service.
 *
 * Migration reference: src/database/migrations/037_bulk_orders.sql
 *
 * Supporting indexes:
 *   - idx_bulk_orders_shop_status            (vendor_id, status)
 *   - idx_bulk_orders_user_created_at        (user_id, created_at DESC)
 *   - idx_bulk_orders_delivery_date_status   (delivery_date, status)
 *   - bulk_orders_order_number_key           UNIQUE
 */
export class BulkOrdersRepository {
  // ────────────────────────────────────────────────────────
  // Column projections — keep these in sync with the schema
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, vendor_id, user_id, order_number, status,
    items, total_items,
    subtotal, discount_amount, delivery_fee, total_amount,
    delivery_date, delivery_slot, delivery_address,
    payment_method, payment_status,
    created_at, updated_at
  `

  // ────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────

  /**
   * Find a bulk order by id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT ${BulkOrdersRepository.SELECT_COLUMNS}
         FROM bulk_orders
        WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Check whether a generated order_number is already taken.
   * Cheap point lookup against the UNIQUE constraint.
   * @param {string} orderNumber
   * @returns {Promise<boolean>}
   */
  async existsOrderNumber(orderNumber) {
    const { rows } = await query(
      `SELECT 1 FROM bulk_orders WHERE order_number = $1 LIMIT 1`,
      [orderNumber]
    )
    return rows.length > 0
  }

  /**
   * Count how many bulk orders for a given YYYYMMDD prefix already exist.
   * Used to seed the per-day sequence in generateOrderNumber().
   * @param {string} pattern - e.g. 'BULK-20251024-%'
   * @returns {Promise<number>}
   */
  async countByOrderNumberPattern(pattern) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total
         FROM bulk_orders
        WHERE order_number LIKE $1`,
      [pattern]
    )
    return rows[0]?.total || 0
  }

  /**
   * List bulk orders with optional filters and pagination.
   * Filters supported (any combination):
   *   - userId:  scope to a customer            (idx user_created_at)
   *   - shopId:  scope to a shop                (idx shop_status)
   *   - status:  exact status match
   *
   * Always paginated (Req 9.9). Default 20, max 100 enforced by Zod.
   *
   * @param {object} filters
   * @param {string} [filters.userId]
   * @param {string} [filters.shopId]
   * @param {string} [filters.status]
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]
   * @returns {Promise<{items: Array<object>, total: number}>}
   */
  async findMany({ userId, shopId, status, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = []
    let idx = 1

    if (userId) {
      conditions.push(`user_id = $${idx++}`)
      params.push(userId)
    }
    if (shopId) {
      conditions.push(`vendor_id = $${idx++}`)
      params.push(shopId)
    }
    if (status) {
      conditions.push(`status = $${idx++}`)
      params.push(status)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${BulkOrdersRepository.SELECT_COLUMNS}
           FROM bulk_orders
          ${where}
          ORDER BY created_at DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM bulk_orders
          ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  // ────────────────────────────────────────────────────────
  // Writes
  // ────────────────────────────────────────────────────────

  /**
   * Insert a new bulk order in DRAFT status.
   * Accepts an optional transaction client; uses pool query() otherwise.
   *
   * @param {object} data - Validated fields (already shaped by service)
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async create(data, client) {
    const sql = `INSERT INTO bulk_orders (
        vendor_id, user_id, order_number, status,
        items, total_items,
        subtotal, discount_amount, delivery_fee, total_amount,
        delivery_date, delivery_slot, delivery_address,
        payment_method, payment_status
      ) VALUES (
        $1, $2, $3, $4,
        $5::jsonb, $6,
        $7, $8, $9, $10,
        $11, $12, $13::jsonb,
        $14, $15
      )
      RETURNING ${BulkOrdersRepository.SELECT_COLUMNS}`

    const params = [
      data.vendor_id,
      data.user_id,
      data.order_number,
      data.status || 'DRAFT',
      JSON.stringify(data.items),
      data.total_items,
      data.subtotal,
      data.discount_amount ?? 0,
      data.delivery_fee ?? 0,
      data.total_amount,
      data.delivery_date,
      data.delivery_slot ?? null,
      JSON.stringify(data.delivery_address),
      data.payment_method ?? null,
      data.payment_status ?? 'PENDING',
    ]

    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(sql, params)
    return rows[0]
  }

  /**
   * Update only the status (and updated_at) of a bulk order.
   * Accepts an optional transaction client; required when this update is
   * part of a stock-deduction or stock-restore flow.
   *
   * @param {string} id
   * @param {string} newStatus
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, newStatus, client) {
    const sql = `UPDATE bulk_orders
        SET status = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING ${BulkOrdersRepository.SELECT_COLUMNS}`
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(sql, [newStatus, id])
    return rows[0] || null
  }

  // ────────────────────────────────────────────────────────
  // Transactional helpers
  // ────────────────────────────────────────────────────────

  /**
   * Lock a bulk order row inside a transaction so the status transition and
   * related stock writes happen atomically (Req 9.5, 9.7, 15.9).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findByIdForUpdate(client, id) {
    const { rows } = await client.query(
      `SELECT ${BulkOrdersRepository.SELECT_COLUMNS}
         FROM bulk_orders
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    return rows[0] || null
  }

  // ────────────────────────────────────────────────────────
  // Cross-table helpers (vendor_services, user_shop_allocations,
  // vendor_staff) executed under the same transaction client where
  // applicable. Keeping them here keeps the service free of direct
  // SQL (Architecture rule: no DB queries in services).
  // ────────────────────────────────────────────────────────

  /**
   * Stock-validation helper for bulk-order submit (Req 9.3).
   * Read-only batch check against vendor_services for a given shop.
   * Returns one row per requested garment_rate_id that exists for this shop, with
   * the available stock_quantity, is_available flag, and max_order_qty.
   *
   * Uses unnest($2::uuid[]) to keep the query fully parameterized while
   * fetching all items in a single round-trip (avoids N+1).
   *
   * @param {import('pg').PoolClient|null} client
   * @param {string} shopId
   * @param {string[]} productIds - distinct list
   * @returns {Promise<Array<{
   *   garment_rate_id: string,
   *   stock_quantity: number,
   *   is_available: boolean,
   *   max_order_qty: number
   * }>>}
   */
  async findShopProductsForValidation(client, shopId, productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return []
    const sql = `
      SELECT sp.garment_rate_id,
             sp.stock_quantity,
             sp.is_available,
             sp.max_order_qty
        FROM vendor_services sp
        JOIN unnest($2::uuid[]) AS t(garment_rate_id)
          ON t.garment_rate_id = sp.garment_rate_id
       WHERE sp.vendor_id = $1
         AND sp.deleted_at IS NULL
    `
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(sql, [shopId, productIds])
    return rows
  }

  /**
   * Lock a shop_product row by (vendor_id, garment_rate_id) for the duration of the
   * caller's transaction. Required for stock deduction on confirm (Req 9.5)
   * and restoration on cancel-after-confirm (Req 9.7).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} shopId
   * @param {string} productId
   * @returns {Promise<{ id: string, stock_quantity: number, is_available: boolean }|null>}
   */
  async lockShopProduct(client, shopId, productId) {
    const { rows } = await client.query(
      `SELECT id, stock_quantity, is_available
         FROM vendor_services
        WHERE vendor_id = $1 AND garment_rate_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [shopId, productId]
    )
    return rows[0] || null
  }

  /**
   * Apply a stock delta to a locked shop_product row. The caller must have
   * locked the row via `lockShopProduct` first and verified the resulting
   * value is non-negative — the DB CHECK constraint is the final defence.
   *
   * Mirrors shop-garment_rates.repository.applyStockUpdate's stock-out
   * side-effects (is_available, sold_out_at) so confirm/cancel transitions
   * keep the product flag consistent with stock (Req 11.1, 11.6).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} shopProductId
   * @param {number} newStockQuantity
   * @returns {Promise<{ id: string, stock_quantity: number, is_available: boolean }|null>}
   */
  async applyShopProductStock(client, shopProductId, newStockQuantity) {
    const { rows } = await client.query(
      `UPDATE vendor_services
          SET stock_quantity = $1,
              is_available = CASE
                WHEN $1 = 0 THEN false
                WHEN stock_quantity = 0 AND $1 > 0 THEN true
                ELSE is_available
              END,
              sold_out_at = CASE
                WHEN $1 = 0 THEN NOW()
                WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                ELSE sold_out_at
              END,
              updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
        RETURNING id, stock_quantity, is_available`,
      [newStockQuantity, shopProductId]
    )
    return rows[0] || null
  }

  /**
   * Verify the caller's user is allocated to the target shop. Used to gate
   * customer-facing creates — `vendor_id` must be in the user's allocations
   * (mirrors the cart-add rule in Req 5.2 applied to bulk orders).
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

  /**
   * Resolve the caller's shop staff role for a given shop (or null if not
   * assigned / inactive). Used by the service to gate state-machine
   * advances by Shop Managers and above.
   *
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<{role: string}|null>}
   */
  async findStaffRole(userId, shopId) {
    const { rows } = await query(
      `SELECT ss.role
         FROM vendor_staff ss
         JOIN vendors s ON s.id = ss.vendor_id
        WHERE ss.user_id = $1
          AND ss.vendor_id = $2
          AND ss.is_active = true
          AND ss.deleted_at IS NULL
          AND s.is_active = true
          AND s.deleted_at IS NULL
        LIMIT 1`,
      [userId, shopId]
    )
    return rows[0] || null
  }
}
