import { query } from '../../config/database.js'

/**
 * Rider Assignment Settings repository — the single GLOBAL row backing
 * the Phase 5 dashboard settings page (see CLAUDE.md's rider-assignment
 * initiative). Mirrors fee-settings.repository.js's one-row-config
 * pattern, minus the per-shop STORE override (not needed here — the
 * broadcast timeout is platform-wide, not per-vendor).
 */
const COLUMNS = `id, broadcast_timeout_minutes, created_at, updated_at, updated_by`

export class RiderAssignmentSettingsRepository {
  async get() {
    const { rows } = await query(`SELECT ${COLUMNS} FROM rider_assignment_settings LIMIT 1`)
    return rows[0] ? this._format(rows[0]) : null
  }

  async update({ broadcast_timeout_minutes }, updatedBy = null) {
    const { rows } = await query(
      `UPDATE rider_assignment_settings
       SET broadcast_timeout_minutes = $1, updated_by = $2, updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [broadcast_timeout_minutes, updatedBy]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** @private coerce the DECIMAL/INTEGER columns to numbers. */
  _format(row) {
    return { ...row, broadcast_timeout_minutes: Number(row.broadcast_timeout_minutes) }
  }
}
