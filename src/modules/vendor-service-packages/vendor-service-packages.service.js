import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorServicePackagesRepository } from './vendor-service-packages.repository.js'
import { VendorCustomerLedgerService } from '../vendor-customer-ledger/vendor-customer-ledger.service.js'

const PAYMENT_MODES = ['CASH', 'UPI', 'CARD', 'BANK']
const round2 = (value) => Math.round(value * 100) / 100

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Vendor Service Packages service — prepaid package definitions/purchases/
 * payments/redemptions, ported from epic-laundry-desktop's packages.ts.
 * Purchases and payments post to VendorCustomerLedgerService (Tier 0)
 * instead of a new ledger mechanism, mirroring epic's own reuse of
 * appendCustomerLedger.
 */
export class VendorServicePackagesService {
  constructor(repository = new VendorServicePackagesRepository(), ledgerService = new VendorCustomerLedgerService()) {
    this.repo = repository
    this.ledger = ledgerService
  }

  async listDefinitions(vendorId, includeInactive) {
    const definitions = await this.repo.listDefinitions(vendorId, includeInactive)
    return Promise.all(definitions.map(async (def) => ({ ...def, lines: await this.repo.linesFor(def.id) })))
  }

  async createDefinition(vendorId, actor, input) {
    const name = String(input.name || '').trim()
    if (name.length < 2) return { success: false, message: 'name is required' }
    const pricePaise = Math.round(Number(input.pricePaise))
    if (!Number.isFinite(pricePaise) || pricePaise < 0) return { success: false, message: 'pricePaise must be zero or more' }
    const validityDays = Math.round(Number(input.validityDays))
    if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650) return { success: false, message: 'validityDays must be between 1 and 3650' }
    if (!Array.isArray(input.lines) || input.lines.length === 0) return { success: false, message: 'At least one service allowance line is required' }

    const seen = new Set()
    for (const line of input.lines) {
      if (seen.has(line.vendorServiceRateId)) return { success: false, message: 'Each garment/service combination can only appear once' }
      seen.add(line.vendorServiceRateId)
      const allowance = Number(line.allowance)
      if (!Number.isFinite(allowance) || allowance <= 0) return { success: false, message: 'allowance must be greater than zero' }
      const rate = await this.repo.findServiceRate(vendorId, line.vendorServiceRateId)
      if (!rate) return { success: false, message: `Service rate ${line.vendorServiceRateId} not found for this vendor` }
    }

