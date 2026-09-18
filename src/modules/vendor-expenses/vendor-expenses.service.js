import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorExpensesRepository } from './vendor-expenses.repository.js'

const PAYMENT_MODES = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'OTHER']

function validate(input) {
  if (!String(input.expenseName || '').trim()) return 'expenseName is required'
  if (!input.expenseDate || Number.isNaN(Date.parse(input.expenseDate))) return 'expenseDate is required'
  if (!Number.isFinite(Number(input.amountPaise)) || Number(input.amountPaise) <= 0) return 'amountPaise must be greater than zero'
  if (input.paymentMode && !PAYMENT_MODES.includes(input.paymentMode)) return `paymentMode must be one of: ${PAYMENT_MODES.join(', ')}`
  return null
}

export class VendorExpensesService {
  constructor(repository = new VendorExpensesRepository()) {
    this.repo = repository
  }

  async create(vendorId, actor, input) {
    const validationError = validate(input)
    if (validationError) return { success: false, message: validationError }
    const expense = await this.repo.create(vendorId, actor.userId, { ...input, amountPaise: Math.round(input.amountPaise) })
    emitAudit('vendor_expense_recorded', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_expense', target_id: expense.id,
      before: null, after: expense, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, expense }
  }

  async update(vendorId, actor, id, input, reason) {
    if (!String(reason || '').trim()) return { success: false, message: 'editReason is required' }
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Expense not found', code: 'NOT_FOUND' }
    if (existing.status !== 'PAID') return { success: false, message: 'Only a paid expense can be edited', code: 'INVALID_STATUS' }
    const validationError = validate(input)
    if (validationError) return { success: false, message: validationError }
    const before = existing
    const expense = await this.repo.update(id, { ...input, amountPaise: Math.round(input.amountPaise), editReason: String(reason).trim().slice(0, 500) })
    emitAudit('vendor_expense_edited', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_expense', target_id: id,
      before, after: expense, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, expense }
  }

  async cancel(vendorId, actor, id, reason) {
    if (!String(reason || '').trim()) return { success: false, message: 'reason is required' }
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Expense not found', code: 'NOT_FOUND' }
    if (existing.status !== 'PAID') return { success: false, message: 'Only a paid expense can be cancelled', code: 'INVALID_STATUS' }
    const expense = await this.repo.cancel(id, String(reason).trim().slice(0, 500))
    emitAudit('vendor_expense_cancelled', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_expense', target_id: id,
      before: existing, after: expense, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, expense }
  }

  async list(vendorId, query) {
    return this.repo.list(vendorId, query)
  }
}
