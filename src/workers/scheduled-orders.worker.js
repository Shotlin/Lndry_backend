import { logger } from '../config/logger.js'
import { scheduledOrdersQueue } from '../config/bullmq.js'
import { ScheduledOrdersRepository } from '../modules/scheduled-orders/scheduled-orders.repository.js'
import { ScheduledOrdersService } from '../modules/scheduled-orders/scheduled-orders.service.js'
import { OrdersRepository } from '../modules/orders/orders.repository.js'
import { OrderSplitterService } from '../modules/orders/order-splitter.service.js'
import { ShopProductsRepository } from '../modules/shop-garment_rates/shop-garment_rates.repository.js'

/**
 * Scheduled-orders worker — processes BullMQ `scheduled-orders` queue jobs.
 *
 * Job types:
 *   - `fire-scheduled-order` — Triggered at the row's `scheduled_for`. The
 *     processor locks the row (SELECT FOR UPDATE), validates stock,
 *     places a real per-shop order via the OrderSplitter, links
 *     `placed_order_id`, computes the next recurrence, and enqueues a
 *     delayed job for the successor. On stock failure it marks the row
 *     FAILED + sends a customer push notification (Req 10.4).
 *
 * Resource budget (Req 10.2, 10.3, 10.4, 10.5; design.md Background Job
 * Architecture):
 *   - Concurrency 3 (configured at worker registration in bullmq.js)
 *   - 3 attempts with exponential backoff (2s base) — queue defaults
 *   - Per-job timeout governed by BullMQ stalled detection; service
 *     paths are short (single transaction, ≤50 items per schedule)
 *   - Structured logs `{ scheduledOrderId, action }`
 *
 * Idempotency: each fire is wrapped in a transaction with a SELECT FOR
 * UPDATE + guarded UPDATE (status=SCHEDULED → PROCESSING). A retry that
 * lands on a row already in PROCESSING / PLACED / FAILED / CANCELLED
 * exits cleanly via `processFire` returning `{ status: 'NOOP' }`.
 *
 * The actual lifecycle logic lives on `ScheduledOrdersService.processFire`
 * — the worker is intentionally a thin BullMQ dispatcher so the same
 * service path is exercised from unit tests without spinning up a queue.
 */

/**
 * Build a job processor bound to a fresh repository/service instance. The
 * factory lets tests substitute mocks for any collaborator and keeps
 * module imports side-effect free (no DB / Redis at import time).
 *
 * @param {object} [deps]
 * @param {ScheduledOrdersService} [deps.scheduledOrdersService]
 * @param {object} [deps.ordersService] - Optional, reserved for future use
 * @param {object} [deps.queue] - Override BullMQ queue (tests)
 * @param {object} [deps.notificationsService] - Optional notifications
 *   gateway — passed through to the service so stock-failure push
 *   notifications can be sent (Req 10.4).
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createScheduledOrderProcessor(deps = {}) {
  const queue = deps.queue || scheduledOrdersQueue

  // If the caller didn't pre-build a service, wire up the default
  // collaborator graph. Tests will pass an explicit `scheduledOrdersService`
  // so this branch is only taken in production.
  const service =
    deps.scheduledOrdersService ||
    (() => {
      const scheduledOrdersRepo = new ScheduledOrdersRepository()
      const ordersRepo = new OrdersRepository()
      const shopProductsRepo = new ShopProductsRepository()
      const orderSplitter = new OrderSplitterService({
        ordersRepository: ordersRepo,
        shopProductsRepository: shopProductsRepo,
      })
      return new ScheduledOrdersService(scheduledOrdersRepo, {
        queue,
        ordersRepository: ordersRepo,
        shopProductsRepository: shopProductsRepo,
        orderSplitter,
        // notificationsService is injected by the runtime when Fastify
        // is available; for the standalone worker-process boot path the
        // stock-failure push notification is a best-effort no-op.
        notificationsService: deps.notificationsService || null,
      })
    })()

  return async function processScheduledOrderJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'fire-scheduled-order') {
      const scheduledOrderId = job?.data?.scheduledOrderId
      if (!scheduledOrderId) {
        logger.warn(
          {
            jobId: job?.id,
            action: 'scheduled_order_fire_missing_id',
          },
          'fire-scheduled-order job missing scheduledOrderId'
        )
        return { ignored: true, reason: 'MISSING_ID' }
      }
      return service.processFire({
        scheduledOrderId,
        ordersService: deps.ordersService || null,
      })
    }

    logger.warn(
      {
        jobId: job?.id,
        type,
        action: 'scheduled_order_unknown_job_type',
      },
      'Unknown scheduled-orders job type'
    )
    return { ignored: true }
  }
}
