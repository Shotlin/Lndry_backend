import { query } from '../../../config/database.js'

// 30s in-memory cache, invalidated immediately on every write — a dashboard
// save takes effect on the very next request, no redeploy/restart needed.
let _cache = null
let _cacheAt = 0
const CACHE_TTL_MS = 30_000

export class OlaMapsSettingsRepository {
  async get() {
    const { rows } = await query(
      `SELECT id, api_key, is_enabled, last_tested_at, last_test_status, last_test_message, updated_at, updated_by
       FROM ola_maps_settings LIMIT 1`
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Cached read for the hot customer-facing proxy path — most requests
   * don't need to hit Postgres just to check whether Ola Maps is enabled.
   */
  async getCached() {
    const now = Date.now()
    if (_cache !== null && now - _cacheAt < CACHE_TTL_MS) {
      return _cache
    }
    const settings = await this.get()
    _cache = settings
    _cacheAt = now
    return settings
  }

  invalidateCache() {
    _cache = null
    _cacheAt = 0
  }

  async upsert({ apiKey, isEnabled, testResult, updatedBy }) {
    const { rows } = await query(
      `INSERT INTO ola_maps_settings (id, api_key, is_enabled, last_tested_at, last_test_status, last_test_message, updated_by)
       VALUES (uuid_generate_v4(), $1, $2, NOW(), $3, $4, $5)
       ON CONFLICT ((1)) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         is_enabled = EXCLUDED.is_enabled,
         last_tested_at = EXCLUDED.last_tested_at,
         last_test_status = EXCLUDED.last_test_status,
         last_test_message = EXCLUDED.last_test_message,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by
       RETURNING id, api_key, is_enabled, last_tested_at, last_test_status, last_test_message, updated_at, updated_by`,
      [
        apiKey ?? null,
        isEnabled,
        testResult ? (testResult.success ? 'SUCCESS' : 'FAILED') : null,
        testResult ? testResult.message : null,
        updatedBy ?? null,
      ]
    )
    this.invalidateCache()
    return this._format(rows[0])
  }

  _format(row) {
    return {
      id: row.id,
      apiKey: row.api_key,
      isEnabled: row.is_enabled,
      lastTestedAt: row.last_tested_at,
      lastTestStatus: row.last_test_status,
      lastTestMessage: row.last_test_message,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }
  }
}
