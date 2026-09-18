import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorReturnCasesRepository } from './vendor-return-cases.repository.js'

const REASONS = ['QUALITY_ISSUE', 'SERVICE_NOT_PERFORMED', 'DUPLICATE_CHARGE', 'CUSTOMER_CANCELLATION', 'OTHER']

export class VendorReturnCasesService {
  constructor(repository = new VendorReturnCasesRepository()) {
    this.repo = repository
  }

  async request(vendorId, actor, input) {
    const order = await this.repo.findOrder(vendorId, input.orderId)
    if (!order) return { success: false, message: 'Order not found for this vendor', code: 'NOT_FOUND' }
    if (!REASONS.includes(input.reason)) return { success: false, message: `reason must be one of: ${REASONS.join(', ')}` }
    const amountPaise = Math.round(Number(input.amountPaise))
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return { success: false, message: 'amountPaise must be greater than zero' }
    const maxPaise = Math.round(Number(order.total_amount) * 100)
    if (amountPaise > maxPaise) return { success: false, message: 'Return amount exceeds the order total', code: 'EXCEEDS_ORDER_TOTAL' }

    const duplicate = await this.repo.findDuplicate(order.id, amountPaise, input.reason)
    if (duplicate) return { success: true, duplicate: true, returnCase: duplicate }

    const returnCase = await this.repo.create(vendorId, actor.userId, {
      orderId: order.id, customerUserId: order.customer_user_id, amountPaise, reason: input.reason, note: input.note,
    })
    emitAudit('vendor_return_case_requested', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_return_case', target_id: returnCase.id,
      before: null, after: returnCase, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, duplicate: false, returnCase }
  }

  async decide(vendorId, actor, id, approve, decisionNote) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Return case not found', code: 'NOT_FOUND' }
    if (existing.status !== 'REQUESTED') return { success: false, message: 'This return case has already been decided' }
    const note = String(decisionNote || '').trim().slice(0, 1000)
    if (note.length < 3) return { success: false, message: 'A decision note is required' }
    const returnCase = await this.repo.decide(id, actor.userId, approve ? 'APPROVED' : 'REJECTED', note)
    emitAudit('vendor_return_case_decided', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_return_case', target_id: id,
      before: existing, after: returnCase, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, returnCase }
  }

  async list(vendorId, query) {
    return this.repo.list(vendorId, query)
  }
}
