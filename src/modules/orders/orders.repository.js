import { query, getClient } from '../../config/database.js'

// Explicit column list (R14.7 — no SELECT *) shared by every plain orders
// read below. Deliberately excludes columns `_format()` doesn't expose
// today (pickup_otp, delivery_otp, weight/count-adjustment audit fields,
// processing_stage, estimated/payable_amount_paise, delivery_partner_id,
// payment_expires_at) so external behavior is unchanged — except
// `auto_assignment_status`, newly added here (and to `_format()`) so the HQ
// "manual rider required" UI can read it without a second fetch.
const ORDER_COLUMNS = `id, order_number, user_id, rider_id, vendor_id, status, items,
  subtotal, discount_amount, delivery_fee, platform_fee, tax_amount, total_amount,
  payment_method, payment_status, coupon_code, delivery_address, delivery_notes,
  estimated_delivery, delivered_at, proof_photo_url, cancelled_reason, handling_fee,
  late_night_fee, tip_amount, delivery_instructions, savings_total, delivery_mode,
  scheduled_delivery_at, scheduled_slot_start, scheduled_slot_end, scheduled_slot_label,
  vendor_slot_id, pickup_date, fee_breakdown, auto_assignment_status, created_at, updated_at`

// Same projection, `o.`-qualified for the queries that LEFT JOIN users (ru).
const ORDER_COLUMNS_O = ORDER_COLUMNS
  .split(',')
  .map((c) => `o.${c.trim()}`)
  .join(', ')

/**
 * Orders repository — all SQL queries for orders + order_items
 */
