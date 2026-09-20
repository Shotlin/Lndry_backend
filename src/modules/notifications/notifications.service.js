import { logger } from '../../config/logger.js'
import { inferLink } from '../../utils/deeplink.js'
import { NotificationDispatcher } from './notification-dispatcher.js'

/**
 * Notifications service — business logic for notifications
 */
export class NotificationsService {
  constructor(repository, fastify, dispatcher = new NotificationDispatcher()) {
    this.repository = repository
    this.fastify = fastify
    this.dispatcher = dispatcher
  }

  async getNotifications(userId, { page, limit, unreadOnly }) {
    const offset = (page - 1) * limit
    return await this.repository.getNotifications(userId, { offset, limit, unreadOnly })
  }

  async markAsRead(userId, notificationId) {
    const notification = await this.repository.getNotificationById(notificationId)
    if (!notification) {
      throw new Error('Notification not found')
    }

    if (notification.user_id !== userId) {
      throw new Error('Not authorized to modify this notification')
    }

    return await this.repository.markAsRead(notificationId)
  }

  async markAllAsRead(userId) {
    return await this.repository.markAllAsRead(userId)
  }

  async deleteNotification(userId, notificationId) {
    const notification = await this.repository.getNotificationById(notificationId)
    if (!notification) {
      throw new Error('Notification not found')
    }

    if (notification.user_id !== userId) {
      throw new Error('Not authorized to delete this notification')
    }

    return await this.repository.deleteNotification(notificationId)
  }

  async getPreferences(userId) {
    return await this.repository.getPreferences(userId)
  }

  async updatePreferences(userId, preferences) {
    return await this.repository.updatePreferences(userId, preferences)
  }

  async registerToken(userId, device) {
    return await this.repository.registerToken(userId, device)
  }

  async unregisterToken(userId, device) {
    return await this.repository.unregisterToken(userId, device)
  }

  async markOpened(userId, ref) {
    return await this.repository.markOpened(userId, ref)
  }

  /**
   * Send notification — creates the in-app item, emits Socket.IO, and pushes
   * to every active device of the user through the central dispatcher.
   * Called by other modules (orders, delivery, payments, ...).
   *
   * `link` is an optional `{ type, params }` destination (see utils/deeplink.js).
   * Callers that predate the contract only set `type` and `data.orderId`; the
   * destination is inferred from those so every existing notification is
   * tappable without touching its call site.
   */
  async sendNotification(userId, { title, body, type = 'general', data = {}, imageUrl, link } = {}) {
    const resolvedLink = link || inferLink(type, data)

    // 1. Create in-app notification
    const notification = await this.repository.createNotification(userId, {
      title, body, type, data: { ...data, link: resolvedLink },
    })

    // 2. Emit via Socket.IO for real-time
    try {
      if (this.fastify?.emitNotification) {
        this.fastify.emitNotification(userId, notification)
      }
    } catch (err) {
      logger.error({ err, userId }, 'Socket.IO notification emit failed')
    }

    // 3. Push to all of the user's devices
    try {
      await this.dispatcher.sendToUsers(
        [userId],
        { title, body, imageUrl, link: resolvedLink, legacyType: type, data },
        { kind: 'TRANSACTIONAL', notificationIds: new Map([[userId, notification.id]]) }
      )
    } catch (err) {
      logger.error({ err, userId }, 'FCM push notification failed')
    }

    return notification
  }

  // Alias for backward compatibility
  async createNotification(userId, opts) {
    return this.sendNotification(userId, opts)
  }
}
