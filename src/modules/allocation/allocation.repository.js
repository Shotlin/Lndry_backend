import { query, getClient } from '../../config/database.js'

/**
 * Allocation repository — all SQL queries for user_shop_allocations
 *
 * Conventions:
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Pincode lookups exploit GIN(serviceable_pincodes) on the vendors table
 *     (idx_shops_serviceable_pincodes — see migration 029)
 *   - Haversine distance is computed in SQL using the formula in design.md;
 *     the result is filtered against each shop's own delivery_radius_km
 *
 * Migration references:
 *   - src/database/migrations/029_shops.sql (vendors, GIN index)
 *   - src/database/migrations/032_user_shop_allocations.sql
 */

// Earth's radius in km used by the haversine formula
const EARTH_RADIUS_KM = 6371

export class AllocationRepository {
  // ────────────────────────────────────────────────────────
  // Read paths — used by the customer-facing GET /my-vendors
  // ────────────────────────────────────────────────────────

  /**
   * Find allocations for a user, joined with vendors to surface display fields.
   * Filters out allocations whose underlying shop has been soft-deleted or
   * deactivated (Requirement 4.5 — customers must only see active vendors).
   * @param {string} userId
   * @returns {Promise<Array<{
   *   id: string,
   *   vendor_id: string,
   *   name: string,
   *   distance_km: number|null,
   *   matched_pincode: string|null,
   *   is_primary: boolean,
   *   allocated_at: string
   * }>>}
   */
  async findByUserId(userId) {
    const { rows } = await query(
      `SELECT a.id, a.vendor_id, s.name, a.distance_km, a.matched_pincode,
              a.is_primary, a.allocated_at
         FROM user_shop_allocations a
         JOIN vendors s ON s.id = a.vendor_id
        WHERE a.user_id = $1
          AND s.is_active = true
          AND s.deleted_at IS NULL
        ORDER BY a.is_primary DESC, a.distance_km ASC NULLS LAST, a.allocated_at ASC`,
      [userId]
    )
    return rows
  }

  /**
   * Return the bare list of allocated shop_ids for a user, restricted to
   * vendors that are still active and not soft-deleted (Requirements 1.5,
   * 4.5, 11.5). Used by customer-facing product queries to scope the
   * master catalog to vendors that actually serve the customer.
   *
   * The result is sorted in a deterministic order (primary first, then
   * smallest distance, then earliest allocation) so callers can hash it
   * into a cache key and get a stable identifier across requests.
   *
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async findShopIdsByUserId(userId) {
    const { rows } = await query(
      `SELECT a.vendor_id
         FROM user_shop_allocations a
         JOIN vendors s ON s.id = a.vendor_id
        WHERE a.user_id = $1
          AND s.is_active = true
          AND s.deleted_at IS NULL
        ORDER BY a.is_primary DESC, a.distance_km ASC NULLS LAST, a.allocated_at ASC`,
      [userId]
    )
    return rows.map((r) => r.vendor_id)
  }

  // ────────────────────────────────────────────────────────
  // Matching paths — pincode + haversine
  // ────────────────────────────────────────────────────────

  /**
   * Find vendors whose serviceable_pincodes contains the given pincode.
   * Uses GIN(serviceable_pincodes) for efficient lookup.
   * Excludes inactive and soft-deleted vendors (Requirement 4.1).
   *
   * If lat/lng are provided, distance_km is computed via haversine for
   * downstream sorting; otherwise it is returned as NULL.
   *
   * @param {string} pincode
   * @param {{lat?: number, lng?: number}} [coords]
   * @returns {Promise<Array<{
   *   id: string,
   *   created_at: string,
   *   distance_km: number|null,
   *   delivery_radius_km: number
   * }>>}
   */
  async findShopsByPincode(pincode, coords = {}) {
    const hasCoords =
      Number.isFinite(coords.lat) && Number.isFinite(coords.lng)

    if (hasCoords) {
      const { rows } = await query(
        `SELECT s.id, s.created_at,
                (${EARTH_RADIUS_KM} * acos(
                  LEAST(1.0, GREATEST(-1.0,
                    cos(radians($2::float8)) * cos(radians(s.lat::float8))
                      * cos(radians(s.lng::float8) - radians($3::float8))
                      + sin(radians($2::float8)) * sin(radians(s.lat::float8))
                  ))
                ))::numeric(7,2) AS distance_km,
                s.delivery_radius_km
           FROM vendors s
          WHERE s.is_active = true
            AND s.deleted_at IS NULL
            AND $1 = ANY(s.serviceable_pincodes)`,
        [pincode, coords.lat, coords.lng]
      )
      return rows
    }

    const { rows } = await query(
      `SELECT s.id, s.created_at,
              NULL::numeric(7,2) AS distance_km,
              s.delivery_radius_km
         FROM vendors s
        WHERE s.is_active = true
          AND s.deleted_at IS NULL
          AND $1 = ANY(s.serviceable_pincodes)`,
      [pincode]
    )
    return rows
  }

