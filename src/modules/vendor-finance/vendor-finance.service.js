import { VendorFinanceRepository } from './vendor-finance.repository.js'

/**
 * Vendor finance reports (Finance & compliance + Statutory controls in the POS website).
 *
 * The numbers are never recomputed here. Every figure is a persisted order / payment / invoice value:
 *   POS            store_orders          subtotal, charges, discount, tax, total — the same columns the counter
 *                                        order screen, the receipt and the invoice read (see the counter quote)
 *   LNDRY_ONLINE   orders                the same fee_breakdown / order_lines the invoice builder reads, with the
 *                                        same re-evaluation rule, so a report line can never disagree with the
 *                                        invoice a customer holds
 * The two channels live in different tables, so an order is in exactly one of them and "All" is a plain sum.
 *
 * Money is integer paise throughout; the website formats it.
 */

export const CHANNELS = Object.freeze({ POS: 'POS', ONLINE: 'LNDRY_ONLINE' })

/** Online orders that count as a sale: accepted by the vendor and not since cancelled or refunded. */
export const ONLINE_SALE_STATUSES = Object.freeze([
  'CONFIRMED', 'PREPARING', // legacy enum values still present on old rows
  'VENDOR_ACCEPTED', 'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED', 'PICKED_UP', 'RECEIVED_AT_VENDOR',
  'RECONCILIATION_PENDING', 'RECONCILIATION_DISPUTED', 'PROCESSING', 'PACKED', 'DELIVERY_ASSIGNED',
  'OUT_FOR_DELIVERY', 'DELIVERY_OTP_VERIFIED', 'DELIVERED',
])
const SALE_SET = new Set(ONLINE_SALE_STATUSES)
const PENDING_SET = new Set(['PENDING', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'WAITING_VENDOR_CONFIRMATION', 'WAITING_FOR_VENDOR_CONFIRMATION'])

const MODE_LABELS = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK: 'Bank transfer', WALLET: 'LNDRY wallet', ONLINE: 'Online payment (gateway)', OTHER: 'Other' }
const MAX_RANGE_DAYS = 800

const int = (value) => Math.round(Number(value) || 0)
const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100)
const parseJson = (value, fallback) => {
  if (value == null) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}
const norm = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1

