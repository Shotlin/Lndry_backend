import { query, getClient } from '../../config/database.js'

/**
 * Notifications repository — database access for notifications
 */
/** Devices kept active per user; older ones are retired on registration. */
const MAX_ACTIVE_DEVICES_PER_USER = 8

export class NotificationsRepository {
  async getNotifications(userId, { offset, limit, unreadOnly }) {
    let sql = 'SELECT * FROM notifications WHERE user_id = $1'
    const params = [userId]

    if (unreadOnly) {
      sql += ' AND is_read = false'
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*)')
    const countResult = await query(countSql, params)
    const total = parseInt(countResult.rows[0].count)

    params.push(limit, offset)
    sql += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3'

    const result = await query(sql, params)

    const unreadCount = await query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    )

    return {
      notifications: result.rows,
      unreadCount: parseInt(unreadCount.rows[0].count),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getNotificationById(notificationId) {
    const { rows } = await query(
      'SELECT id, user_id FROM notifications WHERE id = $1',
      [notificationId]
    )
    return rows[0]
  }

  async markAsRead(notificationId) {
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1',
      [notificationId]
    )
  }

  async markAllAsRead(userId) {
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = $1 AND is_read = false',
      [userId]
    )
  }

  async deleteNotification(notificationId) {
    await query('DELETE FROM notifications WHERE id = $1', [notificationId])
  }

  async getPreferences(userId) {
    const { rows } = await query(
      'SELECT notification_preferences FROM users WHERE id = $1',
      [userId]
    )

    const prefs = rows[0]?.notification_preferences || {}

    return {
      orderUpdates: prefs.orderUpdates !== false,
      promotions: prefs.promotions !== false,
      newProducts: prefs.newProducts !== false,
      deliveryUpdates: prefs.deliveryUpdates !== false,
      priceDrops: prefs.priceDrops !== false,
    }
  }

  async updatePreferences(userId, preferences) {
    const { rows } = await query(
      'UPDATE users SET notification_preferences = $1 WHERE id = $2 RETURNING notification_preferences',
      [JSON.stringify(preferences), userId]
    )
    return rows[0].notification_preferences
  }

  /**
   * Register (or refresh) one device. A user may have several devices, so
   * other devices are left alone; only an older token belonging to the SAME
   * device (Firebase rotated it) is retired.
   */
  async registerToken(userId, { token, platform, appType, deviceId, deviceModel, appVersion }) {
    const { rows: [who] } = await query(
      `SELECT u.role,
              EXISTS (SELECT 1 FROM vendor_employees ve
                       WHERE ve.user_id = u.id AND ve.is_active AND ve.deleted_at IS NULL) AS is_partner
         FROM users u WHERE u.id = $1`,
      [userId]
    )
    const app = appType || (who?.is_partner ? 'partner' : 'customer')

    if (deviceId) {
      await query(
        `UPDATE fcm_tokens SET is_active = false, updated_at = NOW()
          WHERE user_id = $1 AND device_id = $2 AND token <> $3 AND is_active = true`,
        [userId, deviceId, token]
      )
    }

    await query(
      `INSERT INTO fcm_tokens
         (user_id, token, platform, app_type, user_role, device_id, device_model, app_version,
          is_active, last_active_at, logged_out_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NULL, NOW())
       ON CONFLICT (token) DO UPDATE
         SET user_id        = EXCLUDED.user_id,
             platform       = EXCLUDED.platform,
             app_type       = EXCLUDED.app_type,
             user_role      = EXCLUDED.user_role,
             device_id      = COALESCE(EXCLUDED.device_id, fcm_tokens.device_id),
             device_model   = COALESCE(EXCLUDED.device_model, fcm_tokens.device_model),
             app_version    = COALESCE(EXCLUDED.app_version, fcm_tokens.app_version),
             is_active      = true,
             last_active_at = NOW(),
             logged_out_at  = NULL,
             updated_at     = NOW()`,
      [userId, token, platform, app, who?.role || null, deviceId || null, deviceModel || null, appVersion || null]
    )

    // Keep the newest few devices per user; anything older is stale.
    await query(
      `UPDATE fcm_tokens SET is_active = false, updated_at = NOW()
        WHERE id IN (SELECT id FROM fcm_tokens
                      WHERE user_id = $1 AND is_active = true
                      ORDER BY last_active_at DESC NULLS LAST, updated_at DESC
                      OFFSET ${MAX_ACTIVE_DEVICES_PER_USER})`,
      [userId]
    )
  }

  /** Logout: detach this session's device so it stops receiving the user's pushes. */
  async unregisterToken(userId, { token, deviceId }) {
    if (!token && !deviceId) return 0
    const { rowCount } = await query(
      `UPDATE fcm_tokens
          SET is_active = false, logged_out_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND is_active = true
          AND (token = $2 OR (device_id IS NOT NULL AND device_id = $3))`,
      [userId, token || null, deviceId || null]
    )
    return rowCount
  }

  /**
   * A user tapped a push. Records the first open of that delivery, bumps the
   * campaign's opened counter once, and marks the inbox item read.
   */
  async markOpened(userId, { deliveryId, notificationId, campaignId }) {
    const { rows } = await query(
      `UPDATE notification_deliveries
          SET opened_at = NOW()
        WHERE user_id = $1 AND opened_at IS NULL
          AND ( ($2::uuid IS NOT NULL AND id = $2)
             OR ($3::uuid IS NOT NULL AND notification_id = $3)
             OR ($2::uuid IS NULL AND $3::uuid IS NULL AND $4::uuid IS NOT NULL AND campaign_id = $4) )
        RETURNING campaign_id`,
      [userId, deliveryId || null, notificationId || null, campaignId || null]
    )
    const byCampaign = {}
    for (const r of rows) if (r.campaign_id) byCampaign[r.campaign_id] = (byCampaign[r.campaign_id] || 0) + 1
    for (const [id, n] of Object.entries(byCampaign)) {
      await query('UPDATE notification_campaigns SET opened_count = opened_count + $2 WHERE id = $1', [id, n])
    }
    if (notificationId) {
      await query(
        `UPDATE notifications SET is_read = true, read_at = NOW()
          WHERE id = $1 AND user_id = $2 AND is_read = false`,
        [notificationId, userId]
      )
    }
    return rows.length
  }

  async getFcmTokens(userId) {
    const { rows } = await query(
      'SELECT token, platform FROM fcm_tokens WHERE user_id = $1 AND is_active = true',
      [userId]
    )
    return rows
  }

  async createNotification(userId, { title, body, type, data }) {
    const { rows } = await query(
      `INSERT INTO notifications (user_id, title, body, type, data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, body, type, data, is_read, created_at`,
      [userId, title, body, type, JSON.stringify(data || {})]
    )
    return rows[0]
  }
}
