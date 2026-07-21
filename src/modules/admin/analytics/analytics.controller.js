import { AdminAnalyticsService } from './analytics.service.js'
import { success } from '../../../utils/apiResponse.js'

const svc = new AdminAnalyticsService()

export class AdminAnalyticsController {
  async getSales(request, reply) {
    const { startDate, endDate, groupBy } = request.query
    const data = await svc.getSalesAnalytics({ startDate, endDate, groupBy })
    return success(data, 'Sales analytics fetched')
  }

  async getProductPerformance(request, reply) {
    const { startDate, endDate, limit } = request.query
    const data = await svc.getProductPerformance({ startDate, endDate, limit })
    return success(data, 'Product performance fetched')
  }

  async getCustomerCohorts(request, reply) {
    const data = await svc.getCustomerCohorts()
    return success(data, 'Customer cohorts fetched')
  }

  async getDeliveryAnalytics(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getDeliveryAnalytics({ startDate, endDate })
    return success(data, 'Delivery analytics fetched')
  }

  async getFinancialReport(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getFinancialReport({ startDate, endDate })
    return success(data, 'Financial report fetched')
  }

  async getCartEnhancementAnalytics(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getCartEnhancementAnalytics({ startDate, endDate })
    return success(data, 'Cart enhancement analytics fetched')
  }

  async getComparison(request, reply) {
    const data = await svc.getComparison(request.query)
    return success(data, 'Comparison fetched')
  }

  async exportPDF(request, reply) {
    const { startDate, endDate } = request.query
    const buffer = await svc.exportReportPDF({ startDate, endDate })
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="analytics-report-${Date.now()}.pdf"`)
    return reply.send(buffer)
  }
}
