import crypto from 'node:crypto'

import { query, getClient } from '../../config/database.js'

/**
 * Vendor Employees repository — all SQL queries for vendor_employees
 * NEVER uses SELECT * — always named columns
 * All queries use parameterized placeholders ($1, $2...)
 */
export class VendorEmployeesRepository {
  /**
   * Create a new vendor employee record.
   * Caller is responsible for limit checks and duplicate detection.
   * @param {object} data - { user_id, vendor_id, role, permissions, invited_by }
   * @returns {Promise<object>} Created record
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO vendor_employees (
        user_id, vendor_id, role, permissions, invited_by
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, vendor_id, role, permissions,
        is_active, invited_by, created_at, updated_at`,
      [
        data.user_id,
        data.vendor_id,
        data.role,
        JSON.stringify(data.permissions || []),
        data.invited_by || null,
      ]
    )
    return rows[0]
  }

  /**
   * Find vendor employee record by ID, scoped to vendor_id.
   *
   * Requirement 15.3 — soft-deleted rows are excluded by default. Pass
   * `includeDeleted: true` to surface soft-deleted employees for admin
   * restoration / audit paths.
   *
   * Pass shopId=null to fetch without scope (e.g., super admin lookup).
   *
   * Connection routing (mirrors `incrementSessionVersion` in the auth
   * repository): when the caller passes `client` — a `pg.PoolClient`
   * bound to an open transaction — the lookup runs on that client so it
   * observes the same isolation level as the surrounding writes (used by
   * `deactivate()`'s tx wrapping the soft-delete + audit emit per task
   * 5.4 / R28 AC#6). When omitted, the lookup runs on the pool directly.
   *
   * @param {string} id - Employee record UUID
   * @param {string|null} shopId - Optional shop scope filter
   * @param {object} [opts]
   * @param {boolean} [opts.includeDeleted=false]
   * @param {import('pg').PoolClient|null} [opts.client=null] - Optional pg
   *        client bound to an open transaction.
   * @returns {Promise<object|null>}
   */
  async findById(
    id,
    shopId = null,
    { includeDeleted = false, client = null } = {}
  ) {
    const runner = client ? client.query.bind(client) : query
    const deletedClause = includeDeleted ? '' : ' AND deleted_at IS NULL'
    if (shopId) {
      const { rows } = await runner(
        `SELECT id, user_id, vendor_id, role, permissions,
          is_active, invited_by, deleted_at, created_at, updated_at
        FROM vendor_employees
        WHERE id = $1 AND vendor_id = $2${deletedClause}`,
        [id, shopId]
      )
      return rows[0] || null
    }

    const { rows } = await runner(
      `SELECT id, user_id, vendor_id, role, permissions,
        is_active, invited_by, deleted_at, created_at, updated_at
      FROM vendor_employees
      WHERE id = $1${deletedClause}`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Find an active employee record by user_id and vendor_id (excludes soft-deleted).
   * Used for duplicate-assignment detection.
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findByUserAndShop(userId, shopId) {
    const { rows } = await query(
      `SELECT id, user_id, vendor_id, role, permissions,
        is_active, invited_by, deleted_at, created_at, updated_at
      FROM vendor_employees
      WHERE user_id = $1 AND vendor_id = $2 AND deleted_at IS NULL`,
      [userId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Count active employees for a vendor (for max-50 limit enforcement).
   * Uses idx_vendor_employees_vendor_active.
   * @param {string} shopId
   * @returns {Promise<number>}
   */
  async countActiveByShop(shopId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
      FROM vendor_employees
      WHERE vendor_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [shopId]
    )
    return rows[0].count
  }

  /**
   * Count active employee assignments for a user (for max-10 limit enforcement).
   * Uses idx_vendor_employees_user_id.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async countActiveByUser(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
      FROM vendor_employees
      WHERE user_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [userId]
    )
    return rows[0].count
  }

  /**
   * Find a user by case-insensitive email match.
   *
   * Used by the employee-create flow (R20 AC#5) to enforce uniqueness on
   * `users.email` before INSERT. The case-insensitive match (`LOWER`)
   * matches the lower-cased email persisted by the create path; it is
   * also defense-in-depth against historical rows that may carry mixed
   * case. The query is `LIMIT 1` because at most one User can hold a
   * given email per the unique index on `users.email`.
   *
   * @param {string} email — the email to search for (any case)
   * @returns {Promise<{id: string, email: string|null}|null>}
   */
  async findUserByEmailCI(email) {
    const { rows } = await query(
      `SELECT id, email
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    )
    return rows[0] || null
  }

  /**
   * Transactional duplicate-detection helper used by the new-user
   * employee-create path (R20 AC#5). Looks up the first existing user
   * row whose `email` matches case-insensitively OR whose `phone`
   * matches exactly. Bound to the caller's pg client so the SELECT
   * runs inside the same transaction as the subsequent
   * {@link createUserWithPassword} INSERT — preventing a TOCTOU
   * race where two concurrent invitations both pass the check and
   * then race the unique-index violation.
   *
   * @param {import('pg').PoolClient} client — pg client bound to an open transaction
   * @param {{ email?: string|null, phone?: string|null }} args
   * @returns {Promise<{id: string, email: string|null, phone: string|null}|null>}
   */
  async findUserByEmailOrPhone(client, { email = null, phone = null } = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error(
        'vendor-employees.repository.findUserByEmailOrPhone: `client` (pg PoolClient) is required'
      )
    }
    const hasEmail = typeof email === 'string' && email.length > 0
    const hasPhone = typeof phone === 'string' && phone.length > 0
    if (!hasEmail && !hasPhone) return null

    const conditions = []
    const params = []
    let idx = 1
    if (hasEmail) {
      conditions.push(`LOWER(email) = LOWER($${idx++})`)
      params.push(email)
    }
    if (hasPhone) {
      conditions.push(`phone = $${idx++}`)
      params.push(phone)
    }

    const { rows } = await client.query(
      `SELECT id, email, phone
       FROM users
       WHERE ${conditions.join(' OR ')}
       LIMIT 1`,
      params
    )
    return rows[0] || null
  }

  /**
   * Provision a brand-new `users` row inside the caller's
   * transaction.
   *
   * @param {import('pg').PoolClient} client — pg client inside an open transaction
   * @param {object} args
   * @param {string} args.email                   — lowercased email
   * @param {string} args.full_name               — 1..200 chars
   * @param {string|null} [args.phone]            — optional E.164-style phone
   * @param {string} args.password_hash           — bcrypt hash (cost 12)
   * @param {boolean} args.force_password_change  — true for Temp_Password flows
   * @returns {Promise<object>} the newly inserted users row (no password_hash)
   */
  async createUserWithPassword(
    client,
    { email, full_name, phone = null, password_hash, force_password_change }
  ) {
    if (!client || typeof client.query !== 'function') {
      throw new Error(
        'vendor-employees.repository.createUserWithPassword: `client` (pg PoolClient) is required'
      )
    }
    const safePhone =
      phone && phone.length > 0
        ? phone
        : `s:${crypto.randomBytes(6).toString('hex')}`

    const { rows } = await client.query(
      `INSERT INTO users (
         phone, email, name, role, password_hash,
         force_password_change, is_active
       )
       VALUES ($1, $2, $3, 'ADMIN', $4, $5, true)
       RETURNING id, name, email, phone, role,
                 force_password_change, is_active, created_at`,
      [safePhone, email, full_name, password_hash, force_password_change]
    )
    return rows[0]
  }

  /**
   * Insert a `vendor_employees` row inside the caller's transaction.
   *
   * @param {import('pg').PoolClient} client — pg client inside an open transaction
   * @param {object} data — { user_id, vendor_id, role, permissions, invited_by }
   * @returns {Promise<object>} the new vendor_employees row
   */
  async createWithClient(client, data) {
    if (!client || typeof client.query !== 'function') {
      throw new Error(
        'vendor-employees.repository.createWithClient: `client` (pg PoolClient) is required'
      )
    }
    const { rows } = await client.query(
      `INSERT INTO vendor_employees (
        user_id, vendor_id, role, permissions, invited_by
      ) VALUES ($1, $2, $3, $4::jsonb, $5)
      RETURNING id, user_id, vendor_id, role, permissions,
        is_active, invited_by, created_at, updated_at`,
      [
        data.user_id,
        data.vendor_id,
        data.role,
        JSON.stringify(data.permissions || []),
        data.invited_by || null,
      ]
    )
    return rows[0]
  }

  /**
   * Provision a brand-new user AND assign them as vendor employee in a single
   * atomic transaction.
   */
  async createUserAndAssign({
    name,
    email,
    phone = null,
    passwordHash,
    forcePasswordChange,
    shopId,
    role,
    permissions,
    invitedBy = null,
  }) {
    const safePhone =
      phone && phone.length > 0
        ? phone
        : `s:${crypto.randomBytes(6).toString('hex')}`

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // ── 1. INSERT user ─────────────────────────────────────────
      const { rows: userRows } = await client.query(
        `INSERT INTO users (
           phone, email, name, role, password_hash,
           force_password_change, is_active
         )
         VALUES ($1, $2, $3, 'ADMIN', $4, $5, true)
         RETURNING id, name, email, phone, role,
                   force_password_change, is_active, created_at`,
        [safePhone, email, name, passwordHash, forcePasswordChange]
      )
      const user = userRows[0]

      // ── 2. INSERT vendor_employees ───────────────────────────────────
      const { rows: staffRows } = await client.query(
        `INSERT INTO vendor_employees (
           user_id, vendor_id, role, permissions, invited_by
         )
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, user_id, vendor_id, role, permissions,
                   is_active, invited_by, created_at, updated_at`,
        [user.id, shopId, role, JSON.stringify(permissions), invitedBy]
      )
      const staff = staffRows[0]

      await client.query('COMMIT')
      return { user, staff }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * List vendor employees with filtering, pagination.
   */
  async findMany({
    shopId,
    page = 1,
    limit = 20,
    role,
    is_active,
    include_deleted,
    includeDeleted,
  }) {
    const offset = (page - 1) * limit
    const showDeleted =
      includeDeleted === true || include_deleted === 'true'
    const conditions = ['ss.vendor_id = $1']
    const params = [shopId]
    let paramIdx = 2

    if (!showDeleted) {
      conditions.push('ss.deleted_at IS NULL')
    }

    if (role) {
      conditions.push(`ss.role = $${paramIdx++}`)
      params.push(role)
    }

    if (is_active === 'true') {
      conditions.push('ss.is_active = true')
    } else if (is_active === 'false') {
      conditions.push('ss.is_active = false')
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ss.id, ss.user_id, ss.vendor_id, ss.role, ss.permissions,
          ss.is_active, ss.invited_by, ss.created_at, ss.updated_at,
          u.name AS user_name, u.email AS user_email, u.phone AS user_phone
        FROM vendor_employees ss
        LEFT JOIN users u ON u.id = ss.user_id
        WHERE ${where}
        ORDER BY ss.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
        FROM vendor_employees ss
        WHERE ${where}`,
        params
      ),
    ])

    return {
      staff: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Update vendor employee record by ID.
   */
  async update(id, shopId, data) {
    const fields = []
    const params = []
    let idx = 1

    if (data.role !== undefined) {
      fields.push(`role = $${idx++}`)
      params.push(data.role)
    }

    if (data.permissions !== undefined) {
      fields.push(`permissions = $${idx++}`)
      params.push(JSON.stringify(data.permissions))
    }

    if (data.is_active !== undefined) {
      fields.push(`is_active = $${idx++}`)
      params.push(data.is_active)
    }

    if (fields.length === 0) return this.findById(id, shopId)

    fields.push('updated_at = NOW()')
    params.push(id, shopId)

    const { rows } = await query(
      `UPDATE vendor_employees SET ${fields.join(', ')}
       WHERE id = $${idx} AND vendor_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING id, user_id, vendor_id, role, permissions,
         is_active, invited_by, created_at, updated_at`,
      params
    )
    return rows[0] || null
  }

  /**
   * Soft-delete vendor employee record by ID.
   */
  async softDelete(id, shopId, { client = null } = {}) {
    const runner = client ? client.query.bind(client) : query
    const { rowCount } = await runner(
      `UPDATE vendor_employees
       SET deleted_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rowCount > 0
  }

  /**
   * Reset a User's password
   */
  async resetPasswordTx(client, userId, passwordHash) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('resetPasswordTx: pg client (in transaction) is required')
    }
    const { rows } = await client.query(
      `UPDATE users
          SET password_hash         = $1,
               force_password_change = true,
               session_version       = session_version + 1,
               updated_at            = NOW()
         WHERE id = $2
       RETURNING session_version`,
      [passwordHash, userId]
    )
    if (rows.length === 0) {
      throw new Error(`resetPasswordTx: user ${userId} not found`)
    }
    return { session_version: rows[0].session_version }
  }

  /**
   * Find user_ids of all active employees in a shop matching any of the given roles.
   */
  async findActiveUserIdsByShopAndRoles(shopId, roles) {
    if (!shopId || !Array.isArray(roles) || roles.length === 0) return []
    const { rows } = await query(
      `SELECT DISTINCT user_id
       FROM vendor_employees
       WHERE vendor_id = $1
         AND deleted_at IS NULL
         AND is_active = true
         AND role = ANY($2::text[])`,
      [shopId, roles]
    )
    return rows.map((r) => r.user_id)
  }
}
