import { VendorAnalyticsController } from './vendor-analytics.controller.js'
import { requireVendorPermission } from '../../middlewares/vendor-permission.js'

export default async function vendorAnalyticsRoutes(fastify) {
  const controller = new VendorAnalyticsController()

  // GET /summary
  fastify.get('/summary', {
    preHandler: [fastify.authenticate, requireVendorPermission('shop_reports.view')],
    schema: {
      tags: ['Vendor Analytics'],
      summary: 'Get vendor dashboard analytics summary (Flutter App Compatibility)',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['week', 'month'], default: 'week' }
        }
      }
    }
  }, controller.getSummary.bind(controller))
}
