import { query } from '../../config/database.js'
import { ShopReportsService } from './service.js'
import { ShopReportsRepository } from './repository.js'

const repo = new ShopReportsRepository()
const shopReportsService = new ShopReportsService(repo)

export class VendorAnalyticsController {
  
  async getSummary(request, reply) {
    const { period } = request.query
    const userId = request.user.id

    // 1. Resolve Shop ID from Vendor Staff
    const { rows } = await query(
      `SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL LIMIT 1`,
      [userId]
    )
    if (!rows.length) {
      return reply.code(403).send({ success: false, message: 'Not a vendor employee', code: 'NOT_VENDOR' })
    }
    const shopId = rows[0].vendor_id

    // 2. Determine Date Range
    const toDate = new Date()
    const fromDate = new Date()
    const days = period === 'month' ? 30 : 7
    fromDate.setDate(toDate.getDate() - days)

    const filters = {
      from: fromDate.toISOString(),
      to: toDate.toISOString()
    }

    // 3. Fetch data from canonical ShopReportsService
    const [ordersData, revenueData, productsData] = await Promise.all([
      shopReportsService.getExportData(shopId, 'orders', filters),
      shopReportsService.getExportData(shopId, 'revenue', filters),
      shopReportsService.getExportData(shopId, 'top-garment_rates', filters)
    ])

    // 4. Map to Flutter Contract
    let totalRevenue = 0.0
    let totalOrders = 0
    let deliveredCount = 0
    let cancelledCount = 0
    let processingCount = 0
    let pendingCount = 0

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const dailyMap = {}
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().split('T')[0]
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
      const dayLabel = period === 'month' ? `${d.getDate()} ${monthNames[d.getMonth()]}` : weekday
      dailyMap[dateStr] = { label: dayLabel, revenue: 0, orders: 0, date: dateStr }
    }

    // Aggregate Orders
    for (const row of ordersData) {
      const dateStr = new Date(row.date).toISOString().split('T')[0]
      const count = parseInt(row.count, 10)
      totalOrders += count

      if (row.status === 'DELIVERED') {
        deliveredCount += count
        if (dailyMap[dateStr]) dailyMap[dateStr].orders += count
      } else if (['VENDOR_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'AUTO_REJECTED'].includes(row.status)) {
        cancelledCount += count
      } else if (row.status === 'PROCESSING') {
        processingCount += count
      } else if (row.status === 'WAITING_VENDOR_CONFIRMATION') {
        pendingCount += count
      }
    }

    // Aggregate Revenue
    for (const row of revenueData) {
      const dateStr = new Date(row.date).toISOString().split('T')[0]
      const rev = parseFloat(row.gross_revenue || 0)
      totalRevenue += rev
      if (dailyMap[dateStr]) dailyMap[dateStr].revenue += rev
    }

    // Process category breakdown
    const categoryBreakdown = []
    if (totalRevenue > 0) {
      for (const row of productsData) {
        const rev = parseFloat(row.total_revenue || 0)
        categoryBreakdown.push({
          name: row.product_name,
          revenue: rev,
          percentage: Math.round((rev / totalRevenue) * 100)
        })
      }
      categoryBreakdown.sort((a, b) => b.revenue - a.revenue)
    }

    const fulfillmentRate = totalOrders > 0 
      ? Math.round((deliveredCount / totalOrders) * 100) 
      : 0.0
    
    const avgTicket = deliveredCount > 0 ? totalRevenue / deliveredCount : 0.0

    return reply.send({
      success: true,
      message: 'Analytics summary fetched',
      data: {
        period,
        total_revenue: totalRevenue,
        total_orders: totalOrders,
        delivered_orders: deliveredCount,
        cancelled_orders: cancelledCount,
        processing_orders: processingCount,
        pending_orders: pendingCount,
        fulfillment_rate: fulfillmentRate,
        avg_ticket_size: avgTicket,
        daily_data: Object.values(dailyMap),
        category_breakdown: categoryBreakdown,
        repeat_customer_rate: 0.0, // Historical metric placeholder
        on_time_delivery_rate: 0.0 // Historical metric placeholder
      }
    })
  }
}
