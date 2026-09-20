import { logger } from '../config/logger.js'
import { WalletRedemptionService } from '../modules/wallet-redemption/wallet-redemption.service.js'

/**
 * Wallet reconciliation. Every few minutes, any in-store wallet redemption that took money out of a customer's wallet
 * but was never used for a sale is returned to that wallet (once, audit-logged, customer notified).
 *
 * With the reservation model the wallet is only debited inside the order's own transaction, so this should find nothing
 * for new redemptions — it exists for redemptions approved before that model (which debited at approval) and as a
 * permanent safety net: money must never leave a wallet without a sale to show for it.
 */
const INTERVAL_MS = 5 * 60 * 1000
const MIN_AGE_MINUTES = 30 // long enough that an operator finishing a sale never races the refund
let _intervalHandle = null

export function startWalletReconcileWorker() {
  if (_intervalHandle) return
  const service = new WalletRedemptionService()
  const run = () =>
    service.refundStranded({ minutes: MIN_AGE_MINUTES }).catch((err) =>
      logger.error({ err: err.message }, 'Wallet reconciliation sweep failed')
    )
  logger.info('Wallet reconciliation worker started (checking every 5 minutes)')
  _intervalHandle = setInterval(run, INTERVAL_MS)
  _intervalHandle.unref?.()
  setTimeout(run, 20_000).unref?.()
}

export function stopWalletReconcileWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
}
