import { AdminNotificationsRepository } from './notifications.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { logger } from '../../../config/logger.js'
import { NotificationDispatcher } from '../../notifications/notification-dispatcher.js'
import { validateLink, describeLink, isSafeRoute } from '../../../utils/deeplink.js'
import {
  AudienceError, normalizeAudience, audienceFromLegacy, countAudience, resolveAudienceDevices,
} from './audience.js'

/** A scheduled send must be at least this far in the future. */
const MIN_LEAD_SECONDS = 30
/** Devices handed to the dispatcher per round (whole users are kept together). */
const DEVICE_CHUNK = 1000

/** Plain-language failure the controller turns into a 400. */
export class NotificationRequestError extends Error {
  constructor(message, code = 'NOTIFICATION_REQUEST_INVALID') {
    super(message)
    this.code = code
  }
}

const LEGACY_PATH_TO_LINK = {
  '/home': { type: 'home', params: {} },
  '/orders': { type: 'orders', params: {} },
  '/profile/wallet': { type: 'wallet', params: {} },
  '/profile/notifications': { type: 'notifications', params: {} },
  '/profile/offers': { type: 'offers', params: {} },
  '/profile/help': { type: 'help', params: {} },
  '/profile': { type: 'profile', params: {} },
}

/** The old dashboard sent a free-text path; map it onto the link contract. */
export function linkFromLegacyText(text) {
  if (!text) return null
  if (LEGACY_PATH_TO_LINK[text]) return LEGACY_PATH_TO_LINK[text]
  return isSafeRoute(text) ? { type: 'route', params: { route: text } } : null
}

function openRate(c) {
  const sent = Number(c.sent_count) || 0
  return sent > 0 ? Math.round(((Number(c.opened_count) || 0) / sent) * 1000) / 10 : 0
}

export class AdminNotificationsService {
  constructor({ repo = new AdminNotificationsRepository(), dispatcher = new NotificationDispatcher() } = {}) {
    this.repo = repo
    this.dispatcher = dispatcher
  }

  /* ── Templates ── */

  async listTemplates() {
    return this.repo.findAllTemplates()
  }

  async getTemplate(id) {
    return this.repo.findTemplateById(id)
  }

  _templateLink(data) {
    if (!data.deep_link_type) return {}
    const v = validateLink({ type: data.deep_link_type, params: data.deep_link_params })
    if (!v.ok) throw new NotificationRequestError(v.error, 'LINK_INVALID')
    return { deep_link_type: v.link.type, deep_link_params: v.link.params }
  }

  async createTemplate(data, adminId, ip) {
    const t = await this.repo.createTemplate({ ...data, ...this._templateLink(data) })
    logAdminActivity(adminId, 'CREATE_TEMPLATE', 'notification_template', t.id, null, null, ip)
    return t
  }

  async updateTemplate(id, data, adminId, ip) {
    const patch = { ...data }
    if (data.deep_link_type === '' || data.deep_link_type === null) {
      patch.deep_link_type = null
      patch.deep_link_params = {}
    } else if (data.deep_link_type) {
      Object.assign(patch, this._templateLink(data))
    }
    const t = await this.repo.updateTemplate(id, patch)
    if (t) logAdminActivity(adminId, 'UPDATE_TEMPLATE', 'notification_template', id, null, null, ip)
    return t
  }

  async duplicateTemplate(id, adminId, ip) {
    const src = await this.repo.findTemplateById(id)
    if (!src) return null
    const copy = await this.repo.createTemplate({
      name: `${src.name} (copy)`.slice(0, 100),
      title: src.title,
      body: src.body,
      type: src.type,
      variables: src.variables,
      image_url: src.image_url,
      deep_link: src.deep_link,
      deep_link_type: src.deep_link_type,
      deep_link_params: src.deep_link_params,
    })
    logAdminActivity(adminId, 'DUPLICATE_TEMPLATE', 'notification_template', copy.id, null, { from: id }, ip)
    return copy
  }

  async deleteTemplate(id, adminId, ip) {
    const ok = await this.repo.deleteTemplate(id)
    if (ok) logAdminActivity(adminId, 'DELETE_TEMPLATE', 'notification_template', id, null, null, ip)
    return ok
  }

  /* ── Audience ── */

  async _audienceFrom(body) {
    if (body.audience) return normalizeAudience(body.audience)
    if (body.segment) return audienceFromLegacy(body.segment, body.segmentValue)
    throw new AudienceError('Choose who should receive this notification.')
  }

  /** Live user/device counts for the audience the admin is composing. */
  async audienceCount(body) {
    const audience = await this._audienceFrom(body)
    return { audience, ...(await countAudience(audience)) }
  }

