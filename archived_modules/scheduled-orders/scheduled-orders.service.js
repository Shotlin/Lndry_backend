import { logger } from '../../src/config/logger.js'
import { scheduledOrdersQueue } from '../../src/config/bullmq.js'
import { getClient } from '../../src/config/database.js'
import { SCHEDULED_ORDERS_CONSTANTS } from './scheduled-orders.schema.js'

/**
 * Scheduled Orders service — customer-facing CRUD for scheduled / recurring
 * orders (Requirement 10).
 *
 * Responsibilities:
 *   - Validate scheduled_for is at least 2 hours in the future  (Req 10.7)
 *   - Validate vendor_id is in the user's allocations             (Req 10.8)
 *   - Enforce max 20 active scheduled orders per customer       (Req 10.9)
 *   - Enqueue a BullMQ delayed job at scheduled_for             (Req 10.2)
 *   - Cancel: only from SCHEDULED or FAILED, remove queue job   (Req 10.6)
 *
 * NOTE: The BullMQ worker that fires the delayed job (the actual order
 * placement at scheduled_for) is implemented in task 10.3. This service is
 * the producer side only — it adds delayed jobs with a deterministic jobId
 * so the worker (10.3) can pick them up and so cancel can remove them.
 *
 * Architecture:
 *   - All SQL goes through the repository (no direct queries here).
 *   - Errors surface as `{ success, message, code }` envelopes; the
 *     controller maps `code` to HTTP status.
 *   - BullMQ failures during create are non-fatal: the row is committed and
 *     the failure is logged; if the worker can't pick the row up, the
 *     fallback is the periodic sweep query (idx_scheduled_orders_due).
 */

const MS_PER_HOUR = 60 * 60 * 1000

/**
 * Build the canonical BullMQ jobId for a scheduled order.
 * Used at enqueue time (idempotent retries) and at cancel time (remove by id).
 * @param {string} id - scheduled_orders.id
 * @returns {string}
 */
export function jobIdFor(id) {
  return `scheduled-order:${id}`
}

export class ScheduledOrdersService {
  /**
   * @param {import('./scheduled-orders.repository.js').ScheduledOrdersRepository} repository
   * @param {object} [deps]
   * @param {object} [deps.queue=scheduledOrdersQueue] - BullMQ queue (overridable for tests)
   * @param {object} [deps.shopProductsRepository] - For enriching items at fire time (worker)
   * @param {object} [deps.ordersRepository] - For OrderSplitter (worker)
   * @param {object} [deps.orderSplitter] - Optional pre-built splitter (worker / tests)
   * @param {object} [deps.notificationsService] - Optional notifications gateway (worker)
   */
  constructor(repository, deps = {}) {
    this.repo = repository
    // Tests inject a stub queue; in prod we use the singleton from config.
    this.queue = deps.queue || scheduledOrdersQueue
    // Worker-side collaborators. Customer CRUD paths don't need them, so
    // they're optional and lazily required by `processFire`.
    this.shopProductsRepo = deps.shopProductsRepository || null
    this.ordersRepo = deps.ordersRepository || null
    this.orderSplitter = deps.orderSplitter || null
    this.notificationsService = deps.notificationsService || null
  }

  // ────────────────────────────────────────────────────────
  // Pure helpers (no I/O — easy to unit-test)
  // ────────────────────────────────────────────────────────

