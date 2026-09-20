import { AdminNotificationsService, NotificationRequestError } from './notifications.service.js'
import { AudienceError } from './audience.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminNotificationsService()

/** Plain-language request problems become a 400 the dashboard can show as-is. */
async function guarded(reply, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof NotificationRequestError || err instanceof AudienceError) {
      return reply.code(400).send(error(err.message, err.code))
    }
    throw err
  }
}

const notFound = (reply, what) => reply.code(404).send(error(`${what} not found`, 'NOT_FOUND'))

export class AdminNotificationsController {
  /* ── Templates ── */
  async listTemplates() {
    return success(await svc.listTemplates(), 'Templates fetched')
  }

  async getTemplate(request, reply) {
    const t = await svc.getTemplate(request.params.id)
    return t ? success(t, 'Template fetched') : notFound(reply, 'Template')
  }

  async createTemplate(request, reply) {
    return guarded(reply, async () =>
      success(await svc.createTemplate(request.body, request.user.id, request.ip), 'Template created'))
  }

  async updateTemplate(request, reply) {
    return guarded(reply, async () => {
      const t = await svc.updateTemplate(request.params.id, request.body, request.user.id, request.ip)
      return t ? success(t, 'Template updated') : notFound(reply, 'Template')
    })
  }

  async duplicateTemplate(request, reply) {
    const t = await svc.duplicateTemplate(request.params.id, request.user.id, request.ip)
    return t ? success(t, 'Template duplicated') : notFound(reply, 'Template')
  }

  async deleteTemplate(request, reply) {
    const ok = await svc.deleteTemplate(request.params.id, request.user.id, request.ip)
    return ok ? success(null, 'Template deleted') : notFound(reply, 'Template')
  }

  /* ── Campaigns ── */
  async createCampaign(request, reply) {
    return guarded(reply, async () => {
      const c = await svc.createCampaign(request.body, request.user.id, request.ip)
      const msg = { SENDING: 'Sending now', SCHEDULED: 'Campaign scheduled', DRAFT: 'Draft saved' }[c.status] || 'Campaign created'
      return success(c, msg)
    })
  }

  async updateDraft(request, reply) {
    return guarded(reply, async () => {
      const c = await svc.updateDraft(request.params.id, request.body, request.user.id, request.ip)
      return c ? success(c, 'Draft updated') : notFound(reply, 'Draft')
    })
  }

  async sendDraft(request, reply) {
    return guarded(reply, async () => {
      const c = await svc.sendDraft(request.params.id, request.body || {}, request.user.id, request.ip)
      return c ? success(c, c.status === 'SCHEDULED' ? 'Campaign scheduled' : 'Sending now') : notFound(reply, 'Draft')
    })
  }

  async cancelCampaign(request, reply) {
    const c = await svc.cancelCampaign(request.params.id, request.user.id, request.ip)
    return c ? success(c, 'Campaign cancelled')
      : reply.code(404).send(error('Only a scheduled campaign can be cancelled.', 'NOT_CANCELLABLE'))
  }

  async deleteCampaign(request, reply) {
    const ok = await svc.deleteCampaign(request.params.id, request.user.id, request.ip)
    return ok ? success(null, 'Campaign deleted')
      : reply.code(404).send(error('Only drafts and cancelled campaigns can be deleted.', 'NOT_DELETABLE'))
  }

  async listCampaigns(request) {
    const { page, limit, status } = request.query
    return success(await svc.listCampaigns({ page, limit, status }), 'Campaigns fetched')
  }

  async getCampaign(request, reply) {
    const c = await svc.getCampaign(request.params.id)
    return c ? success(c, 'Campaign fetched') : notFound(reply, 'Campaign')
  }

  /* ── Audience / test ── */
  async audienceCount(request, reply) {
    return guarded(reply, async () => success(await svc.audienceCount(request.body), 'Audience counted'))
  }

  async searchRecipients(request) {
    const { q, type } = request.query
    return success(await svc.searchRecipients({ q, type }), 'Recipients fetched')
  }

  async testSend(request, reply) {
    return guarded(reply, async () => success(await svc.testSend(request.body, request.user.id, request.ip), 'Test processed'))
  }

  /* ── Legacy request shapes (kept so the existing dashboard keeps working) ── */
  async sendBulk(request, reply) {
    return guarded(reply, async () => success(await svc.sendBulk(request.body, request.user.id, request.ip), 'Bulk notification queued'))
  }

  async schedule(request, reply) {
    return guarded(reply, async () => success(await svc.scheduleCampaign(request.body, request.user.id, request.ip), 'Campaign scheduled'))
  }

  async getSegmentCount(request, reply) {
    return guarded(reply, async () => {
      const { segment, segmentValue } = request.query
      const count = await svc.getSegmentCount(segment, segmentValue)
      return success({ segment, segmentValue, count }, 'Segment count fetched')
    })
  }
}
