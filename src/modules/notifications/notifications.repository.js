import { query, getClient } from '../../config/database.js'

/**
 * Notifications repository — database access for notifications
 */
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

  async registerToken(userId, token, platform) {
    // Upsert: if token exists, re-activate and update owner.
    // Also mark all OTHER tokens for this user as inactive — a user should
    // only have ONE active token at a time (the most recently registered one).
    // This prevents sending to 10+ stale tokens accumulated over reinstalls.
    await query(
      `INSERT INTO fcm_tokens (user_id, token, platform, is_active, updated_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = EXCLUDED.platform,
             is_active = true,
             updated_at = NOW()`,
      [userId, token, platform]
    )
    // Deactivate all other tokens for this user (keep only the new one active)
    await query(
      `UPDATE fcm_tokens SET is_active = false
       WHERE user_id = $1 AND token != $2 AND is_active = true`,
      [userId, token]
    )
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
