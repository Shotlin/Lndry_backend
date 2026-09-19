import { logger } from '../../config/logger.js'

/**
 * Queues invoice issuing for an order that has just been delivered.
 *
 * Fire-and-forget by design: delivering an order must never wait on, or fail
 * because of, PDF generation. The BullMQ worker (`generate-invoice`, see
 * workers/processors.js) does the work a few seconds later — after the
 * delivering transaction has committed — and retries on failure. If it never
 * runs, nothing is lost: the invoice is simply issued on the customer's first
 * request instead.
 */
export function scheduleInvoiceForDeliveredOrder(orderId) {
  if (process.env.NODE_ENV === 'test') return
  setImmediate(async () => {
    try {
      const { orderQueue } = await import('../../config/bullmq.js')
      await orderQueue.add(
        'generate-invoice',
        { type: 'generate-invoice', orderId },
        { delay: 5000, jobId: `generate-invoice-${orderId}` }
      )
    } catch (err) {
      logger.warn({ err: err.message, orderId }, 'Could not queue invoice generation (will be issued on first request)')
    }
  })
}