  async searchRecipients({ q, type }) {
    return this.repo.searchRecipients({ q, type })
  }

  /* ── Campaigns ── */

  /** Validate everything a campaign carries besides its audience. */
  _content(body) {
    const title = String(body.title || '').trim()
    const text = String(body.body || '').trim()
    if (!title) throw new NotificationRequestError('Add a title.')
    if (!text) throw new NotificationRequestError('Add a message.')

    const rawLink = body.link ?? linkFromLegacyText(body.deep_link)
    const v = validateLink(rawLink)
    if (!v.ok) throw new NotificationRequestError(v.error, 'LINK_INVALID')

    let image = body.image_url ? String(body.image_url).trim() : null
    if (image && !/^https:\/\//i.test(image)) throw new NotificationRequestError('The image must be an https link or an uploaded image.', 'IMAGE_INVALID')

    let expires = null
    if (body.expires_at) {
      expires = new Date(body.expires_at)
      if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) {
        throw new NotificationRequestError('The expiry time must be in the future.')
      }
    }
    return {
      title, body: text, image_url: image, link: v.link,
      deepLinkText: v.link ? describeLink(v.link) : null,
      expires_at: expires ? expires.toISOString() : null,
      type: body.type || 'general',
      template_id: body.template_id || null,
    }
  }

  _schedule(body) {
    const at = new Date(body.scheduledAt)
    if (Number.isNaN(at.getTime())) throw new NotificationRequestError('Pick a date and time.')
    if (at.getTime() < Date.now() + MIN_LEAD_SECONDS * 1000) {
      throw new NotificationRequestError('The scheduled time must be in the future.')
    }
    return at.toISOString()
  }

  /**
   * Create a campaign. mode: SEND_NOW | SCHEDULE | DRAFT.
   * Everything is validated up front and the audience spec is stored, so the
   * scheduler later sends to exactly what was chosen here.
   */
  async createCampaign(body, adminId, ip) {
    const mode = String(body.mode || 'SEND_NOW').toUpperCase()
    if (!['SEND_NOW', 'SCHEDULE', 'DRAFT'].includes(mode)) throw new NotificationRequestError('Unknown send mode.')

    const content = this._content(body)
    const audience = await this._audienceFrom(body)
    const counts = await countAudience(audience)
    const targetApp = this._targetApp(audience)

    let status; let scheduledAt = null
    if (mode === 'DRAFT') {
      status = 'DRAFT'
    } else if (mode === 'SCHEDULE') {
      scheduledAt = this._schedule(body)
      status = 'SCHEDULED'
    } else {
      if (counts.devices === 0) {
        throw new NotificationRequestError('No devices with notifications enabled match this audience yet.', 'NO_DEVICES')
      }
      status = 'SENDING'
    }

    const campaign = await this.repo.createCampaign({
      ...content, audience, targetApp, scheduledAt, status, createdBy: adminId,
      targetCount: counts.users, deviceCount: counts.devices,
    })
    logAdminActivity(adminId, `NOTIFICATION_${mode}`, 'notification_campaign', campaign.id, null,
      { audience: audience.kind, users: counts.users, devices: counts.devices, scheduledAt }, ip)

    if (status === 'SENDING') this._runInBackground(campaign.id)
    return this._decorate(campaign)
  }

  async updateDraft(id, body, adminId, ip) {
    const fields = {}
    if (body.title !== undefined || body.body !== undefined || body.link !== undefined ||
        body.image_url !== undefined || body.expires_at !== undefined || body.deep_link !== undefined) {
      const current = await this.repo.findCampaignById(id)
      if (!current) return null
      const merged = this._content({
        title: body.title ?? current.title,
        body: body.body ?? current.body,
        link: body.link !== undefined ? body.link : (current.deep_link_type ? { type: current.deep_link_type, params: current.deep_link_params } : null),
        image_url: body.image_url !== undefined ? body.image_url : current.image_url,
        expires_at: body.expires_at !== undefined ? body.expires_at : null,
        type: current.type,
        template_id: body.template_id ?? current.template_id,
      })
      Object.assign(fields, {
        title: merged.title, body: merged.body, image_url: merged.image_url,
        link: merged.link, deepLinkText: merged.deepLinkText, expires_at: merged.expires_at,
        template_id: merged.template_id,
      })
    }
    if (body.audience || body.segment) {
      const audience = await this._audienceFrom(body)
      const counts = await countAudience(audience)
      Object.assign(fields, {
        audience, targetApp: this._targetApp(audience),
        targetCount: counts.users, deviceCount: counts.devices,
      })
    }
    const c = await this.repo.updateDraft(id, fields)
    if (c) logAdminActivity(adminId, 'NOTIFICATION_DRAFT_UPDATE', 'notification_campaign', id, null, null, ip)
    return c ? this._decorate(c) : null
  }