  /**
   * Find vendors whose haversine distance to (lat, lng) is within their own
   * delivery_radius_km (Requirement 4.2). Excludes inactive/deleted vendors.
   *
   * The haversine acos argument is clamped via LEAST/GREATEST to ±1 to guard
   * against floating-point drift causing acos() domain errors at antipodes.
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<Array<{
   *   id: string,
   *   created_at: string,
   *   distance_km: number,
   *   delivery_radius_km: number
   * }>>}
   */
  async findShopsByRadius(lat, lng) {
    const { rows } = await query(
      `SELECT id, created_at, distance_km, delivery_radius_km
         FROM (
           SELECT s.id, s.created_at,
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
    return rows
  }

  // ────────────────────────────────────────────────────────
  // Write path — replace allocations atomically
  // ────────────────────────────────────────────────────────

  /**
   * Replace all allocations for a user in a single transaction (Requirement 4.3).
   * Atomically deletes existing rows and inserts the new set so concurrent
   * readers always see a consistent snapshot.
   *
   * Soft-delete exception (Req 15.2 / 15.3):
   *   user_shop_allocations is a precomputed join table that is fully
   *   recomputed on every shop area change and on every customer address
   *   change. It carries no history of its own — the source of truth for
   *   "which vendors can serve this customer" is vendors.serviceable_pincodes
   *   and vendors.delivery_radius_km. A soft-delete column would only grow
   *   indefinitely with no consumer, so this row-level DELETE is intentional.
   *   The vendors/vendor_employees/vendor_services tables enumerated by Req 15.2 are
   *   the only multi-vendor tables that require deleted_at.
   *
   * @param {string} userId
   * @param {Array<{
   *   vendor_id: string,
   *   distance_km: number|null,
   *   matched_pincode: string|null,
   *   is_primary: boolean
   * }>} allocations
   * @returns {Promise<number>} Number of rows inserted/updated
   */
  async replaceForUser(userId, allocations) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `DELETE FROM user_shop_allocations WHERE user_id = $1`,
        [userId]
      )

      let upserted = 0
      for (const a of allocations) {
        const { rowCount } = await client.query(
          `INSERT INTO user_shop_allocations (
             user_id, vendor_id, distance_km, matched_pincode, is_primary
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, vendor_id) DO UPDATE
             SET distance_km     = EXCLUDED.distance_km,
                 matched_pincode = EXCLUDED.matched_pincode,
                 is_primary      = EXCLUDED.is_primary,
                 allocated_at    = NOW()`,
          [
            userId,
            a.vendor_id,
            a.distance_km,
            a.matched_pincode,
            a.is_primary,
          ]
        )
        upserted += rowCount
      }

      await client.query('COMMIT')
      return upserted
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* swallow rollback errors */
      }
      throw err
    } finally {
      client.release()
    }
  }

  // ────────────────────────────────────────────────────────
  // Worker support — find affected users for a shop area change
  // ────────────────────────────────────────────────────────

  /**
   * Page through users whose default address pincode matches the given
   * shop's serviceable_pincodes OR whose default address falls inside the
   * shop's delivery_radius_km.
   *
   * Used by the allocation BullMQ worker to recompute allocations after a
   * shop's serviceable_pincodes or delivery_radius_km changes (Requirement 4.8).
   * Pagination uses keyset-style ORDER BY users.id with a LIMIT to keep
   * memory bounded under the 2-core/4GB constraint.
   *
   * Returns rows with the user's default address coords + pincode so the
   * caller can recompute without an extra round-trip.
   *
   * @param {string} shopId
   * @param {{ afterUserId?: string|null, limit?: number }} [opts]
   * @returns {Promise<Array<{
   *   user_id: string,
   *   lat: number|null,
   *   lng: number|null,
   *   pincode: string|null
   * }>>}
   */
  async findUsersAffectedByShop(shopId, { afterUserId = null, limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200))
    const params = [shopId]
    let cursorClause = ''
    if (afterUserId) {
      params.push(afterUserId)
      cursorClause = `AND u.id > $${params.length}`
    }
    params.push(safeLimit)

    const { rows } = await query(
      `WITH target AS (
         SELECT id, lat, lng, serviceable_pincodes, delivery_radius_km
           FROM vendors
          WHERE id = $1
            AND is_active = true
            AND deleted_at IS NULL
       )
       SELECT u.id AS user_id,
              addr.lat,
              addr.lng,
              addr.pincode
         FROM users u
         JOIN addresses addr
           ON addr.user_id = u.id
          AND addr.is_default = true
         CROSS JOIN target t
        WHERE (
                addr.pincode = ANY(t.serviceable_pincodes)
                OR (
                  addr.lat IS NOT NULL AND addr.lng IS NOT NULL
                  AND (${EARTH_RADIUS_KM} * acos(
                        LEAST(1.0, GREATEST(-1.0,
                          cos(radians(t.lat::float8)) * cos(radians(addr.lat::float8))
                            * cos(radians(addr.lng::float8) - radians(t.lng::float8))
                            + sin(radians(t.lat::float8)) * sin(radians(addr.lat::float8))
                        ))
                      )) <= t.delivery_radius_km::float8
                )
              )
              ${cursorClause}
        ORDER BY u.id ASC
        LIMIT $${params.length}`,
      params
    )

    return rows.map((r) => ({
      user_id: r.user_id,
      lat: r.lat !== null && r.lat !== undefined ? Number(r.lat) : null,
      lng: r.lng !== null && r.lng !== undefined ? Number(r.lng) : null,
      pincode: r.pincode,
    }))
  }
}
