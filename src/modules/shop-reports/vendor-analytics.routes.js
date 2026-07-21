import { VendorAnalyticsController } from './vendor-analytics.controller.js'

export default async function vendorAnalyticsRoutes(fastify) {
  const controller = new VendorAnalyticsController()

  // GET /summary
  fastify.get('/summary', {
    preHandler: [fastify.authenticate],
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
