import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorCustomerLedgerRepository } from './vendor-customer-ledger.repository.js'

const ENTRY_TYPES = ['OPENING_BALANCE', 'INVOICE_DEBIT', 'PAYMENT_CREDIT', 'WALLET_CREDIT', 'WALLET_DEBIT', 'REFUND', 'ADJUSTMENT', 'SETTLEMENT']

export class VendorCustomerLedgerService {
  constructor(repository = new VendorCustomerLedgerRepository()) {
    this.repo = repository
  }

  async append(vendorId, actor, input) {
    if (!ENTRY_TYPES.includes(input.entryType)) {
      return { success: false, message: `entryType must be one of: ${ENTRY_TYPES.join(', ')}` }
    }
    const debit = Math.round(Number(input.debitPaise || 0))
    const credit = Math.round(Number(input.creditPaise || 0))
    if ((debit === 0 && credit === 0) || (debit > 0 && credit > 0)) {
      return { success: false, message: 'Ledger entry needs exactly one of debitPaise or creditPaise' }
    }
    if (!input.customerUserId && !input.customerName && !input.customerPhone) {
      return { success: false, message: 'One of customerUserId, customerName or customerPhone is required' }
    }
    const entry = await this.repo.append(vendorId, actor.userId, { ...input, debitPaise: debit, creditPaise: credit })
    emitAudit('vendor_customer_ledger_posted', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_customer_ledger', target_id: entry.id,
      before: null, after: entry, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, entry }
  }

  async getStatement(vendorId, { customerUserId, phone }) {
    const entries = await this.repo.listForCustomer(vendorId, { customerUserId, phone })
    const balancePaise = entries.reduce((sum, entry) => sum + entry.debitPaise - entry.creditPaise, 0)
    return { entries, balancePaise }
  }
}
