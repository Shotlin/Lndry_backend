import { logger } from '../../config/logger.js'

/**
 * Queue the lifecycle notifications for an order status change.
 *
 * Fire-and-forget on purpose: it is called from inside the transaction that
 * records the status change, so the actual work happens a moment later (in the
 * worker, after the commit) and can never fail or slow the change itself. The
 * job id makes the same transition coalesce while it is waiting; the
 * `notification_events` table is what guarantees a notification is never sent
 * twice even if the job is retried or added again.
 */
export function scheduleLifecycleNotification(orderId, oldStatus, newStatus) {
  if (process.env.NODE_ENV === 'test') return
  setImmediate(async () => {
    try {
      const { orderQueue } = await import('../../config/bullmq.js')
      await orderQueue.add(
        'lifecycle-notify',
        { type: 'lifecycle-notify', orderId, oldStatus, newStatus },
        {
          delay: 2000,
          jobId: `lifecycle-${orderId}-${newStatus}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        }
      )
    } catch (err) {
      logger.warn({ err: err.message, orderId, newStatus }, 'Could not queue lifecycle notification')
    }
  })
}

/** Send an event right away (OTP generated, payment received …). Never throws. */
export async function emitLifecycleEvent(eventKey, opts) {
  try {
    const { lifecycleNotifications } = await import('./lifecycle-notifications.service.js')
    return await lifecycleNotifications().emit(eventKey, opts)
  } catch (err) {
    logger.warn({ err: err.message, eventKey, orderId: opts?.orderId }, 'Lifecycle event failed (non-critical)')
    return []
  }
}
