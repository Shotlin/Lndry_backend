export const getNotificationsSchema = {
  tags: ['Notifications'],
  summary: 'Get user notifications',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 20 },
      unreadOnly: { type: 'boolean', default: false },
    },
  },
}

export const markAsReadSchema = {
  tags: ['Notifications'],
  summary: 'Mark notification as read',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const markAllAsReadSchema = {
  tags: ['Notifications'],
  summary: 'Mark all notifications as read',
}

export const deleteNotificationSchema = {
  tags: ['Notifications'],
  summary: 'Delete notification',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getPreferencesSchema = {
  tags: ['Notifications'],
  summary: 'Get notification preferences',
}

export const updatePreferencesSchema = {
  tags: ['Notifications'],
  summary: 'Update notification preferences',
  body: {
    type: 'object',
    properties: {
      orderUpdates: { type: 'boolean' },
      promotions: { type: 'boolean' },
      newProducts: { type: 'boolean' },
      deliveryUpdates: { type: 'boolean' },
      priceDrops: { type: 'boolean' },
    },
  },
}

export const registerTokenSchema = {
  tags: ['Notifications'],
  summary: 'Register / refresh this device for push notifications',
  body: {
    type: 'object',
    required: ['token', 'platform'],
    properties: {
      token: { type: 'string', minLength: 20, maxLength: 500 },
      platform: { type: 'string', enum: ['ios', 'android', 'web'] },
      app_type: { type: 'string', enum: ['customer', 'partner'] },
      device_id: { type: 'string', maxLength: 120 },
      device_model: { type: 'string', maxLength: 120 },
      app_version: { type: 'string', maxLength: 40 },
    },
  },
}

export const unregisterTokenSchema = {
  tags: ['Notifications'],
  summary: 'Detach this device on logout',
  body: {
    type: 'object',
    properties: {
      token: { type: 'string', maxLength: 500 },
      device_id: { type: 'string', maxLength: 120 },
    },
  },
}

const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
export const markOpenedSchema = {
  tags: ['Notifications'],
  summary: 'Report that a push notification was tapped',
  body: {
    type: 'object',
    properties: {
      delivery_id: { type: 'string', pattern: uuid },
      notification_id: { type: 'string', pattern: uuid },
      campaign_id: { type: 'string', pattern: uuid },
    },
  },
}
