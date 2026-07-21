import { DashboardRepository } from './dashboard.repository.js'
import { DashboardService } from './dashboard.service.js'
import { DashboardController } from './dashboard.controller.js'
import {
  getStatsSchema, getRevenueChartSchema, getOrdersByHourSchema,
  getTopProductsSchema, getLowStockSchema, getPendingActionsSchema,
  getLiveStatsSchema, getCategoryRevenueSchema,
} from './dashboard.schema.js'

/**
 * Admin dashboard routes
 * Prefix: /api/v1/admin/dashboard
 */
export default async function dashboardRoutes(fastify) {
  const repo = new DashboardRepository()
  const service = new DashboardService(repo)
  const ctrl = new DashboardController(service)

  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/stats', { schema: getStatsSchema, preHandler: adminAuth }, ctrl.getStats.bind(ctrl))
  fastify.get('/revenue-chart', { schema: getRevenueChartSchema, preHandler: adminAuth }, ctrl.getRevenueChart.bind(ctrl))
  fastify.get('/orders-by-hour', { schema: getOrdersByHourSchema, preHandler: adminAuth }, ctrl.getOrdersByHour.bind(ctrl))
  fastify.get('/top-garment_rates', { schema: getTopProductsSchema, preHandler: adminAuth }, ctrl.getTopProducts.bind(ctrl))
  fastify.get('/top-products', { schema: getTopProductsSchema, preHandler: adminAuth }, ctrl.getTopProducts.bind(ctrl))
  fastify.get('/low-stock-alerts', { schema: getLowStockSchema, preHandler: adminAuth }, ctrl.getLowStockAlerts.bind(ctrl))
  fastify.get('/pending-actions', { schema: getPendingActionsSchema, preHandler: adminAuth }, ctrl.getPendingActions.bind(ctrl))
  fastify.get('/live-stats', { schema: getLiveStatsSchema, preHandler: adminAuth }, ctrl.getLiveStats.bind(ctrl))
  fastify.get('/category-revenue', { schema: getCategoryRevenueSchema, preHandler: adminAuth }, ctrl.getCategoryRevenue.bind(ctrl))
}
