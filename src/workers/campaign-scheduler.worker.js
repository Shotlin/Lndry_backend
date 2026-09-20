/**
 * Campaign Scheduler Worker
 * Polls DB every 20 seconds for SCHEDULED campaigns that are due.
 * Uses SELECT FOR UPDATE SKIP LOCKED to prevent duplicate sends if
 * multiple backend instances are running.
 *
 * Safe restart: campaigns in status=SENDING that are stuck (backend
 * crashed) should be retried — for MVP we just log them.
 */
import { AdminNotificationsRepository } from '../modules/admin/notifications/notifications.repository.js'
import { AdminNotificationsService } from '../modules/admin/notifications/notifications.service.js'
import { logger } from '../config/logger.js'

const repo = new AdminNotificationsRepository()
const svc = new AdminNotificationsService()

let _intervalHandle = null
const POLL_INTERVAL_MS = 20_000

export function startCampaignScheduler() {
  if (_intervalHandle) return

  logger.info('Campaign scheduler started (polling every 20s)')

  _intervalHandle = setInterval(async () => {
    try {
      await _processDueCampaigns()
    } catch (err) {
      logger.error({ err: err.message }, 'Campaign scheduler poll error')
    }
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup
  _processDueCampaigns().catch(err =>
    logger.error({ err: err.message }, 'Campaign scheduler initial poll error')
  )
}

export function stopCampaignScheduler() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Campaign scheduler stopped')
  }
}

async function _processDueCampaigns() {
  // A crash mid-send would leave a campaign in SENDING forever.
  const stuck = await repo.failStuckSending(30)
  if (stuck.length) logger.warn({ ids: stuck.map((c) => c.id) }, 'Marked stuck campaigns as FAILED')

  const due = await repo.findDueScheduledCampaigns()
  if (!due.length) return

  logger.info({ count: due.length }, 'Processing due scheduled campaigns')

  for (const campaign of due) {
    const locked = await repo.lockAndMarkSending(campaign.id)
    if (!locked) {
      // Another instance already picked it up
      continue
    }

    logger.info({ campaignId: campaign.id }, 'Executing scheduled campaign')
    try {
      // The executor reads the stored audience, content and link from the row,
      // so the send matches exactly what the admin scheduled.
      await svc.executeScheduledCampaign(campaign.id)
    } catch (err) {
      logger.error({ err: err.message, campaignId: campaign.id }, 'Scheduled campaign execution failed')
      await repo.updateCampaignStatus(campaign.id, 'FAILED', {
        failureSummary: { reason: err.message },
      })
    }
  }
}
