import { AdminAnalyticsRepository } from './analytics.repository.js'
import PDFDocument from 'pdfkit'

const repo = new AdminAnalyticsRepository()

export class AdminAnalyticsService {
  async getSalesAnalytics(params) {
    return repo.getSalesAnalytics(params)
  }

  async getProductPerformance(params) {
    return repo.getProductPerformance(params)
  }

  async getCustomerCohorts() {
    return repo.getCustomerCohorts()
  }

  async getDeliveryAnalytics(params) {
    return repo.getDeliveryAnalytics(params)
  }

  async getFinancialReport(params) {
    return repo.getFinancialReport(params)
  }

  async getCartEnhancementAnalytics(params) {
    return repo.getCartEnhancementAnalytics(params)
  }

  async getComparison(params) {
    return repo.getComparisonStats(
      params.period1Start, params.period1End,
      params.period2Start, params.period2End
    )
  }

  async exportReportPDF({ startDate, endDate }) {
    const [sales, financial] = await Promise.all([
      repo.getSalesAnalytics({ startDate, endDate }),
      repo.getFinancialReport({ startDate, endDate }),
    ])

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 })
      const chunks = []
      doc.on('data', c => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Title
      doc.fontSize(20).text('Analytics Report', { align: 'center' })
      doc.moveDown()
      if (startDate || endDate) {
        doc.fontSize(10).text(`Period: ${startDate || 'start'} — ${endDate || 'now'}`, { align: 'center' })
        doc.moveDown()
      }

      // Sales Summary
      doc.fontSize(14).text('Sales Summary')
      doc.moveDown(0.5)
      doc.fontSize(10)
      const s = sales.summary
      doc.text(`Total Revenue: ₹${s.total_revenue.toLocaleString('en-IN')}`)
      doc.text(`Total Orders: ${s.total_orders}`)
      doc.text(`Average Order Value: ₹${s.avg_order_value.toFixed(2)}`)
      doc.text(`Unique Customers: ${s.unique_customers}`)
      doc.text(`Total Discounts: ₹${s.total_discounts.toLocaleString('en-IN')}`)
      doc.moveDown()

      // Financial Summary
      doc.fontSize(14).text('Financial Summary')
      doc.moveDown(0.5)
      doc.fontSize(10)
      const f = financial.revenue
      doc.text(`Gross Revenue: ₹${f.gross.toLocaleString('en-IN')}`)
      doc.text(`Net Revenue: ₹${f.net.toLocaleString('en-IN')}`)
      doc.text(`Delivery Fees: ₹${f.delivery_fees.toLocaleString('en-IN')}`)
      doc.moveDown()

      // Payment Methods
      doc.fontSize(14).text('Payment Methods')
      doc.moveDown(0.5)
      doc.fontSize(10)
      for (const pm of financial.byPaymentMethod) {
        doc.text(`${pm.payment_method}: ₹${pm.revenue.toLocaleString('en-IN')} (${pm.count} orders)`)
      }
      doc.moveDown()

      // GST Breakdown
      if (financial.gstBreakdown.length > 0) {
        doc.fontSize(14).text('GST Breakdown')
        doc.moveDown(0.5)
        doc.fontSize(10)
        for (const g of financial.gstBreakdown) {
          doc.text(`${g.gst_rate}%: Taxable ₹${g.taxable_amount.toLocaleString('en-IN')}, GST ₹${g.gst_amount.toLocaleString('en-IN')}`)
        }
      }

      doc.end()
    })
  }
}
