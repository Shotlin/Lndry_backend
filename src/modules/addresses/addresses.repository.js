import { query, getClient } from '../../config/database.js'

const EARTH_RADIUS_KM = 6371

/**
 * Addresses repository — all SQL queries for delivery addresses
 */
export class AddressesRepository {
  /**
   * Get all addresses for a user
   */
  async findByUser(userId) {
    const { rows } = await query(
      `SELECT id, label, address_line1, address_line2, landmark, city, state, pincode,
              lat, lng, is_default, created_at
       FROM addresses
       WHERE user_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [userId]
    )
    return rows.map(this._format)
  }

  /**
   * Find a single address by ID + user ownership check
   */
  async findByIdAndUser(id, userId) {
    const { rows } = await query(
      `SELECT id, label, address_line1, address_line2, landmark, city, state, pincode,
              lat, lng, is_default, created_at, updated_at
       FROM addresses
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Create a new address
   */
  async create(userId, data) {
    const { rows } = await query(
      `INSERT INTO addresses (user_id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at`,
      [
        userId,
        data.label || 'Home',
        data.addressLine1,
        data.addressLine2 || null,
        data.landmark || null,
        data.city,
        data.state || null,
        data.pincode,
        data.lat || null,
        data.lng || null,
        data.isDefault || false,
      ]
    )
    return this._format(rows[0])
  }

  /**
   * Update an address
   */
  async update(id, userId, data) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = {
      label: 'label',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      landmark: 'landmark',
      city: 'city',
      state: 'state',
      pincode: 'pincode',
      lat: 'lat',
      lng: 'lng',
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }

    if (fields.length === 0) return this.findByIdAndUser(id, userId)

    fields.push(`updated_at = NOW()`)
    params.push(id, userId)

    const { rows } = await query(
      `UPDATE addresses SET ${fields.join(', ')}
       WHERE id = $${idx} AND user_id = $${idx + 1}
       RETURNING id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at, updated_at`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Delete an address
   */
  async delete(id, userId) {
    const result = await query(
      `DELETE FROM addresses WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )
    return result.rowCount > 0
  }

  /**
   * Set an address as default (unset all others first — transaction)
   */
  async setDefault(id, userId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE addresses SET is_default = false, updated_at = NOW() WHERE user_id = $1`,
        [userId]
      )
      const { rows } = await client.query(
        `UPDATE addresses SET is_default = true, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at, updated_at`,
        [id, userId]
      )
      await client.query('COMMIT')
      return rows[0] ? this._format(rows[0]) : null
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Count addresses for a user
   */
  async countByUser(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM addresses WHERE user_id = $1`,
      [userId]
    )
    return rows[0].count
  }

  /**
   * Count how many active, non-deleted vendors serve the given coords using Haversine formula
   */
  async countServiceableVendorsAtCoords(lat, lng) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT s.id,
                (${EARTH_RADIUS_KM} * acos(
                  LEAST(1.0, GREATEST(-1.0,
                    cos(radians($1::float8)) * cos(radians(s.lat::float8))
                      * cos(radians(s.lng::float8) - radians($2::float8))
                      + sin(radians($1::float8)) * sin(radians(s.lat::float8))
                  ))
                ))::numeric(7,2) AS distance_km,
                s.delivery_radius_km
           FROM vendors s
          WHERE s.is_active = true
            AND s.deleted_at IS NULL
       ) candidates
       WHERE distance_km <= delivery_radius_km`,
      [lat, lng]
    )
    return rows[0]?.count || 0
  }

  /**
   * Format snake_case DB row to camelCase JS
   */
  _format(row) {
    return {
      id:           row.id,
      label:        row.label,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      landmark:     row.landmark,
      city:         row.city,
      state:        row.state,
      pincode:      row.pincode,
      lat:          row.lat ? parseFloat(row.lat) : null,
      lng:          row.lng ? parseFloat(row.lng) : null,
      isDefault:    row.is_default,
      createdAt:    row.created_at,
      updatedAt:    row.updated_at,
    }
  }
}
