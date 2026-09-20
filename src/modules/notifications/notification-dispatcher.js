import { randomUUID } from 'node:crypto'
import { query as defaultQuery } from '../../config/database.js'
import { sendPushMessages as defaultSend, buildMessage } from '../../utils/pushNotification.js'
import { resolveLink, buildLinkData } from '../../utils/deeplink.js'
import { logger } from '../../config/logger.js'

/**
 * One row per registered, active device. `shop_role` is the person's active
 * role at a vendor (VENDOR_OWNER / VENDOR_STAFF / VENDOR_RIDER), used to send
 * a captain to the captain screens and a vendor to the vendor screens.
 */
export const DEVICE_COLUMNS = `
  ft.id AS token_id, ft.user_id, ft.token, ft.platform, ft.app_type, ft.device_model,
  (SELECT ve.role FROM vendor_employees ve
    WHERE ve.user_id = ft.user_id AND ve.is_active AND ve.deleted_at IS NULL
    ORDER BY (ve.role = 'VENDOR_OWNER') DESC, ve.created_at ASC LIMIT 1) AS shop_role
`
export const DEVICE_FROM = `
  FROM fcm_tokens ft
  JOIN users u ON u.id = ft.user_id AND u.is_active = true
`

const ROW_CHUNK = 500

/**
 * The single place a push notification leaves the backend. Transactional
 * events, admin campaigns and test sends all go through here so that every
 * message gets the same deep-link contract, a delivery record, and invalid
 * device cleanup.
 */
export class NotificationDispatcher {
  /** `send` and `query` are injectable so the logic can be tested without FCM. */
  constructor({ send = defaultSend, query = defaultQuery } = {}) {
    this.send = send
    this.query = query
  }

  async devicesForUsers(userIds) {
    if (!userIds?.length) return []
    const { rows } = await this.query(
      `SELECT ${DEVICE_COLUMNS} ${DEVICE_FROM}
        WHERE ft.is_active = true AND ft.user_id = ANY($1::uuid[])`,
      [userIds]
    )
    return rows
  }

  /**
   * Push to every active device of the given users.
   * @param message { title, body, imageUrl, link:{type,params}|null, legacyType, data, ttlSeconds }
   * @param ctx     { kind:'TRANSACTIONAL'|'CAMPAIGN'|'TEST', campaignId, notificationIds: Map<userId,id> }
   */
  async sendToUsers(userIds, message, ctx = {}) {
    const devices = await this.devicesForUsers(userIds)
    const summary = await this.dispatch(devices, message, ctx)
    const withDevice = new Set(devices.map((d) => d.user_id))
    summary.noDeviceUserIds = userIds.filter((id) => !withDevice.has(id))
    return summary
  }

  /** Push to an explicit list of device rows (see DEVICE_COLUMNS). */
  async dispatch(devices, message, ctx = {}) {
    const empty = { configured: true, devices: 0, sent: 0, failed: 0, invalid: 0, results: [] }
    if (!devices.length) return empty

    const kind = ctx.kind || 'TRANSACTIONAL'
    const planned = devices.map((d) => {
      const resolved = resolveLink(message.link, { app: d.app_type || 'customer', shopRole: d.shop_role })
      const deliveryId = randomUUID()
      const notificationId = ctx.notificationIds?.get(d.user_id) || null
      const data = {
        ...stringify(message.data),
        ...(resolved ? buildLinkData(resolved) : { type: 'none', deepLink: '' }),
        notificationType: message.legacyType || 'general',
        app: d.app_type || 'customer',
        deliveryId,
        ...(ctx.campaignId ? { campaignId: ctx.campaignId } : {}),
        ...(notificationId ? { notificationId } : {}),
      }
      return {
        device: d,
        deliveryId,
        notificationId,
        message: buildMessage(d.token, {
          title: message.title,
          body: message.body,
          imageUrl: message.imageUrl,
          data,
          ttlSeconds: message.ttlSeconds,
        }),
      }
    })

    const { configured, results: raw } = await this.send(planned.map((p) => p.message))
    if (!configured) {
      return { ...empty, configured: false, devices: devices.length, failed: devices.length }
    }

    const results = planned.map((p, i) => {
      const r = raw[i] || { success: false, errorCode: 'NO_RESULT' }
      const status = r.success ? 'SENT' : r.tokenInvalid ? 'INVALID_TOKEN' : 'FAILED'
      return {
        deliveryId: p.deliveryId,
        notificationId: p.notificationId,
        tokenId: p.device.token_id,
        userId: p.device.user_id,
        appType: p.device.app_type,
        platform: p.device.platform,
        deviceModel: p.device.device_model,
        token: p.device.token,
        status,
        messageId: r.messageId || null,
        errorCode: r.errorCode || null,
      }
    })

    await this._recordDeliveries(results, { kind, campaignId: ctx.campaignId || null })

    const invalidTokens = results.filter((r) => r.status === 'INVALID_TOKEN').map((r) => r.token)
    if (invalidTokens.length) {
      await this.query(
        `UPDATE fcm_tokens SET is_active = false, updated_at = NOW() WHERE token = ANY($1::text[])`,
        [invalidTokens]
      ).catch((err) => logger.error({ err: err.message }, 'Failed to deactivate invalid FCM tokens'))
    }

    return {
      configured: true,
      devices: results.length,
      sent: results.filter((r) => r.status === 'SENT').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      invalid: invalidTokens.length,
      results,
    }
  }

  async _recordDeliveries(results, { kind, campaignId }) {
    for (let i = 0; i < results.length; i += ROW_CHUNK) {
      const chunk = results.slice(i, i + ROW_CHUNK)
      const params = []
      const tuples = chunk.map((r) => {
        params.push(r.deliveryId, campaignId, r.notificationId, r.userId, r.tokenId,
          r.appType || null, kind, r.status, r.messageId, r.errorCode)
        const n = params.length
        return `($${n - 9},$${n - 8},$${n - 7},$${n - 6},$${n - 5},$${n - 4},$${n - 3},$${n - 2},$${n - 1},$${n})`
      })
      try {
        await this.query(
          `INSERT INTO notification_deliveries
             (id, campaign_id, notification_id, user_id, token_id, app_type, kind, status, fcm_message_id, error_code)
           VALUES ${tuples.join(',')}`,
          params
        )
      } catch (err) {
        // Logging must never break delivery.
        logger.error({ err: err.message }, 'Failed to record notification deliveries')
      }
    }
  }
}

function stringify(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => [k, String(v)])
  )
}
