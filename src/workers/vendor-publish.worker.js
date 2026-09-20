import { logger } from '../config/logger.js'
import { autoPublishReadyVendors } from '../modules/vendors/vendor-publishing.js'

/**
 * Safety net for automatic marketplace publishing: every minute, publish any
 * vendor that has become service-ready by a route the request-time hooks don't
 * cover (an admin edit, a bulk import, a direct correction…). The work is one
 * idempotent SQL statement, so overlapping runs or a second worker are harmless.
 */
const INTERVAL_MS = 60 * 1000
let _intervalHandle = null

export function startVendorPublishWorker() {
  if (_intervalHandle) return
  logger.info('Vendor auto-publish worker started (sweeping every minute)')
  const run = () =>
    autoPublishReadyVendors().catch((err) =>
      logger.error({ err: err.message }, 'Vendor auto-publish sweep failed')
    )
  _intervalHandle = setInterval(run, INTERVAL_MS)
  _intervalHandle.unref?.()
  run()
}

export function stopVendorPublishWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
}
