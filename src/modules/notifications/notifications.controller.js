import { success } from '../../utils/apiResponse.js'

/**
 * Notifications controller — handles push notifications and user preferences
 */
export class NotificationsController {
  constructor(service) {
    this.service = service
  }

  /**
   * GET / — Get user notifications
   */
  async getNotifications(request, reply) {
    const { page = 1, limit = 20, unreadOnly = false } = request.query
    const notifications = await this.service.getNotifications(request.user.id, {
      page,
      limit,
      unreadOnly,
    })
    return reply.code(200).send(success(notifications, 'Notifications fetched successfully'))
  }

  /**
   * PATCH /:id/read — Mark notification as read
   */
  async markAsRead(request, reply) {
    const { id } = request.params
    await this.service.markAsRead(request.user.id, id)
    return reply.code(200).send(success(null, 'Notification marked as read'))
  }

  /**
   * PATCH /read-all — Mark all notifications as read
   */
  async markAllAsRead(request, reply) {
    await this.service.markAllAsRead(request.user.id)
    return reply.code(200).send(success(null, 'All notifications marked as read'))
  }

  /**
   * DELETE /:id — Delete notification
   */
  async deleteNotification(request, reply) {
    const { id } = request.params
    await this.service.deleteNotification(request.user.id, id)
    return reply.code(200).send(success(null, 'Notification deleted'))
  }

  /**
   * GET /preferences — Get notification preferences
   */
  async getPreferences(request, reply) {
    const preferences = await this.service.getPreferences(request.user.id)
    return reply.code(200).send(success(preferences, 'Preferences fetched successfully'))
  }

  /**
   * PUT /preferences — Update notification preferences
   */
  async updatePreferences(request, reply) {
    const preferences = await this.service.updatePreferences(request.user.id, request.body)
    return reply.code(200).send(success(preferences, 'Preferences updated successfully'))
  }

  /**
   * POST /tokens — Register FCM/device token (multi-device)
   */
  async registerToken(request, reply) {
    const { token, platform, app_type, device_id, device_model, app_version } = request.body
    await this.service.registerToken(request.user.id, {
      token, platform, appType: app_type, deviceId: device_id,
      deviceModel: device_model, appVersion: app_version,
    })
    return reply.code(200).send(success(null, 'Token registered successfully'))
  }

  /**
   * POST /tokens/unregister — detach this device on logout
   */
  async unregisterToken(request, reply) {
    const { token, device_id } = request.body || {}
    const removed = await this.service.unregisterToken(request.user.id, { token, deviceId: device_id })
    return reply.code(200).send(success({ removed }, 'Device detached'))
  }

  /**
   * POST /opened — the user tapped a push
   */
  async markOpened(request, reply) {
    const { delivery_id, notification_id, campaign_id } = request.body || {}
    const updated = await this.service.markOpened(request.user.id, {
      deliveryId: delivery_id, notificationId: notification_id, campaignId: campaign_id,
    })
    return reply.code(200).send(success({ updated }, 'Recorded'))
  }
}
