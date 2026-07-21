import { getClient } from '../../src/config/database.js'
import { logger } from '../../src/config/logger.js'

/**
 * Bulk Orders service — business logic for the multi-vendor large-order
 * lifecycle (Requirement 9).
 *
 * Responsibilities:
 *   - Generate unique order_number (BULK-YYYYMMDD-XXX)             (Req 9.8)
 *   - Validate creation input including delivery date window       (Req 9.6)
 *   - Validate the customer is allocated to the target shop        (Req 5.2)
 *   - Enforce the state machine for status transitions             (Req 9.1)
 *   - On submit: stock validation against vendor_services            (Req 9.3)
 *   - On confirm: deduct stock with SELECT FOR UPDATE inside a tx  (Req 9.5)
 *   - On cancel-after-confirm: restore stock in the same pattern   (Req 9.7)
 *   - Pagination on listing                                        (Req 9.9)
 *
 * Architecture:
 *   - All SQL goes through the repository (no direct queries here).
 *   - All financial / stock writes happen inside getClient() transactions
 *     with FOR UPDATE locks (Req 14.8, 15.9, 15.10).
 *   - Errors surface as `{ success, message, code }` envelopes for the
 *     controller; HTTP status is mapped in the controller.
 */

// ─── State machine (Req 9.1) ─────────────────────────────
// keys = current status, value = set of permitted next statuses
const STATE_MACHINE = Object.freeze({
  DRAFT: new Set(['SUBMITTED', 'CANCELLED']),
  SUBMITTED: new Set(['CONFIRMED', 'CANCELLED']),
  CONFIRMED: new Set(['PROCESSING', 'CANCELLED']),
  PROCESSING: new Set(['READY']),
  READY: new Set(['DELIVERED']),
  DELIVERED: new Set(),
  CANCELLED: new Set(),
})

// Roles allowed to advance the bulk-order lifecycle on a shop's behalf.
const SHOP_STAFF_ROLES_ALLOWED_TO_TRANSITION = new Set([
  'SHOP_ADMIN',
  'SHOP_MANAGER',
])

// Delivery date window (Req 9.6) — relative to "now" so tests can travel time.
const MIN_DELIVERY_HOURS = 24
const MAX_DELIVERY_DAYS = 30

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

export class BulkOrdersService {
  /**
   * @param {import('./bulk-orders.repository.js').BulkOrdersRepository} repository
   */
  constructor(repository) {
    this.repo = repository
  }

  // ────────────────────────────────────────────────────────
  // Pure helpers (no I/O — easy to unit-test)
  // ────────────────────────────────────────────────────────

  /**
   * Decide whether a status transition is permitted by the bulk-order state
   * machine (Req 9.1). Pure function — exposed so unit and property tests
   * can validate transitions without touching the DB.
   *
   * @param {string} from
   * @param {string} to
   * @returns {boolean}
   */
  static isValidTransition(from, to) {
    if (from === to) return false
    const allowed = STATE_MACHINE[from]
    return Boolean(allowed && allowed.has(to))
  }

  /**
   * Validate that delivery_date falls inside the allowed window
   * (Req 9.6: at least 24h in the future, at most 30d in the future).
   *
   * @param {string|Date} deliveryDateInput
   * @param {Date} [now=new Date()]
   * @returns {{ ok: true } | { ok: false, code: string, message: string }}
   */
  static validateDeliveryDate(deliveryDateInput, now = new Date()) {
    const t = new Date(deliveryDateInput).getTime()
    if (!Number.isFinite(t)) {
      return {
        ok: false,
        code: 'BULK_DATE_INVALID',
        message: 'delivery_date must be a valid date',
      }
    }
    const nowTs = now.getTime()
    const minTs = nowTs + MIN_DELIVERY_HOURS * MS_PER_HOUR
    const maxTs = nowTs + MAX_DELIVERY_DAYS * MS_PER_DAY
    if (t < minTs || t > maxTs) {
      return {
        ok: false,
        code: 'BULK_DATE_INVALID',
        message: `delivery_date must be between ${MIN_DELIVERY_HOURS}h and ${MAX_DELIVERY_DAYS}d in the future`,
      }
    }
    return { ok: true }
  }

