import { query } from '../../../config/database.js'

// Column prefix per mode. Whitelisted constants only — the prefix is interpolated into SQL.
const PREFIX = { TEST: 'test', LIVE: 'live' }

// 10s in-process cache, dropped immediately on every write in THIS process.
// The other API/worker processes pick a change up within one TTL.
let _cache
let _cacheAt = 0
const CACHE_TTL_MS = 10_000

export class RazorpaySettingsRepository {
  async get() {
    const { rows } = await query('SELECT * FROM razorpay_settings LIMIT 1')
    return rows[0] ? this._format(rows[0]) : null
  }

  async getCached() {
    const now = Date.now()
    if (_cache !== undefined && now - _cacheAt < CACHE_TTL_MS) return _cache
    _cache = await this.get()
    _cacheAt = now
    return _cache
  }

  invalidateCache() {
    _cache = undefined
    _cacheAt = 0
  }

  async _ensureRow() {
    await query('INSERT INTO razorpay_settings (id) VALUES (uuid_generate_v4()) ON CONFLICT ((1)) DO NOTHING')
  }

  /**
   * Updates one mode's credentials. Only the fields present in `fields` change:
   * keyId + keySecretEnc (together), webhookSecretEnc (null clears), test (last-test result).
   */
  async saveCredentials(mode, { keyId, keySecretEnc, webhookSecretEnc, test }, updatedBy) {
    const p = PREFIX[mode]
    if (!p) throw new Error(`Unknown Razorpay mode: ${mode}`)
    await this._ensureRow()
    const sets = []
    const params = []
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`) }
    if (keyId !== undefined) { add(`${p}_key_id`, keyId); add(`${p}_key_secret_enc`, keySecretEnc ?? null) }
    if (webhookSecretEnc !== undefined) add(`${p}_webhook_secret_enc`, webhookSecretEnc)
    if (test) {
      add(`${p}_last_tested_at`, new Date())
      add(`${p}_last_status`, test.success ? 'SUCCESS' : 'FAILED')
      add(`${p}_last_message`, test.message)
    }
    add('updated_by', updatedBy ?? null)
    const { rows } = await query(
      `UPDATE razorpay_settings SET ${sets.join(', ')}, updated_at = NOW() RETURNING *`,
      params,
    )
    this.invalidateCache()
    return this._format(rows[0])
  }

  async setActiveMode(mode, updatedBy) {
    await this._ensureRow()
    const { rows } = await query(
      'UPDATE razorpay_settings SET active_mode = $1, updated_by = $2, updated_at = NOW() RETURNING *',
      [mode, updatedBy ?? null],
    )
    this.invalidateCache()
    return this._format(rows[0])
  }

  async clearCredentials(mode, updatedBy) {
    const p = PREFIX[mode]
    if (!p) throw new Error(`Unknown Razorpay mode: ${mode}`)
    await this._ensureRow()
    const { rows } = await query(
      `UPDATE razorpay_settings SET ${p}_key_id = NULL, ${p}_key_secret_enc = NULL, ${p}_webhook_secret_enc = NULL,
         ${p}_last_tested_at = NULL, ${p}_last_status = NULL, ${p}_last_message = NULL,
         updated_by = $1, updated_at = NOW() RETURNING *`,
      [updatedBy ?? null],
    )
    this.invalidateCache()
    return this._format(rows[0])
  }

  async countPendingPayments() {
    try {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE status = 'PENDING' AND expires_at > NOW()`,
      )
      return rows[0]?.n ?? 0
    } catch {
      return 0
    }
  }

  _side(row, p) {
    return {
      keyId: row[`${p}_key_id`],
      keySecretEnc: row[`${p}_key_secret_enc`],
      webhookSecretEnc: row[`${p}_webhook_secret_enc`],
      lastTestedAt: row[`${p}_last_tested_at`],
      lastStatus: row[`${p}_last_status`],
      lastMessage: row[`${p}_last_message`],
    }
  }

  _format(row) {
    return {
      id: row.id,
      activeMode: row.active_mode,
      TEST: this._side(row, 'test'),
      LIVE: this._side(row, 'live'),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }
  }
}