  /**
   * Validate that scheduled_for is at least MIN_FUTURE_HOURS in the future.
   * Pure — exported via the static method so tests can travel time.
   *
   * @param {string|Date} scheduledForInput
   * @param {Date} [now=new Date()]
   * @returns {{ ok: true, ms: number } | { ok: false, code: string, message: string }}
   */
  static validateScheduledFor(scheduledForInput, now = new Date()) {
    const t = new Date(scheduledForInput).getTime()
    if (!Number.isFinite(t)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'scheduled_for must be a valid date',
      }
    }
    const minTs =
      now.getTime() + SCHEDULED_ORDERS_CONSTANTS.MIN_FUTURE_HOURS * MS_PER_HOUR
    if (t < minTs) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `scheduled_for must be at least ${SCHEDULED_ORDERS_CONSTANTS.MIN_FUTURE_HOURS} hours in the future`,
      }
    }
    return { ok: true, ms: t - now.getTime() }
  }

  /**
   * Decide whether a customer can cancel from `currentStatus` (Req 10.6).
   * Pure helper — exported so tests assert against the same matrix.
   *
   * @param {string} currentStatus
   * @returns {boolean}
   */
  static canCustomerCancelFrom(currentStatus) {
    return currentStatus === 'SCHEDULED' || currentStatus === 'FAILED'
  }

  /**
   * Compute the next scheduled_for for a recurring schedule (Req 10.3).
   *
   * Pure helper used by the worker (task 10.3) and Property 15 tests:
   *   DAILY   → +1 day
   *   WEEKLY  → +7 days
   *   MONTHLY → +1 calendar month
   *   ONCE    → null (no successor)
   *
   * Calendar-month addition uses UTC components so DST jumps and locale
   * never shift the wall-clock-equivalent fire time. When the source day
   * doesn't exist in the next month (e.g. Jan 31 → Feb), we clamp to the
   * last valid day of the target month — the same rule Postgres uses for
   * `INTERVAL '1 month'` when adding to a date.
   *
   * @param {Date|string|number} currentDate
   * @param {string} repeatType - ONCE | DAILY | WEEKLY | MONTHLY
   * @returns {Date|null}
   */
  static computeNextScheduledFor(currentDate, repeatType) {
    const cur = new Date(currentDate)
    if (!Number.isFinite(cur.getTime())) return null
    if (repeatType === 'ONCE') return null

    if (repeatType === 'DAILY') {
      return new Date(cur.getTime() + 24 * 60 * 60 * 1000)
    }
    if (repeatType === 'WEEKLY') {
      return new Date(cur.getTime() + 7 * 24 * 60 * 60 * 1000)
    }
    if (repeatType === 'MONTHLY') {
      const y = cur.getUTCFullYear()
      const m = cur.getUTCMonth()
      const d = cur.getUTCDate()
      const targetYear = m === 11 ? y + 1 : y
      const targetMonth = (m + 1) % 12
      // Last valid day of target month (UTC). new Date(Y, M+1, 0) gives
      // the last day of month M; we use UTC math to stay deterministic.
      const lastDayOfTargetMonth = new Date(
        Date.UTC(targetYear, targetMonth + 1, 0)
      ).getUTCDate()
      const day = Math.min(d, lastDayOfTargetMonth)
      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          day,
          cur.getUTCHours(),
          cur.getUTCMinutes(),
          cur.getUTCSeconds(),
          cur.getUTCMilliseconds()
        )
      )
    }
    return null
  }

  // ────────────────────────────────────────────────────────
  // BullMQ enqueue / dequeue helpers
  // ────────────────────────────────────────────────────────

  /**
   * Enqueue a delayed BullMQ job that will fire at scheduled_for.
   * Failures are caught and logged — the DB row is still committed so the
   * periodic sweep (worker side, task 10.3) can recover the row.
   *
   * @param {string} id - scheduled_orders.id
   * @param {Date|string|number} scheduledFor
   * @returns {Promise<void>}
   */
  async _enqueueDelayedJob(id, scheduledFor) {
    if (!this.queue || typeof this.queue.add !== 'function') {
      logger.warn(
        { scheduledOrderId: id, action: 'scheduled_order_enqueue_skipped' },
        'scheduledOrdersQueue unavailable; relying on periodic sweep'
      )
      return
    }
    const fireAt = new Date(scheduledFor).getTime()
    const delay = Math.max(0, fireAt - Date.now())
    try {
      await this.queue.add(
        'fire-scheduled-order',
        { scheduledOrderId: id },
        {
          jobId: jobIdFor(id), // deterministic — coalesces dup enqueues
          delay,
        }
      )
    } catch (err) {
      // Non-fatal — DB row is the source of truth (Req 10.2 fallback).
      logger.error(
        {
          scheduledOrderId: id,
          action: 'scheduled_order_enqueue_failed',
          err: err && err.message,
        },
        'Failed to enqueue scheduled-order job'
      )
    }
  }

  /**
   * Remove the delayed BullMQ job for a scheduled order, if it exists.
   * Used by cancel (Req 10.6). Non-fatal — if the job already fired or was
   * never enqueued, the cancel still succeeds at the DB level.
   *
   * @param {string} id
   */
  async _removeDelayedJob(id) {
    if (!this.queue || typeof this.queue.getJob !== 'function') return
    try {
      const job = await this.queue.getJob(jobIdFor(id))
      if (job) await job.remove()
    } catch (err) {
      logger.warn(
        {
          scheduledOrderId: id,
          action: 'scheduled_order_dequeue_failed',
          err: err && err.message,
        },
        'Failed to remove scheduled-order job (non-fatal)'
      )
    }
  }

  // ────────────────────────────────────────────────────────
  // Create
  // ────────────────────────────────────────────────────────

  /**
   * Create a scheduled order owned by `userId` in SCHEDULED status.
   * Validates the 2-hour future window (Req 10.7), shop allocation
   * (Req 10.8), and the per-customer active cap (Req 10.9). Then enqueues
   * a delayed BullMQ job (Req 10.2) — worker dispatch lives in task 10.3.
   *
   * @param {string} userId
   * @param {object} data - Already validated by createScheduledOrderSchema
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async create(userId, data) {
    if (!userId) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }

    // Req 10.7 — at least 2 hours in the future (deterministic via static).
    const timeCheck = ScheduledOrdersService.validateScheduledFor(
      data.scheduled_for
    )
    if (!timeCheck.ok) {
      return { success: false, message: timeCheck.message, code: timeCheck.code }
    }

    // Req 10.8 — shop must be in user's active allocations.
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

    // Req 10.9 — at most 20 active scheduled orders per customer.
    const activeCount = await this.repo.countActiveForUser(userId)
    if (activeCount >= SCHEDULED_ORDERS_CONSTANTS.MAX_ACTIVE_PER_CUSTOMER) {
      return {
        success: false,
        message: `Maximum of ${SCHEDULED_ORDERS_CONSTANTS.MAX_ACTIVE_PER_CUSTOMER} active scheduled orders reached`,
        code: 'SCHEDULE_LIMIT',
      }
    }

    const inserted = await this.repo.create({
      user_id: userId,
      vendor_id: data.vendor_id,
      items: data.items,
      subtotal: data.subtotal,
      delivery_address: data.delivery_address,
      payment_method: data.payment_method ?? 'COD',
      scheduled_for: data.scheduled_for,
      repeat_type: data.repeat_type ?? 'ONCE',
      repeat_until: data.repeat_until ?? null,
    })

    // Req 10.2 — enqueue delayed job. Worker (task 10.3) consumes it.
    // Failure is logged but doesn't roll back the row — sweep is the safety net.
    await this._enqueueDelayedJob(inserted.id, inserted.scheduled_for)

    logger.info(
      {
        userId,
        shopId: inserted.vendor_id,
        scheduledOrderId: inserted.id,
        scheduledFor: inserted.scheduled_for,
        repeatType: inserted.repeat_type,
        action: 'scheduled_order_created',
      },
      'Scheduled order created'
    )

    return { success: true, data: inserted }
  }

  // ────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────

  /**
   * List the customer's scheduled orders (paginated, optional status filter).
   *
   * @param {string} userId
   * @param {{ page: number, limit: number, status?: string }} filters
   * @returns {Promise<{items, total, page, limit}>}
   */
  async list(userId, filters) {
    const { page, limit, status } = filters
    const { items, total } = await this.repo.findManyByUser({
      userId,
      status,
      page,
      limit,
    })
    return { items, total, page, limit }
  }

  /**
   * Fetch a single scheduled order owned by the customer.
   *
   * @param {string} userId
   * @param {string} id
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async getById(userId, id) {
    if (!userId) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    const row = await this.repo.findByIdForUser(id, userId)
    if (!row) {
      return {
        success: false,
        message: 'Scheduled order not found',
        code: 'SCHEDULED_ORDER_NOT_FOUND',
      }
    }
    return { success: true, data: row }
  }

  // ────────────────────────────────────────────────────────
  // Cancel (Req 10.6)
  // ────────────────────────────────────────────────────────

  /**
   * Cancel a scheduled order. Allowed transitions (Req 10.6):
   *   - SCHEDULED -> CANCELLED
   *   - FAILED    -> CANCELLED
   *
   * Side effects:
   *   - Update DB row (status, updated_at)
   *   - Remove the delayed BullMQ job by jobId (best-effort, non-fatal)
   *
   * @param {string} userId
   * @param {string} id
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async cancel(userId, id) {
    if (!userId) {
      return { success: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    const row = await this.repo.findByIdForUser(id, userId)
    if (!row) {
      return {
        success: false,
        message: 'Scheduled order not found',
        code: 'SCHEDULED_ORDER_NOT_FOUND',
      }
    }
    if (!ScheduledOrdersService.canCustomerCancelFrom(row.status)) {
      return {
        success: false,
        message: `Cannot cancel a scheduled order in status ${row.status}`,
        code: 'INVALID_STATE_TRANSITION',
      }
    }

    const updated = await this.repo.updateStatus(id, 'CANCELLED')

    // Best-effort remove of the queued job; failure is logged but does not
    // roll back the cancel — the worker (task 10.3) treats CANCELLED rows
    // as no-ops and skips them at fire time.
    await this._removeDelayedJob(id)

    logger.info(
      {
        userId,
        shopId: row.vendor_id,
        scheduledOrderId: id,
        from: row.status,
        action: 'scheduled_order_cancelled',
      },
      'Scheduled order cancelled'
    )

    return { success: true, data: updated }
  }

  // ────────────────────────────────────────────────────────
  // Worker-side helpers (task 10.3 — Req 10.2, 10.3, 10.4, 10.5)
  // ────────────────────────────────────────────────────────

  /**
   * Build cart-shaped items for the OrderSplitter from the JSONB items
   * snapshot stored on a scheduled_orders row.
   *
   * For each `{ garment_rate_id, quantity }` we look up the matching shop_product
   * row to resolve `shopProductId`, current price, sale price, name and
   * stock so the splitter can lock + revalidate against the live catalog.
   *
   * Failures (missing shop_product, soft-deleted, unavailable) are returned
   * as a `failures` array so the worker can mark the schedule FAILED with a
   * human-readable reason (Req 10.4).
   *
   * Note on N+1: bounded to ≤50 items per scheduled order (Zod cap) and
   * runs in a background worker; acceptable at this scale. Can be batched
   * via a new `findByShopAndProductIds(shopId, ids[])` repository method
   * if it ever becomes hot.
   *
   * @private
   * @param {string} shopId
   * @param {Array<{garment_rate_id: string, quantity: number}>|string} items
   * @returns {Promise<{ items: Array<object>, failures: Array<{productId,reason,code}> }>}
   */
  async _buildCartItemsFromSchedule(shopId, items) {
    if (!this.shopProductsRepo) {
      throw new Error(
        'shopProductsRepository is required for processFire (worker side)'
      )
    }
    const built = []
    const failures = []
    const parsedItems =
      typeof items === 'string' ? JSON.parse(items) : items || []

    for (const it of parsedItems) {
      const productId = it.garment_rate_id || it.productId
      const quantity = Number(it.quantity)
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
        failures.push({
          productId: productId || null,
          reason: 'Item has invalid garment_rate_id or quantity',
          code: 'SCHEDULED_ITEM_INVALID',
        })
        continue
      }
      const sp = await this.shopProductsRepo.findByShopAndProduct(
        shopId,
        productId
      )
      if (!sp || sp.deleted_at) {
        failures.push({
          productId,
          reason: 'Product is no longer available in this shop',
          code: 'SHOP_PRODUCT_UNAVAILABLE',
        })
        continue
      }
      const price = Number(sp.price ?? 0)
      const salePrice =
        sp.sale_price !== null && sp.sale_price !== undefined
          ? Number(sp.sale_price)
          : null
      const effective = salePrice !== null ? salePrice : price
      built.push({
        productId,
        shopId,
        shopProductId: sp.id,
        quantity,
        name: it.name || `Product ${productId.slice(0, 8)}`,
        unit: it.unit || null,
        price,
        salePrice,
        lineTotal: Number((effective * quantity).toFixed(2)),
      })
    }

    return { items: built, failures }
  }

  /**
   * Persist a FAILED transition with `failure_reason` for a scheduled
   * order (Req 10.4). Runs in its own short transaction so it can be
   * called after a rolled-back fire-attempt without leaking the parent
   * transaction's state.
   *
   * Idempotent on retry: if the row is already FAILED or CANCELLED, the
   * guarded UPDATE is a no-op and we still return success=true so the
   * BullMQ job doesn't requeue.
   *
   * @param {string} scheduledOrderId
   * @param {string} reason
   * @returns {Promise<{success: boolean, data?: object|null}>}
   */
  async recordFailure(scheduledOrderId, reason) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const locked = await this.repo.findByIdForUpdate(client, scheduledOrderId)
      if (!locked) {
        await client.query('ROLLBACK')
        return { success: false, data: null }
      }

      // Only a SCHEDULED or PROCESSING row can be marked FAILED — terminal
      // states (PLACED / CANCELLED / FAILED) stay as-is.
      if (locked.status !== 'SCHEDULED' && locked.status !== 'PROCESSING') {
        await client.query('COMMIT')
        return { success: true, data: locked }
      }

      const updated = await this.repo.updateStatusIfCurrent(
        client,
        scheduledOrderId,
        locked.status,
        'FAILED',
        { failure_reason: reason || null }
      )
      await client.query('COMMIT')
      return { success: true, data: updated }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback failures */
      }
      logger.error(
        {
          scheduledOrderId,
          err: err.message,
          action: 'scheduled_order_record_failure_failed',
        },
        'recordFailure transaction failed'
      )
      return { success: false }
    } finally {
      client.release()
    }
  }

  /**
   * Send a customer-facing push notification when a scheduled order
   * cannot be placed (Req 10.4). Best-effort — failures are logged but
   * never re-thrown so the worker job still settles cleanly.
   *
   * @private
   */
  async _notifyFailure(userId, scheduledOrderId, reason) {
    if (!this.notificationsService || !userId) return
    try {
      await this.notificationsService.sendNotification(userId, {
        title: 'Scheduled order could not be placed',
        body:
          reason ||
          'We were unable to place your scheduled order due to stock issues.',
        type: 'scheduled_order',
        data: {
          scheduledOrderId,
          reason: reason || null,
        },
      })
    } catch (err) {
      logger.warn(
        {
          scheduledOrderId,
          userId,
          err: err.message,
          action: 'scheduled_order_failure_notify_failed',
        },
        'Failed to send scheduled-order failure notification'
      )
    }
  }

  /**
   * Enqueue the delayed BullMQ job for a successor scheduled order
   * (Req 10.3). Mirrors `_enqueueDelayedJob` but isolated so the worker
   * path can be tested independently.
   * @private
   */
  async _enqueueSuccessorJob(successor) {
    return this._enqueueDelayedJob(successor.id, successor.scheduled_for)
  }

  /**
   * Worker entry point — executed when the BullMQ delayed job fires for
   * a scheduled_orders row. Implements the full lifecycle:
   *
   *   1. Lock row + verify SCHEDULED               (Req 10.5, idempotent)
   *   2. Guarded UPDATE → PROCESSING               (claim the row)
   *   3. Validate stock via vendor_services lookup   (Req 10.2, 10.4)
   *   4. Place real per-shop order via OrderSplitter (Req 10.2)
   *   5. Link placed_order_id, set status=PLACED   (Req 10.2)
   *   6. Compute next recurrence and INSERT successor + enqueue
   *      delayed job — only on PLACED (Req 10.3)
   *   7. On stock failure: ROLLBACK + recordFailure(reason) +
   *      push notification (Req 10.4); recurrence is NOT created.
   *
   * Returns a structured `{ status, ... }` summary so the worker can
   * emit useful job logs. The method never throws on the stock-failure
   * path (that's a normal outcome); it only throws on unexpected
   * infrastructure errors so BullMQ can retry.
   *
   * Idempotency: re-firing the same job after a successful PLACED is a
   * no-op — the SELECT sees status=PLACED and returns
   * `{ status: 'NOOP', reason: 'ALREADY_TERMINAL' }`.
   *
   * @param {object} args
   * @param {string} args.scheduledOrderId
   * @param {object} [args.ordersService] - Optional, kept for future use; the
   *   worker currently goes through the OrderSplitter directly so a single
   *   transaction wraps the schedule update + order create + stock decrement
   *   (Req 10.2 atomicity, Req 11.7).
   * @returns {Promise<object>}
   */
  async processFire({ scheduledOrderId }) {
    if (!scheduledOrderId) {
      return { status: 'NOOP', reason: 'MISSING_ID' }
    }
    if (!this.orderSplitter || !this.shopProductsRepo || !this.ordersRepo) {
      throw new Error(
        'processFire requires shopProductsRepository, ordersRepository and orderSplitter on the service'
      )
    }

    const client = await getClient()
    let placed = null
    let parent = null

    try {
      await client.query('BEGIN')

      // ─── 1. Lock row, check terminal/idempotent states ───────────
      parent = await this.repo.findByIdForUpdate(client, scheduledOrderId)
      if (!parent) {
        await client.query('ROLLBACK')
        logger.warn(
          {
            scheduledOrderId,
            action: 'scheduled_order_fire_missing',
          },
          'Scheduled order row missing at fire time'
        )
        return { status: 'NOOP', reason: 'NOT_FOUND' }
      }

      if (parent.status !== 'SCHEDULED') {
        // Already PROCESSING (concurrent retry), PLACED, FAILED or CANCELLED.
        // Idempotent — log and exit cleanly.
        await client.query('COMMIT')
        logger.info(
          {
            scheduledOrderId,
            currentStatus: parent.status,
            action: 'scheduled_order_fire_skipped',
          },
          'Scheduled order not SCHEDULED at fire time; skipping'
        )
        return {
          status: 'NOOP',
          reason: 'ALREADY_TERMINAL',
          from: parent.status,
        }
      }

      // ─── 2. Claim the row (SCHEDULED → PROCESSING, guarded) ──────
      const claimed = await this.repo.updateStatusIfCurrent(
        client,
        scheduledOrderId,
        'SCHEDULED',
        'PROCESSING'
      )
      if (!claimed) {
        await client.query('ROLLBACK')
        return { status: 'NOOP', reason: 'CLAIM_LOST' }
      }

      // ─── 3. Build cart-shaped items + validate availability ──────
      const built = await this._buildCartItemsFromSchedule(
        parent.vendor_id,
        parent.items
      )
      if (built.failures.length > 0) {
        // Catalog-level unavailability — abandon transaction, mark FAILED.
        const reason = `Items unavailable: ${built.failures
          .map((f) => f.productId)
          .join(', ')}`
        const err = new Error('CHECKOUT_PARTIAL_FAIL')
        err.code = 'CHECKOUT_PARTIAL_FAIL'
        err.failures = built.failures
        err.failureReason = reason
        throw err
      }

      // ─── 4. Place real per-shop order via OrderSplitter ──────────
      const groups = this.orderSplitter.splitCart(built.items)
      const created = await this.orderSplitter.createOrders({
        client,
        userId: parent.user_id,
        groups,
        deliveryAddress:
          typeof parent.delivery_address === 'string'
            ? JSON.parse(parent.delivery_address)
            : parent.delivery_address,
        payment: {
          method: (parent.payment_method || 'COD').toUpperCase(),
          status: 'PENDING',
        },
        checkoutMeta: {
          deliveryNotes: 'Auto-placed from scheduled order',
        },
      })
      placed = created[0]

      // ─── 5. Link placed_order_id and mark PLACED ─────────────────
      await this.repo.linkPlacedOrder(client, scheduledOrderId, placed.id)
      await this.repo.updateStatusIfCurrent(
        client,
        scheduledOrderId,
        'PROCESSING',
        'PLACED',
        { placed_order_id: placed.id }
      )

      // ─── 6. Compute and persist successor (Req 10.3) ─────────────
      let successor = null
      if (parent.repeat_type && parent.repeat_type !== 'ONCE') {
        const nextAt = ScheduledOrdersService.computeNextScheduledFor(
          parent.scheduled_for,
          parent.repeat_type
        )
        const repeatUntil = parent.repeat_until
          ? new Date(parent.repeat_until)
          : null
        const nextOk =
          nextAt && (!repeatUntil || nextAt.getTime() <= repeatUntil.getTime())
        if (nextOk) {
          successor = await this.repo.createSuccessor(client, parent, nextAt)
        }
      }

      await client.query('COMMIT')

      // Post-commit: enqueue successor's delayed BullMQ job. Failures
      // here are logged but don't roll back the placed order.
      if (successor) {
        await this._enqueueSuccessorJob(successor)
      }

      logger.info(
        {
          scheduledOrderId,
          userId: parent.user_id,
          shopId: parent.vendor_id,
          placedOrderId: placed.id,
          successorId: successor?.id ?? null,
          action: 'scheduled_order_fired',
        },
        'Scheduled order fired and placed'
      )

      return {
        status: 'PLACED',
        scheduledOrderId,
        placedOrderId: placed.id,
        successorId: successor?.id ?? null,
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback failure */
      }

      // Stock / catalog failure: mark FAILED + push notify, don't requeue.
      const isCatalogFailure =
        err.code === 'CHECKOUT_PARTIAL_FAIL' ||
        err.code === 'INSUFFICIENT_STOCK' ||
        err.code === 'SHOP_PRODUCT_UNAVAILABLE'
      if (isCatalogFailure) {
        const reason =
          err.failureReason ||
          (Array.isArray(err.failures) && err.failures.length > 0
            ? err.failures.map((f) => f.reason).join('; ')
            : err.message || 'Stock validation failed')
        await this.recordFailure(scheduledOrderId, reason)
        if (parent && parent.user_id) {
          await this._notifyFailure(parent.user_id, scheduledOrderId, reason)
        }
        logger.warn(
          {
            scheduledOrderId,
            failures: err.failures || null,
            reason,
            action: 'scheduled_order_failed',
          },
          'Scheduled order marked FAILED due to stock/catalog issue'
        )
        return {
          status: 'FAILED',
          scheduledOrderId,
          reason,
          failures: err.failures || [],
        }
      }

      // Unexpected infrastructure error — let BullMQ retry. Log and
      // re-throw so attempts/backoff kick in.
      logger.error(
        {
          scheduledOrderId,
          err: err.message,
          action: 'scheduled_order_fire_error',
        },
        'Scheduled order fire failed unexpectedly'
      )
      throw err
    } finally {
      client.release()
    }
  }
}
