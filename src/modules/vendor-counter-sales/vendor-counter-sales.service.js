import { randomUUID } from 'node:crypto'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorCounterSalesRepository } from './vendor-counter-sales.repository.js'
import { StoreOrdersRepository } from '../store-orders/store-orders.repository.js'
import { VendorAdjustmentRulesRepository } from '../vendor-adjustment-rules/vendor-adjustment-rules.repository.js'
import { amountForRule } from '../vendor-adjustment-rules/vendor-adjustment-rules.service.js'
import { VendorCustomerLedgerService } from '../vendor-customer-ledger/vendor-customer-ledger.service.js'
import { VendorCashShiftsRepository } from '../vendor-cash-shifts/vendor-cash-shifts.repository.js'

const PAYMENT_MODES = ['CASH', 'UPI', 'CARD', 'BANK', 'PAY_LATER']

/**
 * Vendor Counter Sales service — "ring up a walk-in sale," the counter-sale
 * booking piece of Tier 3 (see CLAUDE.md). Ported from epic-laundry-desktop's
 * domain.ts#bookLaundryOrder, but deliberately booking into the existing
 * `store_orders` table (Desktop Sync initiative, Phase 4) rather than the
 * real pickup-delivery `orders` table — that table's own migration comment
 * already explains why a counter sale can't be a normal order (orders.user_id
 * NOT NULL, no delivery/rider concept, ~145 references assuming a real
 * deliverable order). This reuses that existing, already-shipped design
 * rather than inventing a second one.
 *
 * Deliberately NOT wired to garment-unit tag generation (migration 122) in
 * this pass — those units FK to real order_lines/orders, which a counter
 * sale never creates. Tagging a walk-in sale's physical garments would need
 * either a schema change to garment units or a parallel tagging path; left
 * as a known follow-up, not silently assumed away.
 */
export class VendorCounterSalesService {
  constructor(
    repository = new VendorCounterSalesRepository(),
    storeOrdersRepo = new StoreOrdersRepository(),
    adjustmentRulesRepo = new VendorAdjustmentRulesRepository(),
    ledgerService = new VendorCustomerLedgerService(),
    cashShiftsRepo = new VendorCashShiftsRepository()
  ) {
    this.repo = repository
    this.storeOrders = storeOrdersRepo
    this.adjustmentRules = adjustmentRulesRepo
    this.ledger = ledgerService
    this.cashShifts = cashShiftsRepo
  }

  async _priceLines(vendorId, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return { error: 'At least one line is required' }
    const rateIds = [...new Set(lines.map((line) => line.vendorServiceRateId))]
    const rates = await this.repo.findServiceRates(vendorId, rateIds)
    const rateById = new Map(rates.map((rate) => [rate.id, rate]))

    const priced = []
    let subtotalPaise = 0
    for (const line of lines) {
      const rate = rateById.get(line.vendorServiceRateId)
      if (!rate) return { error: `Service rate ${line.vendorServiceRateId} not found for this vendor` }
      if (!rate.isActive) return { error: `${rate.garmentName} / ${rate.serviceName} is not currently active` }
      const quantity = Number(line.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) return { error: 'Each line quantity must be greater than zero' }
      const amountPaise = Math.round(rate.ratePaise * quantity)
      subtotalPaise += amountPaise
      priced.push({
        vendorServiceRateId: rate.id, garmentName: rate.garmentName, serviceName: rate.serviceName,
        qty: quantity, ratePaise: rate.ratePaise, amountPaise, unit: 'piece',
      })
    }
    return { priced, subtotalPaise }
  }

  async _applyAdjustmentRules(vendorId, subtotalPaise, chargeRuleIds = [], discountRuleIds = []) {
    const [chargeRules, discountRules] = await Promise.all([
      this.adjustmentRules.findByIds(vendorId, chargeRuleIds),
      this.adjustmentRules.findByIds(vendorId, discountRuleIds),
    ])
    if (chargeRules.length !== chargeRuleIds.length) return { error: 'One or more charge rules were not found for this vendor' }
    if (discountRules.length !== discountRuleIds.length) return { error: 'One or more discount rules were not found for this vendor' }
    const chargesPaise = chargeRules.filter((r) => r.kind === 'CHARGE').reduce((sum, rule) => sum + amountForRule(rule, subtotalPaise), 0)
    const discountsPaise = discountRules.filter((r) => r.kind === 'DISCOUNT').reduce((sum, rule) => sum + amountForRule(rule, subtotalPaise + chargesPaise), 0)
    return { chargesPaise, discountsPaise, chargeRules, discountRules }
  }

  async quote(vendorId, input) {
    const { priced, subtotalPaise, error: linesError } = await this._priceLines(vendorId, input.lines || [])
    if (linesError) return { success: false, message: linesError }
    const adjustments = await this._applyAdjustmentRules(vendorId, subtotalPaise, input.chargeRuleIds, input.discountRuleIds)
    if (adjustments.error) return { success: false, message: adjustments.error }
    const totalPaise = Math.max(0, subtotalPaise + adjustments.chargesPaise - adjustments.discountsPaise)
    return { success: true, quote: { lines: priced, subtotalPaise, chargesPaise: adjustments.chargesPaise, discountsPaise: adjustments.discountsPaise, totalPaise } }
  }

  async book(vendorId, actor, input) {
    if (!PAYMENT_MODES.includes(input.paymentMode)) return { success: false, message: `paymentMode must be one of: ${PAYMENT_MODES.join(', ')}` }
    const customer = await this.repo.findCustomer(input.customerUserId)
    if (!customer) return { success: false, message: 'Customer not found', code: 'NOT_FOUND' }

    const quoted = await this.quote(vendorId, input)
    if (!quoted.success) return quoted
    const { lines, subtotalPaise, chargesPaise, discountsPaise, totalPaise } = quoted.quote

    let cashShiftId = null
    if (input.paymentMode === 'CASH') {
      const shift = await this.cashShifts.findOpen(vendorId, input.cashRegister || 'Main counter')
      cashShiftId = shift?.id ?? null
    }

    const posOrderId = String(input.idempotencyKey || `CS-${randomUUID()}`)
    const orderNumber = `CS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const order = await this.storeOrders.upsert({
      vendorId, customerUserId: customer.id, posOrderId, orderNumber,
      items: lines.map((line) => ({ name: line.garmentName, serviceName: line.serviceName, qty: line.qty, unit: line.unit, ratePaise: line.ratePaise, amountPaise: line.amountPaise })),
      subtotalPaise, discountPaise: discountsPaise, taxPaise: 0, totalPaise, paymentMethod: input.paymentMode,
      cashShiftId,
    })

    const reason = `Counter sale ${orderNumber}`
    await this.ledger.append(vendorId, actor, { customerUserId: customer.id, entryType: 'INVOICE_DEBIT', debitPaise: totalPaise, referenceType: 'store_order', referenceId: order.id, reason })
    if (input.paymentMode !== 'PAY_LATER') {
      await this.ledger.append(vendorId, actor, { customerUserId: customer.id, entryType: 'PAYMENT_CREDIT', creditPaise: totalPaise, referenceType: 'store_order', referenceId: order.id, reason: `${input.paymentMode} payment for ${orderNumber}` })
    }

    emitAudit('vendor_counter_sale_booked', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'store_order', target_id: order.id,
      before: null, after: { orderNumber, totalPaise, paymentMode: input.paymentMode }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, order, quote: { lines, subtotalPaise, chargesPaise, discountsPaise, totalPaise } }
  }
}
