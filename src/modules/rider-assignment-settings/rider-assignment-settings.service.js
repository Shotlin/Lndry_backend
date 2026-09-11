import { RiderAssignmentSettingsRepository } from './rider-assignment-settings.repository.js'
import { logger } from '../../config/logger.js'

/**
 * Rider Assignment Settings service — read/write the single GLOBAL
 * config row. VendorOrdersService#_scheduleBroadcastTimeout reads
 * broadcast_timeout_minutes here on every broadcast/retry instead of the
 * Phase 4 hardcoded constant.
 */
export class RiderAssignmentSettingsService {
  constructor(repository = new RiderAssignmentSettingsRepository()) {
    this.repo = repository
  }

  /** Return the settings row, or a safe in-memory default if it's somehow missing. */
  async get() {
    const config = await this.repo.get()
    return config || this._safeDefault()
  }

  async update(data, actor = null) {
    const updated = await this.repo.update(data, actor?.id || null)
    logger.info(
      { userId: actor?.id || null, action: 'rider_assignment_settings_updated' },
      'Rider assignment settings updated'
    )
    return updated || this._safeDefault()
  }

  /** @private mirrors the migration's default — checkout must never crash on a missing row. */
  _safeDefault() {
    return { id: null, broadcast_timeout_minutes: 15 }
  }
}
