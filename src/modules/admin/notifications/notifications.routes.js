import { AdminNotificationsController } from './notifications.controller.js'
import {
  templateIdSchema, createTemplateSchema, updateTemplateSchema,
  sendBulkSchema, scheduleCampaignSchema, listCampaignsSchema,
  campaignIdSchema, cancelCampaignSchema, segmentCountSchema,
  createCampaignSchema, updateDraftSchema, sendDraftSchema,
  audienceCountBodySchema, recipientSearchSchema, testSendSchema,
} from './notifications.schema.js'

const ctrl = new AdminNotificationsController()

export default async function adminNotificationRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  /* Templates */
  fastify.get('/templates', ctrl.listTemplates.bind(ctrl))
  fastify.get('/templates/:id', { schema: templateIdSchema }, ctrl.getTemplate.bind(ctrl))
  fastify.post('/templates', { schema: createTemplateSchema }, ctrl.createTemplate.bind(ctrl))
  fastify.put('/templates/:id', { schema: updateTemplateSchema }, ctrl.updateTemplate.bind(ctrl))
  fastify.post('/templates/:id/duplicate', { schema: templateIdSchema }, ctrl.duplicateTemplate.bind(ctrl))
  fastify.delete('/templates/:id', { schema: templateIdSchema }, ctrl.deleteTemplate.bind(ctrl))

  /* Campaigns (Notification Center) */
  fastify.post('/campaigns', { schema: createCampaignSchema }, ctrl.createCampaign.bind(ctrl))
  fastify.get('/campaigns', { schema: listCampaignsSchema }, ctrl.listCampaigns.bind(ctrl))
  fastify.get('/campaigns/:id', { schema: campaignIdSchema }, ctrl.getCampaign.bind(ctrl))
  fastify.put('/campaigns/:id', { schema: updateDraftSchema }, ctrl.updateDraft.bind(ctrl))
  fastify.post('/campaigns/:id/send', { schema: sendDraftSchema }, ctrl.sendDraft.bind(ctrl))
  fastify.post('/campaigns/:id/cancel', { schema: cancelCampaignSchema }, ctrl.cancelCampaign.bind(ctrl))
  fastify.delete('/campaigns/:id', { schema: campaignIdSchema }, ctrl.deleteCampaign.bind(ctrl))

  /* Audience + test */
  fastify.post('/audience/count', { schema: audienceCountBodySchema }, ctrl.audienceCount.bind(ctrl))
  fastify.get('/recipients/search', { schema: recipientSearchSchema }, ctrl.searchRecipients.bind(ctrl))
  fastify.post('/test', { schema: testSendSchema }, ctrl.testSend.bind(ctrl))

  /* Legacy shapes (existing dashboard) */
  fastify.post('/send-bulk', { schema: sendBulkSchema }, ctrl.sendBulk.bind(ctrl))
  fastify.post('/schedule', { schema: scheduleCampaignSchema }, ctrl.schedule.bind(ctrl))
  fastify.get('/segment-count', { schema: segmentCountSchema }, ctrl.getSegmentCount.bind(ctrl))
}