    const definition = await this.repo.createDefinition(vendorId, { name, description: input.description, pricePaise, validityDays, active: input.active, lines: input.lines })
    emitAudit('vendor_service_package_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_service_package', target_id: definition.id,
      before: null, after: definition, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, definition }
  }

  async _presentCustomerPackage(vendorId, row) {
    const definition = await this.repo.findDefinition(vendorId, row.packageId)
    const lines = await this.repo.linesFor(row.packageId)
    const redemptions = await this.repo.redemptionsFor(row.id)
    const services = lines.map((line) => {
      const used = round2(redemptions.filter((r) => r.vendorServiceRateId === line.vendorServiceRateId).reduce((sum, r) => sum + r.quantity, 0))
      return { vendorServiceRateId: line.vendorServiceRateId, garmentName: line.garmentName, serviceName: line.serviceName, allowance: line.allowance, used, remaining: round2(line.allowance - used) }
    })
    const today = new Date().toISOString().slice(0, 10)
    const effectiveStatus = row.status === 'ACTIVE' && row.expiresOn < today ? 'EXPIRED' : row.status
    return { ...row, status: effectiveStatus, packageName: definition?.name, services, redemptions }
  }

  async purchase(vendorId, actor, input) {
    const definition = await this.repo.findDefinition(vendorId, input.packageId)
    if (!definition) return { success: false, message: 'Service package not found', code: 'NOT_FOUND' }
    if (!definition.active) return { success: false, message: 'This service package is inactive' }
    const purchasedDate = String(input.purchasedDate || new Date().toISOString().slice(0, 10))
    const paymentMode = input.paymentMode || 'PAY_LATER'
    if (!['PAY_LATER', ...PAYMENT_MODES].includes(paymentMode)) return { success: false, message: 'Unsupported payment method' }
    const contractPricePaise = definition.pricePaise
    const pricePaidPaise = input.pricePaidPaise === undefined
      ? (paymentMode === 'PAY_LATER' ? 0 : contractPricePaise)
      : Math.round(Number(input.pricePaidPaise))
    if (!Number.isFinite(pricePaidPaise) || pricePaidPaise < 0 || pricePaidPaise > contractPricePaise) {
      return { success: false, message: `Payment must be between 0 and ${contractPricePaise} paise` }
    }
    const paymentStatus = pricePaidPaise >= contractPricePaise && contractPricePaise > 0 ? 'PAID' : pricePaidPaise > 0 ? 'PART_PAID' : 'UNPAID'
    const reason = String(input.reason || 'Package purchase').trim().slice(0, 500)

    const assigned = await this.repo.purchase(vendorId, actor.userId, {
      packageId: definition.id, customerUserId: input.customerUserId, purchasedDate,
      expiresOn: addDays(purchasedDate, definition.validityDays), contractPricePaise, pricePaidPaise, paymentMode, paymentStatus,
    })

    if (contractPricePaise > 0) {
      await this.ledger.append(vendorId, actor, {
        customerUserId: input.customerUserId, entryType: 'INVOICE_DEBIT', debitPaise: contractPricePaise,
        referenceType: 'vendor_customer_package', referenceId: assigned.id, reason,
      })
      if (pricePaidPaise > 0 && paymentMode !== 'PAY_LATER') {
        await this.ledger.append(vendorId, actor, {
          customerUserId: input.customerUserId, entryType: 'PAYMENT_CREDIT', creditPaise: pricePaidPaise,
          referenceType: 'vendor_customer_package', referenceId: assigned.id, reason: `${paymentMode} package payment`,
        })
      }
    }
    emitAudit('vendor_service_package_purchased', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_customer_package', target_id: assigned.id,
      before: null, after: assigned, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, customerPackage: await this._presentCustomerPackage(vendorId, assigned) }
  }

  async addPayment(vendorId, actor, customerPackageId, input) {
    const assigned = await this.repo.findCustomerPackage(vendorId, customerPackageId)
    if (!assigned) return { success: false, message: 'Customer package not found', code: 'NOT_FOUND' }
    const presented = await this._presentCustomerPackage(vendorId, assigned)
    if (presented.status === 'EXPIRED' || presented.status === 'CANCELLED') return { success: false, message: `Package is ${presented.status.toLowerCase()} and cannot receive payment` }
    const outstanding = assigned.contractPricePaise - assigned.pricePaidPaise
    const amountPaise = Math.round(Number(input.amountPaise))
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return { success: false, message: 'amountPaise must be greater than zero' }
    if (amountPaise > outstanding) return { success: false, message: `Payment exceeds outstanding amount (${outstanding} paise)` }
    if (!PAYMENT_MODES.includes(input.mode)) return { success: false, message: 'Unsupported payment method' }
    const paymentDate = String(input.paymentDate || new Date().toISOString().slice(0, 10))
    const reason = String(input.reason || 'Package payment').trim().slice(0, 500)

    const payment = await this.repo.addPayment(customerPackageId, actor.userId, { amountPaise, mode: input.mode, reference: input.reference, paymentDate, reason })
    const nextCollected = assigned.pricePaidPaise + amountPaise
    const updated = await this.repo.updateCustomerPackagePayment(customerPackageId, {
      pricePaidPaise: nextCollected,
      paymentStatus: nextCollected >= assigned.contractPricePaise && assigned.contractPricePaise > 0 ? 'PAID' : 'PART_PAID',
      paymentMode: input.mode,
    })
    await this.ledger.append(vendorId, actor, {
      customerUserId: assigned.customerUserId, entryType: 'PAYMENT_CREDIT', creditPaise: amountPaise,
      referenceType: 'vendor_customer_package_payment', referenceId: payment.id, reason,
    })
    emitAudit('vendor_service_package_payment_collected', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_customer_package_payment', target_id: payment.id,
      before: null, after: payment, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, payment, customerPackage: await this._presentCustomerPackage(vendorId, updated), outstandingPaise: updated.contractPricePaise - updated.pricePaidPaise }
  }

  async redeem(vendorId, actor, customerPackageId, input) {
    const assigned = await this.repo.findCustomerPackage(vendorId, customerPackageId)
    if (!assigned) return { success: false, message: 'Customer package not found', code: 'NOT_FOUND' }
    let presented = await this._presentCustomerPackage(vendorId, assigned)
    if (presented.status !== 'ACTIVE') return { success: false, message: `Package is ${presented.status.toLowerCase()} and cannot be redeemed` }
    const quantity = round2(Number(input.quantity))
    if (!Number.isFinite(quantity) || quantity <= 0) return { success: false, message: 'quantity must be greater than zero' }
    const line = presented.services.find((s) => s.vendorServiceRateId === input.vendorServiceRateId)
    if (!line) return { success: false, message: 'This garment/service is not included in the package' }
    if (round2(line.used + quantity) > line.allowance) return { success: false, message: 'Redemption exceeds the remaining allowance' }

    const redeemedDate = new Date().toISOString().slice(0, 10)
    const redemption = await this.repo.redeem(customerPackageId, actor.userId, {
      vendorServiceRateId: input.vendorServiceRateId, quantity, redeemedDate, orderId: input.orderId, reason: input.reason,
    })
    presented = await this._presentCustomerPackage(vendorId, assigned)
    const exhausted = presented.services.every((s) => s.remaining <= 0)
    if (exhausted) {
      await this.repo.markStatus(customerPackageId, 'EXHAUSTED')
      presented = await this._presentCustomerPackage(vendorId, assigned)
    }
    emitAudit('vendor_service_package_redeemed', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_package_redemption', target_id: redemption.id,
      before: null, after: { customerPackageId, quantity, exhausted }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, customerPackage: presented }
  }

  async listForCustomer(vendorId, customerUserId) {
    const rows = await this.repo.listForCustomer(vendorId, customerUserId)
    return Promise.all(rows.map((row) => this._presentCustomerPackage(vendorId, row)))
  }
}
