import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { query } from '../config/database.js'
import { decryptSecret } from './secret-box.js'

// 10s in-process cache; the dashboard save path clears it in its own process (other processes: <=10s).
let _cache
let _cacheAt = 0
const TTL_MS = 10_000

export function invalidateSmsConfigCache() {
  _cache = undefined
  _cacheAt = 0
}

/**
 * The SMS (2Factor.in) configuration in force right now:
 *   1. Dashboard (Settings -> SMS / OTP) when saved AND switched on;
 *   2. otherwise the old env vars (SMS_PROVIDER=2factor + TWO_FACTOR_API_KEY);
 *   3. otherwise null (no real SMS can be sent).
 * Never throws — any problem falls back to the env path.
 *
 * @returns {Promise<null | { apiKey: string, template: string, source: 'dashboard'|'env' }>}
 */
export async function getSmsConfig() {
  const now = Date.now()
  if (_cache !== undefined && now - _cacheAt < TTL_MS) return _cache
  let result = null
  try {
    const { rows } = await query(
      'SELECT api_key_enc, template, is_enabled FROM two_factor_settings LIMIT 1',
    )
    const row = rows?.[0]
    if (row?.is_enabled && row.api_key_enc) {
      result = { apiKey: decryptSecret(row.api_key_enc), template: row.template || 'LndryAppOTP', source: 'dashboard' }
    }
  } catch (err) {
    logger.error({ err: err?.message }, 'Could not load SMS settings from the database — using environment values')
  }
  if (!result && env.SMS_PROVIDER === '2factor' && env.TWO_FACTOR_API_KEY) {
    result = {
      apiKey: env.TWO_FACTOR_API_KEY,
      template: env.TWO_FACTOR_TEMPLATE || env.TWO_FACTOR_SENDER || 'LndryAppOTP',
      source: 'env',
    }
  }
  _cache = result
  _cacheAt = now
  return result
}