  /**
   * Build a server-side order_number with the required prefix (Req 9.8).
   * Format: BULK-YYYYMMDD-XXX (sequence is per-day).
   *
   * Looks up the current count of bulk orders for the day to pick the next
   * sequence value, then re-checks uniqueness against the UNIQUE constraint
   * for friendlier errors (the DB constraint is the final defence).
   *
   * @param {Date} [now=new Date()]
   * @returns {Promise<string>}
   */
  async generateOrderNumber(now = new Date()) {
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
    const pattern = `BULK-${ymd}-%`

    let seq = (await this.repo.countByOrderNumberPattern(pattern)) + 1
    // Up to 50 attempts in the (very unlikely) case of a collision after a
    // crash — far below any realistic per-day volume but cheap to bound.
    for (let i = 0; i < 50; i++) {
      const candidate = `BULK-${ymd}-${String(seq).padStart(3, '0')}`
      if (!(await this.repo.existsOrderNumber(candidate))) return candidate
      seq += 1
    }
    // Last resort — fall back to the current candidate; UNIQUE-checked by
    // the DB on insert (will throw 23505 which the caller maps to a code).
    return `BULK-${ymd}-${String(seq).padStart(3, '0')}`
  }

  // ────────────────────────────────────────────────────────
  // Authorization helpers
  // ────────────────────────────────────────────────────────

