import { query, getClient } from '../../../config/database.js'

const COLUMNS = `enabled, scope, title, subtitle, button_text, icon_url, checkout_note,
  assessment_title, assessment_message, price_label, updated_by, updated_at`

/**
 * Assisted booking ("Book With Expert Check") settings — one GLOBAL row plus
 * an optional per-vendor selection (migration 147).
 */
export class AssistedBookingRepository {
  async getSettings() {
    const { rows } = await query(`SELECT ${COLUMNS} FROM assisted_booking_settings WHERE id = 'GLOBAL'`)
    return rows[0] ? this._format(rows[0]) : null
  }

  async listSelectedVendors() {
    const { rows } = await query(
      `SELECT v.id, v.name
         FROM assisted_booking_vendors abv
         JOIN vendors v ON v.id = abv.vendor_id
        WHERE v.deleted_at IS NULL
        ORDER BY v.name ASC`
    )
    return rows
  }

  async isVendorSelected(vendorId) {
    const { rows } = await query(
      `SELECT 1 FROM assisted_booking_vendors WHERE vendor_id = $1`,
      [vendorId]
    )
    return rows.length > 0
  }

  /** Which of [ids] are real, live vendors. */
  async findExistingVendorIds(ids) {
    if (ids.length === 0) return []
    const { rows } = await query(
      `SELECT id FROM vendors WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids]
    )
    return rows.map((r) => r.id)
  }

  /**
   * Saves the settings and (when [vendorIds] is given) replaces the selected
   * vendors — both in one transaction so a half-saved state never exists.
   */
  async save(settings, vendorIds, updatedBy) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE assisted_booking_settings
            SET enabled = $1, scope = $2, title = $3, subtitle = $4, button_text = $5,
                icon_url = $6, checkout_note = $7, assessment_title = $8,
                assessment_message = $9, price_label = $10, updated_by = $11, updated_at = NOW()
          WHERE id = 'GLOBAL'`,
        [
          settings.enabled, settings.scope, settings.title, settings.subtitle, settings.buttonText,
          settings.iconUrl, settings.checkoutNote, settings.assessmentTitle,
          settings.assessmentMessage, settings.priceLabel, updatedBy,
        ]
      )
      if (Array.isArray(vendorIds)) {
        await client.query('DELETE FROM assisted_booking_vendors')
        if (vendorIds.length > 0) {
          await client.query(
            `INSERT INTO assisted_booking_vendors (vendor_id)
             SELECT UNNEST($1::uuid[]) ON CONFLICT DO NOTHING`,
            [vendorIds]
          )
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  _format(row) {
    return {
      enabled: row.enabled,
      scope: row.scope,
      title: row.title,
      subtitle: row.subtitle,
      buttonText: row.button_text,
      iconUrl: row.icon_url || null,
      checkoutNote: row.checkout_note,
      assessmentTitle: row.assessment_title,
      assessmentMessage: row.assessment_message,
      priceLabel: row.price_label,
      updatedAt: row.updated_at,
    }
  }
}
