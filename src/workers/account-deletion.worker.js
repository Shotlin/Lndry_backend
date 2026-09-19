/**
 * Account Deletion Worker
 *
 * Polls hourly for approved deletion requests whose 30-day grace period has
 * ended and anonymizes the account (see AccountDeletionRepository
 * #anonymizeNextDue). Idempotent and multi-instance safe: each request is
 * claimed with SELECT ... FOR UPDATE SKIP LOCKED inside its own transaction.
 */
import { redis } from '../config/redis.js'
import { logger } from '../config/logger.js'
import { AccountDeletionRepository } from '../modules/admin/account-deletion/account-deletion.repository.js'
import { emit as emitAudit } from '../utils/audit-log.js'

const POLL_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const MAX_PER_RUN = 50

let _intervalHandle = null

export function startAccountDeletionWorker() {
  if (_intervalHandle) return
  logger.info('Account deletion worker started (polling hourly)')

  _intervalHandle = setInterval(() => {
    processDueAccountDeletions().catch((err) =>
      logger.error({ err: err.message }, 'Account deletion worker poll error')
    )
  }, POLL_INTERVAL_MS)
  _intervalHandle.unref?.()

  processDueAccountDeletions().catch((err) =>
    logger.error({ err: err.message }, 'Account deletion worker initial poll error')
  )
}

export function stopAccountDeletionWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Account deletion worker stopped')
  }
}

export async function processDueAccountDeletions(repo = new AccountDeletionRepository()) {
  let done = 0
  for (let i = 0; i < MAX_PER_RUN; i++) {
    const result = await repo.anonymizeNextDue()
    if (!result) break
    done++
    try {
      await redis.del(`refresh:${result.userId}`)
    } catch (err) {
      logger.warn({ err: err.message, userId: result.userId }, 'Refresh-token cleanup failed after anonymization')
    }
    emitAudit('account_deletion_completed', {
      actor_user_id: null,
      actor_role: 'SYSTEM',
      target_type: 'account_deletion_request',
      target_id: result.requestId,
      before: null,
      after: { status: 'COMPLETED' },
    })
    logger.info({ requestId: result.requestId }, 'Account anonymized after grace period')
  }
  return done
}