  /** Turn a saved draft into a send-now or a scheduled campaign. */
  async sendDraft(id, { mode = 'SEND_NOW', scheduledAt } = {}, adminId, ip) {
    const draft = await this.repo.findCampaignById(id)
    if (!draft || draft.status !== 'DRAFT') return null
    if (!draft.audience) throw new NotificationRequestError('This draft has no audience yet.')
    const counts = await countAudience(normalizeAudience(draft.audience))

    let status = 'SENDING'; let at = null
    if (String(mode).toUpperCase() === 'SCHEDULE') { status = 'SCHEDULED'; at = this._schedule({ scheduledAt }) }
    else if (counts.devices === 0) throw new NotificationRequestError('No devices with notifications enabled match this audience yet.', 'NO_DEVICES')

    const c = await this.repo.activateDraft(id, { status, scheduledAt: at, targetCount: counts.users, deviceCount: counts.devices })
    if (!c) return null
    logAdminActivity(adminId, `NOTIFICATION_DRAFT_${status}`, 'notification_campaign', id, null, { devices: counts.devices }, ip)
    if (status === 'SENDING') this._runInBackground(id)
    return this._decorate(c)
  }

  async cancelCampaign(id, adminId, ip) {
    const c = await this.repo.cancelCampaign(id)
    if (c) logAdminActivity(adminId, 'CANCEL_CAMPAIGN', 'notification_campaign', id, null, null, ip)
    return c
  }

  async deleteCampaign(id, adminId, ip) {
    const ok = await this.repo.deleteCampaign(id)
    if (ok) logAdminActivity(adminId, 'DELETE_CAMPAIGN', 'notification_campaign', id, null, null, ip)
    return ok
  }

  async listCampaigns({ page = 1, limit = 20, status }) {
    const offset = (page - 1) * limit
    const data = await this.repo.findAllCampaigns({ offset, limit, status })
    return { ...data, campaigns: data.campaigns.map((c) => this._decorate(c)) }
  }

  async getCampaign(id) {
    const c = await this.repo.findCampaignById(id)
    if (!c) return null
    const [breakdown, errors] = await Promise.all([
      this.repo.getCampaignBreakdown(id), this.repo.getCampaignErrors(id),
    ])
    return { ...this._decorate(c), breakdown, errors }
  }

  _decorate(c) {
    return { ...c, open_rate: openRate(c) }
  }

  _targetApp(audience) {
    switch (audience.kind) {
      case 'ALL_CUSTOMERS': case 'SEGMENT': case 'LEGACY': return 'customer'
      case 'ALL_VENDORS': case 'ALL_CAPTAINS': case 'VENDOR': case 'VENDOR_CAPTAINS': return 'partner'
      case 'LOCATION': return audience.target === 'customers' ? 'customer' : 'partner'
      default: return null
    }
  }

  _runInBackground(campaignId) {
    this.executeCampaign(campaignId).catch(async (err) => {
      logger.error({ err: err.message, campaignId }, 'Campaign send failed')
      await this.repo.updateCampaignStatus(campaignId, 'FAILED', { failureSummary: { reason: err.message } })
        .catch(() => {})
    })
  }

  /**
   * The one send executor — immediate and scheduled campaigns both land here.
   * It reads everything (audience, content, link, expiry) from the stored row,
   * so nothing can drift between "created" and "sent".
   */
  async executeCampaign(campaignId) {
    const c = await this.repo.getCampaignForSend(campaignId)
    if (!c || c.status !== 'SENDING') return null

    // A campaign whose audience was never stored (created before this system)
    // must NOT be widened to "everyone" — refuse instead.
    if (!c.audience) {
      await this.repo.updateCampaignStatus(campaignId, 'FAILED', {
        failureSummary: { reason: 'Audience missing — recreate this campaign.' },
      })
      return null
    }
    if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) {
      await this.repo.updateCampaignStatus(campaignId, 'FAILED', { failureSummary: { reason: 'Campaign expired before it was sent.' } })
      return null
    }

    const audience = normalizeAudience(c.audience)
    const devices = await resolveAudienceDevices(audience)
    const link = c.deep_link_type ? { type: c.deep_link_type, params: c.deep_link_params || {} } : null
    const ttlSeconds = c.expires_at ? Math.floor((new Date(c.expires_at).getTime() - Date.now()) / 1000) : undefined
    const message = {
      title: c.title, body: c.body, imageUrl: c.image_url, link, legacyType: 'campaign', ttlSeconds,
      data: { campaignType: c.type || 'general' },
    }

