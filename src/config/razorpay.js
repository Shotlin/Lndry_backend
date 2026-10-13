import Razorpay from 'razorpay'
import { env } from './env.js'
import { logger } from './logger.js'
import { decryptSecret } from '../utils/secret-box.js'
import { RazorpaySettingsRepository } from '../modules/admin/razorpay-settings/razorpay-settings.repository.js'

const settingsRepo = new RazorpaySettingsRepository()

let _client = null
let _clientSig = null

function clientFor(keyId, keySecret) {
  const sig = `${keyId}:${keySecret}`
  if (_client && _clientSig === sig) return _client
  _client = new Razorpay({ key_id: keyId, key_secret: keySecret })
  _clientSig = sig
  return _client
}

/**
 * The Razorpay credentials in force right now:
 *   1. the dashboard's active mode (Settings -> Payments, TEST or LIVE), if its keys are saved;
 *   2. otherwise the old RAZORPAY_* environment variables;
 *   3. otherwise null (payments not configured).
 * Always call this per request — never cache the result across requests, so a mode switch or key
 * change applies within seconds (the settings are cached for ~10s per process).
 *
 * @returns {Promise<null | { client, keyId, keySecret, webhookSecret, mode: 'TEST'|'LIVE', source: 'dashboard'|'env' }>}
 */
export async function getRazorpay() {
  try {
    const row = await settingsRepo.getCached()
    const side = row?.[row.activeMode]
    if (side?.keyId && side?.keySecretEnc) {
      const keySecret = decryptSecret(side.keySecretEnc)
      return {
        client: clientFor(side.keyId, keySecret),
        keyId: side.keyId,
        keySecret,
        webhookSecret: side.webhookSecretEnc ? decryptSecret(side.webhookSecretEnc) : null,
        mode: row.activeMode,
        source: 'dashboard',
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Could not load Razorpay settings from the database — using environment keys')
  }

  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    return {
      client: clientFor(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET),
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || null,
      mode: env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'LIVE' : 'TEST',
      source: 'env',
    }
  }
  return null
}
