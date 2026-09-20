import { logger } from '../config/logger.js'
import {
  orderQueue,
  settlementQueue,
  payoutQueue,
  closeBullMQ,
  startNotificationWorker,
  startOrderWorker,
  startSmsWorker,
  startThemeWorker,
  startAllocationWorker,
  startSettlementWorker,
  startPayoutWorker,
  startScheduledOrderWorker,
  startStockNotificationsWorker,
  startReportPrecomputeWorker,
  startVendorAutoRejectWorker,
  startSlotHoldExpiryWorker,
} from '../config/bullmq.js'


export async function startWorkerRuntime() {
  const {
    processNotificationJob,
    processOrderJob,
    processSmsJob,
    processThemeJob,
    clearLegacyAssignmentTimeoutJobs,
  } = await import('../workers/processors.js')

  // const { createAllocationProcessor } = await import(
  //   '../workers/allocation.worker.js'
  // )

  const { createSettlementProcessor, scheduleSettlementCron } = await import(
    '../workers/settlement.worker.js'
  )

  const { createPayoutProcessor, schedulePayoutCron } = await import(
    '../workers/payout.worker.js'
  )

  // const { createScheduledOrderProcessor } = await import(
  //   '../workers/scheduled-orders.worker.js'
  // )

  // const { createStockNotificationsProcessor } = await import(
  //   '../workers/stock-notifications.worker.js'
  // )

  // const { createReportPrecomputeProcessor } = await import(
  //   '../workers/report-precompute.worker.js'
  // )

  const { startEventLoopMonitor } = await import(
    '../utils/event-loop-monitor.js'
  )

  startNotificationWorker(processNotificationJob)
  startOrderWorker(processOrderJob)
  startSmsWorker(processSmsJob)
  startThemeWorker(processThemeJob)
  // startAllocationWorker(createAllocationProcessor())
  startSettlementWorker(
    createSettlementProcessor({ queue: settlementQueue })
  )
  startPayoutWorker(createPayoutProcessor({ queue: payoutQueue }))
  // Scheduled-orders worker (task 10.3) — fires customer scheduled orders
  // at their scheduled_for time, places real orders, marks FAILED on
  // stock issues, and creates the next recurrence row when applicable.
  // startScheduledOrderWorker(createScheduledOrderProcessor())
  // Stock-notifications worker (task 13.2) — fans out restock push +
  // in-app notifications to every customer who wishlisted a product
  // when its Shop_Product transitions from stock 0 → positive
  // (Requirements 3.4, 11.6).
  // startStockNotificationsWorker(createStockNotificationsProcessor())
  // Report-precompute worker (task 13.4) — runs slow report queries
  // (>100ms median) and caches results to Redis under deterministic keys.
  // startReportPrecomputeWorker(createReportPrecomputeProcessor())

  // LNDRY MVP workers
  const { createVendorAutoRejectProcessor, createSlotHoldExpiryProcessor } = await import(
    '../workers/lndry-jobs.worker.js'
  )
  startVendorAutoRejectWorker(createVendorAutoRejectProcessor())
  startSlotHoldExpiryWorker(createSlotHoldExpiryProcessor())


  // Customer account deletion — anonymizes approved requests once their
  // 30-day grace period is over (polls hourly).
  const { startAccountDeletionWorker } = await import(
    '../workers/account-deletion.worker.js'
  )
  startAccountDeletionWorker()

  // Publishes vendors to the customer marketplace as soon as they are
  // service-ready (approved + services + slots + location) — see
  // modules/vendors/vendor-publishing.js.
  const { startVendorPublishWorker } = await import(
    '../workers/vendor-publish.worker.js'
  )
  startVendorPublishWorker()

  // Returns any wallet money that left a customer's wallet for an in-store redemption no sale ever used.
  const { startWalletReconcileWorker } = await import(
    '../workers/wallet-reconcile.worker.js'
  )
  startWalletReconcileWorker()

  // Event-loop blocking detector (task 13.6) — logs warning when
  // the event loop is blocked for >100ms.
  startEventLoopMonitor()

  try {
    await scheduleSettlementCron(settlementQueue)
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Settlement daily cron registration failed'
    )
  }

  try {
    await schedulePayoutCron(payoutQueue)
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Payout weekly cron registration failed'
    )
  }

  try {
    const removedTimeoutJobs = await clearLegacyAssignmentTimeoutJobs()
    if (removedTimeoutJobs > 0) {
      logger.info(
        { removedTimeoutJobs },
        'Cleared legacy assignment timeout jobs'
      )
    }
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Legacy assignment timeout jobs were not cleared'
    )
  }

  try {
    await orderQueue.add(
      'auto-assign-backlog',
      { type: 'auto-assign-backlog', limit: 500 },
      {
        jobId: 'auto-assign-backlog-startup',
        removeOnComplete: true,
        removeOnFail: true,
      }
    )
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Startup backlog auto-assign job was not queued'
    )
  }

  logger.info('BullMQ workers started')
}

export async function closeWorkerRuntime() {
  const { stopAccountDeletionWorker } = await import(
    '../workers/account-deletion.worker.js'
  )
  stopAccountDeletionWorker()
  await closeBullMQ()
  logger.info('BullMQ queues and workers closed')
}
