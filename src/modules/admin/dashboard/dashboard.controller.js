import { success } from '../../../utils/apiResponse.js'

export class DashboardController {
  constructor(service) {
    this.service = service
  }

  async getStats(request, reply) {
    const { period = 'week' } = request.query
    const data = await this.service.getStats(period)
    return reply.send(success(data, 'Dashboard stats fetched'))
  }

  async getRevenueChart(request, reply) {
    const { days = 7 } = request.query
    const data = await this.service.getRevenueChart(days)
    return reply.send(success(data, 'Revenue chart data'))
  }

  async getOrdersByHour(request, reply) {
    const data = await this.service.getOrdersByHour()
    return reply.send(success(data, 'Orders by hour'))
  }

  async getTopProducts(request, reply) {
    const { limit = 10 } = request.query
    const data = await this.service.getTopProducts(limit)
    return reply.send(success(data, 'Top garment_rates'))
  }

  async getLowStockAlerts(request, reply) {
    const { threshold = 10 } = request.query
    const data = await this.service.getLowStockAlerts(threshold)
    return reply.send(success(data, 'Low stock alerts'))
  }

  async getPendingActions(request, reply) {
    const data = await this.service.getPendingActions()
    return reply.send(success(data, 'Pending actions'))
  }

  async getLiveStats(request, reply) {
    const data = await this.service.getLiveStats()
    return reply.send(success(data, 'Live stats'))
  }

  async getCategoryRevenue(request, reply) {
    const data = await this.service.getCategoryRevenue()
    return reply.send(success(data, 'Category revenue breakdown'))
  }
}