/** Every day of the range, so a chart has no holes. */
function eachDay(from, to) {
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export function normalizeMode(raw) {
  const mode = String(raw || '').toUpperCase()
  if (mode.includes('WALLET')) return 'WALLET'
  if (mode === 'CASH' || mode === 'COD' || mode.includes('CASH')) return 'CASH'
  if (mode.includes('UPI')) return 'UPI'
  if (mode.includes('CARD')) return 'CARD'
  if (mode.includes('BANK') || mode.includes('NETBANKING') || mode.includes('NEFT') || mode.includes('IMPS')) return 'BANK'
  if (mode === 'RAZORPAY' || mode === 'ONLINE' || mode.includes('GATEWAY')) return 'ONLINE'
  return 'OTHER'
}

const failure = (message, code = 'VALIDATION_ERROR', statusCode = 400) => ({ success: false, message, code, statusCode })

/**
 * The persisted money on one online order, read exactly the way the invoice builder reads it
 * (modules/invoices/invoice-data.builder.js#buildFromOrder). After a re-evaluation the payable is
 * subtotal + delivery + platform fee only, so tax / discount / express are not part of the charge.
 */
export function onlineMoney(order) {
  const fb = parseJson(order.fee_breakdown, {}) || {}
  const reEvaluated = fb.original_subtotal_paise != null
  const totalPaise = order.payable_amount_paise ? int(order.payable_amount_paise) : toPaise(order.total_amount)
  const subtotalPaise = order.lines_paise != null ? int(order.lines_paise) : toPaise(order.subtotal)
  const deliveryPaise = int(fb.delivery_fee_paise ?? toPaise(order.delivery_fee))
  const platformPaise = int(fb.platform_fee_paise ?? toPaise(Number(order.platform_fee || 0) + Number(order.handling_fee || 0)))
  const expressPaise = reEvaluated ? 0 : int(fb.express_fee_paise)
  const taxPaise = reEvaluated ? 0 : int(fb.tax_paise ?? toPaise(order.tax_amount))
  const discountPaise = reEvaluated ? 0 : int(fb.discount_paise ?? toPaise(order.discount_amount))
  const chargesPaise = deliveryPaise + platformPaise + expressPaise
  const taxablePaise = subtotalPaise + chargesPaise - discountPaise
  const adjustmentPaise = totalPaise - (taxablePaise + taxPaise)

  // The GST rate the engine applied is recorded on the fee line; fall back to what the amounts imply.
  const gstLine = (parseJson(fb.canonical_breakdown, {})?.fees || []).find((fee) => fee?.code === 'GST')
  const recorded = Number(gstLine?.metadata?.rate)
  const ratePercent = taxPaise <= 0 ? 0 : Number.isFinite(recorded) && recorded > 0 ? recorded : taxablePaise > 0 ? Math.round((taxPaise * 10000) / taxablePaise) / 100 : 0

  return { subtotalPaise, deliveryPaise, platformPaise, expressPaise, chargesPaise, discountPaise, taxablePaise, taxPaise, totalPaise, adjustmentPaise, ratePercent }
}

const blankKpis = () => ({
  orderCount: 0, subtotalPaise: 0, additionalChargesPaise: 0, discountsPaise: 0, netSalesPaise: 0, gstPaise: 0,
  otherAdjustmentsPaise: 0, totalBilledPaise: 0, collectedPaise: 0, refundsPaise: 0, refundsOnSalesPaise: 0,
  outstandingPaise: 0, expensesPaise: 0, cancelledOrderCount: 0,
})
const KPI_KEYS = Object.keys(blankKpis())

function finishKpis(k) {
  return { ...k, netRevenuePaise: k.netSalesPaise - k.refundsOnSalesPaise, netCashPaise: k.collectedPaise - k.refundsPaise - k.expensesPaise }
}

const blankDay = () => ({ orders: 0, netSalesPaise: 0, gstPaise: 0, discountsPaise: 0, collectedPaise: 0, refundsPaise: 0, expensesPaise: 0 })

export class VendorFinanceService {
  constructor(repository = new VendorFinanceRepository()) {
    this.repo = repository
  }

  // ── Request handling ─────────────────────────────────────────────────────

  _period(from, to) {
    if (!isDate(from) || !isDate(to)) return failure('Choose a valid start and end date.')
    if (from > to) return failure('The start date must be on or before the end date.')
    if (daysBetween(from, to) > MAX_RANGE_DAYS) return failure(`Choose a period of at most ${MAX_RANGE_DAYS} days.`)
    return { from, to }
  }

  /** Is this business actually linked to the LNDRY marketplace? Read from the vendor record — never from an id. */
  _marketplace(profile) {
    const approved = Boolean(profile.vendor_approved) && profile.account_enabled !== false && profile.is_active !== false && !profile.deleted_at
    const hasOnlineOrders = Number(profile.online_order_count) > 0
    const connected = approved || hasOnlineOrders
    return {
      connected,
      approved,
      published: Boolean(profile.marketplace_published),
      hasOnlineOrders,
      commissionRatePercent: profile.commission_rate == null ? null : Number(profile.commission_rate),
      reason: connected ? null : 'This business has not been approved as an LNDRY marketplace vendor.',
    }
  }

  _channels(requested, connected) {
    const want = ['ALL', 'POS', 'ONLINE'].includes(String(requested || 'ALL').toUpperCase()) ? String(requested || 'ALL').toUpperCase() : 'ALL'
    const pos = want === 'ALL' || want === 'POS'
    const online = (want === 'ALL' || want === 'ONLINE') && connected
    // "All" for a business that is not on LNDRY is simply its counter business.
    const effective = want === 'ALL' && !connected ? 'POS' : want
    return { requested: want, effective, pos, online }
  }

  // ── Overview (Finance & compliance) ──────────────────────────────────────

  async overview(vendorId, { from, to, channel }) {
    const period = this._period(from, to)
    if (period.success === false) return period
    const profile = await this.repo.vendorProfile(vendorId)
    if (!profile) return failure('Vendor not found', 'NOT_FOUND', 404)
    const marketplace = this._marketplace(profile)
    const want = this._channels(channel, marketplace.connected)

    const notice = want.requested !== 'POS' && !marketplace.connected ? 'LNDRY Online is not connected for this business.' : null
    const base = { success: true, period: { from, to, days: daysBetween(from, to) }, currency: 'INR', generatedAt: new Date().toISOString(), requestedChannel: want.requested, channel: want.effective, marketplace, notice }
    if (want.requested === 'ONLINE' && !marketplace.connected) return { ...base, summary: null, channels: [], trend: [], payments: [], expenses: null, online: null, pos: null, integrity: null }

    const [posBlock, onlineBlock] = await Promise.all([
      want.pos ? this._posBlock(vendorId, from, to) : null,
      want.online ? this._onlineBlock(vendorId, from, to, profile) : null,
    ])
    const blocks = [posBlock, onlineBlock].filter(Boolean)

    const kpis = blankKpis()
    for (const block of blocks) for (const key of KPI_KEYS) kpis[key] += block.kpis[key]

    const trend = eachDay(from, to).map((date) => {
      const merged = blankDay()
      const byChannel = {}
      for (const block of blocks) {
        const row = block.days.get(date) || blankDay()
        for (const key of Object.keys(merged)) merged[key] += row[key]
        byChannel[block.channel] = row.netSalesPaise
      }
      return { date, ...merged, netSalesByChannel: byChannel }
    })

    const payments = this._mergePayments(blocks)
    const topItems = this._mergeTop(blocks)

    return {
      ...base,
      summary: finishKpis(kpis),
      channels: blocks.map((block) => ({ channel: block.channel, ...finishKpis(block.kpis) })),
      trend,
      payments,
      topItems,
      pos: posBlock ? posBlock.extra : null,
      online: onlineBlock ? onlineBlock.extra : null,
      expenses: posBlock ? posBlock.expenseBreakdown : { totalPaise: 0, byCategory: [] },
      integrity: {
        mirroredOrdersExcluded: posBlock ? posBlock.mirrored : 0,
        onlineSupplyStateUnknown: onlineBlock ? onlineBlock.extra.supplyStateUnknown : 0,
        note: 'POS sales and LNDRY online orders are stored separately, so an order is counted once. Any counter row that mirrors an online order number is left out of the totals.',
      },
    }
  }

  // ── POS ──────────────────────────────────────────────────────────────────

  async _posBlock(vendorId, from, to) {
    const [sales, payments, refunds, expenses, topItems, cash, captains, outstandingNow, mirrored] = await Promise.all([
      this.repo.posSales(vendorId, from, to),
      this.repo.posPayments(vendorId, from, to),
      this.repo.posRefunds(vendorId, from, to),
      this.repo.expenses(vendorId, from, to),
      this.repo.posTopItems(vendorId, from, to),
      this.repo.cashClosing(vendorId, from, to),
      this.repo.captainSettlements(vendorId, from, to),
      this.repo.posOutstandingNow(vendorId),
      this.repo.posMirroredCount(vendorId, from, to),
    ])

    const kpis = blankKpis()
    const days = new Map()
    const dayOf = (date) => { if (!days.has(date)) days.set(date, blankDay()); return days.get(date) }
    let cancelledPaid = 0
    const rates = new Map()
    for (const row of sales) {
      const subtotal = int(row.subtotal), charges = int(row.charges), discount = int(row.discount), tax = int(row.tax)
      const net = subtotal + charges - discount
      kpis.orderCount += int(row.orders)
      kpis.subtotalPaise += subtotal
      kpis.additionalChargesPaise += charges
      kpis.discountsPaise += discount
      kpis.netSalesPaise += net
      kpis.gstPaise += tax
      kpis.totalBilledPaise += int(row.total)
      kpis.otherAdjustmentsPaise += int(row.total) - (net + tax)
      kpis.outstandingPaise += int(row.outstanding)
      kpis.cancelledOrderCount += int(row.cancelled_orders)
      cancelledPaid += int(row.cancelled_paid)
      const d = dayOf(row.day)
      d.orders += int(row.orders); d.netSalesPaise += net; d.gstPaise += tax; d.discountsPaise += discount
      const bps = int(row.tax_rate_bps)
      const group = rates.get(bps) || { ratePercent: bps / 100, orders: 0, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, invoiceValuePaise: 0 }
      if (int(row.orders) > 0) {
        group.orders += int(row.orders); group.taxableValuePaise += net; group.cgstPaise += int(row.cgst); group.sgstPaise += int(row.sgst)
        group.taxPaise += tax; group.invoiceValuePaise += int(row.total)
        rates.set(bps, group)
      }
    }

    const modeTotals = new Map()
    for (const row of payments) {
      const amount = int(row.amount)
      kpis.collectedPaise += amount
      dayOf(row.day).collectedPaise += amount
      const mode = normalizeMode(row.mode)
      const entry = modeTotals.get(mode) || { amountPaise: 0, count: 0 }
      entry.amountPaise += amount; entry.count += int(row.count)
      modeTotals.set(mode, entry)
    }

    let approvedReturns = 0, approvedReturnCount = 0, refundTaxPaise = 0
    for (const row of refunds) {
      const amount = int(row.amount_paise)
      approvedReturns += amount; approvedReturnCount += 1
      kpis.refundsPaise += amount
      dayOf(row.day).refundsPaise += amount
      if (row.on_sale) { kpis.refundsOnSalesPaise += amount; refundTaxPaise += int(row.tax_portion) }
    }

    const expenseModes = new Map()
    const expenseCategories = new Map()
    for (const row of expenses) {
      const amount = int(row.amount)
      kpis.expensesPaise += amount
      dayOf(row.day).expensesPaise += amount
      const mode = normalizeMode(row.payment_mode)
      expenseModes.set(mode, (expenseModes.get(mode) || 0) + amount)
      const category = row.category || 'UNCLASSIFIED'
      const entry = expenseCategories.get(category) || { category, amountPaise: 0, count: 0 }
      entry.amountPaise += amount; entry.count += int(row.count)
      expenseCategories.set(category, entry)
    }

    const captainStatus = Object.fromEntries(captains.map((row) => [row.status, { amountPaise: int(row.amount), count: int(row.count) }]))
    const variance = cash.closed.reduce((sum, shift) => sum + int(shift.variance_paise), 0)

    return {
      channel: CHANNELS.POS,
      kpis,
      days,
      paymentModes: modeTotals,
      taxGroups: [...rates.values()],
      refundTaxPaise,
      mirrored,
      top: topItems.map((row) => ({ name: row.name, amountPaise: int(row.amount), orders: int(row.orders) })),
      expenseBreakdown: {
        totalPaise: kpis.expensesPaise,
        byCategory: [...expenseCategories.values()].sort((a, b) => b.amountPaise - a.amountPaise),
        byMode: [...expenseModes.entries()].map(([mode, amountPaise]) => ({ mode, label: MODE_LABELS[mode], amountPaise })),
      },
      extra: {
        cancelledPaidPaise: cancelledPaid,
        approvedReturns: { count: approvedReturnCount, amountPaise: approvedReturns },
        outstandingNow: { amountPaise: outstandingNow.outstanding, orders: outstandingNow.orders },
        cashClosing: {
          shiftsClosed: cash.closed.length,
          totalVariancePaise: variance,
          openShifts: cash.open.map((shift) => ({ id: shift.id, register: shift.register, businessDate: shift.business_date, openingCashPaise: int(shift.opening_cash_paise), openedAt: shift.opened_at })),
          recent: cash.closed.slice(0, 5).map((shift) => ({ id: shift.id, register: shift.register, businessDate: shift.business_date, expectedCashPaise: int(shift.expected_cash_paise), countedCashPaise: int(shift.counted_cash_paise), variancePaise: int(shift.variance_paise), closedAt: shift.closed_at })),
        },
        captainSettlements: {
          pending: captainStatus.PENDING || { amountPaise: 0, count: 0 },
          handedOver: captainStatus.HANDED_OVER || { amountPaise: 0, count: 0 },
          reconciled: captainStatus.RECONCILED || { amountPaise: 0, count: 0 },
          rejected: captainStatus.REJECTED || { amountPaise: 0, count: 0 },
        },
      },
    }
  }

  // ── LNDRY online ─────────────────────────────────────────────────────────

  async _onlineBlock(vendorId, from, to, profile) {
    const [orders, payments, refunds, top, settlementRows, openOrders] = await Promise.all([
      this.repo.onlineOrders(vendorId, from, to),
      this.repo.onlinePayments(vendorId, from, to),
      this.repo.onlineRefunds(vendorId, from, to),
      this.repo.onlineTopItems(vendorId, from, to, ONLINE_SALE_STATUSES),
      this.repo.settlements(vendorId, from, to),
      this.repo.onlineOpenOrders(vendorId),
    ])

    const vendorState = norm(profile.state)
    const kpis = blankKpis()
    const days = new Map()
    const dayOf = (date) => { if (!days.has(date)) days.set(date, blankDay()); return days.get(date) }
    const groups = new Map()
    const statusCounts = { sales: 0, awaitingVendor: 0, cancelled: 0, refunded: 0 }
    const platform = { deliveryFeesPaise: 0, platformFeesPaise: 0, expressFeesPaise: 0 }
    let deliveredItemsPaise = 0
    let supplyStateUnknown = 0

    for (const order of orders) {
      if (SALE_SET.has(order.status)) statusCounts.sales += 1
      else if (PENDING_SET.has(order.status)) { statusCounts.awaitingVendor += 1; continue }
      else if (order.status === 'REFUNDED') { statusCounts.refunded += 1; kpis.cancelledOrderCount += 1; continue }
      else { statusCounts.cancelled += 1; kpis.cancelledOrderCount += 1; continue }

      const money = onlineMoney(order)
      const net = money.subtotalPaise + money.chargesPaise - money.discountPaise
      kpis.orderCount += 1
      kpis.subtotalPaise += money.subtotalPaise
      kpis.additionalChargesPaise += money.chargesPaise
      kpis.discountsPaise += money.discountPaise
      kpis.netSalesPaise += net
      kpis.gstPaise += money.taxPaise
      kpis.totalBilledPaise += money.totalPaise
      kpis.otherAdjustmentsPaise += money.adjustmentPaise
      platform.deliveryFeesPaise += money.deliveryPaise
      platform.platformFeesPaise += money.platformPaise
      platform.expressFeesPaise += money.expressPaise
      if (order.status === 'DELIVERED') deliveredItemsPaise += money.subtotalPaise

      const paid = int(order.paid_paise)
      const settled = order.payment_status === 'PAID' || paid >= money.totalPaise
      kpis.outstandingPaise += settled ? 0 : Math.max(money.totalPaise - paid, 0)

      const d = dayOf(order.day)
      d.orders += 1; d.netSalesPaise += net; d.gstPaise += money.taxPaise; d.discountsPaise += money.discountPaise

      // Place of supply: the delivery address' state; the supplier's own when it cannot be told.
      const shipState = norm(order.ship_state)
      if (!shipState || !vendorState) supplyStateUnknown += 1
      const interState = Boolean(shipState && vendorState && shipState !== vendorState)
      const cgst = interState ? 0 : Math.trunc(money.taxPaise / 2)
      const sgst = interState ? 0 : money.taxPaise - cgst
      const igst = interState ? money.taxPaise : 0
      const key = money.taxPaise > 0 ? money.ratePercent : 0
      const group = groups.get(key) || { ratePercent: key, orders: 0, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, invoiceValuePaise: 0 }
      group.orders += 1; group.taxableValuePaise += net; group.cgstPaise += cgst; group.sgstPaise += sgst; group.igstPaise += igst
      group.taxPaise += money.taxPaise; group.invoiceValuePaise += money.totalPaise
      groups.set(key, group)
    }

    const modeTotals = new Map()
    for (const row of payments) {
      const amount = int(row.amount)
      kpis.collectedPaise += amount
      dayOf(row.day).collectedPaise += amount
      const mode = normalizeMode(row.method)
      const entry = modeTotals.get(mode) || { amountPaise: 0, count: 0 }
      entry.amountPaise += amount; entry.count += int(row.count)
      modeTotals.set(mode, entry)
    }

    let refundTaxPaise = 0
    for (const row of refunds) {
      const amount = int(row.refund_paise)
      kpis.refundsPaise += amount
      dayOf(row.day).refundsPaise += amount
      if (SALE_SET.has(row.status)) {
        kpis.refundsOnSalesPaise += amount
        const money = onlineMoney(row)
        if (money.totalPaise > 0) refundTaxPaise += Math.round((amount * money.taxPaise) / money.totalPaise)
      }
    }

    let outstandingNow = 0
    for (const order of openOrders) {
      const money = onlineMoney(order)
      outstandingNow += Math.max(money.totalPaise - int(order.paid_paise), 0)
    }

    const rate = profile.commission_rate == null ? null : Number(profile.commission_rate)
    const settlement = this._settlement(settlementRows)

    return {
      channel: CHANNELS.ONLINE,
      kpis,
      days,
      paymentModes: modeTotals,
      taxGroups: [...groups.values()],
      refundTaxPaise,
      top: top.map((row) => ({ name: row.name, amountPaise: int(row.amount), orders: int(row.orders) })),
      extra: {
        statusCounts,
        platformCharges: platform,
        commission: {
          ratePercent: rate,
          estimatedOnDeliveredPaise: rate == null ? null : Math.round((deliveredItemsPaise * rate) / 100),
          basis: 'Vendor commission rate × delivered item value. The settled figures below are the platform\'s own records.',
        },
        settlement,
        outstandingNow: { amountPaise: outstandingNow, orders: openOrders.length },
        supplyStateUnknown,
      },
    }
  }

  _settlement(rows) {
    const total = { grossPaise: 0, commissionPaise: 0, deliveryCostPaise: 0, refundPaise: 0, netPaise: 0, payoutPaise: 0 }
    const byStatus = {}
    for (const row of rows) {
      total.grossPaise += toPaise(row.gross_revenue)
      total.commissionPaise += toPaise(row.platform_commission)
      total.deliveryCostPaise += toPaise(row.delivery_costs)
      total.refundPaise += toPaise(row.refund_amount)
      total.netPaise += toPaise(row.net_revenue)
      total.payoutPaise += toPaise(row.payout_amount)
      const status = row.payout_status || 'PENDING'
      const entry = byStatus[status] || { payoutPaise: 0, days: 0 }
      entry.payoutPaise += toPaise(row.payout_amount); entry.days += 1
      byStatus[status] = entry
    }
    return {
      recorded: rows.length > 0,
      days: rows.length,
      ...total,
      byStatus,
      recent: rows.slice(0, 10).map((row) => ({
        date: row.period_start, orders: int(row.total_orders), grossPaise: toPaise(row.gross_revenue), commissionPaise: toPaise(row.platform_commission),
        netPaise: toPaise(row.net_revenue), payoutPaise: toPaise(row.payout_amount), status: row.payout_status, paidAt: row.paid_at || null,
      })),
    }
  }

  // ── Merging ──────────────────────────────────────────────────────────────

  _mergePayments(blocks) {
    const merged = new Map()
    for (const block of blocks) {
      for (const [mode, value] of block.paymentModes) {
        const entry = merged.get(mode) || { mode, label: MODE_LABELS[mode], amountPaise: 0, count: 0, byChannel: {} }
        entry.amountPaise += value.amountPaise; entry.count += value.count
        entry.byChannel[block.channel] = (entry.byChannel[block.channel] || 0) + value.amountPaise
        merged.set(mode, entry)
      }
    }
    return [...merged.values()].filter((entry) => entry.amountPaise !== 0).sort((a, b) => b.amountPaise - a.amountPaise)
  }

  _mergeTop(blocks) {
    const merged = new Map()
    for (const block of blocks) {
      for (const item of block.top) {
        const entry = merged.get(item.name) || { name: item.name, amountPaise: 0, orders: 0, byChannel: {} }
        entry.amountPaise += item.amountPaise; entry.orders += item.orders
        entry.byChannel[block.channel] = (entry.byChannel[block.channel] || 0) + item.amountPaise
        merged.set(item.name, entry)
      }
    }
    return [...merged.values()].sort((a, b) => b.amountPaise - a.amountPaise).slice(0, 8)
  }

  // ── Statutory controls ───────────────────────────────────────────────────

  async statutory(vendorId, { from, to, channel }) {
    const period = this._period(from, to)
    if (period.success === false) return period
    const profile = await this.repo.vendorProfile(vendorId)
    if (!profile) return failure('Vendor not found', 'NOT_FOUND', 404)
    const marketplace = this._marketplace(profile)
    const want = this._channels(channel, marketplace.connected)
    const notice = want.requested !== 'POS' && !marketplace.connected ? 'LNDRY Online is not connected for this business.' : null
    const base = { success: true, period: { from, to, days: daysBetween(from, to) }, currency: 'INR', generatedAt: new Date().toISOString(), requestedChannel: want.requested, channel: want.effective, marketplace, notice }
    if (want.requested === 'ONLINE' && !marketplace.connected) return { ...base, summary: null, rates: [], channels: [], invoices: null, compliance: [], registration: this._registration(profile) }

    const [posBlock, onlineBlock, invoiceRows, missing] = await Promise.all([
      want.pos ? this._posBlock(vendorId, from, to) : null,
      want.online ? this._onlineBlock(vendorId, from, to, profile) : null,
      this.repo.invoices(vendorId, from, to),
      this.repo.deliveredWithoutInvoice(vendorId, from, to),
    ])
    const blocks = [posBlock, onlineBlock].filter(Boolean)

    const rates = new Map()
    const channels = blocks.map((block) => {
      const s = { channel: block.channel, orders: 0, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, invoiceValuePaise: 0, noGstOrders: 0, noGstValuePaise: 0 }
      for (const group of block.taxGroups) {
        s.orders += group.orders; s.taxableValuePaise += group.taxableValuePaise; s.cgstPaise += group.cgstPaise; s.sgstPaise += group.sgstPaise
        s.igstPaise += group.igstPaise || 0; s.taxPaise += group.taxPaise; s.invoiceValuePaise += group.invoiceValuePaise
        if (group.ratePercent === 0) { s.noGstOrders += group.orders; s.noGstValuePaise += group.taxableValuePaise }
        const merged = rates.get(group.ratePercent) || { ratePercent: group.ratePercent, orders: 0, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, invoiceValuePaise: 0, byChannel: {} }
        merged.orders += group.orders; merged.taxableValuePaise += group.taxableValuePaise; merged.cgstPaise += group.cgstPaise; merged.sgstPaise += group.sgstPaise
        merged.igstPaise += group.igstPaise || 0; merged.taxPaise += group.taxPaise; merged.invoiceValuePaise += group.invoiceValuePaise
        merged.byChannel[block.channel] = (merged.byChannel[block.channel] || 0) + group.taxPaise
        rates.set(group.ratePercent, merged)
      }
      s.creditNotePaise = block.kpis.refundsOnSalesPaise
      s.creditTaxPaise = block.refundTaxPaise
      s.netTaxPaise = s.taxPaise - s.creditTaxPaise
      return s
    })

    const sum = (key) => channels.reduce((total, c) => total + c[key], 0)
    const summary = {
      orders: sum('orders'), taxableValuePaise: sum('taxableValuePaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise'),
      taxCollectedPaise: sum('taxPaise'), invoiceValuePaise: sum('invoiceValuePaise'), noGstOrders: sum('noGstOrders'), noGstValuePaise: sum('noGstValuePaise'),
      creditNotesPaise: sum('creditNotePaise'), creditTaxPaise: sum('creditTaxPaise'), netTaxPaise: sum('netTaxPaise'),
    }

    // Invoices, split by channel; an order type maps straight to its channel.
    const chan = (row) => (row.order_type === 'STORE_ORDER' ? CHANNELS.POS : CHANNELS.ONLINE)
    const shown = invoiceRows.filter((row) => (chan(row) === CHANNELS.POS ? want.pos : want.online))
    const invoices = {
      issued: shown.filter((row) => row.status === 'ISSUED').length,
      void: shown.filter((row) => row.status === 'VOID').length,
      taxPaise: shown.filter((row) => row.status === 'ISSUED').reduce((s, row) => s + int(row.tax_paise), 0),
      valuePaise: shown.filter((row) => row.status === 'ISSUED').reduce((s, row) => s + int(row.total_paise), 0),
      byChannel: blocks.map((block) => ({ channel: block.channel, issued: shown.filter((r) => chan(r) === block.channel && r.status === 'ISSUED').length })),
      deliveredWithoutInvoice: (want.pos ? missing.pos : 0) + (want.online ? missing.online : 0),
      recent: shown.slice(0, 25).map((row) => ({
        invoiceNumber: row.invoice_number, orderNumber: row.order_number, channel: chan(row), date: row.invoice_day, status: row.status,
        taxablePaise: int(row.total_paise) - int(row.tax_paise), taxPaise: int(row.tax_paise), totalPaise: int(row.total_paise), paymentStatus: row.payment_status,
      })),
    }

    const registration = this._registration(profile)
    const unknownState = onlineBlock ? onlineBlock.extra.supplyStateUnknown : 0
    const compliance = []
    if (summary.taxCollectedPaise > 0 && !registration.gstin) {
      compliance.push({ key: 'gstin-missing', status: 'ACTION', label: 'GST is being charged but no GSTIN is on file', detail: 'Add the business GSTIN in the vendor profile so it can be shown on invoices and returns.' })
    } else if (registration.gstin) {
      compliance.push({ key: 'gstin', status: 'OK', label: 'GSTIN on file', detail: registration.gstin })
    } else {
      compliance.push({ key: 'gstin-none', status: 'INFO', label: 'No GSTIN on file', detail: 'No GST was charged in this period.' })
    }
    compliance.push(invoices.deliveredWithoutInvoice > 0
      ? { key: 'invoices-pending', status: 'INFO', label: `${invoices.deliveredWithoutInvoice} delivered order(s) have no invoice yet`, detail: 'An invoice is generated the first time it is opened after delivery, or by the platform after delivery.' }
      : { key: 'invoices', status: 'OK', label: 'Every delivered order in this period has an invoice', detail: null })
    if (unknownState > 0) {
      compliance.push({ key: 'supply-state', status: 'INFO', label: `${unknownState} online order(s) have no delivery state`, detail: 'Treated as within your own state (CGST + SGST) when the delivery state is missing.' })
    }
    if (summary.noGstOrders > 0) {
      compliance.push({ key: 'no-gst', status: 'INFO', label: `${summary.noGstOrders} order(s) carry no GST`, detail: 'Either GST was not charged or the order is exempt. Shown separately below the GST rates.' })
    }
    compliance.push({ key: 'sac', status: 'INFO', label: 'SAC / HSN codes are not recorded', detail: 'Services in LNDRY do not carry a SAC/HSN code, so none is printed or reported.' })

    return {
      ...base,
      registration,
      summary,
      rates: [...rates.values()].sort((a, b) => b.ratePercent - a.ratePercent),
      channels,
      invoices,
      compliance,
      basis: {
        split: 'A supply within your own state splits the tax evenly into CGST and SGST; one delivered to another state is IGST. Counter sales are within your state.',
        source: 'Amounts are the tax persisted on each order (the same figure the invoice carries). Credit notes are approved returns / recorded refunds on orders counted here, with the tax portion in proportion to the order.',
        period: 'Orders are counted on the day they were booked.',
      },
    }
  }

  _registration(profile) {
    return { legalName: profile.name, gstin: profile.gst_number || null, gstRegistered: Boolean(profile.gst_number), state: profile.state || null, city: profile.city || null }
  }
}
