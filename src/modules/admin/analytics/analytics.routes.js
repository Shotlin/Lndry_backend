import { AdminAnalyticsController } from './analytics.controller.js'
import {
  salesSchema, productPerformanceSchema, dateRangeSchema, comparisonSchema, cartEnhancementAnalyticsSchema,
} from './analytics.schema.js'

const ctrl = new AdminAnalyticsController()

export default async function adminAnalyticsRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/sales', { schema: salesSchema }, ctrl.getSales)
  fastify.get('/product-performance', { schema: productPerformanceSchema }, ctrl.getProductPerformance)
  fastify.get('/customer-cohorts', ctrl.getCustomerCohorts)
  fastify.get('/delivery', { schema: dateRangeSchema }, ctrl.getDeliveryAnalytics)
  fastify.get('/financial', { schema: dateRangeSchema }, ctrl.getFinancialReport)
  fastify.get('/cart-enhancements', { schema: cartEnhancementAnalyticsSchema }, ctrl.getCartEnhancementAnalytics)
  fastify.get('/comparison', { schema: comparisonSchema }, ctrl.getComparison)
  fastify.get('/export-pdf', { schema: dateRangeSchema }, ctrl.exportPDF)
}
