export class DashboardService {
  constructor(repository) {
    this.repository = repository
  }

  async getStats(period = 'week') {
    return this.repository.getStats(period)
  }

  async getRevenueChart(days) {
    return this.repository.getRevenueChart(days)
  }

  async getOrdersByHour() {
    return this.repository.getOrdersByHour()
  }

  async getTopProducts(limit) {
    return this.repository.getTopProducts(limit)
  }

  async getLowStockAlerts(threshold) {
    return this.repository.getLowStockAlerts(threshold)
  }

  async getPendingActions() {
    return this.repository.getPendingActions()
  }

  async getLiveStats() {
    return this.repository.getLiveStats()
  }

  async getCategoryRevenue() {
    return this.repository.getCategoryRevenue()
  }
}