export class OrdersRepository {
  /**
   * Create an order with order items inside a transaction
   *
   * In the multi-vendor world every checkout produces one order per shop,
   * so `shopId` is expected on `orderData`. Legacy callers (e.g. tests, demo
   * scripts) that pre-date Migration 033 may omit it; the column is nullable
   * to preserve backward compatibility during the transition.
   */
  async create(client, orderData, items) {
    const { rows } = await client.query(
      `INSERT INTO orders (
        order_number, user_id, vendor_id, status, items, subtotal, discount_amount,
        delivery_fee, platform_fee, tax_amount, total_amount,
        payment_method, payment_status, coupon_code, delivery_address,
        delivery_notes, estimated_delivery,
        handling_fee, late_night_fee, tip_amount, delivery_instructions, savings_total,
        delivery_mode, scheduled_delivery_at, scheduled_slot_start, scheduled_slot_end, scheduled_slot_label,
        fee_breakdown,
        vendor_slot_id, pickup_date
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
      RETURNING id, order_number, user_id, vendor_id, rider_id, status, items,
                subtotal, discount_amount, delivery_fee, platform_fee, tax_amount, total_amount,
                payment_method, payment_status, coupon_code, delivery_address, delivery_notes,
                estimated_delivery, delivered_at, proof_photo_url, cancelled_reason,
                handling_fee, late_night_fee, tip_amount, delivery_instructions, savings_total,
                delivery_mode, scheduled_delivery_at, scheduled_slot_start, scheduled_slot_end, scheduled_slot_label,
                fee_breakdown,
                vendor_slot_id, pickup_date,
                created_at, updated_at`,
      [
        orderData.orderNumber,
        orderData.userId,
        orderData.shopId || null,
        orderData.status || 'PENDING',
        JSON.stringify(orderData.items),
        orderData.subtotal,
        orderData.discountAmount || 0,
        orderData.deliveryFee || 0,
        orderData.platformFee || 0,
        orderData.taxAmount || 0,
        orderData.totalAmount,
        orderData.paymentMethod,
        orderData.paymentStatus || 'PENDING',
        orderData.couponCode || null,
        JSON.stringify(orderData.deliveryAddress),
        orderData.deliveryNotes || null,
        orderData.estimatedDelivery || null,
        orderData.handlingFee || 0,
        orderData.lateNightFee || 0,
        orderData.tipAmount || 0,
        orderData.deliveryInstructions || null,
        orderData.savingsTotal || 0,
        orderData.deliveryMode || 'ASAP',
        orderData.scheduledDeliveryAt || null,
        orderData.scheduledSlotStart || null,
        orderData.scheduledSlotEnd || null,
        orderData.scheduledSlotLabel || null,
        JSON.stringify(orderData.feeBreakdown || {}),
        orderData.vendorSlotId || null,
        orderData.pickupDate || null,
      ]
    )

    // Insert denormalized order items
    // Phase 3: also persist shop_product_id and vendor_id so order items
    // can be audited back to the exact per-shop SKU that fulfilled the
    // line. Both columns are NULLABLE on order_items (migration 049),
    // so legacy callers that don't pass shop_product_id continue to
    // work; new orders created via OrderSplitter populate both.
    for (const item of items) {
      await client.query(
        `INSERT INTO order_lines
           (order_id, garment_type_id, name, price, quantity, unit, total,
            shop_product_id, vendor_id, estimated_quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          rows[0].id,
          item.productId,
          item.name,
          item.price,
          item.quantity,
          item.unit,
          item.total,
          item.shopProductId || null,
          item.shopId || rows[0].vendor_id || null,
          item.quantity,
        ]
      )
    }

    return this._format(rows[0])
  }

  /**
   * Update mutable post-checkout extras (tip / handling / late-night /
   * savings / delivery instructions). Used by the multi-vendor checkout
   * flow when a single-shop cart's tip arrives after the per-shop order is
   * already inserted by the OrderSplitter.
   *
   * Only single-shop carts have a well-defined "owner" for tip and similar
   * extras, so this is intentionally a narrow update.
   */
  async updateExtras(orderId, extras = {}) {
    const sets = []
    const params = []
    let idx = 1

    if (Object.prototype.hasOwnProperty.call(extras, 'tipAmount')) {
      sets.push(`tip_amount = $${idx++}`)
      params.push(Number(extras.tipAmount) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'handlingFee')) {
      sets.push(`handling_fee = $${idx++}`)
      params.push(Number(extras.handlingFee) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'lateNightFee')) {
      sets.push(`late_night_fee = $${idx++}`)
      params.push(Number(extras.lateNightFee) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'savingsTotal')) {
      sets.push(`savings_total = $${idx++}`)
      params.push(Number(extras.savingsTotal) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'deliveryInstructions')) {
      sets.push(`delivery_instructions = $${idx++}`)
      params.push(extras.deliveryInstructions || null)
    }

    if (sets.length === 0) return null

    sets.push('updated_at = NOW()')
    params.push(orderId)

    const { rows } = await query(
      `UPDATE orders SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING id, order_number, user_id, vendor_id, status,
                 handling_fee, late_night_fee, tip_amount,
                 delivery_instructions, savings_total, updated_at`,
      params
    )
    return rows[0] || null
  }

  /**
   * Decrement stock for garment_rates in an order (within transaction)
   */
  async decrementStock(client, items) {
    for (const item of items) {
      const { rowCount } = await client.query(
        `UPDATE garment_rates SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1,
                updated_at = NOW()
         WHERE id = $2 AND stock_quantity >= $1`,
        [item.quantity, item.productId]
      )
      if (rowCount === 0) {
        throw new Error(`Insufficient stock for product "${item.name}"`)
      }
    }
  }

  /**
   * Restore stock when an order is cancelled (within transaction).
   *
   * IMPORTANT: Stock is tracked on `vendor_services`, NOT the master `garment_rates`
   * table. This method restores `vendor_services.stock_quantity` for each order
   * item, using `shop_product_id` when available (Phase 3 orders) and falling
   * back to `(garment_rate_id, vendor_id)` lookup for legacy orders.
   *
   * Also clears `sold_out_at` and re-enables `is_available` when restoring
   * from zero (mirrors the `applyStockUpdate` CASE logic).
   */
  async restoreStock(client, items) {
    for (const item of items) {
      const qty = Number(item.quantity)
      if (!qty || qty <= 0) continue

      if (item.shopProductId || item.shop_product_id) {
        // Phase 3 path: exact shop_product_id available
        const shopProductId = item.shopProductId || item.shop_product_id
        await client.query(
          `UPDATE vendor_services
           SET stock_quantity = stock_quantity + $1,
               is_available = CASE
                 WHEN stock_quantity = 0 AND $1 > 0 THEN true
                 ELSE is_available
               END,
               sold_out_at = CASE
                 WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                 ELSE sold_out_at
               END,
               updated_at = NOW()
           WHERE id = $2 AND deleted_at IS NULL`,
          [qty, shopProductId]
        )
      } else {
        // Legacy path: resolve via (garment_rate_id, vendor_id)
        const productId = item.productId || item.garment_rate_id
        const shopId = item.shopId || item.vendor_id
        if (productId && shopId) {
          await client.query(
            `UPDATE vendor_services
             SET stock_quantity = stock_quantity + $1,
                 is_available = CASE
                   WHEN stock_quantity = 0 AND $1 > 0 THEN true
                   ELSE is_available
                 END,
                 sold_out_at = CASE
                   WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                   ELSE sold_out_at
                 END,
                 updated_at = NOW()
             WHERE garment_rate_id = $2 AND vendor_id = $3 AND deleted_at IS NULL`,
            [qty, productId, shopId]
          )
        }
      }
    }
  }

  /**
   * Find order by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find order by ID and user
   */
  async findByIdAndUser(id, userId) {
    const { rows } = await query(
      `SELECT ${ORDER_COLUMNS_O}, ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.id = $1 AND o.user_id = $2`,
      [id, userId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find active order for user (latest non-completed)
   */
  async findActiveByUser(userId) {
    const { rows } = await query(
      `SELECT ${ORDER_COLUMNS_O}, ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.user_id = $1
         AND o.status IN ('PENDING','CONFIRMED','PREPARING','PACKED','OUT_FOR_DELIVERY')
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [userId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async getStatusHistory(orderId) {
    const { rows } = await query(
      `SELECT id, from_status, to_status, note, changed_at, changed_by
       FROM order_status_history
       WHERE order_id = $1
       ORDER BY changed_at ASC`,
      [orderId]
    )
    return rows
  }

  /**
   * Aggregate DELIVERED orders for a shop within a half-open UTC window
   * `[periodStart, periodEnd)`. Powers the Settlement_Worker daily roll-up
   * (Req 6.2, 6.3, 6.4).
   *
   * SELECT projection (Req 14.7 — explicit columns, no SELECT *):
   *   - total_orders   = COUNT(*)
   *   - gross_revenue  = SUM(total_amount)
   *                      Uses total_amount (customer-paid value) so the
   *                      aggregator surfaces a single number that
   *                      reconciles against payments. The settlement
   *                      service may additionally use SUM(subtotal) via
   *                      the write repository when it needs the
   *                      merchandise-only figure for commission
   *                      computation.
   *   - delivery_costs = SUM(delivery_fee)
   *   - refund_amount  = SUM(payments.refund_amount) over LEFT JOIN
   *                      (refunds live on the payments table, not orders).
   *
   * Index: `idx_orders_shop_id_status_created (vendor_id, status,
   * created_at DESC)` narrows the candidate set on (vendor_id,
   * status='DELIVERED'); the delivered_at window is filtered after the
   * index lookup.
   *
   * @param {string} shopId
   * @param {Date|string} periodStart - Inclusive (UTC)
   * @param {Date|string} periodEnd   - Exclusive (UTC)
   * @returns {Promise<{
   *   totalOrders:number,
   *   grossRevenue:number,
   *   deliveryCosts:number,
   *   refundAmount:number
   * }>}
   */
  async aggregateDeliveredForShop(shopId, periodStart, periodEnd) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int                                    AS total_orders,
         COALESCE(SUM(o.total_amount), 0)::numeric(12,2)  AS gross_revenue,
         COALESCE(SUM(o.delivery_fee), 0)::numeric(10,2)  AS delivery_costs,
         COALESCE(SUM(p.refund_amount), 0)::numeric(10,2) AS refund_amount
       FROM orders o
       LEFT JOIN payments p
              ON p.order_id = o.id
             AND p.refund_amount IS NOT NULL
       WHERE o.vendor_id = $1
         AND o.status = 'DELIVERED'
         AND o.delivered_at >= $2
         AND o.delivered_at < $3`,
      [shopId, periodStart, periodEnd]
    )
    const r = rows[0] || {}
    return {
      totalOrders: Number(r.total_orders) || 0,
      grossRevenue: Number(r.gross_revenue) || 0,
      deliveryCosts: Number(r.delivery_costs) || 0,
      refundAmount: Number(r.refund_amount) || 0,
    }
  }

  /**
   * List orders for a user (paginated)
   */
  async findByUser(userId, { limit, offset, status }) {
    const conditions = ['user_id = $1']
    const params = [userId]
    let idx = 2

    if (status) {
      conditions.push(`status = $${idx++}`)
      params.push(status)
    }

    const where = conditions.join(' AND ')

    const countResult = await query(
      `SELECT COUNT(*) FROM orders WHERE ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      orders: rows.map(this._format),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Admin: list all orders (paginated, filterable)
   */
  async findAll({ limit, offset, status, userId }) {
    const conditions = []
    const params = []
    let idx = 1

    if (status) {
      conditions.push(`status = $${idx++}`)
      params.push(status)
    }

    if (userId) {
      conditions.push(`user_id = $${idx++}`)
      params.push(userId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(*) FROM orders ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT ${ORDER_COLUMNS} FROM orders ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      orders: rows.map(this._format),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Update order status
   */
  async updateStatus(id, status, extra = {}) {
    const sets = ['status = $1', 'updated_at = NOW()']
    const params = [status]
    let idx = 2

    if (extra.cancelledReason) {
      sets.push(`cancelled_reason = $${idx++}`)
      params.push(extra.cancelledReason)
    }
    if (extra.deliveredAt) {
      sets.push(`delivered_at = $${idx++}`)
      params.push(extra.deliveredAt)
    }
    if (extra.paymentStatus) {
      sets.push(`payment_status = $${idx++}`)
      params.push(extra.paymentStatus)
    }

    params.push(id)

    const { rows } = await query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING ${ORDER_COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Assign a rider to an order
   */
  async assignRider(id, riderId) {
    const { rows } = await query(
      `UPDATE orders SET rider_id = $1, updated_at = NOW()
       WHERE id = $2 RETURNING ${ORDER_COLUMNS}`,
      [riderId, id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Generate order number: GRO-YYYYMMDD-XXX
   */
  async generateOrderNumber(client = null) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const pattern = `GRO-${today}-%`

    // When a transaction client is supplied, run the COUNT on it so orders
    // already inserted earlier in the same transaction (multi-shop checkout
    // creates one order per shop) are visible and the sequence increments
    // correctly instead of colliding on the same number.
    const runner = client && typeof client.query === 'function' ? client : null
    const { rows } = runner
      ? await runner.query(`SELECT COUNT(*) FROM orders WHERE order_number LIKE $1`, [pattern])
      : await query(`SELECT COUNT(*) FROM orders WHERE order_number LIKE $1`, [pattern])

    const seq = parseInt(rows[0].count, 10) + 1
    return `GRO-${today}-${String(seq).padStart(3, '0')}`
  }

  /**
   * Get order items from order_items table
   * Phase 3: surfaces shop_product_id and vendor_id for audit/UI parity
   * with the JSONB items column.
   */
  async getOrderItems(orderId) {
    const { rows } = await query(
      `SELECT garment_type_id AS garment_rate_id, name, price, quantity, unit, total,
              shop_product_id, vendor_id
       FROM order_lines
       WHERE order_id = $1`,
      [orderId]
    )
    return rows
  }

  /**
   * Batch-fetch product thumbnails for a set of product IDs.
   *
   * Order items are denormalized snapshots that don't store an image, so the
   * customer order screens enrich them at read time. This is a single
   * `id = ANY($1)` query (no N+1) returning a `productId -> thumbnailUrl` map.
   * Named-column projection per R14.7 (no SELECT *).
   *
   * @param {string[]} productIds
   * @returns {Promise<Map<string, string|null>>}
   */
  async findThumbnailsByProductIds(productIds) {
    const ids = Array.from(
      new Set((productIds || []).filter((id) => typeof id === 'string' && id))
    )
    if (ids.length === 0) {
      return new Map()
    }

    const { rows } = await query(
      `SELECT id, (images->>0) AS thumbnail_url
         FROM garment_types
        WHERE id = ANY($1::uuid[])`,
      [ids]
    )

    const map = new Map()
    for (const row of rows) {
      map.set(row.id, row.thumbnail_url || null)
    }
    return map
  }

  /**
   * Format snake_case row to camelCase
   */
  _format(row) {
    return {
      id: row.id,
      orderNumber: row.order_number,
      userId: row.user_id,
      shopId: row.vendor_id || null,
      riderId: row.rider_id,
      riderName: row.rider_name || null,
      riderPhone: row.rider_phone || null,
      status: row.status,
      items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
      subtotal: parseFloat(row.subtotal),
      discountAmount: parseFloat(row.discount_amount),
      deliveryFee: parseFloat(row.delivery_fee),
      platformFee: parseFloat(row.platform_fee),
      taxAmount: parseFloat(row.tax_amount),
      totalAmount: parseFloat(row.total_amount),
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      couponCode: row.coupon_code,
      deliveryAddress: typeof row.delivery_address === 'string'
        ? JSON.parse(row.delivery_address)
        : row.delivery_address,
      deliveryNotes: row.delivery_notes,
      estimatedDelivery: row.estimated_delivery,
      deliveredAt: row.delivered_at,
      proofPhotoUrl: row.proof_photo_url,
      cancelledReason: row.cancelled_reason,
      handlingFee: parseFloat(row.handling_fee || 0),
      lateNightFee: parseFloat(row.late_night_fee || 0),
      tipAmount: parseFloat(row.tip_amount || 0),
      deliveryInstructions: row.delivery_instructions || null,
      savingsTotal: parseFloat(row.savings_total || 0),
      deliveryMode: row.delivery_mode || 'ASAP',
      scheduledDeliveryAt: row.scheduled_delivery_at || null,
      scheduledSlotStart: row.scheduled_slot_start || null,
      scheduledSlotEnd: row.scheduled_slot_end || null,
      scheduledSlotLabel: row.scheduled_slot_label || null,
      vendorSlotId: row.vendor_slot_id || null,
      pickupDate: row.pickup_date || null,
      autoAssignmentStatus: row.auto_assignment_status || null,
      feeBreakdown:
        row.fee_breakdown == null
          ? null
          : typeof row.fee_breakdown === 'string'
            ? JSON.parse(row.fee_breakdown)
            : row.fee_breakdown,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