  /**
   * Decide whether `actor` may advance the lifecycle of a bulk order owned
   * by `shopId`. Allowed:
   *   - platform ADMIN (X-Shop-Id scoped or otherwise) always
   *   - shop staff with SHOP_ADMIN/SHOP_MANAGER role for that shop
   *
   * @param {object} actor - { id, role, shopId, shopRole }
   * @param {string} shopId
   * @returns {Promise<{ ok: boolean, message?: string, code?: string }>}
   */
  async authorizeShopTransition(actor, shopId) {
    if (!actor || !actor.id) {
      return { ok: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    if (actor.role === 'ADMIN') return { ok: true }

    // JWT vendor_id must match (defence-in-depth — middleware should already
    // have enforced this, but the service repeats the check).
    if (actor.shopId && actor.shopId !== shopId) {
      return {
        ok: false,
        message: 'Forbidden — resource is not scoped to your shop',
        code: 'SHOP_SCOPE_MISMATCH',
      }
    }

    const shopRole =
      actor.shopRole && actor.shopId === shopId ? actor.shopRole : null

    if (shopRole && SHOP_STAFF_ROLES_ALLOWED_TO_TRANSITION.has(shopRole)) {
      return { ok: true }
    }

    // Fall back to a DB lookup so non-shop-scoped tokens (rare) can still be
    // authorised when the user actually holds the staff role.
    const staff = await this.repo.findStaffRole(actor.id, shopId)
    if (
      staff &&
      SHOP_STAFF_ROLES_ALLOWED_TO_TRANSITION.has(staff.role)
    ) {
      return { ok: true }
    }

    return {
      ok: false,
      message:
        'Only Shop Admin, Shop Manager, or Super Admin can update this bulk order',
      code: 'FORBIDDEN',
    }
  }

  // ────────────────────────────────────────────────────────
  // Create (DRAFT)
  // ────────────────────────────────────────────────────────

  /**
   * Create a bulk order in DRAFT status owned by `userId`.
   * Validates the user is allocated to the target shop (Req 5.2 / 9.x) and
   * the delivery_date window (Req 9.6).
   *
   * Numeric checks (total_items >= 5, distinct_products >= 3, total_amount
   * range) are enforced by the Zod schema before this method is called.
   *
   * @param {string} userId
   * @param {object} data - Already validated by createBulkOrderSchema
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async create(userId, data) {
    if (!userId) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }

    // Req 9.6 — delivery_date window
    const dateCheck = BulkOrdersService.validateDeliveryDate(data.delivery_date)
    if (!dateCheck.ok) {
      return { success: false, message: dateCheck.message, code: dateCheck.code }
    }

    // Req 5.2 (applied to bulk orders) — shop must be in user's allocations
    const allocated = await this.repo.isUserAllocatedToShop(
      userId,
      data.vendor_id
    )
    if (!allocated) {
      return {
        success: false,
        message:
          'Forbidden — selected shop is not in your allocations or is inactive',
        code: 'NO_ALLOCATION',
      }
    }

    const orderNumber = await this.generateOrderNumber()

    const inserted = await this.repo.create({
      ...data,
      user_id: userId,
      order_number: orderNumber,
      status: 'DRAFT',
    })

    logger.info(
      {
        userId,
        shopId: data.vendor_id,
        action: 'bulk_order_created',
        bulkOrderId: inserted.id,
        orderNumber: inserted.order_number,
      },
      'Bulk order created'
    )

    return { success: true, data: inserted }
  }

  // ────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────

  /**
   * Get a single bulk order, scoped by the actor.
   *
   * Visibility rules:
   *   - platform ADMIN: any
   *   - shop staff (any role) for the owning shop: any
   *   - the customer who created the order: their own
   *   - everyone else: not found (404, never leak existence)
   *
   * @param {string} id
   * @param {object} actor - { id, role, shopId }
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async getById(id, actor) {
    if (!actor || !actor.id) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    const row = await this.repo.findById(id)
    if (!row) {
      return {
        success: false,
        message: 'Bulk order not found',
        code: 'BULK_ORDER_NOT_FOUND',
      }
    }
    if (actor.role === 'ADMIN') return { success: true, data: row }
    if (actor.shopId && actor.shopId === row.vendor_id) {
      return { success: true, data: row }
    }
    if (row.user_id === actor.id) return { success: true, data: row }
    return {
      success: false,
      message: 'Bulk order not found',
      code: 'BULK_ORDER_NOT_FOUND',
    }
  }

  /**
   * List bulk orders scoped to the caller.
   *
   * Scoping rules:
   *   - platform ADMIN with X-Shop-Id (actor.shopId): list for that shop
   *   - platform ADMIN without X-Shop-Id, with vendor_id filter: list for that shop
   *   - platform ADMIN without any shop scope: list across all vendors (admin view)
   *   - shop staff (any role): list for actor.shopId (filter ignored)
   *   - customer (no shopId): list their own bulk orders
   *
   * @param {object} actor - { id, role, shopId }
   * @param {{ page: number, limit: number, status?: string, vendor_id?: string }} filters
   * @returns {Promise<{items, total, page, limit}>}
   */
  async list(actor, filters) {
    const { page, limit, status, vendor_id: shopIdFilter } = filters

    let scope = {}
    if (actor.role === 'ADMIN') {
      // Super Admin: header takes precedence; falls back to query filter.
      const adminShopId = actor.shopId || shopIdFilter || null
      scope = adminShopId ? { shopId: adminShopId } : {}
    } else if (actor.shopId) {
      // Shop staff are pinned to their JWT shop — ignore any vendor_id filter.
      scope = { shopId: actor.shopId }
    } else {
      // Customers see their own bulk orders only.
      scope = { userId: actor.id }
    }

    const { items, total } = await this.repo.findMany({
      ...scope,
      status,
      page,
      limit,
    })

    return { items, total, page, limit }
  }

  // ────────────────────────────────────────────────────────
  // Submit (DRAFT -> SUBMITTED) with stock validation (Req 9.3)
  // ────────────────────────────────────────────────────────

  /**
   * Customer submit flow. Verifies ownership, validates the state transition,
   * and runs a read-only stock check across all items in the order. Stock is
   * NOT deducted here — that happens on confirm (Req 9.5).
   *
   * @param {string} userId
   * @param {string} id
   * @returns {Promise<{success, data?, failed?, message?, code?}>}
   */
  async submit(userId, id) {
    if (!userId) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    const row = await this.repo.findById(id)
    if (!row || row.user_id !== userId) {
      return {
        success: false,
        message: 'Bulk order not found',
        code: 'BULK_ORDER_NOT_FOUND',
      }
    }
    if (!BulkOrdersService.isValidTransition(row.status, 'SUBMITTED')) {
      return {
        success: false,
        message: `Invalid transition from ${row.status} to SUBMITTED`,
        code: 'INVALID_STATE_TRANSITION',
      }
    }

    // Req 9.3 — stock availability for all items
    const items = this._normalizeItems(row.items)
    const stockCheck = await this._validateStock(row.vendor_id, items)
    if (!stockCheck.ok) {
      logger.warn(
        {
          userId,
          shopId: row.vendor_id,
          bulkOrderId: id,
          action: 'bulk_order_submit_insufficient_stock',
          failed: stockCheck.failed,
        },
        'Bulk order submit rejected — insufficient stock'
      )
      return {
        success: false,
        message: 'One or more items have insufficient stock',
        code: 'INSUFFICIENT_STOCK',
        failed: stockCheck.failed,
      }
    }

    const updated = await this.repo.updateStatus(id, 'SUBMITTED')

    logger.info(
      {
        userId,
        shopId: row.vendor_id,
        bulkOrderId: id,
        action: 'bulk_order_submitted',
      },
      'Bulk order submitted'
    )

    return { success: true, data: updated }
  }

  // ────────────────────────────────────────────────────────
  // Status transitions by Shop Manager+ (Req 9.5, 9.7)
  // ────────────────────────────────────────────────────────

  /**
   * Unified status-transition entry point used by `PATCH /:id/status`.
   *
   * Dispatches to the right flow based on the actor profile and the
   * requested target status (Req 9.1):
   *   - Customer (no shopId, no shopRole, role !== ADMIN):
   *       DRAFT->SUBMITTED  → submit() (validates stock, no deduction)
   *       DRAFT->CANCELLED, SUBMITTED->CANCELLED → cancel() (no stock change)
   *       any other transition → 403 FORBIDDEN
   *   - Shop staff or platform ADMIN:
   *       all shop-side transitions via updateStatus()
   *
   * @param {object} actor - { id, role, shopId, shopRole }
   * @param {string} id
   * @param {string} nextStatus
   * @returns {Promise<{success, data?, message?, code?, failed?}>}
   */
  async transitionStatus(actor, id, nextStatus) {
    if (!actor || !actor.id) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    const isShopActor =
      actor.role === 'ADMIN' || Boolean(actor.shopId) || Boolean(actor.shopRole)

    if (!isShopActor) {
      // Customer entry points
      if (nextStatus === 'SUBMITTED') {
        return this.submit(actor.id, id)
      }
      if (nextStatus === 'CANCELLED') {
        return this.cancel(actor.id, id)
      }
      return {
        success: false,
        message:
          'Customers can only transition bulk orders to SUBMITTED or CANCELLED',
        code: 'FORBIDDEN',
      }
    }

    return this.updateStatus(actor, id, nextStatus)
  }

  /**
   * Advance the lifecycle to `newStatus`. Handles three sub-flows:
   *   - SUBMITTED -> CONFIRMED:  deduct stock inside a tx (FOR UPDATE)
   *   - CONFIRMED -> CANCELLED:  restore stock inside a tx (FOR UPDATE)
   *   - everything else:         simple status update (idempotent column)
   *
   * Only Shop Admin/Manager (or platform ADMIN) may invoke; customer-driven
   * cancels are routed through `cancel()` so this entry point covers the
   * shop side of the workflow.
   *
   * @param {object} actor - { id, role, shopId, shopRole }
   * @param {string} id
   * @param {string} newStatus
   * @returns {Promise<{success, data?, message?, code?, failed?}>}
   */
  async updateStatus(actor, id, newStatus) {
    const row = await this.repo.findById(id)
    if (!row) {
      return {
        success: false,
        message: 'Bulk order not found',
        code: 'BULK_ORDER_NOT_FOUND',
      }
    }

    const auth = await this.authorizeShopTransition(actor, row.vendor_id)
    if (!auth.ok) {
      return { success: false, message: auth.message, code: auth.code }
    }

    if (!BulkOrdersService.isValidTransition(row.status, newStatus)) {
      return {
        success: false,
        message: `Invalid transition from ${row.status} to ${newStatus}`,
        code: 'INVALID_STATE_TRANSITION',
      }
    }

    if (row.status === 'SUBMITTED' && newStatus === 'CONFIRMED') {
      return this._confirmAndDeductStock(actor, row)
    }
    if (row.status === 'CONFIRMED' && newStatus === 'CANCELLED') {
      return this._cancelAndRestoreStock(actor, row)
    }

    const updated = await this.repo.updateStatus(id, newStatus)
    logger.info(
      {
        userId: actor.id,
        shopId: row.vendor_id,
        bulkOrderId: id,
        action: 'bulk_order_status_updated',
        from: row.status,
        to: newStatus,
      },
      'Bulk order status updated'
    )
    return { success: true, data: updated }
  }

  /**
   * Customer-initiated cancel. Allowed transitions for the owning customer:
   *   - DRAFT     -> CANCELLED  (no stock side-effects)
   *   - SUBMITTED -> CANCELLED  (no stock side-effects)
   *
   * Cancelling a CONFIRMED order is a Shop-Manager operation routed through
   * `updateStatus` so stock can be restored under the same transaction.
   *
   * @param {string} userId
   * @param {string} id
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async cancel(userId, id) {
    if (!userId) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    const row = await this.repo.findById(id)
    if (!row || row.user_id !== userId) {
      return {
        success: false,
        message: 'Bulk order not found',
        code: 'BULK_ORDER_NOT_FOUND',
      }
    }
    if (!BulkOrdersService.isValidTransition(row.status, 'CANCELLED')) {
      return {
        success: false,
        message: `Invalid transition from ${row.status} to CANCELLED`,
        code: 'INVALID_STATE_TRANSITION',
      }
    }
    if (row.status === 'CONFIRMED') {
      // Customers cannot directly cancel after confirmation — must go through
      // the Shop. Returning a clear code rather than silently mutating stock.
      return {
        success: false,
        message:
          'Confirmed bulk orders can only be cancelled by the shop (stock will be restored)',
        code: 'FORBIDDEN',
      }
    }
    const updated = await this.repo.updateStatus(id, 'CANCELLED')
    logger.info(
      {
        userId,
        shopId: row.vendor_id,
        bulkOrderId: id,
        action: 'bulk_order_cancelled_by_customer',
        from: row.status,
      },
      'Bulk order cancelled by customer'
    )
    return { success: true, data: updated }
  }

  // ────────────────────────────────────────────────────────
  // Internal: stock validation (read-only) — Req 9.3
  // ────────────────────────────────────────────────────────

  /**
   * Read-only stock check for the given items against vendor_services.
   * Aggregates duplicate product_ids so two lines for the same product are
   * summed before comparison.
   *
   * @param {string} shopId
   * @param {Array<{garment_rate_id: string, quantity: number}>} items
   * @returns {Promise<{
   *   ok: boolean,
   *   failed?: Array<{ garment_rate_id: string, requested: number, available: number, reason: string }>
   * }>}
   */
  async _validateStock(shopId, items) {
    const requested = this._aggregateByProduct(items)
    const productIds = [...requested.keys()]
    const rows = await this.repo.findShopProductsForValidation(
      null,
      shopId,
      productIds
    )
    const byProduct = new Map(rows.map((r) => [r.garment_rate_id, r]))

    const failed = []
    for (const [productId, qty] of requested.entries()) {
      const sp = byProduct.get(productId)
      if (!sp) {
        failed.push({
          garment_rate_id: productId,
          requested: qty,
          available: 0,
          reason: 'NOT_LISTED',
        })
        continue
      }
      if (!sp.is_available) {
        failed.push({
          garment_rate_id: productId,
          requested: qty,
          available: Number(sp.stock_quantity),
          reason: 'UNAVAILABLE',
        })
        continue
      }
      if (Number(sp.stock_quantity) < qty) {
        failed.push({
          garment_rate_id: productId,
          requested: qty,
          available: Number(sp.stock_quantity),
          reason: 'INSUFFICIENT_STOCK',
        })
      }
    }
    return failed.length === 0 ? { ok: true } : { ok: false, failed }
  }

  // ────────────────────────────────────────────────────────
  // Internal: confirm + deduct (Req 9.5) and cancel + restore (Req 9.7)
  // ────────────────────────────────────────────────────────

  /**
   * Confirm flow: lock the bulk order row + every shop_product, deduct
   * stock, transition to CONFIRMED. Single transaction; ROLLBACK on any
   * failure (Req 14.8, 15.9, 15.10).
   *
   * @param {object} actor
   * @param {object} row - The current bulk_orders row (already loaded)
   */
  async _confirmAndDeductStock(actor, row) {
    const items = this._normalizeItems(row.items)
    const aggregated = this._aggregateByProduct(items)

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Re-lock the bulk order to keep the transition atomic with the writes.
      const locked = await this.repo.findByIdForUpdate(client, row.id)
      if (!locked) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'Bulk order not found',
          code: 'BULK_ORDER_NOT_FOUND',
        }
      }
      // The row could have moved between the initial read and the FOR UPDATE
      // (e.g., another shop staffer cancelled). Re-validate the transition.
      if (!BulkOrdersService.isValidTransition(locked.status, 'CONFIRMED')) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: `Invalid transition from ${locked.status} to CONFIRMED`,
          code: 'INVALID_STATE_TRANSITION',
        }
      }

      const failed = []
      for (const [productId, qty] of aggregated.entries()) {
        // Sequential awaits inside a transaction client are intentional —
        // pg cannot run multiple queries on the same client in parallel.
        const sp = await this.repo.lockShopProduct(
          client,
          locked.vendor_id,
          productId
        )
        if (!sp) {
          failed.push({
            garment_rate_id: productId,
            requested: qty,
            available: 0,
            reason: 'NOT_LISTED',
          })
          continue
        }
        if (Number(sp.stock_quantity) < qty) {
          failed.push({
            garment_rate_id: productId,
            requested: qty,
            available: Number(sp.stock_quantity),
            reason: 'INSUFFICIENT_STOCK',
          })
          continue
        }
        await this.repo.applyShopProductStock(
          client,
          sp.id,
          Number(sp.stock_quantity) - qty
        )
      }

      if (failed.length > 0) {
        await client.query('ROLLBACK')
        logger.warn(
          {
            userId: actor.id,
            shopId: locked.vendor_id,
            bulkOrderId: locked.id,
            action: 'bulk_order_confirm_insufficient_stock',
            failed,
          },
          'Bulk order confirm rolled back — insufficient stock'
        )
        return {
          success: false,
          message: 'One or more items have insufficient stock',
          code: 'INSUFFICIENT_STOCK',
          failed,
        }
      }

      const updated = await this.repo.updateStatus(
        locked.id,
        'CONFIRMED',
        client
      )
      await client.query('COMMIT')

      logger.info(
        {
          userId: actor.id,
          shopId: locked.vendor_id,
          bulkOrderId: locked.id,
          action: 'bulk_order_confirmed',
          itemCount: aggregated.size,
        },
        'Bulk order confirmed and stock deducted'
      )

      return { success: true, data: updated }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      // DB CHECK on stock_quantity >= 0 is the final defence (23514).
      if (err && err.code === '23514') {
        return {
          success: false,
          message: 'Stock would become negative',
          code: 'INSUFFICIENT_STOCK',
        }
      }
      logger.error(
        {
          userId: actor.id,
          shopId: row.vendor_id,
          bulkOrderId: row.id,
          action: 'bulk_order_confirm_failed',
          err: err && err.message,
        },
        'Bulk order confirm transaction failed'
      )
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Cancel-after-confirm flow: lock the bulk order + every shop_product,
   * restore stock, transition to CANCELLED. Single transaction; ROLLBACK on
   * any failure (Req 9.7, 15.9, 15.10).
   *
   * @param {object} actor
   * @param {object} row
   */
  async _cancelAndRestoreStock(actor, row) {
    const items = this._normalizeItems(row.items)
    const aggregated = this._aggregateByProduct(items)

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const locked = await this.repo.findByIdForUpdate(client, row.id)
      if (!locked) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'Bulk order not found',
          code: 'BULK_ORDER_NOT_FOUND',
        }
      }
      if (!BulkOrdersService.isValidTransition(locked.status, 'CANCELLED')) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: `Invalid transition from ${locked.status} to CANCELLED`,
          code: 'INVALID_STATE_TRANSITION',
        }
      }
      // Only restore stock when the previous state was CONFIRMED.
      const mustRestore = locked.status === 'CONFIRMED'

      if (mustRestore) {
        for (const [productId, qty] of aggregated.entries()) {
          const sp = await this.repo.lockShopProduct(
            client,
            locked.vendor_id,
            productId
          )
          if (!sp) {
            // Product was de-listed mid-flight — skip silently rather than
            // fail the cancel. The order is being cancelled, not satisfied.
            continue
          }
          await this.repo.applyShopProductStock(
            client,
            sp.id,
            Number(sp.stock_quantity) + qty
          )
        }
      }

      const updated = await this.repo.updateStatus(
        locked.id,
        'CANCELLED',
        client
      )
      await client.query('COMMIT')

      logger.info(
        {
          userId: actor.id,
          shopId: locked.vendor_id,
          bulkOrderId: locked.id,
          action: mustRestore
            ? 'bulk_order_cancelled_stock_restored'
            : 'bulk_order_cancelled',
          from: locked.status,
        },
        'Bulk order cancelled'
      )

      return { success: true, data: updated }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      logger.error(
        {
          userId: actor.id,
          shopId: row.vendor_id,
          bulkOrderId: row.id,
          action: 'bulk_order_cancel_failed',
          err: err && err.message,
        },
        'Bulk order cancel transaction failed'
      )
      throw err
    } finally {
      client.release()
    }
  }

  // ────────────────────────────────────────────────────────
  // Items helpers
  // ────────────────────────────────────────────────────────

  /**
   * Normalise the items column to a JS array.
   * Postgres jsonb may surface as either a JS array (pg auto-parses jsonb)
   * or a string (legacy callers / pg < 8 quirks).
   */
  _normalizeItems(items) {
    if (Array.isArray(items)) return items
    if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }

  /**
   * Sum quantities by garment_rate_id so duplicate rows in the items array
   * collapse before a single FOR UPDATE on the shop_product.
   */
  _aggregateByProduct(items) {
    const map = new Map()
    for (const it of items) {
      const pid = it.garment_rate_id
      const q = Number(it.quantity || 0)
      if (!pid || !Number.isFinite(q) || q <= 0) continue
      map.set(pid, (map.get(pid) || 0) + q)
    }
    return map
  }
}

// Re-export the state machine for tests / property checks.
export { STATE_MACHINE }
