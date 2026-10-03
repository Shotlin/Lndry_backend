import { query } from '../../config/database.js'
import { emit as emitAudit } from '../../utils/audit-log.js'

/**
 * Counter (POS) settings kept on the server, one JSON document per
 * (vendor, setting). Replaces the browser-only storage the counter website
 * used before, so every computer and every staff member of a shop sees the
 * same settings.
 *
 * Saves are optimistic: the caller sends the `version` it last read and a
 * stale version is refused (409 VERSION_CONFLICT) instead of overwriting a
 * newer save made on another computer.
 */

/** key -> expected JSON shape. A new setting is added here (nowhere else). */
export const SETTING_KEYS = {
  'print-settings': 'object',
  'upi-qr': 'object',
  'service-zones': 'array',
  'message-templates': 'array',
  'order-no-series': 'array',
  'store-packages': 'array',
  'service-units': 'array',
  'route-runs': 'array',
}
/** Day-to-day operating data any counter staff may save; everything else is shop configuration. */
export const OPERATIONAL_KEYS = new Set(['route-runs'])

const MAX_BYTES = 256 * 1024
const MAX_ARRAY_ITEMS = 2000

const fail = (message, code = 'VALIDATION_ERROR', status = 400) => ({ success: false, message, code, status })
const shape = (row) => ({ key: row.setting_key, value: row.value, version: row.version, updatedAt: row.updated_at })

export class VendorPosSettingsService {
  async listAll(vendorId) {
    const { rows } = await query('SELECT setting_key, value, version, updated_at FROM vendor_pos_settings WHERE vendor_id = $1', [vendorId])
    return Object.fromEntries(rows.filter((row) => row.setting_key in SETTING_KEYS).map((row) => [row.setting_key, shape(row)]))
  }

  async get(vendorId, key) {
    if (!(key in SETTING_KEYS)) return fail('Unknown setting', 'NOT_FOUND', 404)
    const { rows } = await query('SELECT setting_key, value, version, updated_at FROM vendor_pos_settings WHERE vendor_id = $1 AND setting_key = $2', [vendorId, key])
    // Never saved yet: the caller falls back to its built-in defaults.
    if (!rows[0]) return { success: true, setting: { key, value: null, version: 0, updatedAt: null } }
    return { success: true, setting: shape(rows[0]) }
  }

  async put(vendorId, actor, key, input) {
    if (!(key in SETTING_KEYS)) return fail('Unknown setting', 'NOT_FOUND', 404)
    const value = input?.value
    const wanted = SETTING_KEYS[key]
    const isArray = Array.isArray(value)
    const isObject = value !== null && typeof value === 'object' && !isArray
    if ((wanted === 'array' && !isArray) || (wanted === 'object' && !isObject)) return fail(`This setting must be ${wanted === 'array' ? 'a list' : 'an object'}`)
    if (isArray && value.length > MAX_ARRAY_ITEMS) return fail(`This setting can hold at most ${MAX_ARRAY_ITEMS} entries`)
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) return fail('This setting is too large to save', 'TOO_LARGE', 413)

    const expected = input?.version === undefined || input?.version === null ? null : Number(input.version)
    if (expected !== null && (!Number.isInteger(expected) || expected < 0)) return fail('Invalid version')

    const json = JSON.stringify(value)
    let row
    if (expected === null) {
      // Caller does not track versions: last write wins (still atomic).
      row = (await query(
        `INSERT INTO vendor_pos_settings (vendor_id, setting_key, value, version, updated_by)
         VALUES ($1, $2, $3::jsonb, 1, $4)
         ON CONFLICT (vendor_id, setting_key) DO UPDATE
           SET value = EXCLUDED.value, version = vendor_pos_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING setting_key, value, version, updated_at`,
        [vendorId, key, json, actor.userId])).rows[0]
    } else if (expected === 0) {
      // "I have never seen a saved copy": only succeeds if there still isn't one.
      row = (await query(
        `INSERT INTO vendor_pos_settings (vendor_id, setting_key, value, version, updated_by)
         VALUES ($1, $2, $3::jsonb, 1, $4)
         ON CONFLICT (vendor_id, setting_key) DO NOTHING
         RETURNING setting_key, value, version, updated_at`,
        [vendorId, key, json, actor.userId])).rows[0]
    } else {
      row = (await query(
        `UPDATE vendor_pos_settings SET value = $3::jsonb, version = version + 1, updated_by = $4, updated_at = NOW()
         WHERE vendor_id = $1 AND setting_key = $2 AND version = $5
         RETURNING setting_key, value, version, updated_at`,
        [vendorId, key, json, actor.userId, expected])).rows[0]
    }
    if (!row) return fail('These settings were changed on another computer. Reload and try again.', 'VERSION_CONFLICT', 409)

    emitAudit('pos_setting_saved', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'pos_setting', target_id: vendorId,
      before: null, after: { key, version: row.version }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, setting: shape(row) }
  }
}
