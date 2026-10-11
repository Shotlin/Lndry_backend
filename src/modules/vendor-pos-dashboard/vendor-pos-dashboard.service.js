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
    const [tiles, collectedToday, onlineRequests, washingToStore, counterSales, cashShift, taskRows, qualityClaims, returnCases, riderSettlements, orderHolds, topGarments] = await Promise.all([
      this.repo.homeOrderTiles(vendorId, asOf),
      this.repo.homeCollectionToday(vendorId, asOf),
      this.repo.onlineOrderRequestsCount(vendorId),
      this.repo.washingToStoreCount(vendorId),
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
      // POS Home tiles. Integers, never null: every figure is computed from this vendor's own rows.
      home: {
        todayRevenuePaise: Number(tiles.revenue_today_paise),
        todayCollectionPaise: Number(collectedToday),
        onlineOrderRequests: onlineRequests,
        washingToStore,
        bookingsToday: tiles.bookings_today,
        deliveriesToday: tiles.deliveries_today,
        deliveredToday: tiles.delivered_today,
        pendingOrders: tiles.pending_orders,
        unassignedPickups: tiles.unassigned_pickups,
        upcomingDeliveries: tiles.upcoming_deliveries,
        unassignedDeliveries: tiles.unassigned_deliveries,
        expressOrders: tiles.express_orders,
        collectionDuePaise: Number(tiles.collection_due_paise),
      },
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
  /** Totals for [from, to] (YYYY-MM-DD, inclusive, at most 366 days). Every figure is whole paise from the database. */
  async report(vendorId, from, to) {
    const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
    if (!valid(from) || !valid(to)) return { success: false, message: 'from and to must be real dates (YYYY-MM-DD)' }
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1
    if (days < 1) return { success: false, message: 'from must not be after to' }
    if (days > 366) return { success: false, message: 'A report can cover at most 366 days' }
    const r = await this.repo.report(vendorId, from, to)
    const mode = (m) => Number(r.payments.find((p) => p.mode === m)?.total_paise ?? 0)
    const collectionPaise = r.payments.reduce((sum, p) => sum + Number(p.total_paise), 0)
    const expensesPaise = Number(r.expenses.total_paise)
    const statusCount = (...s) => r.byStatus.filter((x) => s.includes(x.status)).reduce((sum, x) => sum + x.count, 0)
    return {
      success: true,
      report: {
        from, to, days,
        orderCount: r.orders.count,
        revenuePaise: Number(r.orders.revenue_paise),
        collectionPaise,
        duesPaise: Number(r.dues.dues_paise),
        duesOrderCount: r.dues.count,
        expensesPaise,
        expenseCount: r.expenses.count,
        netPaise: collectionPaise - expensesPaise,
        ordersByStatus: {
          booked: statusCount('BOOKED', 'PICKED_UP'),
          inProcess: statusCount('IN_PROCESS'),
          ready: statusCount('READY', 'OUT_FOR_DELIVERY'),
          delivered: statusCount('DELIVERED'),
          cancelled: statusCount('CANCELLED'),
        },
        paymentMix: { cashPaise: mode('CASH'), upiPaise: mode('UPI'), cardPaise: mode('CARD'), bankPaise: mode('BANK'), walletPaise: mode('WALLET') },
        expenseByCategory: r.expenseByCategory.map((x) => ({ category: x.category, totalPaise: Number(x.total_paise) })),
        topGarments: r.topGarments.map((x) => ({ name: x.name, qty: x.qty, revenuePaise: Number(x.revenue_paise) })),
        daily: r.daily.map((x) => ({ date: x.day, revenuePaise: Number(x.revenue_paise), collectionPaise: Number(x.collection_paise), expensesPaise: Number(x.expenses_paise) })),
      },
    }
  }
}
