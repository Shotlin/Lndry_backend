import { query } from '../../../config/database.js'
import { invalidateSmsConfigCache } from '../../../utils/sms-config.js'

export class TwoFactorSettingsRepository {
  async get() {
    const { rows } = await query('SELECT * FROM two_factor_settings LIMIT 1')
    return rows[0] ? this._format(rows[0]) : null
  }

  async upsert({ apiKeyEnc, template, isEnabled, testResult, balance }, updatedBy) {
    const { rows } = await query(
      `INSERT INTO two_factor_settings (id, api_key_enc, template, is_enabled, last_tested_at, last_test_status, last_test_message, last_balance, updated_by)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ((1)) DO UPDATE SET
         api_key_enc = EXCLUDED.api_key_enc,
         template = EXCLUDED.template,
         is_enabled = EXCLUDED.is_enabled,
         last_tested_at = EXCLUDED.last_tested_at,
         last_test_status = EXCLUDED.last_test_status,
         last_test_message = EXCLUDED.last_test_message,
         last_balance = EXCLUDED.last_balance,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [
        apiKeyEnc ?? null,
        template,
        isEnabled,
        testResult ? new Date() : null,
        testResult ? (testResult.success ? 'SUCCESS' : 'FAILED') : null,
        testResult ? testResult.message : null,
        balance ?? null,
        updatedBy ?? null,
      ],
    )
    invalidateSmsConfigCache()
    return this._format(rows[0])
  }

  async clear(updatedBy) {
    const { rows } = await query(
      `UPDATE two_factor_settings SET api_key_enc = NULL, is_enabled = false, last_tested_at = NULL,
         last_test_status = NULL, last_test_message = NULL, last_balance = NULL, updated_by = $1, updated_at = NOW()
       RETURNING *`,
      [updatedBy ?? null],
    )
    invalidateSmsConfigCache()
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      id: row.id,
      apiKeyEnc: row.api_key_enc,
      template: row.template,
      isEnabled: row.is_enabled,
      lastTestedAt: row.last_tested_at,
      lastTestStatus: row.last_test_status,
      lastTestMessage: row.last_test_message,
      lastBalance: row.last_balance,
      updatedAt: row.updated_at,
    }
  }
}
