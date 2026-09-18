import { VendorPosDashboardRepository } from './vendor-pos-dashboard.repository.js'

function csvEscape(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export class VendorPosDashboardService {
  constructor(repository = new VendorPosDashboardRepository()) {
    this.repo = repository
  }

  async dashboard(vendorId) {
    const asOf = new Date().toISOString().slice(0, 10)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
    const [counterSales, cashShift, taskRows, qualityClaims, returnCases, riderSettlements, orderHolds, topGarments] = await Promise.all([
      this.repo.counterSalesSummary(vendorId, asOf),
      this.repo.openCashShift(vendorId),
      this.repo.productionTaskCounts(vendorId),
      this.repo.openQualityClaimsCount(vendorId),
      this.repo.pendingReturnCasesCount(vendorId),
      this.repo.pendingRiderSettlementsCount(vendorId),
      this.repo.activeOrderHoldsCount(vendorId),
      this.repo.topGarmentsSince(vendorId, sevenDaysAgo),
    ])

    const productionTasks = { open: 0, inProgress: 0, urgent: 0 }
    for (const row of taskRows) {
      if (row.status === 'OPEN') productionTasks.open += row.count
      if (row.status === 'IN_PROGRESS') productionTasks.inProgress += row.count
      if (row.priority === 'URGENT') productionTasks.urgent += row.count
    }

    return {
      asOf,
      counterSalesToday: counterSales,
      cashShift: cashShift ? { id: cashShift.id, register: cashShift.register, openingCashPaise: cashShift.opening_cash_paise, openedAt: cashShift.opened_at } : null,
      productionTasks,
      openQualityClaims: qualityClaims,
      pendingReturnCases: returnCases,
      pendingRiderSettlements: riderSettlements,
      activeOrderHolds: orderHolds,
      topGarmentsLast7Days: topGarments,
    }
  }

  async exportCounterSalesCsv(vendorId, from, to) {
    const rows = await this.repo.exportCounterSales(vendorId, from, to)
    const header = ['Order Number', 'Placed At', 'Customer', 'Phone', 'Subtotal (paise)', 'Discount (paise)', 'Tax (paise)', 'Total (paise)', 'Payment Method']
    const lines = [header.join(',')]
    for (const row of rows) {
      lines.push([
        row.order_number, row.placed_at, row.customer_name, row.customer_phone,
        row.subtotal_paise, row.discount_paise, row.tax_paise, row.total_paise, row.payment_method,
      ].map(csvEscape).join(','))
    }
    return lines.join('\n')
  }

  async search(vendorId, q) {
    const query = String(q || '').trim()
    if (query.length < 2) return { success: false, message: 'q must be at least 2 characters' }
    return { success: true, results: await this.repo.search(vendorId, query) }
  }
}