    let sent = 0; let failed = 0; let invalid = 0; let configured = true
    const users = new Set()
    for (const chunk of chunkByUser(devices, DEVICE_CHUNK)) {
      const userIds = [...new Set(chunk.map((d) => d.user_id))]
      userIds.forEach((u) => users.add(u))
      const inbox = await this.repo.insertInboxItems(userIds, {
        title: c.title, body: c.body, type: 'campaign',
        data: { campaignId, link, imageUrl: c.image_url || null },
      })
      const r = await this.dispatcher.dispatch(chunk, message, {
        kind: 'CAMPAIGN', campaignId, notificationIds: inbox,
      })
      configured = configured && r.configured
      sent += r.sent; failed += r.failed; invalid += r.invalid
    }

    let status = 'SENT'
    const failureSummary = { invalidTokensDeactivated: invalid }
    if (!configured) { status = 'FAILED'; failureSummary.reason = 'Push service is not configured on the server.' }
    else if (devices.length > 0 && sent === 0) { status = 'FAILED'; failureSummary.reason = 'No device accepted the message.' }

    await this.repo.updateCampaignStatus(campaignId, status, {
      sentCount: sent, failedCount: failed + invalid, targetCount: users.size,
      deviceCount: devices.length, failureSummary,
    })
    logger.info({ campaignId, users: users.size, devices: devices.length, sent, failed, invalid }, 'Campaign send complete')
    return { status, sent, failed, invalid }
  }

  /** Called by the scheduler once a SCHEDULED campaign has been claimed. */
  async executeScheduledCampaign(campaignId) {
    return this.executeCampaign(campaignId)
  }

  /* ── Test send ── */

  /**
   * Send a real notification to ONE registered person, using their current
   * server-stored devices — no token is ever typed or configured by hand.
   * Result per device: SENT | FAILED | INVALID_TOKEN, or NO_DEVICE overall.
   */
  async testSend(body, adminId, ip) {
    let userId = body.userId
    if (!userId && body.phone) {
      const list = await this.repo.searchRecipients({ q: body.phone, type: 'any', limit: 1 })
      userId = list[0]?.id
    }
    if (!userId) throw new NotificationRequestError('Pick a registered user to send the test to.', 'USER_REQUIRED')
    const user = await this.repo.findUserBasic(userId)
    if (!user || !user.is_active) throw new NotificationRequestError('That user was not found.', 'USER_NOT_FOUND')

    const content = this._content({
      title: body.title || 'LNDRY test notification',
      body: body.body || 'This is a test notification from the admin dashboard.',
      link: body.link, image_url: body.image_url, deep_link: body.deep_link,
    })

    const devices = await this.dispatcher.devicesForUsers([userId])
    if (!devices.length) {
      return { status: 'NO_DEVICE', user: { id: user.id, name: user.name, phone: user.phone }, devices: [] }
    }
    const r = await this.dispatcher.dispatch(devices, {
      title: content.title, body: content.body, imageUrl: content.image_url, link: content.link,
      legacyType: 'test', data: {},
    }, { kind: 'TEST' })

    let status = 'FAILED'
    if (!r.configured) status = 'NOT_CONFIGURED'
    else if (r.sent > 0) status = 'SENT'
    else if (r.invalid === r.devices) status = 'INVALID_TOKEN'
    logAdminActivity(adminId, 'NOTIFICATION_TEST', 'user', userId, null, { status }, ip)

    return {
      status,
      user: { id: user.id, name: user.name, phone: user.phone },
      devices: (r.results.length ? r.results : devices.map((d) => ({ appType: d.app_type, platform: d.platform, status: 'FAILED' })))
        .map((d) => ({
          app: d.appType, platform: d.platform, model: d.deviceModel || null,
          status: d.status, error: d.errorCode || null,
        })),
    }
  }

  /* ── Legacy request shapes (existing dashboard) ── */

  async sendBulk(body, adminId, ip) {
    return this.createCampaign({ ...body, mode: 'SEND_NOW' }, adminId, ip)
  }

  async scheduleCampaign(body, adminId, ip) {
    return this.createCampaign({ ...body, mode: 'SCHEDULE' }, adminId, ip)
  }

  async getSegmentCount(segment, segmentValue) {
    const audience = await audienceFromLegacy(segment, segmentValue)
    return (await countAudience(audience)).users
  }
}

/** Split devices into chunks without splitting a user's devices across chunks. */
export function* chunkByUser(devices, size) {
  let chunk = []
  let lastUser = null
  for (const d of devices) {
    if (chunk.length >= size && d.user_id !== lastUser) {
      yield chunk
      chunk = []
    }
    chunk.push(d)
    lastUser = d.user_id
  }
  if (chunk.length) yield chunk
}
